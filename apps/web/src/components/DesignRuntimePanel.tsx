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
import { ProjectStructurePanel } from './ProjectStructurePanel';
import { DesignRuntimeValidationPanel } from './DesignRuntimeValidationPanel';
import { DesignSystemVersionsPanel } from './DesignSystemVersionsPanel';
import { DesignRuntimeSourceSelections } from './DesignRuntimeSourceSelections';
import { DesignHandoffPanel } from './DesignHandoffPanel';
import { DesignPreviewPanel, type DesignPreviewSelection } from './DesignPreviewPanel';
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
  return { sourcePath, exportName: '', framework: 'react', componentId: `component-${identity}`, codeComponentId: `code/${identity}` };
}

function sourceSelections(state: ProjectDesignRuntimeState): SourceSelection[] {
  return (state.registry?.components ?? []).flatMap((component) => {
    // A manually chosen binding target does not replace the original compilation source.
    const code = state.codeIndex.components.find((candidate) => candidate.sourcePath === component.source?.sourcePath && candidate.exportName === component.source?.exportName);
    const metadataExports = new Set(Object.values(component.slots ?? {}).map((slot) => slot.source?.exportName).filter((name): name is string => !!name));
    const storySources = new Map<string, NonNullable<SourceSelection['storySources']>[number]>();
    for (const story of component.stories ?? []) {
      if (!story.source.sourcePath) continue;
      const source = storySources.get(story.source.sourcePath) ?? { sourcePath: story.source.sourcePath, selections: [] };
      source.selections.push({ id: story.id, exportName: story.exportName }); storySources.set(source.sourcePath, source);
    }
    return code ? [{
      sourcePath: code.sourcePath,
      exportName: code.exportName,
      framework: code.framework,
      componentId: component.id,
      codeComponentId: code.id,
      ...(metadataExports.size === 1 ? { metadataExportName: [...metadataExports][0]! } : {}),
      ...(storySources.size ? { storySources: [...storySources.values()] } : {}),
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
  const sourceFiles = files.map(({ name }) => name).filter((name) => /\.(tsx|ts|vue)$/.test(name) && !name.endsWith('.d.ts')).sort();
  const [state, setState] = useState<ProjectDesignRuntimeState | null>(null);
  const [selections, setSelections] = useState<SourceSelection[]>(() => [newSelection(sourceFiles[0])]);
  const [designSystemId, setDesignSystemId] = useState('project');
  const [componentId, setComponentId] = useState('');
  const [codeId, setCodeId] = useState('');
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [transforms, setTransforms] = useState<Record<string, string>>({});
  const [slotMappings, setSlotMappings] = useState<Record<string, string>>({});
  const [propDrafts, setPropDrafts] = useState<Record<string, PropDraft>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [structureBusy, setStructureBusy] = useState(false);
  const [tab, setTab] = useState<'code' | 'structure' | 'versions' | 'validation' | 'handoff' | 'preview'>('code');
  const [previewOpened, setPreviewOpened] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<DesignPreviewSelection>();
  const openPreview = (selection: DesignPreviewSelection) => { setPreviewSelection(selection); setPreviewOpened(true); setTab('preview'); };
  const [handoffOpened, setHandoffOpened] = useState(false);
  const [versionsOpened, setVersionsOpened] = useState(false);
  const [validationOpened, setValidationOpened] = useState(false);
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
    setTransforms(Object.fromEntries(nextBinding?.propMappings?.map((mapping) => [mapping.designProp, mapping.valueTransform !== undefined ? JSON.stringify({ valueTransform: mapping.valueTransform }, null, 2) : mapping.values !== undefined ? JSON.stringify({ values: mapping.values }, null, 2) : '']) ?? []));
    setSlotMappings(Object.fromEntries(nextBinding?.slotMappings?.map((mapping) => [mapping.designSlot, mapping.codeSlot]) ?? []));
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
    let propMappings: NonNullable<ComponentBinding['propMappings']>;
    try {
      propMappings = Object.keys(selectedComponent?.props ?? {}).map((designProp) => {
        const codeProp = Object.hasOwn(mappings, designProp) ? mappings[designProp]! : designProp;
        const input = Object.hasOwn(transforms, designProp) ? transforms[designProp]!.trim() : '';
        const transform: unknown = input ? JSON.parse(input) : {};
        if (transform === null || typeof transform !== 'object' || Array.isArray(transform) || Object.keys(transform).some((key) => key !== 'values' && key !== 'valueTransform')) throw new Error(t('designHandoff.invalidTransform'));
        return { designProp, codeProp, ...transform };
      }).filter((mapping) => mapping.designProp !== mapping.codeProp || Object.hasOwn(mapping, 'values') || Object.hasOwn(mapping, 'valueTransform'));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    const nextBinding: ComponentBinding = {
      schemaVersion: 1,
      id: binding?.id ?? `binding:${state.registry!.id}:${componentId}:${selectedCode.framework}`,
      componentRef,
      framework: selectedCode.framework,
      status: 'bound',
      verified: true,
      codeComponentId: selectedCode.id,
      ...(binding?.source ? { source: binding.source } : {}),
      propMappings,
      slotMappings: Object.entries(slotMappings).filter(([, codeSlot]) => codeSlot !== '').map(([designSlot, codeSlot]) => ({ designSlot, codeSlot })),
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

  return (
    <section id="design-runtime-panel" className={styles.panel} aria-labelledby={`${inputId}-title`} data-testid="design-runtime-panel">
      <header className={styles.header}>
        <div>
          <h2 ref={heading} tabIndex={-1} id={`${inputId}-title`}>{t('designRuntime.title')}</h2>
          <p>{t('designRuntime.description')}</p>
        </div>
        <div className={styles.actions}>
          {state ? <span className={styles.muted}>{t('designRuntime.revision', { revision: state.revision })}</span> : null}
          <Button disabled={busy || structureBusy} onClick={() => void perform(getProjectDesignRuntime, ({ state: nextState }) => adoptState(nextState, state === null))}>{t('designRuntime.refresh')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
        </div>
      </header>
      <div role="tablist" aria-label={t('designRuntime.title')} className={styles.actions}>
        <Button role="tab" id={`${inputId}-code-tab`} aria-controls={`${inputId}-code`} aria-selected={tab === 'code'} disabled={busy || structureBusy} data-testid="design-runtime-code-tab" onClick={() => setTab('code')}>{t('projectStructure.codeTab')}</Button>
        <Button role="tab" id={`${inputId}-structure-tab`} aria-controls={`${inputId}-structure`} aria-selected={tab === 'structure'} disabled={busy || structureBusy} data-testid="design-runtime-structure-tab" onClick={() => setTab('structure')}>{t('projectStructure.title')}</Button>
        <Button role="tab" id={`${inputId}-versions-tab`} aria-controls={`${inputId}-versions`} aria-selected={tab === 'versions'} disabled={busy || structureBusy} data-testid="design-runtime-versions-tab" onClick={() => { setVersionsOpened(true); setTab('versions'); }}>{t('designVersions.title')}</Button>
        <Button role="tab" id={`${inputId}-validation-tab`} aria-controls={`${inputId}-validation`} aria-selected={tab === 'validation'} disabled={busy || structureBusy} data-testid="design-runtime-validation-tab" onClick={() => { setValidationOpened(true); setTab('validation'); }}>{t('designValidation.title')}</Button>
        <Button role="tab" id={`${inputId}-handoff-tab`} aria-controls={`${inputId}-handoff`} aria-selected={tab === 'handoff'} disabled={busy || structureBusy} data-testid="design-runtime-handoff-tab" onClick={() => { setHandoffOpened(true); setTab('handoff'); }}>{t('designHandoff.title')}</Button>
        <Button role="tab" id={`${inputId}-preview-tab`} aria-controls={`${inputId}-preview`} aria-selected={tab === 'preview'} disabled={busy || structureBusy} data-testid="design-runtime-preview-tab" onClick={() => { setPreviewSelection(undefined); setPreviewOpened(true); setTab('preview'); }}>{t('designPreview.title')}</Button>
      </div>
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
      <div id={`${inputId}-code`} role="tabpanel" aria-labelledby={`${inputId}-code-tab`} hidden={tab !== 'code'}>
      <div className={styles.columns}>
        <form className={styles.card} onSubmit={(event) => { event.preventDefault(); compile(); }}>
          <h3>{t('designRuntime.sources')}</h3>
          <p className={styles.muted}>{t('designRuntime.sourceHint')}</p>
          <fieldset disabled={viewerOnly || busy || !state}>
            <label className={styles.field}>{t('designRuntime.systemId')}
              <input data-testid="design-runtime-system-id" value={designSystemId} readOnly={!!state?.registry} required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" onChange={(event) => setDesignSystemId(event.target.value)} />
            </label>
            <DesignRuntimeSourceSelections selections={selections} files={sourceFiles} onChange={setSelections} />
            <div className={styles.actions}>
              <Button data-testid="design-runtime-add-source" onClick={() => setSelections((current) => [...current, newSelection(sourceFiles[0])])}>{t('designRuntime.addSource')}</Button>
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
                {selectedComponent.stories?.length ? <><h4>{t('designRuntime.stories')}</h4><ul>{selectedComponent.stories.map((story) => <li key={story.id}><strong>{story.name}</strong> · <code>{story.exportName}</code><p>{Object.entries(story.args).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join(', ')}</p><code>{story.source.sourcePath}</code></li>)}</ul></> : null}
              </> : null}
            </section>
            <section className={styles.card}>
              <h3>{t('designRuntime.binding')}</h3>
              <p>{t('designRuntime.status')}: <strong data-testid="design-runtime-binding-status">{t(`designRuntime.status.${binding?.status ?? 'unbound'}`)}</strong></p>
              {binding && binding.status !== 'unbound' ? <p className={styles.muted}>{t('designRuntime.boundTarget')}: <code>{binding.codeComponentId}</code></p> : null}
              <label className={styles.field}>{t('designRuntime.codeComponent')}
                <select data-testid="design-runtime-code-select" value={codeId} disabled={busy} onChange={(event) => { setCodeId(event.target.value); setMappings({}); setSlotMappings({}); setDiagnostics(null); setMessage(''); }}>
                  {state.codeIndex.components.map((component) => <option key={component.id} value={component.id}>{component.name} · {component.id}</option>)}
                </select>
              </label>
              {selectedCode ? <ComponentMetadata component={selectedCode} /> : null}
              {selectedComponent && selectedCode ? <fieldset disabled={viewerOnly || busy}>
                <legend>{t('designRuntime.propMappings')}</legend>
                {Object.keys(selectedComponent.props).map((name) => <div key={name}><label className={styles.mapping}>
                  <code>{name}</code><span aria-hidden="true">→</span>
                  <select aria-label={`${t('designRuntime.propMappings')}: ${name}`} value={Object.hasOwn(mappings, name) ? mappings[name] : name} onChange={(event) => setMappings((current) => ({ ...current, [name]: event.target.value }))}>
                    {!Object.hasOwn(selectedCode.props, name) ? <option value={name}>{name}</option> : null}
                    {Object.keys(selectedCode.props).map((codeProp) => <option key={codeProp} value={codeProp}>{codeProp}</option>)}
                  </select>
                </label><label className={styles.field}>{t('designHandoff.valueTransform')}: {name}
                  <textarea rows={2} data-testid={`design-runtime-value-transform-${name}`} value={Object.hasOwn(transforms, name) ? transforms[name] : ''} onChange={(event) => setTransforms((current) => ({ ...current, [name]: event.target.value }))} />
                </label></div>)}
                <p className={styles.muted}>{t('designHandoff.transformHint')}</p>
              </fieldset> : null}
              {selectedComponent && selectedCode && Object.keys(selectedComponent.slots ?? {}).length ? <fieldset disabled={viewerOnly || busy}>
                <legend>{t('designRuntime.slotMappings')}</legend>
                {Object.keys(selectedComponent.slots ?? {}).map((name) => {
                  const target = Object.hasOwn(slotMappings, name) ? slotMappings[name]! : '';
                  return <label className={styles.mapping} key={name}><code>{name}</code><span aria-hidden="true">→</span>
                    <select data-testid={`design-runtime-slot-mapping-${name}`} aria-label={`${t('designRuntime.slotMappings')}: ${name}`} value={target} onChange={(event) => setSlotMappings((current) => ({ ...current, [name]: event.target.value }))}>
                      <option value="">{t('designRuntime.chooseCodeSlot')}</option>
                      {target && !Object.hasOwn(selectedCode.slots ?? {}, target) ? <option value={target}>{target}</option> : null}
                      {Object.keys(selectedCode.slots ?? {}).map((codeSlot) => <option value={codeSlot} key={codeSlot}>{codeSlot}</option>)}
                    </select>
                  </label>;
                })}
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
      </div>
      <div id={`${inputId}-structure`} role="tabpanel" aria-labelledby={`${inputId}-structure-tab`} hidden={tab !== 'structure'}>
        {state ? <ProjectStructurePanel scope={scope} state={state} sourceIdentity={files} viewerOnly={viewerOnly} externalBusy={busy} onState={(next) => adoptState(next)} onBusyChange={setStructureBusy} onPreview={openPreview} /> : null}
      </div>
      <div id={`${inputId}-handoff`} role="tabpanel" aria-labelledby={`${inputId}-handoff-tab`} hidden={tab !== 'handoff'}>
        {handoffOpened && state ? <DesignHandoffPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} externalBusy={busy} onState={(next) => adoptState(next)} onBusyChange={setStructureBusy} /> : null}
      </div>
      <div id={`${inputId}-versions`} role="tabpanel" aria-labelledby={`${inputId}-versions-tab`} hidden={tab !== 'versions'}>
        {versionsOpened ? <DesignSystemVersionsPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} externalBusy={busy} onState={(next) => { adoptState(next); setError(''); setDiagnostics(null); }} onBusyChange={setStructureBusy} onPreview={openPreview} /> : null}
      </div>
      <div id={`${inputId}-preview`} role="tabpanel" aria-labelledby={`${inputId}-preview-tab`} hidden={tab !== 'preview'}>
        {previewOpened && tab === 'preview' && state ? <DesignPreviewPanel key={previewSelection?.id ?? 'current'} scope={scope} state={state} selection={previewSelection} sourceIdentity={files} externalBusy={busy} onBusyChange={setStructureBusy} /> : null}
      </div>
      <div id={`${inputId}-validation`} role="tabpanel" aria-labelledby={`${inputId}-validation-tab`} hidden={tab !== 'validation'}>
        {validationOpened ? <DesignRuntimeValidationPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} externalBusy={busy} onState={(next) => { adoptState(next); setError(''); setDiagnostics(null); }} onBusyChange={setStructureBusy} /> : null}
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
