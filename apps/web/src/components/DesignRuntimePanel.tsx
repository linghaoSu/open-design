import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, VisuallyHidden } from '@open-design/components';
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
import { DesignRuntimeLegacyMigration, isLegacyDesignSource, legacyHtmlDesignSources } from './DesignRuntimeLegacyMigration';
import { DesignHandoffPanel } from './DesignHandoffPanel';
import { DesignPreviewPanel, type DesignPreviewSelection } from './DesignPreviewPanel';
import { Icon } from './Icon';
import { ReactComponentPreview } from './ReactComponentPreview';
import styles from './DesignRuntimePanel.module.css';

interface Props {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  files: readonly { name: string; size?: number; mtime?: number; type?: 'file' | 'dir' }[];
  viewerOnly: boolean;
  onClose(): void;
  onOpenSource?(sourcePath: string, exportName?: string): void;
  initialTab?: 'migration';
}

type SourceSelection = ProjectDesignRuntimeCompileRequest['selections'][number];
type ScalarKind = 'string' | 'number' | 'boolean' | 'null';
type RuntimeTab = 'overview' | 'code' | 'structure' | 'migration' | 'versions' | 'validation' | 'handoff' | 'preview';
interface PropDraft { included: boolean; input: string; kind: ScalarKind }

function newSelection(sourcePath = ''): SourceSelection {
  const identity = crypto.randomUUID();
  const framework = sourcePath.endsWith('.vue') ? 'vue' : 'react';
  return { sourcePath, exportName: framework === 'vue' ? 'default' : '', framework, componentId: `component-${identity}`, codeComponentId: `code/${identity}` };
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

function DesignRuntimePanelContent({ projectId, workspaceContext, files, viewerOnly, onClose, onOpenSource, initialTab }: Props) {
  const t = useT();
  const inputId = useId();
  const sourceFiles = files.map(({ name }) => name).filter((name) => /\.(tsx|ts|vue)$/.test(name) && !name.endsWith('.d.ts')).sort();
  const [state, setState] = useState<ProjectDesignRuntimeState | null>(null);
  const [selections, setSelections] = useState<SourceSelection[]>(() => [newSelection(sourceFiles[0])]);
  const [designSystemId, setDesignSystemId] = useState('project');
  const [componentId, setComponentId] = useState('');
  const [codeId, setCodeId] = useState('');
  const [bindingFramework, setBindingFramework] = useState<'react' | 'vue'>('react');
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [transforms, setTransforms] = useState<Record<string, string>>({});
  const [slotMappings, setSlotMappings] = useState<Record<string, string>>({});
  const [propDrafts, setPropDrafts] = useState<Record<string, PropDraft>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [structureBusy, setStructureBusy] = useState(false);
  const [tab, setTab] = useState<RuntimeTab>(initialTab ?? 'overview');
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [componentView, setComponentView] = useState<'list' | 'detail'>('list');
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const componentList = useRef<HTMLDivElement>(null);
  const moreMenu = useRef<HTMLDetailsElement>(null);
  const [migrationOpened, setMigrationOpened] = useState(initialTab === 'migration');
  const [previewOpened, setPreviewOpened] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<DesignPreviewSelection>();
  const openPreview = (selection: DesignPreviewSelection) => { setPreviewSelection(selection); setPreviewOpened(true); setTab('preview'); };
  const [handoffOpened, setHandoffOpened] = useState(false);
  const [versionsOpened, setVersionsOpened] = useState(false);
  const [validationOpened, setValidationOpened] = useState(false);
  function navigate(next: RuntimeTab) {
    if (next === 'migration') setMigrationOpened(true);
    if (next === 'versions') setVersionsOpened(true);
    if (next === 'validation') setValidationOpened(true);
    if (next === 'handoff') setHandoffOpened(true);
    if (next === 'preview') { setPreviewSelection(undefined); setPreviewOpened(true); }
    if (moreMenu.current) moreMenu.current.open = false;
    setTab(next);
  }
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
    && candidate.framework === (selectedCode?.framework ?? bindingFramework));
  const searchQuery = query.trim().toLowerCase();
  const visibleComponents = state?.registry?.components.filter((component) =>
    `${component.name} ${component.source?.exportName ?? ''} ${component.id}`.toLowerCase().includes(searchQuery)) ?? [];
  const registryLocked = !!state?.lock.dependencies.length;
  const legacyHtmlSources = legacyHtmlDesignSources(files, state?.registry?.components.flatMap((component) => component.source?.sourcePath ? [component.source.sourcePath] : []) ?? []);
  const hasLegacyFiles = legacyHtmlSources.length > 0 || files.some((file) => file.type !== 'dir' && !/\.html?$/i.test(file.name) && isLegacyDesignSource(file.name));
  const previewSource = selectedComponent?.source?.exportName && /\.[jt]sx$/.test(selectedComponent.source.sourcePath ?? '')
    && files.some((file) => file.type !== 'dir' && file.name === selectedComponent.source?.sourcePath)
    ? selectedComponent.source : undefined;

  function browseComponent(id: string) {
    if (id !== componentId) selectComponent(id);
    setComponentView('detail');
  }

  useEffect(() => {
    if (componentView === 'detail') detailHeading.current?.focus();
    else componentList.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
  }, [componentView, componentId]);

  function selectComponent(nextId: string, nextState = state, preferredBinding?: ComponentBinding) {
    setComponentId(nextId);
    const ref = nextState?.registry ? `ds:${nextState.registry.id}/${nextId}` : '';
    const nextBinding = preferredBinding ?? nextState?.bindings.bindings.find((candidate) => candidate.componentRef === ref);
    const candidateCode = nextBinding ? nextState?.codeIndex.components.find((code) => code.framework === nextBinding.framework) : nextState?.codeIndex.components[0];
    setBindingFramework(nextBinding?.framework ?? candidateCode?.framework ?? 'react');
    setCodeId(nextBinding && nextBinding.status !== 'unbound' ? nextBinding.codeComponentId : candidateCode?.id ?? '');
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
      setTab(initialTab ?? (nextState.registry ? 'code' : 'overview'));
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
        if (mounted.current && generation.current === current) {
          adoptState(nextState, true);
        }
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
    if (viewerOnly || !state || registryLocked) return;
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
          <Button variant="ghost" size="icon" aria-label={t('designRuntime.refresh')} title={t('designRuntime.refresh')} disabled={busy || structureBusy} onClick={() => void perform(getProjectDesignRuntime, ({ state: nextState }) => adoptState(nextState, state === null))}><Icon name="refresh" size={16} /></Button>
          <Button variant="ghost" size="icon" aria-label={t('common.close')} title={t('common.close')} onClick={onClose}><Icon name="close" size={16} /></Button>
        </div>
      </header>
      <div role="tablist" aria-label={t('designRuntime.title')} className={styles.navigation}>
        {(['overview', 'code', 'preview'] as const).map((id) => <Button key={id} variant="ghost" className={styles.tab} role="tab" id={`${inputId}-${id}-tab`} aria-controls={`${inputId}-${id}`} aria-selected={tab === id} disabled={busy || structureBusy} data-testid={`design-runtime-${id}-tab`} onClick={() => navigate(id)}>{id === 'overview' ? t('designWorkspace.overview') : id === 'code' ? t('designRuntime.components') : t('designPreview.title')}</Button>)}
        <details ref={moreMenu} className={styles.more} data-testid="design-runtime-more">
          <summary className={styles.moreTrigger} data-active={!['overview', 'code', 'preview'].includes(tab)}>{t('designWorkspace.more')}<Icon name="chevron-down" size={12} /></summary>
          <div className={styles.moreMenu}>
            {(['migration', 'versions', 'structure', 'validation', 'handoff'] as const).map((id) => <Button key={id} variant="ghost" className={styles.tab} role="tab" id={`${inputId}-${id}-tab`} aria-controls={`${inputId}-${id}`} aria-selected={tab === id} disabled={busy || structureBusy} data-testid={`design-runtime-${id}-tab`} onClick={() => navigate(id)}>{id === 'migration' ? t('designWorkspace.migrateTitle') : id === 'versions' ? t('designVersions.title') : id === 'structure' ? t('projectStructure.title') : id === 'validation' ? t('designValidation.title') : t('designHandoff.title')}</Button>)}
          </div>
        </details>
      </div>
      <div className={styles.content}>
      {viewerOnly ? <p className={styles.notice}>{t('designRuntime.readOnly')}</p> : null}
      {busy ? <p role="status">{t('common.loading')}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {state && !registryLocked && legacyHtmlSources.length > 0 && (tab === 'overview' || tab === 'code') ? <div className={styles.repair} data-testid="design-runtime-legacy-html">
        <Icon name="folder-transfer" size={18} /><div><strong>{t('designWorkspace.legacyHtmlTitle')}</strong><p>{t('designWorkspace.legacyHtmlHint')}</p><p><code>{legacyHtmlSources.join(', ')}</code></p></div>
        <Button disabled={busy || structureBusy} data-testid="design-runtime-migrate-html" onClick={() => navigate('migration')}>{t('designWorkspace.openMigration')}</Button>
      </div> : null}
      {diagnostics?.length ? <ul className={styles.diagnostics} aria-label={t('designRuntime.diagnostics')}>
        {diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>
          <strong>{diagnostic.code}</strong> <span>{diagnostic.message}</span>
          {diagnostic.path ? <code>{diagnostic.path.join(' → ')}</code> : null}
          {diagnostic.allowedValues ? <span>{t('designRuntime.allowedValues')}: {diagnostic.allowedValues.map((value) => JSON.stringify(value)).join(', ')}</span> : null}
        </li>)}
      </ul> : null}
      <div id={`${inputId}-overview`} role="tabpanel" aria-labelledby={`${inputId}-overview-tab`} hidden={tab !== 'overview'}>
        {state ? <DesignSystemOverview state={state} hasLegacyFiles={hasLegacyFiles} hasSourceFiles={sourceFiles.length > 0} disabled={busy || structureBusy} onNavigate={navigate} onRepair={(id, target) => { selectComponent(id, state, target); setComponentView('detail'); setConnectionsOpen(true); navigate('code'); }} /> : null}
      </div>
      <div id={`${inputId}-code`} role="tabpanel" aria-labelledby={`${inputId}-code-tab`} hidden={tab !== 'code'}>
      {!state?.registry ? <p className={styles.sectionIntro}>{t('designWorkspace.componentsHint')}</p> : null}
      {registryLocked ? <div className={styles.versionNotice} data-testid="design-runtime-locked-registry"><p>{t('designWorkspace.lockedRegistry')}</p><Button variant="ghost" disabled={busy || structureBusy} data-testid="design-runtime-manage-version" onClick={() => navigate('versions')}>{t('designVersions.title')}<Icon name="arrow-right" size={14} /></Button></div> : null}
      <div className={styles.columns}>
        <details className={styles.sourceSetup} open={!state?.registry} data-testid="design-runtime-source-setup">
        <summary>{t('designWorkspace.editSources')}</summary>
        <form className={styles.card} onSubmit={(event) => { event.preventDefault(); compile(); }}>
          <h3>{t('designRuntime.sources')}</h3>
          <p className={styles.muted}>{t(sourceFiles.length ? 'designRuntime.sourceHint' : 'designWorkspace.noSourceFiles')}</p>
          <fieldset disabled={viewerOnly || busy || !state || registryLocked}>
            <details className={styles.advanced}>
              <summary>{t('designWorkspace.advanced')}</summary>
              <label className={styles.field}>{t('designRuntime.systemId')}
                <input data-testid="design-runtime-system-id" value={designSystemId} readOnly={!!state?.registry} required pattern="[A-Za-z0-9][A-Za-z0-9._-]*" onChange={(event) => setDesignSystemId(event.target.value)} />
              </label>
            </details>
            <DesignRuntimeSourceSelections selections={selections} files={sourceFiles} onChange={setSelections} />
            <div className={styles.actions}>
              <Button data-testid="design-runtime-add-source" onClick={() => setSelections((current) => [...current, newSelection(sourceFiles[0])])}>{t('designRuntime.addSource')}</Button>
              <Button data-testid="design-runtime-compile" type="submit" variant="primary" disabled={!sourceFiles.length}>{t('designRuntime.compile')}</Button>
            </div>
          </fieldset>
          {onOpenSource ? <div className={styles.actions}>{selections.map((selection, index) => /\.[jt]sx$/i.test(selection.sourcePath) && files.some((file) => file.type !== 'dir' && file.name === selection.sourcePath)
            ? <Button key={index} variant="ghost" disabled={busy || structureBusy} data-testid={`design-runtime-preview-selection-${index}`} onClick={() => onOpenSource(selection.sourcePath, selection.exportName || undefined)}><Icon name="external-link" size={14} />{t('designWorkspace.previewFile', { file: selection.sourcePath })}</Button> : null)}</div> : null}
        </form>
        </details>
        <div className={styles.catalog} data-view={componentView} data-empty={!state?.registry?.components.length} data-testid="design-runtime-catalog">
          {!state?.registry ? null : <>
            <div className={styles.componentList} ref={componentList}>
              <div className={styles.listHeading}><h3>{t('designRuntime.components')}</h3><span data-testid="design-runtime-component-count" aria-live="polite">{searchQuery ? `${visibleComponents.length} / ${state.registry.components.length}` : state.registry.components.length}</span></div>
              <label className={styles.componentSearch}><VisuallyHidden>{t('common.search')}</VisuallyHidden><Icon name="search" size={15} />
                <Input type="search" placeholder={t('common.search')} data-testid="design-runtime-component-search" value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              <div className={styles.componentRows} aria-label={t('designRuntime.components')}>
                {visibleComponents.map((component) => <Button key={component.id} variant="ghost" className={styles.componentRow} data-testid={`design-runtime-component-select-${component.id}`} aria-pressed={componentId === component.id} aria-controls={`${inputId}-component-detail`} disabled={busy} onClick={() => browseComponent(component.id)}><Icon name="blocks" size={16} /><span>{component.name}{component.source?.exportName && component.source.exportName !== component.name ? <small>{component.source.exportName}</small> : null}</span><Icon name="chevron-right" size={14} /></Button>)}
              </div>
              {!visibleComponents.length ? <p className={styles.emptyList} role="status">{t(state.registry.components.length ? 'designWorkspace.noMatches' : registryLocked ? 'designWorkspace.noVersionComponents' : 'designWorkspace.noComponents')}</p> : null}
            </div>
            <div className={styles.componentDetail} id={`${inputId}-component-detail`} role="region" aria-label={t('designWorkspace.componentDetails')}>
            <Button variant="ghost" className={styles.backToList} data-testid="design-runtime-back-to-components" onClick={() => setComponentView('list')}><Icon name="arrow-left" size={14} />{t('designWorkspace.backToComponents')}</Button>
            <section className={styles.card}>
              {selectedComponent ? <>
                <div className={styles.detailHeading}><h3 ref={detailHeading} tabIndex={-1}>{selectedComponent.name}</h3>
                  {previewSource && onOpenSource ? <Button variant="ghost" data-testid="design-runtime-preview-source" onClick={() => onOpenSource(previewSource.sourcePath!, previewSource.exportName)}><Icon name="external-link" size={15} />{t('designWorkspace.openSource')}</Button> : null}
                </div>
                {previewSource ? <div className={styles.inlinePreview}><ReactComponentPreview layout="component" projectId={projectId} workspaceContext={workspaceContext} sourcePath={previewSource.sourcePath!} sourceIdentity={JSON.stringify(files.filter((file) => file.name === previewSource.sourcePath))} componentPreviewRequest={{ exportName: previewSource.exportName, nonce: 0 }} /></div> : <ComponentMetadata component={selectedComponent} hideName />}
                <details className={styles.advanced}><summary>{t('designWorkspace.componentDetails')}</summary>
                {previewSource ? <ComponentMetadata component={selectedComponent} hideName /> : null}
                <p className={styles.muted}><code>{selectedComponent.id}</code></p>
                {selectedComponent.source ? <p className={styles.muted}><code>{selectedComponent.source.sourcePath}</code> · {selectedComponent.source.exportName}</p> : null}
                <h4>{t('designRuntime.slots')}</h4>
                {Object.entries(selectedComponent.slots ?? {}).length ? <ul>
                  {Object.entries(selectedComponent.slots ?? {}).map(([name, slot]) => <li key={name}>
                    <strong>{name}</strong>: {slot.accepts.join(', ')} · {slot.required ? t('designRuntime.required') : t('designRuntime.optional')} · {slot.multiple ? t('designRuntime.multiple') : t('designRuntime.single')}
                  </li>)}
                </ul> : <p className={styles.muted}>{t('common.none')}</p>}
                {selectedComponent.stories?.length ? <><h4>{t('designRuntime.stories')}</h4><ul>{selectedComponent.stories.map((story) => <li key={story.id}><strong>{story.name}</strong> · <code>{story.exportName}</code><p>{Object.entries(story.args).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join(', ')}</p><code>{story.source.sourcePath}</code></li>)}</ul></> : null}
                </details>
              </> : null}
            </section>
            <details className={styles.advanced} open={connectionsOpen} onToggle={(event) => { if (event.target === event.currentTarget) setConnectionsOpen(event.currentTarget.open); }} data-testid="design-runtime-connections"><summary>{t('designWorkspace.connections')}</summary>
            <section className={styles.card}>
              <h3>{t('designRuntime.binding')}</h3>
              <p>{t('designRuntime.status')}: <strong data-testid="design-runtime-binding-status">{t(`designRuntime.status.${binding?.status ?? 'unbound'}`)}</strong></p>
              {binding && binding.status !== 'unbound' ? <p className={styles.muted}>{t('designRuntime.boundTarget')}: <code>{binding.codeComponentId}</code></p> : null}
              <label className={styles.field}>{t('designRuntime.codeComponent')}
                <select data-testid="design-runtime-code-select" value={codeId} disabled={busy} onChange={(event) => { const code = state.codeIndex.components.find((candidate) => candidate.id === event.target.value); if (code) setBindingFramework(code.framework); setCodeId(event.target.value); setMappings({}); setSlotMappings({}); setDiagnostics(null); setMessage(''); }}>
                  {!selectedCode ? <option value={codeId}>{codeId || t('common.none')}</option> : null}
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
            </details>
            {selectedComponent ? <details className={styles.advanced} data-testid="design-runtime-usage-checks"><summary>{t('designWorkspace.usageChecks')}</summary><form className={styles.card} onSubmit={(event) => { event.preventDefault(); validate(); }}>
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
            </form></details> : null}
            </div>
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
      <div id={`${inputId}-migration`} role="tabpanel" aria-labelledby={`${inputId}-migration-tab`} hidden={tab !== 'migration'}>
        {migrationOpened ? <DesignRuntimeLegacyMigration scope={scope} state={state} files={files} viewerOnly={viewerOnly} externalBusy={busy} onState={(next) => { adoptState(next); setError(''); setDiagnostics(null); }} onBusyChange={setStructureBusy} /> : null}
      </div>
      <div id={`${inputId}-versions`} role="tabpanel" aria-labelledby={`${inputId}-versions-tab`} hidden={tab !== 'versions'}>
        {versionsOpened ? <DesignSystemVersionsPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} externalBusy={busy} onState={(next) => { adoptState(next); setError(''); setDiagnostics(null); }} onBusyChange={setStructureBusy} onPreview={openPreview} /> : null}
      </div>
      <div id={`${inputId}-preview`} role="tabpanel" aria-labelledby={`${inputId}-preview-tab`} hidden={tab !== 'preview'}>
        <p className={styles.sectionIntro}>{t('designWorkspace.previewHint')}</p>
        {previewOpened && tab === 'preview' && state ? <DesignPreviewPanel key={previewSelection?.id ?? 'current'} scope={scope} state={state} selection={previewSelection} sourceIdentity={files} externalBusy={busy} onBusyChange={setStructureBusy} onOpenStructure={() => navigate('structure')} /> : null}
      </div>
      <div id={`${inputId}-validation`} role="tabpanel" aria-labelledby={`${inputId}-validation-tab`} hidden={tab !== 'validation'}>
        {validationOpened ? <DesignRuntimeValidationPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} externalBusy={busy} onState={(next) => { adoptState(next); setError(''); setDiagnostics(null); }} onBusyChange={setStructureBusy} /> : null}
      </div>
      </div>
    </section>
  );
}

