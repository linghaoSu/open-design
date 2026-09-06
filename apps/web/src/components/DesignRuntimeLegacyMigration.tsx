import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import {
  LegacyDesignSystemMigrationPlanSchema,
  type LegacyDesignSystemMigrationPlan,
  type LegacyDesignSystemMigrationReview,
  type ProjectDesignRuntimeState,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { applyProjectDesignRuntimeLegacyMigration, getProjectDesignRuntime, ProjectDesignRuntimeError,
  reviewProjectDesignRuntimeLegacyMigration, type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
import { DesignRuntimeSourceSelections } from './DesignRuntimeSourceSelections';
import { DesignSystemVersionDetails, initialVersionConstraints, VersionConstraintFields } from './DesignSystemVersionDetails';
import { StructureDiagnostics } from './ProjectStructureReview';
import styles from './DesignRuntimeLegacyMigration.module.css';

interface Props {
  scope: ProjectDesignRuntimeScope;
  state: ProjectDesignRuntimeState | null;
  files: readonly { name: string; size?: number; mtime?: number; type?: 'file' | 'dir' }[];
  viewerOnly: boolean;
  externalBusy?: boolean;
  onState(state: ProjectDesignRuntimeState): void;
  onBusyChange?(busy: boolean): void;
}

export const isLegacyDesignSource = (name: string) => /(^|\/)(DESIGN\.md|tokens\.css|components\.html)$/i.test(name) || /^system\/variables\.css$/i.test(name);
const json = (value: unknown) => JSON.stringify(value, null, 2);
const migrationSteps = ['name', 'files', 'review'] as const;
type MigrationStep = typeof migrationSteps[number];

/** Project, account, membership and edit authority changes discard all review evidence. */
export function DesignRuntimeLegacyMigration(props: Props) {
  return <MigrationContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext), props.viewerOnly])} {...props} />;
}

