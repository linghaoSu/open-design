import { useEffect, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import type {
  ComponentDeletionAnalysis, ComponentInstance, ProjectDesignRuntimeState, ProjectComponentDefinition,
  ProjectDesignRuntimeDeleteComponentRequest, SharedComponentImpact, UIIRDocument, UIIRNode, ValidationDiagnostic,
} from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import {
  deleteProjectDesignRuntimeComponent, detachProjectDesignRuntimeInstance, discardProjectDesignRuntimeComponent,
  getProjectDesignRuntime, getProjectDesignRuntimeChange, getProjectDesignRuntimeDeletion,
  ProjectDesignRuntimeError, publishProjectDesignRuntimeComponent, saveProjectDesignRuntimeDocument,
  stageProjectDesignRuntimeComponent, undoProjectDesignRuntimeComponent, validateProjectDesignRuntimeDocument,
  type ProjectDesignRuntimeScope,
} from '../providers/design-runtime';
import { useT } from '../i18n';
import { SemanticScreenEditor, SemanticTemplateEditor, SemanticTreeEditor } from './SemanticTreeEditor';
import { DesignRuntimePatterns } from './DesignRuntimePatterns';
import { PublicComponentPropsEditor } from './PublicComponentPropsEditor';
import { ComponentImpact, ReferenceUsages, StructureDiagnostics } from './ProjectStructureReview';
import { adoptSubtree, allNodes, formForDefinition, freshId, prepareDefinition, type ComponentFormDraft } from './project-structure-drafts';
import styles from './ProjectStructurePanel.module.css';

interface Props {
  scope: ProjectDesignRuntimeScope;
  state: ProjectDesignRuntimeState;
  viewerOnly: boolean;
  externalBusy?: boolean;
  sourceIdentity?: unknown;
  onState(state: ProjectDesignRuntimeState): void;
  onBusyChange?(busy: boolean): void;
}
interface DocumentWork { value: UIIRDocument; base: string; dirty: boolean }
interface Extraction { componentId: string; source: UIIRNode; publishedRevision?: number }
const fingerprint = (value: unknown) => JSON.stringify(value);
const documentWork = (state: ProjectDesignRuntimeState): DocumentWork => ({
  value: structuredClone(state.document ?? { schemaVersion: 1, id: freshId('document'), screens: [] }),
  base: fingerprint(state.document), dirty: false,
});

/** Scope remounts discard local authority and cancel late results, including account switches. */
export function ProjectStructurePanel(props: Props) {
  return <ProjectStructurePanelContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext)])} {...props} />;
}

