import { useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import { DesignSystemMigrationPlanSchema, type ComponentReferenceOwner, type DesignSystemMigrationPlan,
  type DesignSystemUpgradeReview, type ProjectDesignRuntimeState, type ProjectDesignRuntimeVersionSummary,
  type ValidationDiagnostic } from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { applyProjectDesignRuntimeUpgrade, reviewProjectDesignRuntimeUpgrade, ProjectDesignRuntimeError,
  type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
import { DesignRuntimeMigrationRecipes } from './DesignRuntimeMigrationRecipes';
import type { DesignPreviewSelection } from './DesignPreviewPanel';
import { StructureDiagnostics } from './ProjectStructureReview';
import styles from './DesignRuntimeUpgrades.module.css';

const copyKeys = ["title", "hint", "target", "choose", "range", "editor", "editorHint", "vocabulary", "review", "apply", "noLock", "noTargets", "staleCatalog", "invalid", "ready", "blocked", "applied", "current", "proposed", "planDiagnostics", "none", "diff", "breaking", "screens", "usages", "overrides", "bindings", "code", "coverage", "documents", "proof", "loading", "source", "readOnly"] as const;
type DesignRuntimeUpgradeCopy = Record<(typeof copyKeys)[number], string>;
interface Props {
  scope: ProjectDesignRuntimeScope;
  state: ProjectDesignRuntimeState | null;
  catalog: readonly ProjectDesignRuntimeVersionSummary[];
  catalogRevision: number | null;
  viewerOnly: boolean;
  externalBusy?: boolean;
  onState(state: ProjectDesignRuntimeState): void;
  onBusyChange?(busy: boolean): void;
  onPreview?(selection: DesignPreviewSelection): void;
}
const emptyEditor = JSON.stringify({ rules: [], bindingDecisions: [] }, null, 2);
const editorSchema = DesignSystemMigrationPlanSchema.innerType().pick({ rules: true, bindingDecisions: true });
const versionKey = (entry: ProjectDesignRuntimeVersionSummary) => JSON.stringify([entry.id, entry.version, entry.digest, entry.sourceDigest]);
const ownerLabel = (owner: ComponentReferenceOwner) => owner.kind === 'component' ? owner.componentRef : `${owner.documentId} / ${owner.screenId}`;
const json = (value: unknown) => JSON.stringify(value, null, 2);
const examples = json({ rules: [
  { id: 'variant', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'appearance', valueMap: [{ from: 'primary', to: 'ghost' }] },
  { id: 'remove-prop', type: 'drop-prop', componentRef: 'ds:acme/Button', prop: 'obsolete' },
  { id: 'replace', type: 'replace-component', fromRef: 'ds:acme/Button', toRef: 'ds:acme/Action' },
  { id: 'rename-slot', type: 'rename-slot', componentRef: 'ds:acme/Button', fromSlot: 'header', toSlot: 'caption' },
  { id: 'remove-slot', type: 'drop-slot', componentRef: 'ds:acme/Button', slot: 'body', children: 'delete' },
], bindingDecisions: [
  { type: 'revalidate', bindingId: 'binding/Button' },
  { type: 'use-target-package', bindingId: 'binding/Action', targetBindingId: 'binding/Action' },
  { type: 'unbind', bindingId: 'binding/Old' },
] });

export function DesignRuntimeUpgrades(props: Props) {
  return <UpgradeContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext), props.viewerOnly])} {...props} />;
}
function UpgradeContent({ scope, state, catalog, catalogRevision, viewerOnly, externalBusy = false, onState, onBusyChange, onPreview }: Props) {
  const t = useT();
  const copy = Object.fromEntries(copyKeys.map((key) => [key, t(`designUpgrade.${key}`)])) as DesignRuntimeUpgradeCopy;
  const [selected, setSelected] = useState(''); const [range, setRange] = useState(''); const [editor, setEditor] = useState(emptyEditor);
  const [reviewed, setReviewed] = useState<{ review: DesignSystemUpgradeReview; state: ProjectDesignRuntimeState; catalog: readonly ProjectDesignRuntimeVersionSummary[]; editor: string; range: string; selected: string } | null>(null);
  const [recipeBusy, setRecipeBusy] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const mounted = useRef(false); const epoch = useRef(0); const running = useRef(false); const abort = useRef<AbortController | null>(null);
  const callbacks = useRef({ onState, onBusyChange }); callbacks.current = { onState, onBusyChange };
  const latest = useRef({ state, catalog, catalogRevision, editor, range, selected }); latest.current = { state, catalog, catalogRevision, editor, range, selected };
  const active = state?.lock.dependencies[0];
  const targets = catalog.filter((entry) => entry.id === active?.designSystemId && entry.version !== active.version);
  const target = targets.find((entry) => versionKey(entry) === selected);
  const staleCatalog = state !== null && catalogRevision !== state.revision;
  let plan: DesignSystemMigrationPlan | null = null; let invalid = '';
  if (active && target) {
    try {
      const choices = editorSchema.parse(JSON.parse(editor));
      plan = DesignSystemMigrationPlanSchema.parse({ schemaVersion: 1, id: 'reviewed-upgrade', from: active,
        to: { designSystemId: target.id, version: target.version, digest: target.digest, source: { type: 'bundle', digest: target.sourceDigest } },
        targetRange: range, ...choices });
    } catch (cause) { invalid = `${copy.invalid} ${cause instanceof Error ? cause.message : String(cause)}`; }
  }
  const validReview = reviewed && reviewed.state === state && reviewed.catalog === catalog && reviewed.editor === editor && reviewed.range === range && reviewed.selected === selected && !staleCatalog ? reviewed.review : null;
  const locked = busy || externalBusy || recipeBusy;
  function invalidate() { setReviewed(null); setError(''); setDiagnostics([]); setMessage(''); }
  function cancel() { epoch.current += 1; abort.current?.abort(); running.current = false; setBusy(false); callbacks.current.onBusyChange?.(false); }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current += 1; abort.current?.abort(); running.current = false; callbacks.current.onBusyChange?.(false); };
  }, []);
  useEffect(() => { cancel(); invalidate(); }, [state, catalog, catalogRevision]);

  async function perform(apply: boolean) {
    if (running.current || externalBusy || recipeBusy || !plan || !state || staleCatalog || (apply && (viewerOnly || !validReview?.canApply))) return;
    const snapshot = latest.current; const token = ++epoch.current; const controller = new AbortController(); abort.current = controller;
    const current = () => mounted.current && epoch.current === token && Object.entries(snapshot).every(([key, value]) => Reflect.get(latest.current, key) === value);
    running.current = true; setBusy(true); callbacks.current.onBusyChange?.(true); setError(''); setMessage(''); setDiagnostics([]);
    if (!apply) setReviewed(null);
    try {
      const authority = { ...scope, signal: controller.signal };
      if (apply && validReview) {
        const result = await applyProjectDesignRuntimeUpgrade(authority, { expectedRevision: state.revision,
          plan: validReview.plan, reviewId: validReview.id, baseDigest: validReview.baseDigest, planDigest: validReview.planDigest });
        if (!current()) return;
        setReviewed(null); setMessage(copy.applied); callbacks.current.onState(result.state);
      } else {
        const result = await reviewProjectDesignRuntimeUpgrade(authority, { expectedRevision: state.revision, plan });
        if (!current()) return;
        if (result.revision !== state.revision || result.review.projectId !== state.codeIndex.id || json(result.review.plan) !== json(plan)) throw new Error(copy.staleCatalog);
        setReviewed({ review: result.review, state, catalog, editor, range, selected });
      }
    } catch (cause) {
      if (!current()) return;
      setReviewed(null); setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError) setDiagnostics(cause.diagnostics);
    } finally { if (mounted.current && epoch.current === token) { running.current = false; setBusy(false); callbacks.current.onBusyChange?.(false); } }
  }

  return <section className={styles.panel} data-testid="design-runtime-upgrades">
    <h3>{copy.title}</h3><p className={styles.muted}>{copy.hint}</p>
    {!active ? <p>{copy.noLock}</p> : <>
      <p>{copy.source}: <code>{active.designSystemId}@{active.version}</code></p>
      {!targets.length ? <p>{copy.noTargets}</p> : null}
      {staleCatalog ? <p role="status">{copy.staleCatalog}</p> : null}
      <label className={styles.field}>{copy.target}<select data-testid="upgrade-target" disabled={locked || !targets.length} value={selected} onChange={(event) => {
        invalidate(); setSelected(event.target.value); const next = targets.find((entry) => versionKey(entry) === event.target.value); setRange(next?.version ?? '');
      }}><option value="">{copy.choose}</option>{targets.map((entry) => <option key={versionKey(entry)} value={versionKey(entry)}>{entry.name} · {entry.version}</option>)}</select></label>
      <label className={styles.field}>{copy.range}<input data-testid="upgrade-range" disabled={locked || !target} value={range} onChange={(event) => { invalidate(); setRange(event.target.value); }} /></label>
      {state && target ? <DesignRuntimeMigrationRecipes scope={scope} state={state} target={target} targetRange={range} disabled={busy || externalBusy || staleCatalog}
        onBusyChange={(next) => { setRecipeBusy(next); callbacks.current.onBusyChange?.(next); }} onSelectionChange={invalidate}
        onPlan={(next) => { invalidate(); setRange(next.targetRange); setEditor(json({ rules: next.rules, bindingDecisions: next.bindingDecisions })); }} /> : null}
      <label className={styles.field}>{copy.editor}<textarea data-testid="upgrade-editor" spellCheck={false} rows={10} disabled={locked || !target} value={editor} onChange={(event) => { invalidate(); setEditor(event.target.value); }} /></label>
      <p className={styles.muted}>{copy.editorHint}</p>
      <details><summary>{copy.vocabulary}</summary><pre>{examples}</pre></details>
      {invalid ? <p className={styles.error} role="alert">{invalid}</p> : null}
      {viewerOnly ? <p className={styles.muted}>{copy.readOnly}</p> : null}
      <div className={styles.actions}>
        <Button data-testid="upgrade-review" disabled={locked || !plan || staleCatalog} onClick={() => void perform(false)}>{copy.review}</Button>
        <Button data-testid="upgrade-apply" variant="primary" disabled={locked || viewerOnly || !validReview?.canApply} onClick={() => void perform(true)}>{copy.apply}</Button>
        {onPreview ? <Button data-testid="upgrade-preview" disabled={locked || !validReview} onClick={() => { if (validReview) onPreview({ id: crypto.randomUUID(), comparison: { type: 'upgrade', proof: { plan: validReview.plan, reviewId: validReview.id, baseDigest: validReview.baseDigest, planDigest: validReview.planDigest } }, screenIds: validReview.affectedScreens.length ? validReview.affectedScreens.map((screen) => screen.screenId) : state?.document?.screens.slice(0, 6).map((screen) => screen.id) ?? [] }); }}>{t('designPreview.open')}</Button> : null}
      </div>
    </>}
    {busy ? <p role="status">{copy.loading}</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <StructureDiagnostics diagnostics={diagnostics} />
    {validReview ? <UpgradeReview review={validReview} state={state} copy={copy} /> : null}
  </section>;
}