function DesignSystemOverview({ state, hasLegacyFiles, hasSourceFiles, disabled, onNavigate, onRepair }: {
  state: ProjectDesignRuntimeState;
  hasLegacyFiles: boolean;
  hasSourceFiles: boolean;
  disabled: boolean;
  onNavigate(tab: RuntimeTab): void;
  onRepair(componentId: string, binding: ComponentBinding): void;
}) {
  const t = useT();
  const hasSystem = !!state.registry;
  const componentRefs = new Map((state.registry?.components ?? []).map((component) => [`ds:${state.registry!.id}/${component.id}`, component.id]));
  const connectionIssues = state.bindings.bindings.filter((binding) => binding.status !== 'bound' && componentRefs.has(binding.componentRef));
  return <div className={styles.overview}>
    <div className={styles.overviewHeading}>
      <h3>{t(hasSystem ? 'designRuntime.components' : 'designWorkspace.startTitle')}</h3>
      <p>{t(hasSystem ? 'designWorkspace.existingHint' : 'designWorkspace.startHint')}</p>
    </div>
    {hasSystem ? <>
      <div className={styles.stats}>
        <Button variant="ghost" disabled={disabled} onClick={() => onNavigate('code')}><Icon name="blocks" size={18} />{t('designWorkspace.componentsCount', { count: state.registry!.components.length })}<Icon name="chevron-right" size={14} /></Button>
        <Button variant="ghost" disabled={disabled} onClick={() => onNavigate('preview')}><Icon name="layout" size={18} />{t('designWorkspace.screensCount', { count: state.document?.screens.length ?? 0 })}<Icon name="chevron-right" size={14} /></Button>
      </div>
      {connectionIssues.length ? <div className={styles.repair}>
        <Icon name="alert-triangle" size={18} />
        <div><strong>{t('designWorkspace.repairTitle')}</strong><p>{t('designWorkspace.repairHint', { count: connectionIssues.length })}</p></div>
        <Button disabled={disabled} data-testid="design-runtime-repair-connections" onClick={() => onRepair(componentRefs.get(connectionIssues[0]!.componentRef)!, connectionIssues[0]!)}>{t('designWorkspace.connections')}</Button>
      </div> : null}
    </> : null}
    {!hasSystem && hasLegacyFiles ? <p className={styles.detected}><Icon name="check" size={16} />{t('designWorkspace.legacyDetected')}</p> : null}
    <div className={styles.choices}>
      <section className={styles.choice}>
        <Icon name="folder-transfer" size={22} />
        <h4>{t('designWorkspace.migrateTitle')}</h4>
        <p>{t('designWorkspace.migrateHint')}</p>
        <Button data-testid="design-runtime-start-migration" variant={!hasSystem && hasLegacyFiles ? 'primary' : 'default'} disabled={disabled} onClick={() => onNavigate('migration')}>{t('designWorkspace.openMigration')}<Icon name="arrow-right" size={14} /></Button>
      </section>
      <section className={styles.choice}>
        <Icon name="blocks" size={22} />
        <h4>{t('designWorkspace.createTitle')}</h4>
        <p>{t(hasSourceFiles ? 'designWorkspace.createHint' : 'designWorkspace.noSourceFiles')}</p>
        <Button data-testid="design-runtime-start-code" variant={!hasLegacyFiles ? 'primary' : 'default'} disabled={disabled} onClick={() => onNavigate('code')}>{t('designWorkspace.openSources')}<Icon name="arrow-right" size={14} /></Button>
      </section>
    </div>
    <div className={styles.importPackage}>
      <p>{t('designWorkspace.importHint')}</p>
      <Button variant="ghost" disabled={disabled} data-testid="design-runtime-import-version" onClick={() => onNavigate('versions')}><Icon name="import" size={15} />{t('designWorkspace.importVersion')}</Button>
    </div>
  </div>;
}

function ComponentMetadata({ component, hideName = false }: { component: ComponentDefinition | CodeComponentDefinition; hideName?: boolean }) {
  const t = useT();
  return <div className={styles.metadata}>
    {!hideName ? <p><strong>{component.name}</strong></p> : null}
    {'sourcePath' in component ? <p><code>{component.sourcePath}</code> · {component.exportName} · {component.framework}</p> : null}
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
