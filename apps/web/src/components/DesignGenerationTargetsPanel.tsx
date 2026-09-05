import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import { DesignGenerationTargetsSchema, type DesignGenerationTargets, type ProjectDesignRuntimeGenerationTargetsResponse, type ProjectDesignRuntimeState } from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { getProjectDesignRuntimeGenerationTargets, saveProjectDesignRuntimeGenerationTargets, ProjectDesignRuntimeError, type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
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
type Row = { key: string; sourcePath: string; exportName: string; screenId: string };
const rowsFrom = (targets: DesignGenerationTargets): Row[] => targets.outputs.map((output) => ({ key: crypto.randomUUID(), sourcePath: output.sourcePath, exportName: output.exportName ?? '', screenId: output.screenId ?? '' }));

export function DesignGenerationTargetsPanel(props: Props) {
  return <TargetsContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext), props.viewerOnly])} {...props} />;
}
function TargetsContent({ scope, state, files, viewerOnly, externalBusy = false, onState, onBusyChange }: Props) {
  const t = useT(); const id = useId();
  const [snapshot, setSnapshot] = useState<ProjectDesignRuntimeGenerationTargetsResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]); const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const dirtyRef = useRef(false); const mounted = useRef(false); const running = useRef(false); const generation = useRef(0); const abort = useRef<AbortController | null>(null);
  const snapshotRef = useRef(snapshot); const stateRevision = useRef(state?.revision);
  const disabled = busy || externalBusy; const stale = snapshot !== null && baseRevision !== snapshot.revision;
  function adopt(next: ProjectDesignRuntimeGenerationTargetsResponse, replace = false) {
    snapshotRef.current = next; setSnapshot(next);
    if (replace || !dirtyRef.current) { setRows(rowsFrom(next.targets)); setBaseRevision(next.revision); dirtyRef.current = false; setDirty(false); }
  }
  function edit(next: Row[]) { setRows(next); dirtyRef.current = true; setDirty(true); setMessage(''); }
  function change(index: number, patch: Partial<Row>) { edit(rows.map((row, at) => at === index ? { ...row, ...patch } : row)); }
  async function perform(action: (authority: ProjectDesignRuntimeScope, current: () => boolean) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); onBusyChange?.(true); setError(''); setMessage('');
    const ticket = ++generation.current; const controller = new AbortController(); abort.current = controller;
    const current = () => mounted.current && generation.current === ticket && !controller.signal.aborted;
    const authority = { ...scope, signal: controller.signal };
    try { await action(authority, current); }
    catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError && cause.status === 409) {
        setMessage(t('designGenerationTargets.conflict'));
        try { const fresh = await getProjectDesignRuntimeGenerationTargets(authority); if (current()) adopt(fresh); }
        catch (refreshError) { if (current()) setError(refreshError instanceof Error ? refreshError.message : String(refreshError)); }
      }
    } finally { if (current()) { running.current = false; setBusy(false); onBusyChange?.(false); } }
  }
  const refresh = () => perform(async (authority, current) => { const fresh = await getProjectDesignRuntimeGenerationTargets(authority); if (current()) adopt(fresh); });
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; generation.current++; abort.current?.abort(); running.current = false; onBusyChange?.(false); };
  }, []);
  useEffect(() => {
    if (stateRevision.current === state?.revision) return;
    stateRevision.current = state?.revision;
    if (state && snapshotRef.current?.revision === state.revision) return;
    generation.current++; abort.current?.abort(); running.current = false; setBusy(false); onBusyChange?.(false); void refresh();
  }, [state?.revision]);
  function save() {
    if (viewerOnly || disabled || stale || baseRevision === null) return;
    const parsed = DesignGenerationTargetsSchema.safeParse({ schemaVersion: 1, outputs: rows.map((row) => ({ sourcePath: row.sourcePath, ...(row.exportName ? { exportName: row.exportName } : {}), ...(row.screenId ? { screenId: row.screenId } : {}) })) });
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')); return; }
    void perform(async (authority, current) => {
      const response = await saveProjectDesignRuntimeGenerationTargets(authority, { expectedRevision: baseRevision, targets: parsed.data });
      if (!current()) return;
      adopt({ revision: response.state.revision, targets: response.state.generationTargets }, true); setMessage(t('designRuntime.saved')); onState(response.state);
    });
  }
  return <section className={styles.card} data-testid="generation-targets">
    <div className={styles.actions}><h3>{t('designGenerationTargets.title')}</h3><Button data-testid="generation-targets-refresh" disabled={disabled} onClick={() => void refresh()}>{t('designRuntime.refresh')}</Button></div>
    <p className={styles.muted}>{t('designGenerationTargets.description')}</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {message ? <p role="status" className={styles.notice}>{message}</p> : null}
    {dirty ? <p className={styles.notice}>{t('designGenerationTargets.dirty')}</p> : null}
    <datalist id={`${id}-paths`}>{[...new Set(files.map((file) => file.name))].sort().map((path) => <option key={path} value={path}/>)}</datalist>
    <datalist id={`${id}-screens`}>{state?.document?.screens.map((screen) => <option key={screen.id} value={screen.id}>{screen.name ?? screen.id}</option>)}</datalist>
    {rows.map((row, index) => <fieldset key={row.key} className={styles.output} disabled={viewerOnly || disabled || !snapshot}>
      <label className={styles.field}>{t('designRuntime.sourcePath')}<input data-testid={`generation-target-path-${index}`} list={`${id}-paths`} value={row.sourcePath} onChange={(event) => change(index, { sourcePath: event.target.value })}/></label>
      <label className={styles.field}>{t('designRuntime.exportName')}<input data-testid={`generation-target-export-${index}`} value={row.exportName} onChange={(event) => change(index, { exportName: event.target.value })}/></label>
      <label className={styles.field}>{t('designValidation.screen')}<input data-testid={`generation-target-screen-${index}`} list={`${id}-screens`} value={row.screenId} onChange={(event) => change(index, { screenId: event.target.value })}/></label>
      <Button data-testid={`generation-target-delete-${index}`} onClick={() => edit(rows.filter((_, at) => at !== index))}>{t('common.delete')}</Button>
    </fieldset>)}
    {stale ? <div className={styles.notice}><p>{t('designGenerationTargets.conflict')}</p><Button data-testid="generation-targets-rebase" disabled={viewerOnly || disabled} onClick={() => setBaseRevision(snapshot!.revision)}>{t('designValidation.rebase')}</Button></div> : null}
    <div className={styles.actions}>
      <Button data-testid="generation-targets-add" disabled={viewerOnly || disabled || !snapshot || rows.length >= 500} onClick={() => edit([...rows, { key: crypto.randomUUID(), sourcePath: '', exportName: '', screenId: '' }])}>{t('designValidation.addOutput')}</Button>
      <Button data-testid="generation-targets-save" disabled={viewerOnly || disabled || !snapshot || stale || !dirty} onClick={save}>{t('designGenerationTargets.save')}</Button>
      <Button disabled={disabled || !snapshot || !dirty} onClick={() => adopt(snapshot!, true)}>{t('projectStructure.discardEdits')}</Button>
    </div>
  </section>;
}
