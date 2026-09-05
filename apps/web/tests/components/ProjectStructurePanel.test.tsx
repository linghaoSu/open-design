// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectComponentDefinitionSchema, ProjectDesignRuntimeStateSchema, type ProjectComponentDefinition,
  type ProjectDesignRuntimeState, type SharedComponentDraft, type SharedComponentImpact,
} from '@open-design/contracts';
import { ProjectStructurePanel } from '../../src/components/ProjectStructurePanel';
import { ReferenceUsages } from '../../src/components/ProjectStructureReview';
import * as provider from '../../src/providers/design-runtime';
import { emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';

vi.mock('../../src/providers/design-runtime', async () => ({
  ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'),
  getProjectDesignRuntime: vi.fn(), saveProjectDesignRuntimeDocument: vi.fn(), validateProjectDesignRuntimeDocument: vi.fn(),
  stageProjectDesignRuntimeComponent: vi.fn(), publishProjectDesignRuntimeComponent: vi.fn(), discardProjectDesignRuntimeComponent: vi.fn(),
  getProjectDesignRuntimeChange: vi.fn(), undoProjectDesignRuntimeComponent: vi.fn(), getProjectDesignRuntimeDeletion: vi.fn(),
  deleteProjectDesignRuntimeComponent: vi.fn(), detachProjectDesignRuntimeInstance: vi.fn(),
}));
const scope = { projectId: 'project-a', workspaceContext: workspaceContextFixture({ workspaceId: 'workspace-a', workspaceMemberId: 'member-a' }) };
const definition: ProjectComponentDefinition = ProjectComponentDefinitionSchema.parse({
  schemaVersion: 1, id: 'card', name: 'ApplicationCard', revision: 1,
  template: { schemaVersion: 1, type: 'text', id: 'shared-title', text: '' },
  props: { title: { type: 'string', required: true, default: 'Before' } },
  propMappings: [{ prop: 'title', nodeId: 'shared-title', path: ['text'] }],
});
function initialState(): ProjectDesignRuntimeState {
  const state = emptyDesignRuntimeState(1);
  state.projectComponents.components = [structuredClone(definition)];
  state.sharedChanges.history = [{ schemaVersion: 1, componentRef: 'local:card', definition: structuredClone(definition), changeId: null }];
  state.document = { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, type: 'screen', id: 'screen-one', name: 'First screen', children: [
    { schemaVersion: 1, type: 'instance', id: 'first-card', ref: 'local:card', overrides: [] },
    { schemaVersion: 1, type: 'text', id: 'source-text', text: 'Extract this' },
  ] }, { schemaVersion: 1, type: 'screen', id: 'screen-two', name: 'Second screen', children: [
    { schemaVersion: 1, type: 'instance', id: 'second-card', ref: 'local:card', overrides: [{ schemaVersion: 1, path: ['props', 'title'], value: 'Custom' }] },
  ] }] };
  return ProjectDesignRuntimeStateSchema.parse(state);
}
function makeImpact(state: ProjectDesignRuntimeState, proposed: ProjectComponentDefinition, baseRevision: number): SharedComponentImpact {
  return {
    schemaVersion: 1, componentRef: `local:${proposed.id}`, baseRevision, proposedRevision: proposed.revision,
    usages: { schemaVersion: 1, target: `local:${proposed.id}`, directUsages: [], transitiveUsages: [], chains: [], cycles: [], diagnostics: [],
      affectedScreens: state.document?.screens.map((entry) => ({ kind: 'screen', documentId: state.document!.id, screenId: entry.id })) ?? [] },
    current: { schemaVersion: 1, document: { schemaVersion: 1, id: 'document', screens: [] }, origins: [], diagnostics: [] },
    proposed: { schemaVersion: 1, document: { schemaVersion: 1, id: 'document', screens: [] }, origins: [], diagnostics: [] }, diagnostics: [],
  };
}
function Harness({ initial = initialState(), viewerOnly = false, accepted = vi.fn() }: { initial?: ProjectDesignRuntimeState; viewerOnly?: boolean; accepted?: (state: ProjectDesignRuntimeState) => void }) {
  const [state, setState] = useState(initial);
  return <ProjectStructurePanel scope={scope} state={state} viewerOnly={viewerOnly} onState={(next) => { accepted(next); setState(next); }} />;
}
function mockWrites(initial = initialState()) {
  let stored = structuredClone(initial);
  vi.mocked(provider.stageProjectDesignRuntimeComponent).mockImplementation(async (_scope, input) => {
    const draft: SharedComponentDraft = { schemaVersion: 1, id: input.draftId, componentRef: `local:${input.definition.id}`,
      baseDefinition: stored.projectComponents.components.find((entry) => entry.id === input.definition.id) ?? null,
      proposedDefinition: input.definition, source: { type: 'edit' } };
    stored = { ...stored, revision: stored.revision + 1, sharedChanges: { ...stored.sharedChanges, drafts: [draft] } };
    return { state: structuredClone(stored), draft, impact: makeImpact(stored, input.definition, input.expectedDefinitionRevision) };
  });
  vi.mocked(provider.publishProjectDesignRuntimeComponent).mockImplementation(async (_scope, id) => {
    const draft = stored.sharedChanges.drafts.find((entry) => entry.id === id)!;
    stored = { ...stored, revision: stored.revision + 1,
      projectComponents: { ...stored.projectComponents, components: [...stored.projectComponents.components.filter((entry) => entry.id !== draft.proposedDefinition.id), draft.proposedDefinition] },
      sharedChanges: { ...stored.sharedChanges, drafts: [], history: [...stored.sharedChanges.history, { schemaVersion: 1, componentRef: draft.componentRef, definition: draft.proposedDefinition, changeId: draft.id }] } };
    return { state: structuredClone(stored), impact: makeImpact(stored, draft.proposedDefinition, draft.baseDefinition?.revision ?? 0) };
  });
  vi.mocked(provider.saveProjectDesignRuntimeDocument).mockImplementation(async (_scope, input) => {
    stored = { ...stored, revision: stored.revision + 1, document: input.document };
    return { state: structuredClone(stored) };
  });
  return () => stored;
}
const buttonDisabled = (testId: string) => (screen.getByTestId(testId) as HTMLButtonElement).disabled;
const inputValue = (testId: string) => (screen.getByTestId(testId) as HTMLInputElement).value;
beforeEach(() => vi.resetAllMocks());
afterEach(() => { cleanup(); resetWorkspaceAccountGeneration(); });

