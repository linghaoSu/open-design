import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type {
  CodeComponentDefinition,
  ComponentBinding,
  ComponentDefinition,
  ComponentPropDefinition,
  JsonValue,
  ProjectDesignRuntimeCompileRequest,
  ProjectDesignRuntimeResponse,
  ProjectDesignRuntimeState,
  ValidationDiagnostic,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import {
  compileProjectDesignRuntime,
  deleteProjectDesignRuntimeBinding,
  getProjectDesignRuntime,
  ProjectDesignRuntimeError,
  putProjectDesignRuntimeBinding,
  revalidateProjectDesignRuntimeBinding,
  resolveProjectDesignRuntimeBinding,
  validateProjectDesignRuntimeUsage,
  type ProjectDesignRuntimeScope,
} from '../providers/design-runtime';
import { useT } from '../i18n';
import styles from './DesignRuntimePanel.module.css';

interface Props {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  files: readonly { name: string }[];
  viewerOnly: boolean;
  onClose(): void;
}

type SourceSelection = ProjectDesignRuntimeCompileRequest['selections'][number];
type ScalarKind = 'string' | 'number' | 'boolean' | 'null';
interface PropDraft { included: boolean; input: string; kind: ScalarKind }

function newSelection(sourcePath = ''): SourceSelection {
  const identity = crypto.randomUUID();
  return { sourcePath, exportName: '', componentId: `component-${identity}`, codeComponentId: `code/${identity}` };
}

function sourceSelections(state: ProjectDesignRuntimeState): SourceSelection[] {
  return (state.registry?.components ?? []).flatMap((component) => {
    const source = component.source;
    const code = state.codeIndex.components.find((candidate) =>
      candidate.sourcePath === source?.sourcePath && candidate.exportName === source?.exportName);
    return source && code ? [{
      sourcePath: source.sourcePath,
      exportName: code.exportName,
      componentId: component.id,
      codeComponentId: code.id,
      ...(code.packageName === undefined ? {} : { packageName: code.packageName }),
    }] : [];
  });
}

function scalarKind(value: JsonValue): ScalarKind {
  return value === null ? 'null' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
}

function initialPropDraft(prop: ComponentPropDefinition): PropDraft {
  const value = prop.default !== undefined ? prop.default
    : prop.type === 'enum' ? prop.values[0] : prop.type === 'boolean' ? false : prop.type === 'number' ? 0 : '';
  return {
    included: prop.required && prop.default === undefined,
    input: String(value),
    kind: value === undefined ? 'string' : scalarKind(value),
  };
}

/** Invalid scalar input is kept intact so the daemon can explain its diagnostic. */
function propValue(draft: PropDraft): JsonValue {
  if (draft.kind === 'number' && draft.input.trim() !== '' && Number.isFinite(Number(draft.input))) return Number(draft.input);
  if (draft.kind === 'boolean' && (draft.input === 'true' || draft.input === 'false')) return draft.input === 'true';
  if (draft.kind === 'null' && draft.input === 'null') return null;
  return draft.input;
}

/** A scope change remounts all drafts and invalidates pending reads and writes. */
export function DesignRuntimePanel(props: Props) {
  const scopeKey = JSON.stringify([props.projectId, workspaceAccountScopedCacheKey(props.workspaceContext)]);
  return <DesignRuntimePanelContent key={scopeKey} {...props} />;
}

function DesignRuntimePanelContent({ projectId, workspaceContext, files, viewerOnly, onClose }: Props) {
  const t = useT();
  const inputId = useId();
  const sourceFiles = files.map(({ name }) => name).filter((name) => /\.(tsx|ts)$/.test(name) && !name.endsWith('.d.ts')).sort();
  const [state, setState] = useState<ProjectDesignRuntimeState | null>(null);
  const [selections, setSelections] = useState<SourceSelection[]>(() => [newSelection(sourceFiles[0])]);
  const [designSystemId, setDesignSystemId] = useState('project');
  const [componentId, setComponentId] = useState('');
  const [codeId, setCodeId] = useState('');
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [propDrafts, setPropDrafts] = useState<Record<string, PropDraft>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[] | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const running = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scope: ProjectDesignRuntimeScope = { projectId, workspaceContext };
  const selectedComponent = state?.registry?.components.find((component) => component.id === componentId);
  const selectedCode = state?.codeIndex.components.find((component) => component.id === codeId);
  const componentRef = selectedComponent && state?.registry ? `ds:${state.registry.id}/${selectedComponent.id}` : '';
  const binding = state?.bindings.bindings.find((candidate) => candidate.componentRef === componentRef
    && candidate.framework === (selectedCode?.framework ?? 'react'));
  const visibleComponents = state?.registry?.components.filter((component) =>
    `${component.name} ${component.id}`.toLowerCase().includes(query.toLowerCase())) ?? [];

  function selectComponent(nextId: string, nextState = state) {
    setComponentId(nextId);
    const ref = nextState?.registry ? `ds:${nextState.registry.id}/${nextId}` : '';
    const nextBinding = nextState?.bindings.bindings.find((candidate) => candidate.componentRef === ref);
    setCodeId(nextBinding && nextBinding.status !== 'unbound' ? nextBinding.codeComponentId : nextState?.codeIndex.components[0]?.id ?? '');
    setMappings(Object.fromEntries(nextBinding?.propMappings?.map((mapping) => [mapping.designProp, mapping.codeProp]) ?? []));
    setPropDrafts({});
    setDiagnostics(null);
    setMessage('');
  }

  function adoptState(nextState: ProjectDesignRuntimeState, initialize = false) {
    setState(nextState);
    if (initialize) {
      if (nextState.registry) setDesignSystemId(nextState.registry.id);
      const nextSelections = sourceSelections(nextState);
      if (nextSelections.length) setSelections(nextSelections);
    }
    if (initialize || !nextState.registry?.components.some((component) => component.id === componentId)) {
      selectComponent(nextState.registry?.components[0]?.id ?? '', nextState);
    }
  }

  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    void getProjectDesignRuntime({ projectId, workspaceContext, signal: abort.signal })
      .then(({ state: nextState }) => {
        if (mounted.current && generation.current === current) adoptState(nextState, true);
      })
      .catch((cause: unknown) => {
        if (mounted.current && generation.current === current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (mounted.current && generation.current === current) {
          running.current = false;
          setBusy(false);
        }
      });
    return () => {
      mounted.current = false;
      generation.current += 1;
      controller.current?.abort();
    };
    // The outer keyed boundary owns project/workspace identity changes.
  }, []);

  async function perform<T>(operation: (authority: ProjectDesignRuntimeScope) => Promise<T>, accept: (result: T) => void) {
    if (running.current) return;
    running.current = true;
    const current = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    const authority = { ...scope, signal: abort.signal };
    const isCurrent = () => mounted.current && generation.current === current;
    setBusy(true);
    setError('');
    setMessage('');
    setDiagnostics(null);
    try {
      const result = await operation(authority);
      if (isCurrent()) accept(result);
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError) {
        setDiagnostics(cause.diagnostics.length ? cause.diagnostics : null);
        if (cause.status === 409) {
          try {
            const refreshed = await getProjectDesignRuntime(authority);
            if (isCurrent()) {
              adoptState(refreshed.state);
              setMessage(t('designRuntime.conflict'));
            }
          } catch (refreshError) {
            if (isCurrent()) setError(`${cause.message} ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
          }
        }
      }
    } finally {
      if (isCurrent()) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  function acceptMutation({ state: nextState }: ProjectDesignRuntimeResponse) {
    adoptState(nextState);
    setMessage(t('designRuntime.saved'));
  }

  function compile() {
    if (viewerOnly || !state) return;
    void perform((authority) => compileProjectDesignRuntime(authority, {
      expectedRevision: state.revision, designSystemId, selections,
    }), acceptMutation);
  }

  function bind() {
    if (viewerOnly || !state || !selectedCode || !componentRef) return;
    const nextBinding: ComponentBinding = {
      schemaVersion: 1,
      id: binding?.id ?? `binding:${state.registry!.id}:${componentId}:${selectedCode.framework}`,
      componentRef,
      framework: selectedCode.framework,
      status: 'bound',
      verified: true,
      codeComponentId: selectedCode.id,
      propMappings: Object.entries(mappings)
        .filter(([designProp, codeProp]) => designProp !== codeProp)
        .map(([designProp, codeProp]) => ({ designProp, codeProp })),
    };
    void perform((authority) => putProjectDesignRuntimeBinding(authority, nextBinding.id, {
      expectedRevision: state.revision, binding: nextBinding,
    }), acceptMutation);
  }

  function validate() {
    if (!state || !selectedComponent) return;
    const props: Record<string, JsonValue> = {};
    for (const [name, definition] of Object.entries(selectedComponent.props)) {
      const draft = Object.hasOwn(propDrafts, name) ? propDrafts[name]! : initialPropDraft(definition);
      if (draft.included) props[name] = propValue(draft);
    }
    void perform((authority) => validateProjectDesignRuntimeUsage(authority, { component: componentRef, props }), (result) => {
      setDiagnostics(result.diagnostics);
      setMessage(result.diagnostics.length ? '' : t('designRuntime.valid'));
    });
  }

  function changeSelection(index: number, values: Partial<SourceSelection>) {
    setSelections((current) => current.map((selection, position) => position === index ? { ...selection, ...values } : selection));
  }

  return (
    <section id="design-runtime-panel" className={styles.panel} aria-labelledby={`${inputId}-title`} data-testid="design-runtime-panel">
      <header className={styles.header}>
        <div>
          <h2 ref={heading} tabIndex={-1} id={`${inputId}-title`}>{t('designRuntime.title')}</h2>
          <p>{t('designRuntime.description')}</p>
        </div>
        <div className={styles.actions}>
          {state ? <span className={styles.muted}>{t('designRuntime.revision', { revision: state.revision })}</span> : null}
          <Button disabled={busy} onClick={() => void perform(getProjectDesignRuntime, ({ state: nextState }) => adoptState(nextState, state === null))}>{t('designRuntime.refresh')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </header>
      {viewerOnly ? <p className={styles.notice}>{t('designRuntime.readOnly')}</p> : null}
      {busy ? <p role="status">{t('common.loading')}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {diagnostics?.length ? <ul className={styles.diagnostics} aria-label={t('designRuntime.diagnostics')}>
        {diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>
          <strong>{diagnostic.code}</strong> <span>{diagnostic.message}</span>
          {diagnostic.path ? <code>{diagnostic.path.join(' → ')}</code> : null}
          {diagnostic.allowedValues ? <span>{t('designRuntime.allowedValues')}: {diagnostic.allowedValues.map((value) => JSON.stringify(value)).join(', ')}</span> : null}
        </li>)}
      </ul> : null}
      <div className={styles.columns}>
        <form className={styles.card} onSubmit={(event) => { event.preventDefault(); compile(); }}>
          <h3>{t('designRuntime.sources')}</h3>
          <p className={styles.muted}>{t('designRuntime.sourceHint')}</p>
          <fieldset disabled={viewerOnly || busy || !state}>
            <label className={styles.field}>{t('designRuntime.systemId')}
              <input data-testid="design-runtime-system-id" value={designSystemId} readOnly={!!state?.registry} required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" onChange={(event) => setDesignSystemId(event.target.value)} />
            </label>
            {selections.map((selection, index) => <div className={styles.source} key={selection.componentId}>
              <label className={styles.field}>{t('designRuntime.sourcePath')}
                <select data-testid={`design-runtime-source-path-${index}`} value={selection.sourcePath} required onChange={(event) => changeSelection(index, { sourcePath: event.target.value })}>
                  <option value="">{t('designRuntime.chooseSource')}</option>
                  {selection.sourcePath && !sourceFiles.includes(selection.sourcePath) ? <option value={selection.sourcePath}>{selection.sourcePath}</option> : null}
                  {sourceFiles.map((path) => <option key={path} value={path}>{path}</option>)}
                </select>
              </label>
              <label className={styles.field}>{t('designRuntime.exportName')}
                <input data-testid={`design-runtime-export-name-${index}`} value={selection.exportName} required pattern="[A-Za-z_$][A-Za-z0-9_$]*" onChange={(event) => changeSelection(index, { exportName: event.target.value })} />
              </label>
              <details>
                <summary>{t('designRuntime.identities')}</summary>
                <p className={styles.muted}>{t('designRuntime.identityHint')}</p>
                <label className={styles.field}>{t('designRuntime.componentId')}
                  <input data-testid={`design-runtime-component-id-${index}`} value={selection.componentId} readOnly />
                </label>
                <label className={styles.field}>{t('designRuntime.codeId')}
                  <input data-testid={`design-runtime-code-id-${index}`} value={selection.codeComponentId} readOnly />
                </label>
                <label className={styles.field}>{t('designRuntime.packageName')}
                  <input value={selection.packageName ?? ''} onChange={(event) => changeSelection(index, { packageName: event.target.value || undefined })} />
                </label>
              </details>
              <Button variant="ghost" disabled={selections.length === 1} aria-label={`${t('common.delete')} ${index + 1}`} onClick={() => setSelections((current) => current.filter((_, position) => position !== index))}>{t('common.delete')}</Button>
            </div>)}
            <div className={styles.actions}>
              <Button onClick={() => setSelections((current) => [...current, newSelection(sourceFiles[0])])}>{t('designRuntime.addSource')}</Button>
              <Button data-testid="design-runtime-compile" type="submit" variant="primary">{t('designRuntime.compile')}</Button>
            </div>
          </fieldset>
        </form>
        <div className={styles.catalog}>
          {!state?.registry ? <p className={styles.empty}>{t('designRuntime.empty')}</p> : <>
            <section className={styles.card}>
              <h3>{t('designRuntime.components')}</h3>
              <label className={styles.field}>{t('common.search')}
                <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <label className={styles.field}>{t('designRuntime.component')}
                <select data-testid="design-runtime-component-select" value={componentId} disabled={busy} onChange={(event) => selectComponent(event.target.value)}>
                  {selectedComponent && !visibleComponents.includes(selectedComponent) ? <option value={selectedComponent.id}>{selectedComponent.name}</option> : null}
                  {visibleComponents.map((component) => <option key={component.id} value={component.id}>{component.name} · {component.id}</option>)}
                </select>
              </label>
              {selectedComponent ? <>
                <ComponentMetadata component={selectedComponent} />
                <h4>{t('designRuntime.slots')}</h4>
                {Object.entries(selectedComponent.slots ?? {}).length ? <ul>
                  {Object.entries(selectedComponent.slots ?? {}).map(([name, slot]) => <li key={name}>
                    <strong>{name}</strong>: {slot.accepts.join(', ')} · {slot.required ? t('designRuntime.required') : t('designRuntime.optional')} · {slot.multiple ? t('designRuntime.multiple') : t('designRuntime.single')}
                  </li>)}
                </ul> : <p className={styles.muted}>{t('common.none')}</p>}
              </> : null}
            </section>
            <section className={styles.card}>
              <h3>{t('designRuntime.binding')}</h3>
              <p>{t('designRuntime.status')}: <strong data-testid="design-runtime-binding-status">{t(`designRuntime.status.${binding?.status ?? 'unbound'}`)}</strong></p>
              {binding && binding.status !== 'unbound' ? <p className={styles.muted}>{t('designRuntime.boundTarget')}: <code>{binding.codeComponentId}</code></p> : null}
              <label className={styles.field}>{t('designRuntime.codeComponent')}
                <select data-testid="design-runtime-code-select" value={codeId} disabled={busy} onChange={(event) => { setCodeId(event.target.value); setMappings({}); setDiagnostics(null); setMessage(''); }}>
                  {state.codeIndex.components.map((component) => <option key={component.id} value={component.id}>{component.name} · {component.id}</option>)}
                </select>
              </label>
              {selectedCode ? <ComponentMetadata component={selectedCode} /> : null}
              {selectedComponent && selectedCode ? <fieldset disabled={viewerOnly || busy}>
                <legend>{t('designRuntime.propMappings')}</legend>
                {Object.keys(selectedComponent.props).map((name) => <label className={styles.mapping} key={name}>
                  <code>{name}</code><span aria-hidden="true">→</span>
                  <select aria-label={`${t('designRuntime.propMappings')}: ${name}`} value={Object.hasOwn(mappings, name) ? mappings[name] : name} onChange={(event) => setMappings((current) => ({ ...current, [name]: event.target.value }))}>
                    {!Object.hasOwn(selectedCode.props, name) ? <option value={name}>{name}</option> : null}
                    {Object.keys(selectedCode.props).map((codeProp) => <option key={codeProp} value={codeProp}>{codeProp}</option>)}
                  </select>
                </label>)}
              </fieldset> : null}
              <div className={styles.actions}>
                <Button data-testid="design-runtime-bind" disabled={viewerOnly || busy || !selectedCode || !selectedComponent} onClick={bind}>{t('designRuntime.bind')}</Button>
                <Button data-testid="design-runtime-unbind" disabled={viewerOnly || busy || !binding || binding.status === 'unbound'} onClick={() => {
                  if (state && binding && !viewerOnly) void perform((authority) => deleteProjectDesignRuntimeBinding(authority, binding.id, { expectedRevision: state.revision }), acceptMutation);
                }}>{t('designRuntime.unbind')}</Button>
                <Button data-testid="design-runtime-revalidate" disabled={viewerOnly || busy || !binding || binding.status === 'unbound'} onClick={() => {
                  if (state && binding && !viewerOnly) void perform((authority) => revalidateProjectDesignRuntimeBinding(authority, binding.id, { expectedRevision: state.revision }), acceptMutation);
                }}>{t('designRuntime.revalidate')}</Button>
                <Button data-testid="design-runtime-resolve" disabled={busy || !binding} onClick={() => {
                  if (binding) void perform((authority) => resolveProjectDesignRuntimeBinding(authority, binding.id), ({ resolution }) => {
                    if (resolution.ok) setMessage(t('designRuntime.resolved', { name: resolution.codeComponent.name }));
                    else setDiagnostics(resolution.diagnostics);
                  });
                }}>{t('designRuntime.resolve')}</Button>
              </div>
            </section>
            {selectedComponent ? <form className={styles.card} onSubmit={(event) => { event.preventDefault(); validate(); }}>
              <h3>{t('designRuntime.validate')}</h3>
              <fieldset disabled={busy}>
                {Object.entries(selectedComponent.props).map(([name, definition]) => {
                  const draft = Object.hasOwn(propDrafts, name) ? propDrafts[name]! : initialPropDraft(definition);
                  const update = (patch: Partial<PropDraft>) => setPropDrafts((current) => ({ ...current, [name]: { ...draft, ...patch } }));
                  const kinds = definition.type === 'enum' ? [...new Set(definition.values.map(scalarKind))] : [definition.type];
                  return <div key={name} className={styles.propInput}>
                    <label className={styles.include}>
                      <input type="checkbox" data-testid={`design-runtime-prop-include-${name}`} checked={draft.included} onChange={(event) => update({ included: event.target.checked })} />
                      {t('designRuntime.includeProp', { name })}
                    </label>
                    <label className={styles.field}>{name}
                      {definition.type === 'boolean' ? <select data-testid={`design-runtime-prop-${name}`} disabled={!draft.included} value={draft.input} onChange={(event) => update({ input: event.target.value })}>
                        <option value="false">false</option><option value="true">true</option>
                      </select> : <input data-testid={`design-runtime-prop-${name}`} disabled={!draft.included} value={draft.input} list={definition.type === 'enum' ? `${inputId}-${name}-values` : undefined} inputMode={draft.kind === 'number' ? 'decimal' : undefined} onChange={(event) => update({ input: event.target.value })} />}
                    </label>
                    {definition.type === 'enum' ? <datalist id={`${inputId}-${name}-values`}>
                      {definition.values.filter((value) => scalarKind(value) === draft.kind).map((value) => <option key={JSON.stringify(value)} value={String(value)} />)}
                    </datalist> : null}
                    {kinds.length > 1 ? <label className={styles.field}>{t('designRuntime.valueType')}
                      <select disabled={!draft.included} value={draft.kind} onChange={(event) => update({ kind: event.target.value as ScalarKind })}>
                        {kinds.map((kind) => <option key={kind}>{kind}</option>)}
                      </select>
                    </label> : null}
                    <span className={styles.muted}>{definition.required ? t('designRuntime.required') : t('designRuntime.optional')}{definition.default !== undefined ? ` · ${t('common.default')}: ${JSON.stringify(definition.default)}` : ''}</span>
                  </div>;
                })}
                <Button data-testid="design-runtime-validate" type="submit">{t('designRuntime.validate')}</Button>
              </fieldset>
            </form> : null}
          </>}
        </div>
      </div>
    </section>
  );
}

function ComponentMetadata({ component }: { component: ComponentDefinition | CodeComponentDefinition }) {
  const t = useT();
  return <div className={styles.metadata}>
    <p><strong>{component.name}</strong> <code>{component.id}</code></p>
    {'sourcePath' in component ? <p><code>{component.sourcePath}</code> · {component.exportName} · {component.framework}</p> : component.source ? <p><code>{component.source.sourcePath}</code> · {component.source.exportName}</p> : null}
    <h4>{t('designRuntime.props')}</h4>
    {Object.entries(component.props).length ? <dl className={styles.props}>
      {Object.entries(component.props).map(([name, definition]) => <div key={name}>
        <dt>{name}</dt>
        <dd><code>{definition.type === 'enum' ? definition.values.map((value) => JSON.stringify(value)).join(' | ') : definition.type}</code> · {definition.required ? t('designRuntime.required') : t('designRuntime.optional')}
          {definition.default !== undefined ? <span> · {t('common.default')}: <code>{JSON.stringify(definition.default)}</code></span> : null}
        </dd>
      </div>)}
    </dl> : <p className={styles.muted}>{t('common.none')}</p>}
  </div>;
}
