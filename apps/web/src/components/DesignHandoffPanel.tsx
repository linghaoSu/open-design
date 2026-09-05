import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import {
  ComponentPropMappingSchema, ComponentSlotMappingSchema, ProjectDesignRuntimeRegisterLocalBindingRequestSchema,
  type ComponentFramework, type HandoffBuildResult, type HandoffCodeResult, type HandoffScreenOutput,
  type ProjectDesignRuntimeState, type ValidationDiagnostic,
} from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import {
  createProjectDesignRuntimeHandoff, emitProjectDesignRuntimeHandoff, getProjectDesignRuntime,
  registerProjectDesignRuntimeLocalBinding, refreshProjectDesignRuntimeCodeComponent,
  putProjectDesignRuntimeBinding, revalidateProjectDesignRuntimeBinding, deleteProjectDesignRuntimeBinding,
  resolveProjectDesignRuntimeBinding, ProjectDesignRuntimeError, type ProjectDesignRuntimeScope,
} from '../providers/design-runtime';
import { fetchProjectFiles } from '../providers/registry';
import { useT } from '../i18n';
import { StructureDiagnostics } from './ProjectStructureReview';
import styles from './DesignHandoffPanel.module.css';

interface Props {
  scope: ProjectDesignRuntimeScope; state: ProjectDesignRuntimeState; files: readonly { name: string }[];
  viewerOnly: boolean; externalBusy?: boolean; onState(state: ProjectDesignRuntimeState): void; onBusyChange?(busy: boolean): void;
}
interface BindingDraft {
  baseRevision: number; definitionRevision: number; bindingId: string; codeId: string;
  sourcePath: string; exportName: string; packageName: string; propMappings: string; slotMappings: string;
  mode: 'source' | 'existing';
}
const json = (value: unknown) => JSON.stringify(value, null, 2);