describe('ProjectStructurePanel', () => {
  it('stages a shared default without changing published definitions, then publishes explicitly with both screens listed', async () => {
    const stored = mockWrites(); const accepted = vi.fn();
    render(<StrictMode><Harness accepted={accepted} /></StrictMode>);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    fireEvent.change(screen.getByTestId('structure-prop-default-0'), { target: { value: 'After' } });
    fireEvent.click(screen.getByTestId('structure-stage'));
    await screen.findByTestId('structure-impact');
    expect(stored().projectComponents.components[0]!.props.title!.default).toBe('Before');
    expect(provider.publishProjectDesignRuntimeComponent).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('structure-impact')).getByText('First screen')).toBeTruthy();
    expect(within(screen.getByTestId('structure-impact')).getByText('Second screen')).toBeTruthy();
    expect(vi.mocked(provider.stageProjectDesignRuntimeComponent).mock.calls[0]![1]).toMatchObject({ expectedRevision: 1, expectedDefinitionRevision: 1, definition: { id: 'card', revision: 2 } });
    fireEvent.click(screen.getByTestId('structure-publish'));
    await waitFor(() => expect(stored().projectComponents.components[0]!.revision).toBe(2));
    expect(stored().document).toEqual(initialState().document);
    expect(stored().projectComponents.components[0]!.props.title!.default).toBe('After');
    expect(provider.saveProjectDesignRuntimeDocument).not.toHaveBeenCalled();
    expect(accepted).toHaveBeenCalledTimes(2);
  });

  it('keeps extraction as separate stage, publish, draft adoption, and save steps', async () => {
    const stored = mockWrites();
    render(<Harness />);
    fireEvent.click(within(screen.getByTestId('semantic-node-source-text')).getByRole('button', { name: 'Extract shared component' }));
    expect(screen.queryByTestId('structure-adopt-extraction')).toBeNull();
    fireEvent.change(screen.getByTestId('structure-component-name'), { target: { value: 'Extracted text' } });
    fireEvent.click(screen.getByTestId('structure-stage'));
    await screen.findByTestId('structure-impact');
    expect(screen.queryByTestId('structure-adopt-extraction')).toBeNull();
    const proposed = vi.mocked(provider.stageProjectDesignRuntimeComponent).mock.calls[0]![1].definition;
    expect(proposed.template).toEqual(initialState().document!.screens[0]!.children[1]);
    expect(stored().document).toEqual(initialState().document);
    fireEvent.click(screen.getByTestId('structure-publish'));
    await screen.findByTestId('structure-adopt-extraction');
    expect(stored().document).toEqual(initialState().document);
    fireEvent.click(screen.getByTestId('structure-adopt-extraction'));
    expect(provider.saveProjectDesignRuntimeDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('structure-save-document'));
    await waitFor(() => expect(provider.saveProjectDesignRuntimeDocument).toHaveBeenCalledOnce());
    expect(stored().document!.screens[0]!.children[1]).toEqual({ schemaVersion: 1, type: 'instance', id: 'source-text', ref: `local:${proposed.id}`, overrides: [] });
  });

  it('creates a shared component through named public properties, defaults and explicit target controls', async () => {
    const initial = emptyDesignRuntimeState(); mockWrites(initial);
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByTestId('structure-new-component'));
    fireEvent.change(screen.getByTestId('structure-component-name'), { target: { value: 'Text label' } });
    fireEvent.click(screen.getByTestId('semantic-add-node-root'));
    fireEvent.click(screen.getByTestId('structure-add-prop'));
    fireEvent.change(screen.getByTestId('structure-prop-name-0'), { target: { value: 'constructor' } });
    expect(buttonDisabled('structure-stage')).toBe(true);
    fireEvent.click(screen.getByTestId('structure-prop-default-enabled-0'));
    fireEvent.change(screen.getByTestId('structure-prop-default-0'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('structure-add-mapping'));
    const target = screen.getByTestId('structure-mapping-target-0') as HTMLSelectElement;
    fireEvent.change(target, { target: { value: target.options[1]!.value } });
    expect(buttonDisabled('structure-stage')).toBe(false);
    fireEvent.click(screen.getByTestId('structure-stage'));
    await screen.findByTestId('structure-impact');
    const request = vi.mocked(provider.stageProjectDesignRuntimeComponent).mock.calls[0]![1];
    expect(request).toMatchObject({ expectedRevision: 0, expectedDefinitionRevision: 0, definition: {
      name: 'Text label', revision: 1, props: { constructor: { type: 'string', required: false, default: 'Hello' } },
      template: { type: 'text', text: '' }, propMappings: [{ prop: 'constructor', path: ['text'] }],
    } });
    expect(ProjectComponentDefinitionSchema.parse(request.definition)).toEqual(request.definition);
    expect(provider.publishProjectDesignRuntimeComponent).not.toHaveBeenCalled();
  });

  it('retains invalid numeric defaults visibly and blocks staging until repaired', () => {
    const initial = initialState();
    const card = initial.projectComponents.components[0]!;
    card.props.title = { type: 'number', required: true, default: 3 };
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    fireEvent.change(screen.getByTestId('structure-prop-default-0'), { target: { value: '-' } });
    expect(inputValue('structure-prop-default-0')).toBe('-');
    expect(screen.getByRole('alert').textContent).toContain('Enter a finite number');
    expect(buttonDisabled('structure-stage')).toBe(true);
    expect(provider.stageProjectDesignRuntimeComponent).not.toHaveBeenCalled();
  });

  it('preserves edited screen text across remote refreshes and requires explicit document rebase before saving', () => {
    const state = initialState(); const onState = vi.fn();
    const { rerender } = render(<ProjectStructurePanel scope={scope} state={state} viewerOnly={false} onState={onState} />);
    fireEvent.change(screen.getByTestId('semantic-text-source-text'), { target: { value: 'My draft' } });
    const remote = initialState(); remote.revision = 2; remote.document!.screens[0]!.children[1] = { schemaVersion: 1, type: 'text', id: 'source-text', text: 'Remote text' };
    rerender(<ProjectStructurePanel scope={scope} state={remote} viewerOnly={false} onState={onState} />);
    expect(inputValue('semantic-text-source-text')).toBe('My draft');
    expect(buttonDisabled('structure-save-document')).toBe(true);
    fireEvent.click(screen.getByTestId('structure-rebase-document'));
    expect(buttonDisabled('structure-save-document')).toBe(false);
    expect(inputValue('semantic-text-source-text')).toBe('My draft');
    expect(provider.saveProjectDesignRuntimeDocument).not.toHaveBeenCalled();
  });

  it('does not publish stale staged content after the user edits the form again', async () => {
    mockWrites(); render(<Harness />);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    fireEvent.click(screen.getByTestId('structure-stage'));
    await screen.findByTestId('structure-impact');
    fireEvent.change(screen.getByTestId('structure-prop-default-0'), { target: { value: 'Not staged yet' } });
    expect(buttonDisabled('structure-publish')).toBe(true);
    expect(provider.publishProjectDesignRuntimeComponent).not.toHaveBeenCalled();
  });

  it('keeps component drafts and refreshes authority after a CAS conflict without retrying', async () => {
    const initial = initialState(); const remote = initialState(); remote.revision = 9;
    vi.mocked(provider.stageProjectDesignRuntimeComponent).mockRejectedValue(new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Changed remotely.', details: { currentRevision: 9 } }));
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: remote });
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    fireEvent.change(screen.getByTestId('structure-prop-default-0'), { target: { value: 'Keep local' } });
    fireEvent.click(screen.getByTestId('structure-stage'));
    await waitFor(() => expect(provider.getProjectDesignRuntime).toHaveBeenCalledOnce());
    expect(inputValue('structure-prop-default-0')).toBe('Keep local');
    expect(provider.stageProjectDesignRuntimeComponent).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.getProjectDesignRuntime).mock.calls[0]![0]).toMatchObject(scope);
  });

  it('rebases edits from a remotely published pending draft with a fresh change ID', async () => {
    const initial = initialState();
    const proposed = { ...definition, revision: 2 };
    initial.sharedChanges.drafts = [{ schemaVersion: 1, id: 'old-draft', componentRef: 'local:card', baseDefinition: definition, proposedDefinition: proposed, source: { type: 'edit' } }];
    const { rerender } = render(<ProjectStructurePanel scope={scope} state={initial} viewerOnly={false} onState={vi.fn()} />);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    fireEvent.change(screen.getByTestId('structure-prop-default-0'), { target: { value: 'Keep these edits' } });
    const remote = initialState(); remote.revision = 3;
    remote.projectComponents.components = [proposed];
    remote.sharedChanges.history.push({ schemaVersion: 1, componentRef: 'local:card', definition: proposed, changeId: 'old-draft' });
    rerender(<ProjectStructurePanel scope={scope} state={remote} viewerOnly={false} onState={vi.fn()} />);
    mockWrites(remote);
    fireEvent.click(screen.getByTestId('structure-rebase-component'));
    fireEvent.click(screen.getByTestId('structure-stage'));
    await waitFor(() => expect(provider.stageProjectDesignRuntimeComponent).toHaveBeenCalledOnce());
    const request = vi.mocked(provider.stageProjectDesignRuntimeComponent).mock.calls[0]![1];
    expect(request.draftId).not.toBe('old-draft');
    expect(request).toMatchObject({ expectedRevision: 3, expectedDefinitionRevision: 2, definition: { revision: 3, props: { title: { default: 'Keep these edits' } } } });
  });

  it.each(['project', 'workspace', 'account'])('cancels late reads and resets drafts when %s authority changes', async (boundary) => {
    let resolve!: (value: Awaited<ReturnType<typeof provider.validateProjectDesignRuntimeDocument>>) => void;
    vi.mocked(provider.validateProjectDesignRuntimeDocument).mockReturnValue(new Promise((done) => { resolve = done; }));
    const onState = vi.fn(); const state = initialState();
    const { rerender } = render(<ProjectStructurePanel scope={scope} state={state} viewerOnly={false} onState={onState} />);
    fireEvent.change(screen.getByTestId('semantic-text-source-text'), { target: { value: 'Old draft' } });
    fireEvent.click(screen.getByTestId('structure-validate-document'));
    if (boundary === 'account') advanceWorkspaceAccountGeneration('new-account');
    const nextScope = boundary === 'project' ? { ...scope, projectId: 'project-b' } : boundary === 'workspace'
      ? { ...scope, workspaceContext: workspaceContextFixture({ workspaceId: 'workspace-b', workspaceMemberId: 'member-b' }) } : scope;
    rerender(<ProjectStructurePanel scope={nextScope} state={state} viewerOnly={false} onState={onState} />);
    await act(async () => resolve({ revision: 99, resolution: { schemaVersion: 1, document: null, origins: [], diagnostics: [{ schemaVersion: 1, code: 'ODDS1003', severity: 'error', message: 'Old diagnostic.' }] } }));
    expect(inputValue('semantic-text-source-text')).toBe('Extract this');
    expect(screen.queryByText('Old diagnostic.')).toBeNull();
    expect(vi.mocked(provider.validateProjectDesignRuntimeDocument).mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(onState).not.toHaveBeenCalled();
  });

  it('lets viewers inspect and validate while disabling all source and publication mutations', async () => {
    render(<Harness viewerOnly />);
    expect(buttonDisabled('structure-new-screen')).toBe(true);
    expect(buttonDisabled('structure-new-component')).toBe(true);
    expect(buttonDisabled('structure-save-document')).toBe(true);
    expect(buttonDisabled('structure-validate-document')).toBe(false);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    expect(buttonDisabled('structure-stage')).toBe(true);
    expect((screen.getByTestId('structure-prop-default-0') as HTMLInputElement).closest('fieldset')!.disabled).toBe(true);
    expect(buttonDisabled('structure-analyze-deletion')).toBe(false);
  });

  it('displays dependency chains in their outward target-to-owner order', () => {
    const usages = makeImpact(initialState(), definition, 0).usages;
    usages.chains = [[
      { schemaVersion: 1, owner: { kind: 'component', componentRef: 'local:wrapper' }, nodeId: 'nested', target: 'local:card', path: ['template'] },
      { schemaVersion: 1, owner: { kind: 'screen', documentId: 'document', screenId: 'screen-one' }, nodeId: 'outer', target: 'local:wrapper', path: ['children', 0] },
    ]];
    render(<ReferenceUsages usages={usages} document={initialState().document} />);
    expect(screen.getByText('local:card → local:wrapper → First screen')).toBeTruthy();
  });

  it('previews detached output read-only, adopts it into the draft, and saves only on request', async () => {
    const stored = mockWrites();
    vi.mocked(provider.detachProjectDesignRuntimeInstance).mockResolvedValue({ revision: 1, node: { schemaVersion: 1, type: 'text', id: 'derived-root', text: 'Before' }, origins: [], diagnostics: [] });
    render(<Harness />);
    fireEvent.click(screen.getByTestId('structure-preview-detach'));
    await screen.findByTestId('structure-adopt-detach');
    expect(provider.detachProjectDesignRuntimeInstance).toHaveBeenCalledWith(expect.objectContaining(scope), { instance: initialState().document!.screens[0]!.children[0], mode: 'guided' });
    expect((screen.getByTestId('semantic-text-derived-root') as HTMLTextAreaElement).disabled).toBe(true);
    expect(provider.saveProjectDesignRuntimeDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('structure-adopt-detach'));
    expect(inputValue('semantic-text-first-card')).toBe('Before');
    expect(stored().document).toEqual(initialState().document);
    fireEvent.click(screen.getByTestId('structure-save-document'));
    await waitFor(() => expect(provider.saveProjectDesignRuntimeDocument).toHaveBeenCalledOnce());
    expect(stored().document!.screens[0]!.children[0]).toEqual({ schemaVersion: 1, type: 'text', id: 'first-card', text: 'Before' });
  });

  it('stages undo from immutable history, then discards it without changing the published definition', async () => {
    const initial = initialState();
    const second = { ...definition, revision: 2, props: { title: { type: 'string' as const, required: true, default: 'Second' } } };
    initial.projectComponents.components = [second];
    initial.sharedChanges.history.push({ schemaVersion: 1, componentRef: 'local:card', definition: second, changeId: 'published-change' });
    const restored = { ...definition, revision: 3 };
    const draft: SharedComponentDraft = { schemaVersion: 1, id: 'undo-draft', componentRef: 'local:card', baseDefinition: second, proposedDefinition: restored, source: { type: 'undo', definitionRevision: 1 } };
    const staged = { ...initial, revision: 2, sharedChanges: { ...initial.sharedChanges, drafts: [draft] } };
    vi.mocked(provider.undoProjectDesignRuntimeComponent).mockResolvedValue({ state: staged, draft, impact: makeImpact(initial, restored, 2) });
    vi.mocked(provider.discardProjectDesignRuntimeComponent).mockResolvedValue({ state: { ...initial, revision: 3 } });
    const accepted = vi.fn(); render(<Harness initial={initial} accepted={accepted} />);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    fireEvent.click(screen.getByTestId('structure-undo-1'));
    await screen.findByTestId('structure-impact');
    expect(inputValue('structure-prop-default-0')).toBe('Before');
    expect(provider.undoProjectDesignRuntimeComponent).toHaveBeenCalledWith(expect.objectContaining(scope), 'card', { expectedRevision: 1, draftId: expect.any(String), expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 });
    expect(accepted.mock.calls.at(-1)![0].projectComponents.components[0]).toEqual(second);
    fireEvent.click(screen.getByTestId('structure-discard-stage'));
    await waitFor(() => expect(provider.discardProjectDesignRuntimeComponent).toHaveBeenCalledOnce());
    expect(provider.publishProjectDesignRuntimeComponent).not.toHaveBeenCalled();
    expect(accepted.mock.calls.at(-1)![0].sharedChanges.history).toEqual(initial.sharedChanges.history);
  });

  it.each(['reject', 'replace', 'detach', 'delete-instances'] as const)('requires reference analysis and an explicit %s deletion action', async (action) => {
    const initial = initialState();
    initial.projectComponents.components.push({ ...definition, id: 'replacement', name: 'Replacement' });
    const usages = makeImpact(initial, definition, 0).usages;
    vi.mocked(provider.getProjectDesignRuntimeDeletion).mockResolvedValue({ revision: 1, analysis: { schemaVersion: 1, componentRef: 'local:card', canDelete: action === 'reject', usages, diagnostics: [] } });
    vi.mocked(provider.deleteProjectDesignRuntimeComponent).mockResolvedValue({ state: { ...initial, revision: 2, projectComponents: { ...initial.projectComponents, components: initial.projectComponents.components.slice(1) } } });
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByTestId('structure-component-card'));
    expect(screen.queryByTestId('structure-delete-component')).toBeNull();
    fireEvent.click(screen.getByTestId('structure-analyze-deletion'));
    await screen.findByTestId('structure-delete-component');
    fireEvent.change(screen.getByTestId('structure-delete-action'), { target: { value: action } });
    if (action === 'replace') fireEvent.change(screen.getByTestId('structure-delete-replacement'), { target: { value: 'local:replacement' } });
    expect(provider.deleteProjectDesignRuntimeComponent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('structure-delete-component'));
    await waitFor(() => expect(provider.deleteProjectDesignRuntimeComponent).toHaveBeenCalledOnce());
    expect(provider.deleteProjectDesignRuntimeComponent).toHaveBeenCalledWith(expect.objectContaining(scope), 'card', {
      expectedRevision: 1, action: action === 'replace' ? { type: action, replacementRef: 'local:replacement' } : { type: action },
    });
  });
});
