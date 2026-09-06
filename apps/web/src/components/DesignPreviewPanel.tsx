import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Select } from '@open-design/components';
import type { DesignPreviewBundle, DesignPreviewComparison, DesignPreviewKind, ProjectDesignPreviewResult, ProjectDesignRuntimeState } from '@open-design/contracts';
import { createProjectDesignRuntimePreview, ProjectDesignRuntimeError, type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { StructureDiagnostics } from './ProjectStructureReview';
import { useT } from '../i18n';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { DESIGN_PREVIEW_CHANNEL, designPreviewFrameDocument, type DesignPreviewRenderStatus } from './design-preview-frame';
import styles from './DesignPreviewPanel.module.css';

export interface DesignPreviewSelection { id: string; comparison: DesignPreviewComparison; screenIds: string[] }
interface Props {
  scope: ProjectDesignRuntimeScope; state: ProjectDesignRuntimeState; selection?: DesignPreviewSelection | undefined;
  externalBusy?: boolean | undefined; sourceIdentity?: unknown; onBusyChange?(busy: boolean): void;
  onOpenStructure?(): void;
}

function RuntimeFrame({ bundle, role, screenId }: { bundle: DesignPreviewBundle; role: string; screenId: string }) {
  const t = useT(); const ref = useRef<HTMLIFrameElement>(null);
  const nonce = useMemo(() => crypto.randomUUID(), [bundle.digest]);
  const srcDoc = useMemo(() => designPreviewFrameDocument(bundle, nonce), [bundle, nonce]);
  const [status, setStatus] = useState<DesignPreviewRenderStatus>('loading'); const [error, setError] = useState('');
  useEffect(() => {
    setStatus('loading'); setError('');
    const timer = setTimeout(() => { setStatus((old) => old === 'rendered' || old === 'error' ? old : 'error'); setError((old) => old || t('designPreview.timeout')); }, 15000);
    const receive = (event: MessageEvent) => {
      const value: unknown = event.data;
      if (event.source !== ref.current?.contentWindow || event.origin !== 'null' || !value || typeof value !== 'object') return;
      const message = value as Record<string, unknown>;
      if (message.channel !== DESIGN_PREVIEW_CHANNEL || message.nonce !== nonce || message.status !== 'rendered' && message.status !== 'error') return;
      clearTimeout(timer);
      if (message.status === 'error') { setStatus('error'); setError(typeof message.message === 'string' ? message.message.slice(0, 2000) : t('designPreview.runtimeError')); }
      else setStatus((old) => old === 'error' ? old : 'rendered');
    };
    window.addEventListener('message', receive); return () => { clearTimeout(timer); window.removeEventListener('message', receive); };
  }, [nonce, t]);
  return <div className={styles.preview}>
    <p role="status" data-testid={`design-preview-status-${role}-${screenId}`} data-status={status}>{t(`designPreview.${status}`)}</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <iframe ref={ref} className={styles.frame} title={`${role}: ${screenId}`} data-testid={`design-preview-frame-${role}-${screenId}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} />
  </div>;
}

export function DesignPreviewPanel(props: Props) {
  return <PreviewContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext), props.selection?.id])} {...props} />;
}
function PreviewContent({ scope, state, selection, externalBusy = false, sourceIdentity, onBusyChange, onOpenStructure }: Props) {
  const t = useT(); const [kind, setKind] = useState<DesignPreviewKind>('semantic-design'); const [framework, setFramework] = useState<'react' | 'vue'>('react');
  const [comparison, setComparison] = useState(selection?.comparison);
  const [screenIds, setScreenIds] = useState(() => selection?.screenIds.slice(0, 6) ?? state.document?.screens.slice(0, 6).map((screen) => screen.id) ?? []);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<ProjectDesignPreviewResult | null>(null);
  const pending = useRef(false); const mounted = useRef(true); const epoch = useRef(0); const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current++; controller.current?.abort(); busyCallback.current?.(false); }; }, []);
  const formKey = JSON.stringify([kind, framework, comparison, screenIds]); const currentKey = useRef(formKey); currentKey.current = formKey;
  const currentState = useRef(state); currentState.current = state;
  useEffect(() => { epoch.current++; setResult(null); }, [state, sourceIdentity]);
  const change = () => { epoch.current++; setResult(null); setError(''); };
  async function build() {
    if (pending.current || externalBusy || !screenIds.length) return;
    const generation = ++epoch.current; const snapshot = state; const key = formKey;
    pending.current = true; setBusy(true); busyCallback.current?.(true); setError(''); setResult(null);
    try {
      controller.current = new AbortController();
      const value = await createProjectDesignRuntimePreview({ ...scope, signal: controller.current.signal }, { id: crypto.randomUUID(), expectedRevision: snapshot.revision, kind, framework, screenIds, ...(comparison ? { comparison } : {}) });
      if (!mounted.current || generation !== epoch.current || currentState.current !== snapshot || currentKey.current !== key) return;
      if (value.revision !== snapshot.revision || value.projectId !== scope.projectId || value.request.kind !== kind || value.request.framework !== framework || JSON.stringify(value.request.screenIds) !== JSON.stringify(screenIds)) throw new Error(t('designPreview.stale'));
      setResult(value);
    } catch (failure) {
      if (mounted.current && generation === epoch.current) setError(failure instanceof ProjectDesignRuntimeError || failure instanceof Error ? failure.message : t('designPreview.failed'));
    } finally { pending.current = false; if (mounted.current) { setBusy(false); busyCallback.current?.(false); } }
  }
  const locked = busy || externalBusy;
  return <section className={styles.panel} data-testid="design-preview-panel">
    <h3>{t('designPreview.title')}</h3>
    {comparison ? <div className={styles.notice} data-testid="design-preview-comparison"><p>{comparison.type === 'shared-draft' ? `${t('designPreview.sharedComparison')}: ${comparison.draftId}` : `${t('designPreview.upgradeComparison')}: ${comparison.proof.plan.from.version} → ${comparison.proof.plan.to.version}`}</p><Button data-testid="design-preview-clear-comparison" disabled={locked} onClick={() => { change(); setComparison(undefined); }}>{t('designPreview.clearComparison')}</Button></div> : null}
    {state.document?.screens.length ? <>
    <fieldset className={styles.screens} disabled={locked}><legend>{t('designPreview.screens')}</legend>{state.document.screens.map((screen) => <label className={styles.screenChoice} key={screen.id}><input data-testid={`design-preview-screen-${screen.id}`} type="checkbox" checked={screenIds.includes(screen.id)} disabled={!screenIds.includes(screen.id) && screenIds.length >= 6} onChange={(event) => { change(); setScreenIds((old) => event.target.checked ? [...old, screen.id] : old.filter((id) => id !== screen.id)); }} />{screen.name ?? screen.id}</label>)}</fieldset>
    <div><Button data-testid="design-preview-build" variant="primary" disabled={locked || !screenIds.length} onClick={() => void build()}>{busy ? t('designPreview.building') : t('designPreview.build')}</Button></div>
    <details className={styles.advanced} data-testid="design-preview-advanced"><summary>{t('designWorkspace.advanced')}</summary>
      <p className={styles.muted}>{t('designPreview.hint')}</p>
      <div className={styles.fields}>
      <label className={styles.field}>{t('designPreview.kind')}<Select data-testid="design-preview-kind" value={kind} disabled={locked} onChange={(event) => { change(); setKind(event.target.value as DesignPreviewKind); }}><option value="semantic-design">{t('designPreview.semantic')}</option><option value="production-handoff">{t('designPreview.production')}</option></Select></label>
      <label className={styles.field}>{t('designPreview.framework')}<Select data-testid="design-preview-framework" value={framework} disabled={locked} onChange={(event) => { change(); setFramework(event.target.value as 'react' | 'vue'); }}><option value="react">React</option><option value="vue">Vue</option></Select></label>
      <label className={styles.field}>{t('designPreview.draft')}<Select data-testid="design-preview-draft" disabled={locked} value={comparison?.type === 'shared-draft' ? comparison.draftId : ''} onChange={(event) => {
        change(); const draft = state.sharedChanges.drafts.find((entry) => entry.id === event.target.value);
        setComparison(draft ? { type: 'shared-draft', draftId: draft.id, expectedDefinitionRevision: draft.baseDefinition?.revision ?? 0 } : undefined);
      }}><option value="">{t('designPreview.currentOnly')}</option>{state.sharedChanges.drafts.map((draft) => <option key={draft.id} value={draft.id}>{draft.componentRef} · {draft.proposedDefinition.revision}</option>)}</Select></label>
    </div>
    <p className={styles.muted}>{kind === 'semantic-design' ? t('designPreview.semanticHint') : t('designPreview.productionHint')}</p>
    </details>
    </> : <div className={styles.empty} data-testid="design-preview-empty">
      <p>{t('designPreview.noScreens')}</p>
      {onOpenStructure ? <Button data-testid="design-preview-open-structure" disabled={locked} onClick={onOpenStructure}>{t('projectStructure.title')}</Button> : null}
    </div>}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {result ? <>
      <div className={styles.notice} data-testid="design-preview-impact"><strong>{t('designPreview.impact')}</strong><p>{t('designPreview.selected')}: {result.request.screenIds.join(', ')}</p><p>{t('designPreview.affected')}: {result.impact.affectedScreens.map((screen) => screen.screenId).join(', ') || t('designPreview.none')}</p><p className={styles.muted}>{t('designPreview.sampleHint')}</p><StructureDiagnostics diagnostics={result.impact.diagnostics} /></div>
      <StructureDiagnostics diagnostics={result.diagnostics} />
      <div className={`${styles.comparison} ${result.sides.length === 1 ? styles.single : ''}`}>{result.sides.map((side) => <section className={styles.side} data-testid={`design-preview-side-${side.role}`} key={side.role}>
        <h4>{t(`designPreview.${side.role}`)}</h4><p>{t('designPreview.revision')}: {result.revision} · {side.kind}</p>
        <div data-testid={`design-preview-diagnostics-${side.role}`}><StructureDiagnostics diagnostics={side.diagnostics} /></div>
        {side.screens.map((screen) => <div key={screen.screenId}><h5>{state.document?.screens.find((entry) => entry.id === screen.screenId)?.name ?? screen.screenId}</h5><StructureDiagnostics diagnostics={screen.diagnostics} />{screen.bundle ? <RuntimeFrame key={JSON.stringify([result.requestDigest, side.role, screen.screenId, screen.bundle.digest])} bundle={screen.bundle} role={side.role} screenId={screen.screenId} /> : <p>{t('designPreview.unavailable')}</p>}</div>)}
        <details className={styles.evidence}><summary>{t('designPreview.evidence')}</summary><p>{t('designPreview.runtimeHint')}</p><pre>{JSON.stringify({ lock: side.lock, runtimePackages: side.runtimePackages, targetPackages: side.targetPackages, sourceDigest: side.sourceDigest, sourceEvidence: side.sourceEvidence, origins: side.origins }, null, 2)}</pre></details>
      </section>)}</div>
      <p className={styles.muted}>{t('designPreview.telemetryHint')}</p>
    </> : null}
  </section>;
}