function initialDraft(state: ProjectDesignRuntimeState, componentId: string, framework: ComponentFramework): BindingDraft {
  const definition = state.projectComponents.components.find((entry) => entry.id === componentId);
  const binding = state.bindings.bindings.find((entry) => entry.componentRef === `local:${componentId}` && entry.framework === framework);
  const code = binding && binding.status !== 'unbound' ? [...state.codeIndex.components, ...state.projectCodeIndex.components].find((entry) => entry.id === binding.codeComponentId) : undefined;
  return { baseRevision: state.revision, definitionRevision: definition?.revision ?? 1,
    bindingId: binding?.id ?? `local/${componentId}/${framework}`, codeId: code?.id ?? `project/${componentId}/${framework}`,
    sourcePath: code?.sourcePath ?? '', exportName: code?.exportName ?? (framework === 'vue' ? 'default' : definition?.name.replace(/[^A-Za-z0-9_$]/g, '') ?? ''),
    packageName: code?.packageName ?? '', mode: code && !state.projectCodeIndex.components.some((entry) => entry.id === code.id) ? 'existing' : 'source',
    propMappings: json(binding?.propMappings ?? Object.keys(definition?.props ?? {}).map((name) => ({ designProp: name, codeProp: name }))),
    slotMappings: json(binding?.slotMappings ?? []),
  };
}
function download(name: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DesignHandoffPanel(props: Props) {
  return <HandoffContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext)])} {...props} />;
}
function HandoffContent({ scope, state, files, viewerOnly, externalBusy = false, onState, onBusyChange }: Props) {
  const t = useT(); const sourceListId = useId();
  const [componentId, setComponentId] = useState(state.projectComponents.components[0]?.id ?? '');
  const [framework, setFramework] = useState<ComponentFramework>('react');
  const [draft, setDraft] = useState(() => initialDraft(state, componentId, 'react'));
  const [dirty, setDirty] = useState(false); const dirtyRef = useRef(false);
  const [paths, setPaths] = useState(files.map((file) => file.name));
  const [handoffId, setHandoffId] = useState(() => `handoff-${crypto.randomUUID()}`);
  const [fromVersion, setFromVersion] = useState(''); const [sharedIds, setSharedIds] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<Record<string, HandoffScreenOutput>>({});
  const [result, setResult] = useState<{ revision: number; handoff: HandoffBuildResult; code?: HandoffCodeResult } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const mounted = useRef(false); const running = useRef(false); const generation = useRef(0); const abort = useRef<AbortController | null>(null);
  const disabled = busy || externalBusy; const staleDraft = dirty && draft.baseRevision !== state.revision;
  const definition = state.projectComponents.components.find((entry) => entry.id === componentId);
  const binding = state.bindings.bindings.find((entry) => entry.componentRef === `local:${componentId}` && entry.framework === framework);
  const codes = [...state.codeIndex.components, ...state.projectCodeIndex.components].filter((code) => code.framework === framework);
  const staleResult = !!result && result.revision !== state.revision;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; abort.current?.abort(); onBusyChange?.(false); }; }, []);
  useEffect(() => { setPaths(files.map((file) => file.name)); }, [files]);
  useEffect(() => {
    if (!dirtyRef.current) {
      const id = state.projectComponents.components.some((entry) => entry.id === componentId) ? componentId : state.projectComponents.components[0]?.id ?? '';
      setComponentId(id); setDraft(initialDraft(state, id, framework));
    }
  }, [state.revision, componentId, framework]);
  const edit = (patch: Partial<BindingDraft>) => { setDraft((value) => ({ ...value, ...patch })); dirtyRef.current = true; setDirty(true); setMessage(''); };
  function reset(id = componentId, target = framework) { dirtyRef.current = false; setDirty(false); setComponentId(id); setFramework(target); setDraft(initialDraft(state, id, target)); }
  async function perform(action: (authority: ProjectDesignRuntimeScope, current: () => boolean) => Promise<void>) {
    if (running.current || externalBusy) return;
    running.current = true; setBusy(true); onBusyChange?.(true); setError(''); setMessage(''); setDiagnostics([]);
    const ticket = ++generation.current; const controller = new AbortController(); abort.current = controller;
    const current = () => mounted.current && generation.current === ticket && !controller.signal.aborted;
    const authority = { ...scope, signal: controller.signal };
    try { await action(authority, current); }
    catch (cause) {
      if (!current()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError) {
        setDiagnostics(cause.diagnostics);
        if (cause.status === 409) {
          setMessage(t('designHandoff.conflict'));
          try { const response = await getProjectDesignRuntime(authority); if (current()) onState(response.state); }
          catch (refreshError) { if (current()) setError(refreshError instanceof Error ? refreshError.message : String(refreshError)); }
        }
      }
    } finally { if (current()) { running.current = false; setBusy(false); onBusyChange?.(false); } }
  }
  function adopt(next: ProjectDesignRuntimeState) { dirtyRef.current = false; setDirty(false); onState(next); setDraft(initialDraft(next, componentId, framework)); setMessage(t('designRuntime.saved')); }
  function register() {
    if (!definition || viewerOnly || staleDraft) return;
    void perform(async (authority, current) => {
      const nextBinding = { schemaVersion: 1 as const, id: draft.bindingId, componentRef: `local:${componentId}`, framework,
        definitionRevision: draft.definitionRevision, codeComponentId: draft.codeId, status: 'bound' as const, verified: true as const,
        ...(binding?.source ? { source: binding.source } : {}),
        propMappings: ComponentPropMappingSchema.array().parse(JSON.parse(draft.propMappings)),
        slotMappings: ComponentSlotMappingSchema.array().parse(JSON.parse(draft.slotMappings)),
      };
      if (draft.mode === 'existing') {
        const response = await putProjectDesignRuntimeBinding(authority, nextBinding.id, { expectedRevision: draft.baseRevision, binding: nextBinding });
        if (current()) adopt(response.state);
      } else {
        const request = ProjectDesignRuntimeRegisterLocalBindingRequestSchema.parse({ expectedRevision: draft.baseRevision, binding: nextBinding,
          source: { framework, sourcePath: draft.sourcePath, exportName: draft.exportName, codeComponentId: draft.codeId, ...(draft.packageName ? { packageName: draft.packageName } : {}) } });
        const response = await registerProjectDesignRuntimeLocalBinding(authority, request);
        if (current()) { adopt(response.state); setDiagnostics(response.diagnostics); }
      }
    });
  }
  function outputFor(screenId: string): HandoffScreenOutput {
    return Object.hasOwn(outputs, screenId) ? outputs[screenId]! : { screenId, sourcePath: `src/screens/${screenId}.${framework === 'react' ? 'tsx' : 'vue'}`, exportName: framework === 'react' ? 'Screen' : 'default' };
  }
  function build(emit: boolean) {
    void perform(async (authority, current) => {
      const selection = { ...(fromVersion && state.registry ? { fromVersion: { designSystemId: state.registry.id, version: fromVersion } } : {}), ...(sharedIds.length ? { sharedChangeIds: sharedIds } : {}) };
      const request = { expectedRevision: state.revision, id: handoffId, framework, ...(Object.keys(selection).length ? { changeContextSelection: selection } : {}) };
      if (emit) {
        const response = await emitProjectDesignRuntimeHandoff(authority, { ...request, outputs: state.document?.screens.map((screen) => outputFor(screen.id)) ?? [] });
        if (current()) setResult({ revision: response.revision, handoff: response.handoff, code: response.code });
      } else {
        const response = await createProjectDesignRuntimeHandoff(authority, request);
        if (current()) setResult({ revision: response.revision, handoff: response.result });
      }
    });
  }
  return <section className={styles.panel} data-testid="design-handoff-panel">
    <div className={styles.actions}><p>{t('designHandoff.description')}</p>
      <Button data-testid="handoff-refresh-files" disabled={disabled} onClick={() => void perform(async (authority, current) => {
        const [next, freshFiles] = await Promise.all([getProjectDesignRuntime(authority), fetchProjectFiles(scope.projectId, { signal: authority.signal, workspaceContext: scope.workspaceContext, fresh: true, requireAuthoritative: true })]);
        if (current()) { onState(next.state); setPaths(freshFiles.map((file) => file.name)); }
      })}>{t('designHandoff.refreshFiles')}</Button>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}<StructureDiagnostics diagnostics={diagnostics} />
    <div className={styles.columns}>
      <form className={styles.card} onSubmit={(event) => { event.preventDefault(); register(); }}>
        <h3>{t('designHandoff.localCode')}</h3>
        <label className={styles.field}>{t('designHandoff.framework')}<select data-testid="handoff-framework" disabled={disabled || dirty} value={framework} onChange={(event) => { reset(componentId, event.target.value as ComponentFramework); setOutputs({}); setResult(null); }}><option value="react">React</option><option value="vue">Vue</option></select></label>
        <label className={styles.field}>{t('designHandoff.localComponent')}<select data-testid="handoff-local-component" disabled={disabled || dirty} value={componentId} onChange={(event) => reset(event.target.value)}>
          {!definition ? <option value="">{t('common.none')}</option> : null}{state.projectComponents.components.map((entry) => <option value={entry.id} key={entry.id}>{entry.name} · {entry.id}</option>)}
        </select></label>
        {definition ? <><p>{t('designHandoff.definitionRevision', { revision: draft.definitionRevision })} · <code>{binding?.status ?? 'unbound'}</code></p>
          <details><summary>{t('designRuntime.props')}</summary><pre>{json(definition.props)}</pre></details>
          {dirty ? <div className={styles.notice}><p>{t(staleDraft ? 'designHandoff.conflict' : 'designHandoff.dirty')}</p><Button type="button" data-testid="handoff-reset-binding" disabled={disabled} onClick={() => reset()}>{t('designHandoff.reloadBinding')}</Button></div> : null}
          <fieldset disabled={disabled || viewerOnly || staleDraft}>
            <label className={styles.field}>{t('designHandoff.implementation')}<select data-testid="handoff-binding-mode" value={draft.mode} onChange={(event) => edit({ mode: event.target.value as BindingDraft['mode'] })}><option value="source">{t('designHandoff.registerSource')}</option><option value="existing">{t('designHandoff.existingCode')}</option></select></label>
            {draft.mode === 'source' ? <>
              <label className={styles.field}>{t('designRuntime.sourcePath')}<input data-testid="handoff-source-path" required value={draft.sourcePath} list={sourceListId} onChange={(event) => edit({ sourcePath: event.target.value })} /></label>
              <datalist id={sourceListId}>{paths.filter((path) => framework === 'vue' ? path.endsWith('.vue') : /\.(tsx?|jsx?)$/.test(path)).map((path) => <option key={path} value={path} />)}</datalist>
              <label className={styles.field}>{t('designRuntime.exportName')}<input data-testid="handoff-export-name" required value={draft.exportName} onChange={(event) => edit({ exportName: event.target.value })} /></label>
              <label className={styles.field}>{t('designRuntime.packageName')}<input data-testid="handoff-package-name" value={draft.packageName} onChange={(event) => edit({ packageName: event.target.value })} /></label>
              <label className={styles.field}>{t('designRuntime.codeId')}<input data-testid="handoff-code-id" required value={draft.codeId} onChange={(event) => edit({ codeId: event.target.value })} /></label>
            </> : <label className={styles.field}>{t('designHandoff.existingCode')}<select data-testid="handoff-existing-code" value={draft.codeId} onChange={(event) => edit({ codeId: event.target.value })}><option value="">{t('common.none')}</option>{codes.map((code) => <option key={code.id} value={code.id}>{code.name} · {code.id} · {code.sourcePath}</option>)}</select></label>}
            <label className={styles.field}>{t('designHandoff.bindingId')}<input data-testid="handoff-binding-id" required value={draft.bindingId} readOnly={!!binding} onChange={(event) => edit({ bindingId: event.target.value })} /></label>
            <label className={styles.field}>{t('designRuntime.propMappings')}<textarea data-testid="handoff-prop-mappings" rows={6} value={draft.propMappings} onChange={(event) => edit({ propMappings: event.target.value })} /></label>
            <p className={styles.muted}>{t('designHandoff.mappingHint')}</p>
            <label className={styles.field}>{t('designRuntime.slotMappings')}<textarea data-testid="handoff-slot-mappings" rows={3} value={draft.slotMappings} onChange={(event) => edit({ slotMappings: event.target.value })} /></label>
            <Button data-testid="handoff-register-local" variant="primary" type="submit">{t('designHandoff.register')}</Button>
          </fieldset>
          <div className={styles.actions}>
            <Button disabled={viewerOnly || disabled || dirty || !binding || binding.status === 'unbound'} onClick={() => binding && void perform(async (authority, current) => { const response = await revalidateProjectDesignRuntimeBinding(authority, binding.id, { expectedRevision: state.revision }); if (current()) adopt(response.state); })}>{t('designRuntime.revalidate')}</Button>
            <Button disabled={viewerOnly || disabled || dirty || !binding || binding.status === 'unbound'} onClick={() => binding && void perform(async (authority, current) => { const response = await deleteProjectDesignRuntimeBinding(authority, binding.id, { expectedRevision: state.revision }); if (current()) adopt(response.state); })}>{t('designRuntime.unbind')}</Button>
            <Button disabled={disabled || !binding} onClick={() => binding && void perform(async (authority, current) => { const response = await resolveProjectDesignRuntimeBinding(authority, binding.id); if (current()) { if (response.resolution.ok) setMessage(t('designRuntime.resolved', { name: response.resolution.codeComponent.name })); else setDiagnostics(response.resolution.diagnostics); } })}>{t('designRuntime.resolve')}</Button>
          </div>
        </> : <p>{t('designHandoff.noLocal')}</p>}
      </form>
      <section className={styles.card}>
        <h3>{t('designHandoff.title')}</h3><p className={styles.muted}>{t('designHandoff.sourceProof')}</p>
        <fieldset disabled={disabled}>
          <label className={styles.field}>{t('designHandoff.handoffId')}<input value={handoffId} onChange={(event) => { setHandoffId(event.target.value); setResult(null); }} /></label>
          <details><summary>{t('designHandoff.changeContext')}</summary>
            {state.registry ? <label className={styles.field}>{t('designHandoff.previousVersion')}<input placeholder="1.0.0" value={fromVersion} onChange={(event) => { setFromVersion(event.target.value); setResult(null); }} /></label> : null}
            {state.sharedChanges.history.filter((entry) => entry.changeId).map((entry) => <label className={styles.check} key={`${entry.componentRef}-${entry.definition.revision}`}><input type="checkbox" checked={sharedIds.includes(entry.changeId!)} onChange={(event) => { setSharedIds(event.target.checked ? [...sharedIds, entry.changeId!] : sharedIds.filter((id) => id !== entry.changeId)); setResult(null); }} />{entry.componentRef} · {entry.definition.revision} · {entry.changeId}</label>)}
          </details>
          <Button data-testid="handoff-create" onClick={() => build(false)}>{t('designHandoff.create')}</Button>
          <h4>{t('designHandoff.outputs')}</h4>
          {state.document?.screens.map((screen) => { const output = outputFor(screen.id); const change = (patch: Partial<HandoffScreenOutput>) => { setOutputs((value) => ({ ...value, [screen.id]: { ...output, ...patch } })); setResult((value) => value ? { revision: value.revision, handoff: value.handoff } : null); }; return <div key={screen.id} className={styles.output}>
            <strong>{screen.name ?? screen.id}</strong><label className={styles.field}>{t('designRuntime.sourcePath')}<input data-testid={`handoff-output-path-${screen.id}`} value={output.sourcePath} onChange={(event) => change({ sourcePath: event.target.value })} /></label>
            <label className={styles.field}>{t('designRuntime.exportName')}<input data-testid={`handoff-output-export-${screen.id}`} value={output.exportName} onChange={(event) => change({ exportName: event.target.value })} /></label>
          </div>; })}
          <Button data-testid="handoff-emit" disabled={!state.document} onClick={() => build(true)}>{t('designHandoff.emit')}</Button>
        </fieldset>
        {result ? <div data-testid="handoff-result"><p>{t('designRuntime.revision', { revision: result.revision })}</p>
          {staleResult ? <p role="status" className={styles.notice}>{t('designHandoff.staleResult')}</p> : null}
          <strong data-testid="handoff-readiness">{t(result.handoff.manifest?.ready && !staleResult ? 'designHandoff.ready' : 'designHandoff.notReady')}</strong>
          <StructureDiagnostics diagnostics={result.handoff.diagnostics} />
          {result.handoff.manifest ? <details data-testid="handoff-evidence"><summary>{t('designHandoff.sourceProof')}</summary>
            {result.handoff.manifest.snapshot.lock.dependencies.map((entry) => <p key={entry.designSystemId}><strong>{entry.designSystemId}@{entry.version}</strong><br/><code>{entry.digest}</code><br/><code>{entry.source.digest}</code></p>)}
            {result.handoff.manifest.snapshot.targetPackages.map((entry) => <p key={entry.name}><strong>{entry.name}</strong> · <code>{entry.installation.status === 'observed' ? entry.installation.version : entry.installation.status}</code>{entry.declaredRange ? <> · <code>{entry.declaredRange}</code></> : null}</p>)}
            {result.handoff.manifest.changeContext?.semanticDiff ? <p>{t('designUpgrade.diff')}: {result.handoff.manifest.changeContext.semanticDiff.from.designSystemId}@{result.handoff.manifest.changeContext.semanticDiff.from.version} → {result.handoff.manifest.changeContext.semanticDiff.to.version}</p> : null}
            {result.handoff.manifest.changeContext?.sharedRevisions?.map((entry) => <p key={`${entry.componentRef}-${entry.definition.revision}`}>{entry.componentRef} · {t('designHandoff.definitionRevision', { revision: entry.definition.revision })} · {entry.changeId}</p>)}
            <pre>{json({ lock: result.handoff.manifest.snapshot.lock, packages: result.handoff.manifest.snapshot.targetPackages, changeContext: result.handoff.manifest.changeContext })}</pre>
          </details> : null}
          {result.handoff.manifest?.coverage.map((entry) => <div key={entry.componentRef}><code>{entry.componentRef}</code> · {t(entry.ready ? 'designHandoff.ready' : 'designHandoff.notReady')}<StructureDiagnostics diagnostics={entry.diagnostics} /></div>)}
          <Button disabled={staleResult} onClick={() => download(`${result.handoff.manifest?.id ?? 'handoff'}.json`, json(result.handoff), 'application/json')}>{t('designHandoff.downloadManifest')}</Button>
          {result.code ? <><StructureDiagnostics diagnostics={result.code.diagnostics} />{result.code.files.map((file) => <details key={file.sourcePath} data-testid="handoff-emitted-file"><summary>{file.sourcePath}</summary><pre>{file.content}</pre><Button disabled={staleResult} onClick={() => download(file.sourcePath.split('/').pop()!, file.content)}>{t('designHandoff.downloadCode')}</Button></details>)}</> : null}
        </div> : null}
      </section>
    </div>
    <section className={styles.card}><h3>{t('designHandoff.registeredCode')}</h3><p className={styles.muted}>{t('designHandoff.refreshHint')}</p>
      {state.projectCodeIndex.components.map((code) => <div className={styles.codeRow} key={code.id}><div><strong>{code.name}</strong> · <code>{code.id}</code><p>{code.sourcePath} · {code.exportName} · {code.framework}</p></div><Button data-testid={`handoff-refresh-code-${code.id}`} disabled={disabled || viewerOnly} onClick={() => void perform(async (authority, current) => { const response = await refreshProjectDesignRuntimeCodeComponent(authority, code.id, { expectedRevision: state.revision }); if (current()) { onState(response.state); setDiagnostics(response.diagnostics); } })}>{t('designHandoff.refreshCode')}</Button></div>)}
      {!state.projectCodeIndex.components.length ? <p>{t('common.none')}</p> : null}
    </section>
  </section>;
}
