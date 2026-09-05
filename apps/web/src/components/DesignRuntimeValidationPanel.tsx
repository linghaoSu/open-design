import { useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import {
  defaultProjectDesignValidationSettings, ProjectDesignRuntimeValidateArtifactsRequestSchema,
  type ProjectDesignValidationSettings, type ProjectDesignRuntimeState, type ProjectDesignRuntimeValidationSettingsResponse,
  type ProjectDesignRuntimeValidateArtifactsRequest, type ProjectDesignRuntimeValidateArtifactsResponse, type ValidationDiagnostic,
} from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { getProjectDesignRuntimeValidationSettings, saveProjectDesignRuntimeValidationSettings, validateProjectDesignRuntimeArtifacts,
  ProjectDesignRuntimeError, type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
import { DesignGenerationTargetsPanel } from './DesignGenerationTargetsPanel';
import { VersionConstraintFields } from './DesignSystemVersionDetails';
import styles from './DesignRuntimeValidationPanel.module.css';

interface Props {
  scope: ProjectDesignRuntimeScope;
  state: ProjectDesignRuntimeState | null;
  files: readonly { name: string }[];
  viewerOnly: boolean;
  externalBusy?: boolean;
  onState(state: ProjectDesignRuntimeState): void;
  onBusyChange?(busy: boolean): void;
}
type Source = ProjectDesignRuntimeValidateArtifactsRequest['sources'][number];
type Output = ProjectDesignRuntimeValidateArtifactsRequest['outputs'][number] & { key: string };
const languageFor = (path: string): Source['language'] => path.endsWith('.vue') ? 'vue' : /\.html?$/.test(path) ? 'html' : path.endsWith('.css') ? 'css' : 'tsx';
const outputFor = (source: Source): Output => ({ key: crypto.randomUUID(), sourcePath: source.sourcePath, ...(source.language === 'html' ? {} : { exportName: source.language === 'vue' ? 'default' : 'Screen' }) });

export function DesignRuntimeValidationPanel(props: Props) {
  return <ValidationContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext)])} {...props} />;
}
function ValidationContent({ scope, state, files, viewerOnly, externalBusy = false, onState, onBusyChange }: Props) {
  const t = useT();
  const [targetsOpened, setTargetsOpened] = useState(false);
  const [targetsBusy, setTargetsBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<ProjectDesignRuntimeValidationSettingsResponse | null>(null);
  const [draft, setDraft] = useState<ProjectDesignValidationSettings>(defaultProjectDesignValidationSettings);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);
  const [outputs, setOutputs] = useState<Output[]>([]);
  const [result, setResult] = useState<ProjectDesignRuntimeValidateArtifactsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [failureDiagnostics, setFailureDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const mounted = useRef(false); const running = useRef(false); const generation = useRef(0);
  const abort = useRef<AbortController | null>(null); const dirtyRef = useRef(false); const dirtyFields = useRef(new Set<'mode' | 'policy'>());
  const snapshotRef = useRef(snapshot);
  const locked = !!snapshot?.lock.dependencies.length;
  const staleDraft = baseRevision !== null && snapshot !== null && baseRevision !== snapshot.revision;
  const staleResult = !!result && (result.revision !== snapshot?.revision || !!state && result.revision !== state.revision);
  const disabled = busy || externalBusy || targetsBusy;
  const paths = [...new Set([...files.map((file) => file.name).filter((path) => /\.(?:tsx?|jsx?|vue|html?|css)$/.test(path) && !path.endsWith('.d.ts')), ...sources.map((source) => source.sourcePath)])].sort();
  const outputSources = sources.filter((source) => source.language !== 'css');

  function adopt(next: ProjectDesignRuntimeValidationSettingsResponse, replace = false) {
    snapshotRef.current = next; setSnapshot(next);
    if (replace || !dirtyRef.current) { setDraft(next.settings); setBaseRevision(next.revision); dirtyRef.current = false; dirtyFields.current.clear(); setDirty(false); }
    else setDraft((current) => ({ ...next.settings, ...(dirtyFields.current.has('mode') ? { mode: current.mode } : {}), ...(dirtyFields.current.has('policy') ? { projectConstraints: current.projectConstraints } : {}) }));
  }
  function edit(next: ProjectDesignValidationSettings, field: 'mode' | 'policy') { dirtyFields.current.add(field); setDraft(next); dirtyRef.current = true; setDirty(true); setMessage(''); }
  async function perform(action: (authority: ProjectDesignRuntimeScope, current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); onBusyChange?.(true); setError(''); setMessage(''); setFailureDiagnostics([]);
    const ticket = ++generation.current; const controller = new AbortController(); abort.current = controller;
    const current = () => mounted.current && generation.current === ticket && !controller.signal.aborted;
    const authority = { ...scope, signal: controller.signal };
    try { await action(authority, current); }
    catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError) {
        setFailureDiagnostics(cause.diagnostics);
        if (cause.status === 409) {
          setMessage(t('designValidation.settingsConflict'));
          try { const fresh = await getProjectDesignRuntimeValidationSettings(authority); if (current()) adopt(fresh); }
          catch (refreshError) { if (current()) setError(refreshError instanceof Error ? refreshError.message : String(refreshError)); }
        }
      }
    } finally { if (current()) { running.current = false; setBusy(false); onBusyChange?.(false); } }
  }
  const refresh = () => perform(async (authority, current) => { const next = await getProjectDesignRuntimeValidationSettings(authority); if (current()) adopt(next); });
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; generation.current++; abort.current?.abort(); running.current = false; onBusyChange?.(false); };
    // Scope changes remount this component, including account generation changes.
  }, []);
  useEffect(() => { if (state && snapshotRef.current && state.revision !== snapshotRef.current.revision && !running.current) void refresh(); }, [state?.revision]);

  function toggleSource(path: string) {
    setResult(null);
    if (sources.some((source) => source.sourcePath === path)) { setSources(sources.filter((source) => source.sourcePath !== path)); return; }
    const source = { sourcePath: path, language: languageFor(path) };
    setSources([...sources, source]); if (!outputs.length && source.language !== 'css') setOutputs([outputFor(source)]);
  }
  function changeOutput(index: number, patch: Partial<Output>) { setOutputs(outputs.map((output, at) => at === index ? { ...output, ...patch } : output)); setResult(null); }
  function save() {
    if (baseRevision === null || viewerOnly) return;
    void perform(async (authority, current) => {
      const response = await saveProjectDesignRuntimeValidationSettings(authority, { expectedRevision: baseRevision, settings: draft });
      if (!current()) return;
      dirtyRef.current = false; setDirty(false); setBaseRevision(response.state.revision); onState(response.state);
      const fresh = await getProjectDesignRuntimeValidationSettings(authority);
      if (current()) { adopt(fresh, true); setMessage(t('designRuntime.saved')); }
    });
  }
  function validate() {
    if (!snapshot) return;
    const parsed = ProjectDesignRuntimeValidateArtifactsRequestSchema.safeParse({ expectedRevision: snapshot.revision, sources,
      outputs: outputs.map(({ key: _key, ...output }) => ({ ...output, ...(output.exportName ? {} : { exportName: undefined }), ...(output.screenId ? {} : { screenId: undefined }) })) });
    if (!parsed.success) { setError(`${t('designValidation.noSources')} ${parsed.error.issues.map((issue) => issue.message).join(' ')}`); return; }
    void perform(async (authority, current) => { const response = await validateProjectDesignRuntimeArtifacts(authority, parsed.data); if (current()) setResult(response); });
  }
  return <section className={styles.panel}>
    <Button data-testid="generation-targets-open" disabled={disabled} aria-expanded={targetsOpened} onClick={() => setTargetsOpened(!targetsOpened)}>{t('designGenerationTargets.title')}</Button>
    {targetsOpened ? <DesignGenerationTargetsPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} externalBusy={busy || externalBusy} onState={onState} onBusyChange={(value) => { setTargetsBusy(value); onBusyChange?.(value); }} /> : null}
    <div className={styles.actions}><p>{t('designValidation.description')}</p><Button data-testid="validation-refresh" disabled={disabled} onClick={() => void refresh()}>{t('designRuntime.refresh')}</Button></div>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {message ? <p role="status" className={styles.notice}>{message}</p> : null}
    <ValidationDiagnostics diagnostics={failureDiagnostics} />
    <div className={styles.columns}>
      <section className={styles.card}>
        <label className={styles.field}>{t('designValidation.mode')}<select data-testid="validation-mode" value={draft.mode} disabled={viewerOnly || disabled || !snapshot} onChange={(event) => edit({ ...draft, mode: event.target.value as ProjectDesignValidationSettings['mode'] }, 'mode')}>
          {(['explore', 'guided', 'strict'] as const).map((mode) => <option key={mode} value={mode}>{t(`designVersions.${mode}`)}</option>)}
        </select></label>
        <p className={styles.muted}>{t('designValidation.modeHint')}</p>
        {dirty ? <p className={styles.notice}>{t('designValidation.dirtyHint')}</p> : null}
        {snapshot?.effectiveConstraints === null ? <p className={styles.notice}>{t('designValidation.recoveryHint')}</p> : null}
        <ValidationDiagnostics diagnostics={snapshot?.diagnostics ?? []} />
        <p>{t('designValidation.effectivePolicy')}: <strong>{snapshot?.effectiveConstraints?.source === 'locked' ? t('designValidation.lockedPolicy') : snapshot?.effectiveConstraints ? t('designValidation.projectPolicy') : t('common.none')}</strong></p>
        {snapshot?.lock.dependencies.map((entry) => <p key={entry.designSystemId}><code>{entry.designSystemId}@{entry.version}</code><br/><code>{entry.digest}</code></p>)}
        {locked ? <p className={styles.muted}>{t('designValidation.lockedHint')}</p> : null}
        <details><summary>{t('designVersions.constraints')}</summary>
          <VersionConstraintFields value={locked ? snapshot?.effectiveConstraints?.constraints ?? draft.projectConstraints : draft.projectConstraints} disabled={viewerOnly || disabled || !snapshot || locked} {...(locked ? {} : { onChange: (value: ProjectDesignValidationSettings['projectConstraints']) => edit({ ...draft, projectConstraints: value }, 'policy') })} />
        </details>
        {staleDraft ? <div className={styles.notice}><p>{t('designValidation.settingsConflict')}</p><Button data-testid="validation-rebase" disabled={disabled || viewerOnly} onClick={() => setBaseRevision(snapshot!.revision)}>{t('designValidation.rebase')}</Button></div> : null}
        <div className={styles.actions}>
          <Button data-testid="validation-save-settings" disabled={viewerOnly || disabled || !snapshot || staleDraft || !dirty} onClick={save}>{t('designValidation.saveSettings')}</Button>
          <Button disabled={disabled || !snapshot || !dirty} onClick={() => adopt(snapshot!, true)}>{t('projectStructure.discardEdits')}</Button>
        </div>
      </section>
      <section className={styles.card}>
        <h3>{t('designRuntime.sources')}</h3><p className={styles.muted}>{t('designValidation.sourceHint')}</p>
        <fieldset disabled={disabled || !snapshot} className={styles.sources}>{paths.map((path) => <div key={path}><label><input type="checkbox" data-testid={`validation-source-${path}`} checked={sources.some((source) => source.sourcePath === path)} onChange={() => toggleSource(path)} /><code>{path}</code></label>
          {sources.some((source) => source.sourcePath === path) ? <select aria-label={`${t('designRuntime.framework')}: ${path}`} value={sources.find((source) => source.sourcePath === path)!.language} onChange={(event) => { setSources(sources.map((source) => source.sourcePath === path ? { ...source, language: event.target.value as Source['language'] } : source)); setResult(null); }}>
            {(['tsx', 'vue', 'html', 'css'] as const).map((language) => <option key={language} value={language}>{language.toUpperCase()}</option>)}
          </select> : null}</div>)}</fieldset>
        <h3>{t('designValidation.outputs')}</h3>
        {outputs.map((output, index) => <fieldset key={output.key} className={styles.output} disabled={disabled || !snapshot}>
          <label className={styles.field}>{t('designRuntime.sourcePath')}<select data-testid={`validation-output-path-${index}`} value={output.sourcePath} onChange={(event) => {
            const source = outputSources.find((entry) => entry.sourcePath === event.target.value)!;
            const next = outputFor(source); changeOutput(index, { sourcePath: next.sourcePath, exportName: next.exportName ?? '' });
          }}>{!outputSources.some((source) => source.sourcePath === output.sourcePath) ? <option value={output.sourcePath}>{output.sourcePath}</option> : null}{outputSources.map((source) => <option key={source.sourcePath} value={source.sourcePath}>{source.sourcePath}</option>)}</select></label>
          <label className={styles.field}>{t('designRuntime.exportName')}<input data-testid={`validation-output-export-${index}`} value={output.exportName ?? ''} onChange={(event) => changeOutput(index, { exportName: event.target.value })} /></label>
          <label className={styles.field}>{t('designValidation.screen')}<select data-testid={`validation-output-screen-${index}`} value={output.screenId ?? ''} onChange={(event) => changeOutput(index, { screenId: event.target.value })}><option value="">{t('designValidation.unmapped')}</option>{state?.document?.screens.map((screen) => <option key={screen.id} value={screen.id}>{screen.name ?? screen.id}</option>)}</select></label>
          <Button onClick={() => { setOutputs(outputs.filter((_, at) => index !== at)); setResult(null); }}>{t('common.delete')}</Button>
        </fieldset>)}
        <div className={styles.actions}><Button data-testid="validation-add-output" disabled={disabled || !outputSources.length} onClick={() => { setOutputs([...outputs, outputFor(outputSources[0]!)]); setResult(null); }}>{t('designValidation.addOutput')}</Button>
          <Button data-testid="validation-run" variant="primary" disabled={disabled || !snapshot || !sources.length || !outputs.length} onClick={validate}>{t('designValidation.run')}</Button></div>
      </section>
    </div>
    {result ? <section className={styles.card} data-testid="validation-result">
      {staleResult ? <p className={styles.notice}>{t('designValidation.staleResult')}</p> : null}
      <h3>{result.result.accepted ? t('designValidation.accepted') : t('designValidation.rejected')}</h3>
      <p>{t('designRuntime.revision', { revision: result.revision })} · {t(`designVersions.${result.result.mode}`)} · {result.result.policySource === 'locked' ? t('designValidation.lockedPolicy') : t('designValidation.projectPolicy')}</p>
      <strong data-testid="validation-strict-ready">{result.result.strictReady ? t('designValidation.strictReady') : t('designValidation.notReady')}</strong>
      <h4>{t('designValidation.coverage')}</h4><ul className={styles.coverage}>{Object.entries(result.result.coverage).map(([key, complete]) => <li key={key}>{complete ? '✓' : '—'} {t(`designValidation.${key as keyof typeof result.result.coverage}`)}</li>)}</ul>
      <h4>{t('designValidation.metrics')}</h4><dl className={styles.metrics}>
        {(['componentReuse', 'bindingReuse'] as const).map((key) => <div key={key}><dt>{t(`designValidation.${key}`)}</dt><dd>{result.result.metrics[key].reused}/{result.result.metrics[key].total} · {result.result.metrics[key].rate === null ? t('common.none') : `${Math.round(result.result.metrics[key].rate * 100)}%`}</dd></div>)}
        <div><dt>{t('designValidation.semanticReuse')}</dt><dd>{result.result.semanticReuse.reused}/{result.result.semanticReuse.total}</dd></div>
        {(['unknownComponents', 'unknownTokens', 'rawColors', 'rawSpacing', 'rawRadius', 'intrinsicControls', 'duplicateControls', 'duplicateStructures', 'unsupported', 'unresolvedImports'] as const).map((key) => <div key={key}><dt>{key === 'unknownComponents' || key === 'rawColors' || key === 'rawSpacing' || key === 'rawRadius' ? t(`designVersions.${key}`) : key === 'unknownTokens' ? t('designVersions.undeclaredTokens') : t(`designValidation.${key}`)}</dt><dd>{result.result.metrics[key]}</dd></div>)}
      </dl><ValidationDiagnostics diagnostics={result.result.diagnostics} />
    </section> : null}
  </section>;
}

function ValidationDiagnostics({ diagnostics }: { diagnostics: readonly ValidationDiagnostic[] }) {
  const t = useT();
  return diagnostics.length ? <ul className={styles.diagnostics} aria-label={t('designRuntime.diagnostics')}>{diagnostics.map((issue, index) => <li key={index}><strong>{issue.code}</strong> · {issue.severity === 'info' ? null : <>{t(`designVersions.${issue.severity}`)} · </>} {issue.message}
    {issue.location ? <code>{issue.location.sourcePath}:{issue.location.line}:{issue.location.column}</code> : null}
    {issue.nodeId || issue.path ? <code>{[issue.nodeId, issue.path?.join(' → ')].filter(Boolean).join(' · ')}</code> : null}
  </li>)}</ul> : null;
}
