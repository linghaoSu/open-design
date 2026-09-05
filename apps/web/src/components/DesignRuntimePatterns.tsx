import { useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type { DesignPatternDefinition, JsonValue, ProjectDesignRuntimeInstantiatePatternResponse, ProjectDesignRuntimeState, UIIRDocument, UIIRNode, ValidationDiagnostic } from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { getProjectDesignRuntimePattern, instantiateProjectDesignRuntimePattern, listProjectDesignRuntimePatterns, ProjectDesignRuntimeError, type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
import { ScalarPropEditor, SemanticTreeEditor } from './SemanticTreeEditor';
import { StructureDiagnostics } from './ProjectStructureReview';
import { freshId } from './project-structure-drafts';
import styles from './ProjectStructurePanel.module.css';

interface Props {
  scope: ProjectDesignRuntimeScope; state: ProjectDesignRuntimeState; document: UIIRDocument; screenId: string;
  viewerOnly: boolean; disabled: boolean; sourceIdentity?: unknown;
  onAdd(node: UIIRNode): void; onBusyChange(busy: boolean): void;
}
/** Account or permission changes discard all pending authority, including a read-only preview. */
export function DesignRuntimePatterns(props: Props) {
  return <PatternContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext), props.viewerOnly])} {...props} />;
}
function PatternContent({ scope, state, document, screenId, viewerOnly, disabled, sourceIdentity, onAdd, onBusyChange }: Props) {
  const t = useT();
  const [query, setQuery] = useState(''); const [patterns, setPatterns] = useState<DesignPatternDefinition[] | null>(null);
  const [catalogRevision, setCatalogRevision] = useState<number | null>(null); const [selected, setSelected] = useState<DesignPatternDefinition | null>(null);
  const [instanceId, setInstanceId] = useState(() => freshId('pattern')); const [props, setProps] = useState<Record<string, JsonValue>>({}); const [slots, setSlots] = useState<Record<string, UIIRNode[]>>({});
  const previewAuthority = useRef<{ state: ProjectDesignRuntimeState; document: UIIRDocument; screenId: string; sourceIdentity: unknown; props: Record<string, JsonValue>; slots: Record<string, UIIRNode[]>; instanceId: string; selected: DesignPatternDefinition | null } | null>(null);
  const [preview, setPreview] = useState<ProjectDesignRuntimeInstantiatePatternResponse | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const mounted = useRef(false); const epoch = useRef(0); const running = useRef(false); const abort = useRef<AbortController | null>(null);
  const latest = useRef({ state, document, screenId, sourceIdentity, viewerOnly, disabled, onAdd, onBusyChange }); latest.current = { state, document, screenId, sourceIdentity, viewerOnly, disabled, onAdd, onBusyChange };
  const active = state.lock.dependencies[0]; const locked = disabled || busy;
  function invalidate() { epoch.current += 1; abort.current?.abort(); running.current = false; setBusy(false); latest.current.onBusyChange(false); previewAuthority.current = null; setPreview(null); setError(''); setDiagnostics([]); setMessage(''); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epoch.current += 1; abort.current?.abort(); latest.current.onBusyChange(false); }; }, []);
  useEffect(() => { invalidate(); }, [state, document, screenId, sourceIdentity, viewerOnly]);
  const snapshot = previewAuthority.current;
  const validPreview = snapshot && snapshot.state === state && snapshot.document === document && snapshot.screenId === screenId && snapshot.sourceIdentity === sourceIdentity && snapshot.props === props && snapshot.slots === slots && snapshot.instanceId === instanceId && snapshot.selected === selected ? preview : null;
  const currentCatalog = catalogRevision === state.revision;
  const proofMatches = (dependency: ProjectDesignRuntimeInstantiatePatternResponse['dependency']) => active !== undefined && dependency.designSystemId === active.designSystemId && dependency.version === active.version && dependency.digest === active.digest && dependency.source.digest === active.source.digest;
  async function perform<T>(request: (authority: ProjectDesignRuntimeScope) => Promise<T>, accept: (value: T) => void) {
    if (running.current || disabled) return;
    const snapshot = latest.current; const token = ++epoch.current; const controller = new AbortController(); abort.current = controller;
    const current = () => mounted.current && epoch.current === token && latest.current.state === snapshot.state && latest.current.document === snapshot.document && latest.current.screenId === snapshot.screenId && latest.current.sourceIdentity === snapshot.sourceIdentity && latest.current.viewerOnly === snapshot.viewerOnly;
    running.current = true; setBusy(true); latest.current.onBusyChange(true); setError(''); setMessage(''); setDiagnostics([]); setPreview(null);
    try { const result = await request({ ...scope, signal: controller.signal }); if (current()) accept(result); }
    catch (cause) { if (current()) { setError(cause instanceof Error ? cause.message : String(cause)); if (cause instanceof ProjectDesignRuntimeError) setDiagnostics(cause.diagnostics); } }
    finally { if (mounted.current && epoch.current === token) { running.current = false; setBusy(false); latest.current.onBusyChange(false); } }
  }
  function requireCurrent(revision: number, dependency: ProjectDesignRuntimeInstantiatePatternResponse['dependency']) {
    if (revision !== state.revision || !proofMatches(dependency)) throw new Error(t('designPatterns.stale'));
  }
  const editProp = (name: string, value: JsonValue | undefined) => {
    invalidate(); setProps((previous) => { const next = { ...previous }; if (value === undefined) delete next[name]; else next[name] = value; return next; });
  };
  const catalog = { registry: state.registry, localComponents: state.projectComponents.components };
  return <section className={styles.card} data-testid="design-patterns">
    <h4>{t('designPatterns.title')}</h4><p className={styles.muted}>{t('designPatterns.description')}</p>
    {!active ? <p>{t('designPatterns.noLock')}</p> : null}
    <label className={styles.field}>{t('common.search')}<input data-testid="pattern-search" type="search" disabled={locked} value={query} onChange={(event) => { invalidate(); setQuery(event.target.value); }} /></label>
    <Button data-testid="pattern-load" disabled={locked || !active} onClick={() => void perform((authority) => listProjectDesignRuntimePatterns(authority, query), (result) => {
      requireCurrent(result.revision, result.dependency); setPatterns(result.patterns); setCatalogRevision(result.revision); setSelected(null); setProps({}); setSlots({});
    })}>{t('designPatterns.load')}</Button>
    {patterns?.length ? <label className={styles.field}>{t('designPatterns.choose')}<select data-testid="pattern-select" disabled={locked || !currentCatalog} value={selected?.id ?? ''} onChange={(event) => {
      invalidate(); setSelected(null); setProps({}); setSlots({}); const id = event.target.value;
      if (id) void perform((authority) => getProjectDesignRuntimePattern(authority, id), (result) => {
        requireCurrent(result.revision, result.dependency); if (result.pattern.id !== id) throw new Error(t('designPatterns.stale')); setSelected(result.pattern); setInstanceId(freshId('pattern'));
      });
    }}><option value="">{t('designPatterns.choose')}</option>{patterns.map((pattern) => <option key={pattern.id} value={pattern.id}>{pattern.name} · {pattern.id}</option>)}</select></label> : patterns ? <p>{t('designPatterns.empty')}</p> : null}
    {selected ? <>
      <p>{selected.description}</p>
      <label className={styles.field}>{t('designPatterns.instanceId')}<input data-testid="pattern-instance-id" disabled={locked} value={instanceId} onChange={(event) => { invalidate(); setInstanceId(event.target.value); }} /></label>
      {Object.entries(selected.props).map(([name, definition]) => <ScalarPropEditor key={name} nodeId="pattern-config" name={name} definition={definition} value={Object.hasOwn(props, name) ? props[name] : undefined} explicit={Object.hasOwn(props, name)} instance={false} disabled={locked} onChange={(value) => editProp(name, value)} />)}
      {Object.entries(selected.slots).map(([name, definition]) => <section key={name} data-testid={`pattern-slot-${name}`}><h5>{name} · {t(definition.required ? 'designRuntime.required' : 'designRuntime.optional')}</h5>
        <SemanticTreeEditor {...catalog} accepts={definition.accepts} nodes={Object.hasOwn(slots, name) ? slots[name]! : []} {...(definition.multiple ? {} : { maxRoots: 1 })} disabled={locked} onChange={(nodes) => { invalidate(); setSlots((previous) => ({ ...previous, [name]: nodes })); }} />
      </section>)}
      <p className={styles.muted}>{t('designPatterns.previewHint')}</p>
      <Button data-testid="pattern-preview" disabled={locked || !currentCatalog} onClick={() => void perform((authority) => instantiateProjectDesignRuntimePattern(authority, selected.id, { expectedRevision: state.revision, instanceId, destinationScreenId: screenId, props, slots, document }), (result) => {
        requireCurrent(result.revision, result.dependency); if (result.patternId !== selected.id || result.instanceId !== instanceId) throw new Error(t('designPatterns.stale')); previewAuthority.current = { state, document, screenId, sourceIdentity, props, slots, instanceId, selected }; setPreview(result); setDiagnostics(result.diagnostics);
      })}>{t('designPatterns.preview')}</Button>
    </> : null}
    {validPreview?.node ? <section data-testid="pattern-result"><SemanticTreeEditor {...catalog} nodes={[validPreview.node]} disabled onChange={() => {}} />
      <Button data-testid="pattern-add" disabled={locked || viewerOnly || !currentCatalog} onClick={() => {
        if (!validPreview.node || viewerOnly || latest.current.disabled || !currentCatalog) return;
        const node = validPreview.node; invalidate(); latest.current.onAdd(node); setInstanceId(freshId('pattern')); setMessage(t('designPatterns.added'));
      }}>{t('designPatterns.add')}</Button>
    </section> : null}
    {busy ? <p role="status">{t('common.loading')}</p> : null}{message ? <p role="status">{message}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}<StructureDiagnostics diagnostics={diagnostics} />
  </section>;
}