function ProjectStructurePanelContent({ scope, state, viewerOnly, externalBusy = false, sourceIdentity, onState, onBusyChange }: Props) {
  const t = useT();
  const [work, setWork] = useState(() => documentWork(state));
  const [screenId, setScreenId] = useState(state.document?.screens[0]?.id ?? '');
  const [componentId, setComponentId] = useState('');
  const [forms, setForms] = useState<ComponentFormDraft[]>([]);
  const [view, setView] = useState<'screen' | 'component'>('screen');
  const [busy, setBusy] = useState(false);
  const [patternsOpened, setPatternsOpened] = useState(false);
  const [patternsBusy, setPatternsBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const [impact, setImpact] = useState<{ revision: number; draftId: string; value: SharedComponentImpact } | null>(null);
  const [deletion, setDeletion] = useState<{ revision: number; value: ComponentDeletionAnalysis } | null>(null);
  const [deleteAction, setDeleteAction] = useState<ProjectDesignRuntimeDeleteComponentRequest['action']['type']>('reject');
  const [replacementRef, setReplacementRef] = useState('');
  const [extraction, setExtraction] = useState<Extraction | null>(null);
  const [detachId, setDetachId] = useState('');
  const [detached, setDetached] = useState<{ source: ComponentInstance; node: UIIRNode; revision: number } | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); busyCallback.current?.(false); };
  }, []);
  useEffect(() => {
    // Refreshes can update clean documents; they never replace an edited draft.
    setWork((previous) => !previous.dirty && previous.base !== fingerprint(state.document) ? documentWork(state) : previous);
  }, [state.document]);

  const locked = busy || externalBusy || patternsBusy;
  const disabled = viewerOnly || locked;
  const selectedScreen = work.value.screens.find((screen) => screen.id === screenId);
  const form = forms.find((entry) => entry.id === componentId);
  const prepared = form ? prepareDefinition(form) : null;
  const published = state.projectComponents.components.find((entry) => entry.id === componentId);
  const pending = state.sharedChanges.drafts.find((entry) => entry.componentRef === `local:${componentId}`);
  const componentConflict = !!form && (form.baseRevision !== (published?.revision ?? 0)
    || (pending !== undefined && pending.id !== form.draftId)
    || state.sharedChanges.history.some((entry) => entry.changeId === form.draftId));
  const documentConflict = work.dirty && work.base !== fingerprint(state.document);
  const currentImpact = impact && impact.draftId === pending?.id ? impact : null;
  const unstaged = !!pending && (!prepared?.success || fingerprint(prepared.definition) !== fingerprint(pending.proposedDefinition));
  const instances = allNodes(selectedScreen?.children ?? []).filter((node): node is ComponentInstance => node.type === 'instance');
  const selectedInstance = instances.find((instance) => instance.id === detachId) ?? instances[0];
  const history = state.sharedChanges.history.filter((entry) => entry.componentRef === `local:${componentId}`).slice().sort((a, b) => b.definition.revision - a.definition.revision);
  const catalog = { registry: state.registry, localComponents: state.projectComponents.components };

  function updateForm(next: ComponentFormDraft) {
    setForms((previous) => [...previous.filter((entry) => entry.id !== next.id), next]);
  }
  function selectComponent(id: string) {
    setComponentId(id); setView('component'); setDeletion(null); setError(''); setDiagnostics([]);
    if (forms.some((entry) => entry.id === id)) return;
    const staged = state.sharedChanges.drafts.find((entry) => entry.componentRef === `local:${id}`);
    const definition = staged?.proposedDefinition ?? state.projectComponents.components.find((entry) => entry.id === id);
    if (definition) updateForm(formForDefinition(definition, staged ? staged.baseDefinition?.revision ?? 0 : definition.revision, staged?.id));
  }
  function newComponent(source?: UIIRNode) {
    const id = freshId('component');
    updateForm({ id, draftId: freshId('change'), name: '', baseRevision: 0, template: source ? structuredClone(source) : null, props: [], mappings: [] });
    setComponentId(id); setView('component'); setImpact(null); setDeletion(null); setError(''); setDiagnostics([]);
    if (source) setExtraction({ componentId: id, source: structuredClone(source) });
  }
  function editDocument(value: UIIRDocument) { setWork((previous) => ({ ...previous, value, dirty: true })); }
  function adoptPublished(next: ProjectDesignRuntimeState) { stateRef.current = next; onState(next); }

  async function perform<T>(operation: (authority: ProjectDesignRuntimeScope) => Promise<T>, accept: (result: T) => void, read = false) {
    if (running.current || externalBusy) return;
    running.current = true; setBusy(true); busyCallback.current?.(true);
    setError(''); setMessage(''); setDiagnostics([]);
    const abort = new AbortController(); controller.current = abort;
    const authority = { ...scope, signal: abort.signal };
    try {
      const result = await operation(authority);
      if (!mounted.current) return;
      if (read && result && typeof result === 'object' && 'revision' in result && result.revision !== stateRef.current.revision) {
        const refreshed = await getProjectDesignRuntime(authority);
        if (mounted.current) { adoptPublished(refreshed.state); setMessage(t('projectStructure.staleRead')); }
      } else accept(result);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ProjectDesignRuntimeError) {
        setDiagnostics(cause.diagnostics);
        if (cause.status === 409) {
          try {
            const refreshed = await getProjectDesignRuntime(authority);
            if (mounted.current) { adoptPublished(refreshed.state); setMessage(t('projectStructure.conflict')); }
          } catch (refreshError) {
            if (mounted.current) setError(`${cause.message} ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
          }
        }
      }
    } finally {
      if (mounted.current) { running.current = false; setBusy(false); busyCallback.current?.(false); }
    }
  }

  function stage() {
    if (disabled || !form || !prepared?.success || componentConflict) return;
    void perform((authority) => stageProjectDesignRuntimeComponent(authority, {
      expectedRevision: state.revision, draftId: form.draftId, expectedDefinitionRevision: form.baseRevision, definition: prepared.definition,
    }), (result) => {
      adoptPublished(result.state); setImpact({ revision: result.state.revision, draftId: result.draft.id, value: result.impact });
    });
  }
  function replaceSource(source: UIIRNode, node: UIIRNode) {
    const next = adoptSubtree(work.value, source, node);
    if (next) { editDocument(next); setView('screen'); setError(''); }
    else setError(t('projectStructure.sourceChanged'));
  }

  const componentIds = [...new Set([...state.projectComponents.components.map((entry) => entry.id), ...state.sharedChanges.drafts.map((entry) => entry.proposedDefinition.id), ...forms.map((entry) => entry.id)])];
  return <section data-testid="project-structure-panel" aria-label={t('projectStructure.title')} className={styles.panel}>
    {busy ? <p role="status">{t('common.loading')}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {message ? <p className={styles.notice} role="status">{message}</p> : null}
    <StructureDiagnostics diagnostics={diagnostics} />
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <h3>{t('projectStructure.screens')}</h3>
        {work.value.screens.map((screen) => <Button key={screen.id} disabled={locked} data-testid={`structure-screen-${screen.id}`} aria-pressed={view === 'screen' && screen.id === screenId} onClick={() => { setScreenId(screen.id); setView('screen'); setDetached(null); }}>
          {screen.name || screen.id}
        </Button>)}
        <Button disabled={disabled} data-testid="structure-new-screen" onClick={() => {
          const id = freshId('screen'); editDocument({ ...work.value, screens: [...work.value.screens, { schemaVersion: 1, type: 'screen', id, name: t('projectStructure.newScreen'), children: [] }] });
          setScreenId(id); setView('screen');
        }}>{t('projectStructure.newScreen')}</Button>
        <h3>{t('projectStructure.sharedComponents')}</h3>
        {componentIds.map((id) => {
          const local = forms.find((entry) => entry.id === id);
          const live = state.projectComponents.components.find((entry) => entry.id === id);
          const staged = state.sharedChanges.drafts.find((entry) => entry.proposedDefinition.id === id);
          return <Button key={id} disabled={locked} data-testid={`structure-component-${id}`} aria-pressed={view === 'component' && componentId === id} onClick={() => selectComponent(id)}>
            {local?.name || staged?.proposedDefinition.name || live?.name || id} · {t(staged ? 'projectStructure.staged' : live ? 'projectStructure.published' : 'projectStructure.draft')}
          </Button>;
        })}
        <Button disabled={disabled} data-testid="structure-new-component" onClick={() => newComponent()}>{t('semanticEditor.newComponent')}</Button>
      </aside>
      <div className={styles.content}>
        {view === 'screen' ? <>
          <p className={styles.muted}>{t('projectStructure.documentDraft')}</p>
          {documentConflict ? <div className={styles.notice} role="alert"><p>{t('projectStructure.documentConflict')}</p>
            <Button disabled={disabled} data-testid="structure-rebase-document" onClick={() => setWork({ ...work, base: fingerprint(state.document) })}>{t('projectStructure.useDraft')}</Button>
          </div> : null}
          <div className={styles.actions}>
            <Button disabled={locked} data-testid="structure-validate-document" onClick={() => void perform((authority) => validateProjectDesignRuntimeDocument(authority, { document: work.value }), ({ resolution }) => {
              setDiagnostics(resolution.diagnostics); if (!resolution.diagnostics.length) setMessage(t('projectStructure.documentValid'));
            }, true)}>{t('projectStructure.validateDocument')}</Button>
            <Button disabled={disabled || !work.dirty || documentConflict} data-testid="structure-save-document" variant="primary" onClick={() => void perform((authority) => saveProjectDesignRuntimeDocument(authority, { expectedRevision: state.revision, document: work.value }), (result) => {
              adoptPublished(result.state); setWork(documentWork(result.state)); setMessage(t('designRuntime.saved'));
            })}>{t('projectStructure.saveDocument')}</Button>
            <Button disabled={disabled || !work.dirty} data-testid="structure-discard-document" onClick={() => { setWork(documentWork(state)); setDetached(null); }}>{t('projectStructure.discardEdits')}</Button>
          </div>
          {selectedScreen ? <>
            <Button data-testid="structure-patterns-open" disabled={locked} onClick={() => setPatternsOpened((value) => !value)}>{t('designPatterns.title')}</Button>
            {patternsOpened ? <DesignRuntimePatterns scope={scope} state={state} document={work.value} screenId={selectedScreen.id} sourceIdentity={sourceIdentity} viewerOnly={viewerOnly} disabled={busy || externalBusy || documentConflict}
              onBusyChange={(value) => { setPatternsBusy(value); busyCallback.current?.(value); }}
              onAdd={(node) => editDocument({ ...work.value, screens: work.value.screens.map((screen) => screen.id === selectedScreen.id ? { ...screen, children: [...screen.children, node] } : screen) })} /> : null}
            <SemanticScreenEditor {...catalog} screen={selectedScreen} disabled={disabled} onExtractComponent={(node) => newComponent(node)}
              onChange={(screen) => editDocument({ ...work.value, screens: work.value.screens.map((entry) => entry.id === screen.id ? screen : entry) })} />
            <Button disabled={disabled} data-testid="structure-delete-screen" onClick={() => { editDocument({ ...work.value, screens: work.value.screens.filter((screen) => screen.id !== selectedScreen.id) }); setScreenId(work.value.screens.find((screen) => screen.id !== selectedScreen.id)?.id ?? ''); }}>{t('common.delete')} {t('semanticEditor.screen')}</Button>
            {instances.length ? <section className={styles.card}>
              <h4>{t('projectStructure.detach')}</h4>
              <div className={styles.row}>
                <label className={styles.field}>{t('semanticEditor.instance')}<select disabled={locked} data-testid="structure-detach-instance" value={selectedInstance?.id ?? ''} onChange={(event) => { setDetachId(event.target.value); setDetached(null); }}>
                  {instances.map((instance) => <option key={instance.id} value={instance.id}>{instance.id} · {instance.ref}</option>)}
                </select></label>
                <label className={styles.field}>{t('projectStructure.detachMode')}<output data-testid="structure-detach-mode">{t(`projectStructure.${state.validationSettings.mode}`)}</output></label>
              </div>
              <Button disabled={locked || !selectedInstance} data-testid="structure-preview-detach" onClick={() => {
                if (selectedInstance) void perform((authority) => detachProjectDesignRuntimeInstance(authority, { instance: selectedInstance, mode: state.validationSettings.mode }), (result) => {
                  setDiagnostics(result.diagnostics); setDetached(result.node ? { source: structuredClone(selectedInstance), node: result.node, revision: result.revision } : null);
                }, true);
              }}>{t('projectStructure.previewDetach')}</Button>
              {detached ? <><SemanticTreeEditor {...catalog} nodes={[detached.node]} disabled onChange={() => {}} />
                <Button disabled={disabled || detached.revision !== state.revision} data-testid="structure-adopt-detach" onClick={() => { replaceSource(detached.source, detached.node); setDetached(null); }}>{t('projectStructure.adoptDetach')}</Button>
              </> : null}
            </section> : null}
          </> : <p className={styles.muted}>{t('projectStructure.empty')}</p>}
        </> : form ? <>
          <section className={styles.card}>
            <h3>{t('projectStructure.sharedComponents')}</h3>
            <code>{`local:${form.id}`}</code><p className={styles.muted}>{t('designRuntime.revision', { revision: form.baseRevision + 1 })} · {t('projectStructure.draft')}</p>
            <label className={styles.field}>{t('projectStructure.componentName')}<input data-testid="structure-component-name" disabled={disabled} value={form.name} onChange={(event) => updateForm({ ...form, name: event.target.value })} /></label>
            {componentConflict ? <div className={styles.notice} role="alert"><p>{t('projectStructure.componentConflict')}</p>
              <Button disabled={disabled} data-testid="structure-rebase-component" onClick={() => updateForm({
                ...form, baseRevision: published?.revision ?? 0,
                draftId: pending?.id ?? (state.sharedChanges.history.some((entry) => entry.changeId === form.draftId) ? freshId('change') : form.draftId),
              })}>{t('projectStructure.rebase')}</Button>
            </div> : null}
            {form.template ? <SemanticTemplateEditor {...catalog} template={form.template} mappedTargets={form.mappings} disabled={disabled} onChange={(template) => updateForm({ ...form, template })} />
              : <><p>{t('projectStructure.templateRequired')}</p><SemanticTreeEditor {...catalog} nodes={[]} maxRoots={1} disabled={disabled} onChange={(nodes) => { if (nodes[0]) updateForm({ ...form, template: nodes[0] }); }} /></>}
          </section>
          <PublicComponentPropsEditor {...catalog} value={form} disabled={disabled} onChange={updateForm} />
          {prepared && !prepared.success ? <ul className={styles.diagnostics} role="alert">{prepared.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
          {extraction?.componentId === form.id ? <p className={styles.notice}>{t('projectStructure.extractHint')}</p> : null}
          <div className={styles.actions}>
            <Button disabled={disabled || !prepared?.success || componentConflict} data-testid="structure-stage" onClick={stage}>{t('projectStructure.stage')}</Button>
            <Button disabled={disabled} data-testid="structure-discard-component-edits" onClick={() => {
              if (pending || published) updateForm(formForDefinition(pending?.proposedDefinition ?? published!, pending ? pending.baseDefinition?.revision ?? 0 : published!.revision, pending?.id));
              else { setForms(forms.filter((entry) => entry.id !== form.id)); setComponentId(''); }
            }}>{t('projectStructure.discardEdits')}</Button>
          </div>
          {pending ? <section className={styles.card}>
            <h4>{t('projectStructure.staged')} · {pending.proposedDefinition.name}</h4>
            {unstaged ? <p className={styles.notice}>{t('projectStructure.unstaged')}</p> : null}
            {!currentImpact || currentImpact.revision !== state.revision ? <p className={styles.muted}>{t('projectStructure.reviewAgain')}</p> : null}
            <div className={styles.actions}>
              <Button disabled={locked} data-testid="structure-review-impact" onClick={() => void perform((authority) => getProjectDesignRuntimeChange(authority, pending.id), (result) => setImpact({ revision: result.revision, draftId: result.draft.id, value: result.impact }), true)}>{t('projectStructure.reviewImpact')}</Button>
              <Button disabled={disabled || unstaged || !currentImpact || currentImpact.revision !== state.revision || currentImpact.value.diagnostics.some((entry) => entry.severity === 'error')} data-testid="structure-publish" variant="primary" onClick={() => void perform((authority) => publishProjectDesignRuntimeComponent(authority, pending.id, { expectedRevision: state.revision, expectedDefinitionRevision: pending.baseDefinition?.revision ?? 0 }), (result) => {
                adoptPublished(result.state); setImpact(null); const definition = result.state.projectComponents.components.find((entry) => entry.id === componentId)!;
                updateForm(formForDefinition(definition, definition.revision)); setMessage(t('designRuntime.saved'));
                if (extraction?.componentId === componentId) setExtraction({ ...extraction, publishedRevision: definition.revision });
              })}>{t('projectStructure.publish')}</Button>
              <Button disabled={disabled} data-testid="structure-discard-stage" onClick={() => void perform((authority) => discardProjectDesignRuntimeComponent(authority, pending.id, { expectedRevision: state.revision }), (result) => { adoptPublished(result.state); setImpact(null); })}>{t('projectStructure.discardStage')}</Button>
            </div>
          </section> : null}
          {currentImpact ? <ComponentImpact impact={currentImpact.value} document={state.document} /> : null}
          {extraction?.componentId === componentId && extraction.publishedRevision !== undefined && extraction.publishedRevision === published?.revision ? <Button disabled={disabled} data-testid="structure-adopt-extraction" onClick={() => {
            replaceSource(extraction.source, { schemaVersion: 1, type: 'instance', id: extraction.source.id, ref: `local:${componentId}`, overrides: [] }); setExtraction(null);
          }}>{t('projectStructure.adoptExtraction')}</Button> : null}
          {history.length ? <section className={styles.card}>
            <h4>{t('projectStructure.history')}</h4>
            {history.map((entry) => <details key={entry.definition.revision}>
              <summary>{t('designRuntime.revision', { revision: entry.definition.revision })} · {entry.definition.name}</summary>
              <SemanticTemplateEditor {...catalog} template={entry.definition.template} mappedTargets={entry.definition.propMappings} disabled onChange={() => {}} />
              <dl>{Object.entries(entry.definition.props).map(([name, prop]) => <div key={name}><dt>{name}</dt><dd>{prop.type} · {prop.required ? t('designRuntime.required') : t('designRuntime.optional')}{prop.default !== undefined ? ` · ${t('common.default')}: ${JSON.stringify(prop.default)}` : ''}</dd></div>)}</dl>
              <Button disabled={disabled || !!pending || !published || entry.definition.revision >= published.revision} data-testid={`structure-undo-${entry.definition.revision}`} onClick={() => {
                if (published) void perform((authority) => undoProjectDesignRuntimeComponent(authority, componentId, { expectedRevision: state.revision, draftId: freshId('change'), expectedDefinitionRevision: published.revision, restoreDefinitionRevision: entry.definition.revision }), (result) => {
                  adoptPublished(result.state); updateForm(formForDefinition(result.draft.proposedDefinition, result.draft.baseDefinition!.revision, result.draft.id)); setImpact({ revision: result.state.revision, draftId: result.draft.id, value: result.impact });
                });
              }}>{t('projectStructure.stageUndo', { revision: entry.definition.revision })}</Button>
            </details>)}
          </section> : null}
          {published ? <section className={styles.card}>
            <h4>{t('projectStructure.references')}</h4>
            <Button disabled={locked} data-testid="structure-analyze-deletion" onClick={() => void perform((authority) => getProjectDesignRuntimeDeletion(authority, componentId), (result) => setDeletion({ revision: result.revision, value: result.analysis }), true)}>{t('projectStructure.analyzeDeletion')}</Button>
            {deletion?.value.componentRef === `local:${componentId}` ? <>
              <ReferenceUsages usages={deletion.value.usages} document={state.document} /><StructureDiagnostics diagnostics={deletion.value.diagnostics} />
              <p className={styles.muted}>{t('projectStructure.deletionHint')}</p>
              <label className={styles.field}>{t('projectStructure.deletionAction')}<select disabled={disabled} data-testid="structure-delete-action" value={deleteAction} onChange={(event) => setDeleteAction(event.target.value as typeof deleteAction)}>
                <option value="reject">{t('projectStructure.safeDelete')}</option><option value="replace">{t('projectStructure.replace')}</option><option value="detach">{t('projectStructure.detachAll')}</option><option value="delete-instances">{t('projectStructure.deleteInstances')}</option>
              </select></label>
              {deleteAction === 'replace' ? <label className={styles.field}>{t('projectStructure.replacement')}<select disabled={disabled} data-testid="structure-delete-replacement" value={replacementRef} onChange={(event) => setReplacementRef(event.target.value)}>
                <option value="">{t('common.none')}</option>
                {state.projectComponents.components.filter((entry) => entry.id !== componentId).map((entry) => <option key={entry.id} value={`local:${entry.id}`}>{entry.name}</option>)}
                {state.registry?.components.map((entry) => <option key={entry.id} value={`ds:${state.registry!.id}/${entry.id}`}>{entry.name}</option>)}
              </select></label> : null}
              <Button disabled={disabled || work.dirty || !!pending || deletion.revision !== state.revision || (deleteAction === 'reject' && !deletion.value.canDelete) || (deleteAction === 'replace' && !replacementRef)} data-testid="structure-delete-component" onClick={() => void perform((authority) => deleteProjectDesignRuntimeComponent(authority, componentId, { expectedRevision: state.revision, action: deleteAction === 'replace' ? { type: 'replace', replacementRef } : { type: deleteAction } }), (result) => {
                adoptPublished(result.state); setWork(documentWork(result.state)); setForms(forms.filter((entry) => entry.id !== componentId)); setComponentId(''); setDeletion(null); setView('screen');
              })}>{t('projectStructure.deleteComponent')}</Button>
            </> : null}
          </section> : null}
        </> : <p className={styles.muted}>{t('projectStructure.empty')}</p>}
      </div>
    </div>
  </section>;
}