function UpgradeReview({ review, state, copy }: { review: DesignSystemUpgradeReview; state: ProjectDesignRuntimeState | null; copy: DesignRuntimeUpgradeCopy }) {
  const changeLabel = (change: DesignSystemUpgradeReview['diff']['changes'][number]) => {
    const entity = change.entity;
    const name = entity.kind === 'component' ? state?.registry?.components.find((entry) => entry.id === entity.id)?.name
      : entity.kind === 'code-component' ? state?.codeIndex.components.find((entry) => entry.id === entity.id)?.name : undefined;
    const identity = entity.kind === 'source' ? entity.path : 'id' in entity ? `${entity.kind} · ${entity.id}`
      : entity.kind === 'constraint' ? `${entity.kind} · ${entity.mode}` : `${entity.kind} · ${entity.packageName}`;
    return [name ?? identity, change.path.join('.')].filter(Boolean).join(' · ');
  };
  const screenName = (owner: Extract<ComponentReferenceOwner, { kind: 'screen' }>) => {
    const document = [review.proposed.document, review.current.document].find((entry) => entry?.id === owner.documentId && entry.screens.some((screen) => screen.id === owner.screenId));
    return document?.screens.find((screen) => screen.id === owner.screenId)?.name ?? owner.screenId;
  };
  const diagnostics = (title: string, values: ValidationDiagnostic[]) => <section><h4>{title}</h4>{values.length ? <StructureDiagnostics diagnostics={values} /> : <p className={styles.muted}>{copy.none}</p>}</section>;
  return <div className={styles.review} data-testid="upgrade-impact">
    <p role="status">{review.canApply ? copy.ready : copy.blocked}</p>
    <section><h4>{copy.diff}</h4>{review.diff.changes.length ? <ul>{review.diff.changes.map((change) => <li key={change.id}>
      {change.breaking ? <strong className={styles.breaking}>{copy.breaking} · </strong> : null}<strong>{changeLabel(change)}</strong> — {change.reason}
      <details><summary>{change.kind}</summary><code>{json(change.entity)}</code><div className={styles.columns}><pre>{json(change.before)}</pre><pre>{json(change.after)}</pre></div></details>
    </li>)}</ul> : <p className={styles.muted}>{copy.none}</p>}</section>
    <div className={styles.columns}>{diagnostics(copy.current, review.current.diagnostics)}{diagnostics(copy.proposed, review.proposed.diagnostics)}</div>
    {diagnostics(copy.planDiagnostics, review.diagnostics)}
    <section data-testid="upgrade-affected-screens"><h4>{copy.screens} ({review.affectedScreens.length})</h4><ul>{review.affectedScreens.map((owner) => <li key={json(owner)}><strong>{screenName(owner)}</strong> <code>{ownerLabel(owner)}</code></li>)}</ul></section>
    <section><h4>{copy.usages} ({review.affectedUsages.length})</h4><ul>{review.affectedUsages.map((usage, index) => <li key={index}><code>{ownerLabel(usage.owner)} · {usage.nodeId} → {usage.target}</code></li>)}</ul></section>
    {review.invalidOverrides.length ? <section><h4>{copy.overrides}</h4>{review.invalidOverrides.map((entry, index) => <div key={index}><code>{ownerLabel(entry.owner)} · {entry.nodeId} · {entry.property}</code><StructureDiagnostics diagnostics={entry.diagnostics} /></div>)}</section> : null}
    <section><h4>{copy.bindings}</h4>{review.bindingTransitions.length ? review.bindingTransitions.map((entry) => <details key={entry.bindingId}><summary>{entry.bindingId}</summary><div className={styles.columns}><pre>{json(entry.before)}</pre><pre>{json(entry.after)}</pre></div></details>) : <p className={styles.muted}>{copy.none}</p>}</section>
    <section><h4>{copy.code}</h4><p className={styles.muted}>{copy.coverage}</p><ul>{review.codeImpact.bindings.map((binding) => <li key={json(binding)}><code>{binding.id} · {binding.componentRef} · {binding.status}</code></li>)}</ul><ul>{review.codeImpact.sourceFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul></section>
    <details><summary>{copy.documents}</summary><div className={styles.columns}><pre>{json(review.current.document)}</pre><pre>{json(review.proposed.document)}</pre></div></details>
    <details><summary>{copy.proof}</summary><pre>{json({ reviewId: review.id, baseRevision: review.baseRevision, baseDigest: review.baseDigest, planDigest: review.planDigest, from: review.plan.from, to: review.plan.to })}</pre></details>
  </div>;
}