function MigrationContent({ scope, state, files, viewerOnly, externalBusy = false, onState, onBusyChange }: Props) {
  const t = useT();
  const id = useId();
  const [step, setStep] = useState<MigrationStep>('name');
  const stepIndex = migrationSteps.indexOf(step);
  const stepHeadings = useRef<Partial<Record<MigrationStep, HTMLHeadingElement | null>>>({});
  const previousStep = useRef(step);
  const paths = files.filter((file) => file.type !== 'dir').map((file) => file.name).sort();
  const sourceIdentity = JSON.stringify(files.map((file) => [file.name, file.size, file.mtime, file.type]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const [draft, setDraft] = useState<LegacyDesignSystemMigrationPlan>(() => {
    const tokenStylesheet = paths.find((name) => /^tokens\.css$/i.test(name)) ?? paths.find((name) => /^system\/variables\.css$/i.test(name));
    return { schemaVersion: 1, designSystemId: state?.registry?.id ?? scope.projectId, name: t('designMigration.defaultName'), version: '1.0.0',
      mode: state?.validationSettings.mode === 'guided' ? 'guided' : 'explore', sourcePaths: paths.filter(isLegacyDesignSource),
      ...(tokenStylesheet ? { tokenStylesheet } : {}), selections: [], constraints: state?.validationSettings.projectConstraints ?? initialVersionConstraints(), codeCompatibility: [] };
  });
  const [reviewed, setReviewed] = useState<{ review: LegacyDesignSystemMigrationReview; plan: LegacyDesignSystemMigrationPlan; state: ProjectDesignRuntimeState; sourceIdentity: string; draft: LegacyDesignSystemMigrationPlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const mounted = useRef(false); const epoch = useRef(0); const running = useRef(false); const abort = useRef<AbortController | null>(null);
  const callbacks = useRef({ onState, onBusyChange }); callbacks.current = { onState, onBusyChange };
  const latest = useRef({ state, sourceIdentity, draft }); latest.current = { state, sourceIdentity, draft };
  const reviewRef = useRef(reviewed); reviewRef.current = reviewed;
  const appliedRevision = useRef<number | null>(null);
  const locked = busy || externalBusy;
  const requiredPaths = [draft.tokenStylesheet, ...draft.selections.flatMap((selection) => [selection.sourcePath, ...(selection.storySources ?? []).map((source) => source.sourcePath)])].filter((value): value is string => !!value);
  const sourcePaths = [...new Set([...draft.sourcePaths, ...requiredPaths])].sort();
  const parsed = LegacyDesignSystemMigrationPlanSchema.safeParse({ ...draft, sourcePaths });
  const validReview = reviewed && reviewed.state === state && reviewed.sourceIdentity === sourceIdentity && reviewed.draft === draft ? reviewed : null;
  const issues = parsed.success ? [] : parsed.error.issues;
  const nameFields = ['designSystemId', 'name', 'version', 'mode', 'constraints', 'codeCompatibility'];
  const nameIssues = issues.filter((issue) => nameFields.includes(String(issue.path[0])));
  const fileIssues = issues.filter((issue) => !nameFields.includes(String(issue.path[0])));

  function cancel() {
    epoch.current += 1; abort.current?.abort(); running.current = false; setBusy(false); callbacks.current.onBusyChange?.(false);
  }
  function update(change: Partial<LegacyDesignSystemMigrationPlan>) {
    cancel(); setReviewed(null); setError(''); setMessage(''); setDiagnostics([]); setDraft((previous) => ({ ...previous, ...change }));
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current += 1; abort.current?.abort(); running.current = false; callbacks.current.onBusyChange?.(false); };
  }, []);
  useEffect(() => {
    cancel(); setReviewed(null); setError(''); setDiagnostics([]);
    if (reviewRef.current && appliedRevision.current !== state?.revision) setMessage(t('designMigration.stale'));
  }, [state, sourceIdentity]);
  useEffect(() => {
    if (previousStep.current !== step) stepHeadings.current[step]?.focus();
    previousStep.current = step;
  }, [step]);

  async function perform(apply: boolean) {
    if (step !== 'review' || running.current || externalBusy || !state || !parsed.success || (apply && (viewerOnly || !validReview?.review.canApply))) return;
    const snapshot = latest.current; const token = ++epoch.current; const controller = new AbortController(); abort.current = controller;
    const current = () => mounted.current && epoch.current === token && latest.current.state === snapshot.state && latest.current.sourceIdentity === snapshot.sourceIdentity && latest.current.draft === snapshot.draft;
    running.current = true; setBusy(true); callbacks.current.onBusyChange?.(true); setError(''); setMessage(''); setDiagnostics([]);
    if (!apply) setReviewed(null);
    const authority = { ...scope, signal: controller.signal };
    try {
      if (apply && validReview) {
        const { review, plan } = validReview;
        const result = await applyProjectDesignRuntimeLegacyMigration(authority, { expectedRevision: state.revision, plan,
          reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, sourceDigest: review.sourceDigest });
        if (!current()) return;
        appliedRevision.current = result.state.revision;
        setReviewed(null); setMessage(t('designMigration.applied', { version: result.version.version })); callbacks.current.onState(result.state);
      } else {
        const plan = parsed.data;
        const result = await reviewProjectDesignRuntimeLegacyMigration(authority, { expectedRevision: state.revision, plan });
        if (!current()) return;
        if (result.revision !== state.revision || result.review.baseRevision !== state.revision || result.review.projectId !== scope.projectId) throw new Error(t('designMigration.invalidResponse'));
        setReviewed({ review: result.review, plan, state, sourceIdentity, draft });
      }
    } catch (cause) {
      if (!current()) return;
      setReviewed(null); setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError) {
        setDiagnostics(cause.diagnostics);
        if (cause.status === 409) {
          setMessage(t('designMigration.stale'));
          try {
            const refreshed = await getProjectDesignRuntime(authority);
            if (current()) callbacks.current.onState(refreshed.state);
          } catch { /* The original conflict remains actionable; a new review is required. */ }
        }
      }
    } finally {
      if (mounted.current && epoch.current === token) { running.current = false; setBusy(false); callbacks.current.onBusyChange?.(false); }
    }
  }

  return <section className={styles.panel} data-testid="design-runtime-legacy-migration">
    <header className={styles.heading}><h3>{t('designMigration.title')}</h3><p className={styles.muted}>{t('designMigration.description')}</p></header>
    <ol className={styles.progress} aria-label={t('designMigration.title')}>
      {migrationSteps.map((value, index) => <li key={value} className={styles.progressStep} data-testid={`legacy-step-indicator-${value}`} aria-current={step === value ? 'step' : undefined} data-complete={index < stepIndex}>
        <span className={styles.stepNumber} aria-hidden="true">{index + 1}</span>
        <span>{t(value === 'name' ? 'designWorkspace.migrationStepName' : value === 'files' ? 'designWorkspace.migrationStepFiles' : 'designWorkspace.migrationStepReview')}</span>
      </li>)}
    </ol>
    <section className={styles.step} data-testid="legacy-step-name" hidden={step !== 'name'} aria-labelledby={`${id}-name`}>
      <h4 id={`${id}-name`} tabIndex={-1} ref={(node) => { stepHeadings.current.name = node; }}>{t('designWorkspace.migrationDetails')}</h4>
      <fieldset disabled={locked} className={styles.sources}>
        <label className={styles.field}>{t('designVersions.name')}<Input data-testid="legacy-name" value={draft.name} onChange={(event) => update({ name: event.target.value })} /></label>
        <details className={styles.advanced} data-testid="legacy-advanced"><summary>{t('designWorkspace.advanced')}</summary>
          <div className={styles.fields}>
            <label className={styles.field}>{t('designRuntime.systemId')}<Input data-testid="legacy-system-id" value={draft.designSystemId} onChange={(event) => update({ designSystemId: event.target.value })} /></label>
            <label className={styles.field}>{t('designVersions.version')}<Input data-testid="legacy-version" value={draft.version} onChange={(event) => update({ version: event.target.value })} /></label>
            <label className={styles.field}>{t('designValidation.mode')}<Select data-testid="legacy-mode" value={draft.mode} onChange={(event) => update({ mode: event.target.value as 'explore' | 'guided' })}>
              <option value="explore">{t('designVersions.explore')}</option><option value="guided">{t('designVersions.guided')}</option>
            </Select></label>
          </div>
          <details><summary>{t('designMigration.constraints')}</summary><VersionConstraintFields value={draft.constraints} disabled={locked} onChange={(constraints) => update({ constraints })} /></details>
        </details>
      </fieldset>
      {nameIssues.length ? <p className={styles.error} role="alert">{nameIssues.map((issue) => issue.message).join(' ')}</p> : null}
    </section>
    <section className={styles.step} data-testid="legacy-step-files" hidden={step !== 'files'} aria-labelledby={`${id}-files`}>
    <h4 id={`${id}-files`} tabIndex={-1} ref={(node) => { stepHeadings.current.files = node; }}>{t('designWorkspace.migrationFiles')}</h4>
    <fieldset disabled={locked} className={styles.sources}>
      <p className={styles.muted}>{t('designMigration.sourcesHint')}</p>
      <div className={styles.sourceList}>{!paths.length ? <p>{t('designMigration.noFiles')}</p> : paths.map((name) => <label key={name} className={styles.source}>
        <Input type="checkbox" data-testid={`legacy-source-${name}`} checked={sourcePaths.includes(name)} disabled={requiredPaths.includes(name)} onChange={(event) => update({ sourcePaths: event.target.checked ? [...draft.sourcePaths, name] : draft.sourcePaths.filter((path) => path !== name) })} />
        <code>{name}</code>
      </label>)}</div>
      <label className={styles.field}>{t('designMigration.tokenStylesheet')}<Select data-testid="legacy-token-stylesheet" value={draft.tokenStylesheet ?? ''} onChange={(event) => update({ tokenStylesheet: event.target.value || undefined })}>
        <option value="">{t('designMigration.noStylesheet')}</option>{paths.filter((name) => /\.css$/i.test(name)).map((name) => <option key={name} value={name}>{name}</option>)}
      </Select></label>
    </fieldset>
    <details><summary>{t('designMigration.codeTitle')}</summary><p className={styles.muted}>{t('designMigration.codeHint')}</p>
      <fieldset disabled={locked} className={styles.sources}>
        <DesignRuntimeSourceSelections selections={draft.selections} files={paths} allowEmpty onChange={(selections) => update({ selections })} />
        <Button data-testid="legacy-add-component" onClick={() => {
          const identity = crypto.randomUUID();
          update({ selections: [...draft.selections, { sourcePath: '', exportName: '', framework: 'react', componentId: `component-${identity}`, codeComponentId: `code/${identity}` }] });
        }}>{t('designMigration.addComponent')}</Button>
      </fieldset>
    </details>
    {fileIssues.length && paths.length ? <p className={styles.error} role="alert">{fileIssues.map((issue) => issue.message).join(' ')}</p> : null}
    </section>
    <section className={styles.step} data-testid="legacy-step-review" hidden={step !== 'review'} aria-labelledby={`${id}-review`}>
    <h4 id={`${id}-review`} tabIndex={-1} ref={(node) => { stepHeadings.current.review = node; }}>{t('designWorkspace.migrationReview')}</h4>
    <p className={styles.muted}>{t('designMigration.readiness')}</p>
    {!parsed.success && sourcePaths.length ? <p className={styles.error} role="alert">{parsed.error.issues.map((issue) => issue.message).join(' ')}</p> : null}
    {viewerOnly ? <p className={styles.muted}>{t('designRuntime.readOnly')}</p> : null}
    {busy ? <p role="status">{t('common.loading')}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <StructureDiagnostics diagnostics={diagnostics} />
    {validReview ? <MigrationReview review={validReview.review} /> : null}
    </section>
    <footer className={styles.navigation}>
      <Button data-testid="legacy-back" variant="ghost" disabled={locked || stepIndex === 0} onClick={() => setStep(migrationSteps[stepIndex - 1]!)}>{t('designFiles.back')}</Button>
      {step !== 'review' ? <Button data-testid="legacy-continue" variant="primary" disabled={locked || (step === 'name' ? nameIssues.length > 0 : !parsed.success)} onClick={() => setStep(migrationSteps[stepIndex + 1]!)}>{t('questions.continue')}</Button> : <div className={styles.actions}>
        <Button data-testid="legacy-review" variant={validReview?.review.canApply ? 'default' : 'primary'} disabled={locked || !state || !parsed.success} onClick={() => void perform(false)}>{t('designMigration.review')}</Button>
        {validReview?.review.canApply ? <Button data-testid="legacy-apply" variant="primary" disabled={locked || viewerOnly} onClick={() => void perform(true)}>{t('designMigration.apply')}</Button> : null}
      </div>}
    </footer>
  </section>;
}

function MigrationReview({ review }: { review: LegacyDesignSystemMigrationReview }) {
  const t = useT();
  const converted = review.tokens.filter((record) => record.status === 'converted');
  const unresolved = review.tokens.filter((record) => record.status === 'unresolved');
  return <div className={styles.review} data-testid="legacy-review-result">
    <p role="status">{review.canApply ? t('designMigration.ready') : t('designMigration.blocked')}</p>
    <dl className={styles.counts}>
      <div><dt>{t('designMigration.converted')}</dt><dd data-testid="legacy-converted-count">{converted.length}</dd></div>
      <div><dt>{t('designMigration.unresolved')}</dt><dd data-testid="legacy-unresolved-count">{unresolved.length}</dd></div>
      <div><dt>{t('designMigration.compiled')}</dt><dd data-testid="legacy-compiled-count">{review.compiledComponentRefs.length}</dd></div>
      <div><dt>{t('designMigration.packaged')}</dt><dd>{review.preservedSourcePaths.length}</dd></div>
    </dl>
    {!review.compiledComponentRefs.length ? <p data-testid="legacy-token-foundation">{t('designMigration.tokenFoundation')}</p> : null}
    <StructureDiagnostics diagnostics={review.diagnostics} />
    {unresolved.length ? <section><h4>{t('designMigration.unresolved')}</h4><ul>{unresolved.map((record, index) => <li key={index}><code>{record.cssVariable}</code> = <code>{record.sourceValue}</code> · {record.reason}<br /><code>{record.sourcePath}:{record.line}</code></li>)}</ul></section> : null}
    <details data-testid="legacy-package-details"><summary>{t('designWorkspace.packageDetails')}</summary>
      <section><h4>{t('designMigration.packaged')}</h4><ul data-testid="legacy-packaged-sources">{review.files.map((file) => <li key={file.path}><code>{file.path}</code> · {file.byteLength} B</li>)}</ul></section>
      {review.candidate ? <DesignSystemVersionDetails value={review.candidate.package} /> : null}
      <details><summary>{t('designMigration.proof')}</summary><pre>{json({ reviewId: review.id, baseRevision: review.baseRevision, baseDigest: review.baseDigest, planDigest: review.planDigest, sourceDigest: review.sourceDigest, files: review.files })}</pre></details>
    </details>
  </div>;
}
