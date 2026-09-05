// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDesignRuntimeResponse } from '@open-design/contracts';
import { DesignRuntimePanel } from '../../src/components/DesignRuntimePanel';
import * as provider from '../../src/providers/design-runtime';
import { designRuntimeState, emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/design-runtime', async () => ({
  ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'),
  getProjectDesignRuntime: vi.fn(), compileProjectDesignRuntime: vi.fn(),
  putProjectDesignRuntimeBinding: vi.fn(), deleteProjectDesignRuntimeBinding: vi.fn(),
  revalidateProjectDesignRuntimeBinding: vi.fn(), resolveProjectDesignRuntimeBinding: vi.fn(),
  validateProjectDesignRuntimeUsage: vi.fn(),
}));

const workspaceContext = workspaceContextFixture({ workspaceId: 'workspace-a', workspaceMemberId: 'member-a' });
const panelProps = {
  projectId: 'project-a', workspaceContext,
  files: [{ name: 'src/Button.tsx' }, { name: 'src/Card.tsx' }],
  viewerOnly: false, onClose: vi.fn(),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: designRuntimeState() });
  vi.mocked(provider.compileProjectDesignRuntime).mockResolvedValue({ state: designRuntimeState(2) });
  vi.mocked(provider.putProjectDesignRuntimeBinding).mockResolvedValue({ state: designRuntimeState(3) });
  vi.mocked(provider.validateProjectDesignRuntimeUsage).mockResolvedValue({ revision: 1, diagnostics: [] });
});
afterEach(cleanup);

describe('DesignRuntimePanel', () => {
  it.each(['constructor', 'toString'])('validates a required %s prop without reading Object.prototype', async (name) => {
    const state = designRuntimeState();
    state.registry!.components[0]!.props = { [name]: { type: 'boolean', required: true } };
    state.codeIndex.components[0]!.props = state.registry!.components[0]!.props;
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByTestId('design-runtime-component-select');
    fireEvent.click(screen.getByTestId('design-runtime-validate'));
    await waitFor(() => expect(provider.validateProjectDesignRuntimeUsage).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.validateProjectDesignRuntimeUsage).mock.calls[0]![1].props).toEqual({ [name]: false });
  });
  it('compiles multiple selected project exports with identities retained across export edits', async () => {
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: emptyDesignRuntimeState() });
    render(<DesignRuntimePanel {...panelProps} />);
    await waitFor(() => expect(screen.getByTestId('design-runtime-compile').closest('fieldset')?.disabled).toBe(false));
    const componentId = (screen.getByTestId('design-runtime-component-id-0') as HTMLInputElement).value;
    const codeId = (screen.getByTestId('design-runtime-code-id-0') as HTMLInputElement).value;
    fireEvent.change(screen.getByTestId('design-runtime-export-name-0'), { target: { value: 'Button' } });
    fireEvent.change(screen.getByTestId('design-runtime-export-name-0'), { target: { value: 'RenamedButton' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
    fireEvent.change(screen.getByTestId('design-runtime-source-path-1'), { target: { value: 'src/Card.tsx' } });
    fireEvent.change(screen.getByTestId('design-runtime-export-name-1'), { target: { value: 'Card' } });
    fireEvent.click(screen.getByTestId('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce());
    const [authority, request] = vi.mocked(provider.compileProjectDesignRuntime).mock.calls[0]!;
    expect(authority).toMatchObject({ projectId: 'project-a', workspaceContext });
    expect(request).toMatchObject({ expectedRevision: 0, designSystemId: 'project', selections: [
      { sourcePath: 'src/Button.tsx', exportName: 'RenamedButton', componentId, codeComponentId: codeId },
      { sourcePath: 'src/Card.tsx', exportName: 'Card' },
    ] });
    expect(request.selections[1]!.componentId).not.toBe(componentId);
    expect(request.selections.every((selection) => !Object.hasOwn(selection, 'sourceText'))).toBe(true);
  });

  it('compiles explicit frameworks, metadata and grouped story selections without reallocating identities', async () => {
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: emptyDesignRuntimeState() });
    render(<DesignRuntimePanel {...panelProps} files={[...panelProps.files, { name: 'src/Button.stories.ts' }, { name: 'src/Card.vue' }, { name: 'src/Card.stories.ts' }]} />);
    await waitFor(() => expect(screen.getByTestId('design-runtime-compile').closest('fieldset')?.disabled).toBe(false));
    fireEvent.change(screen.getByTestId('design-runtime-source-path-0'), { target: { value: 'src/Button.tsx' } });
    fireEvent.change(screen.getByTestId('design-runtime-export-name-0'), { target: { value: 'Button' } });
    fireEvent.change(screen.getByTestId('design-runtime-metadata-export-0'), { target: { value: 'ButtonPolicy' } });
    fireEvent.click(screen.getByTestId('design-runtime-add-story-source-0'));
    fireEvent.change(screen.getByTestId('design-runtime-story-source-0-0'), { target: { value: 'src/Button.stories.ts' } });
    fireEvent.change(screen.getByTestId('design-runtime-story-export-0-0-0'), { target: { value: 'Primary' } });
    const storyId = (screen.getByTestId('design-runtime-story-id-0-0-0') as HTMLInputElement).value;
    fireEvent.change(screen.getByTestId('design-runtime-story-export-0-0-0'), { target: { value: 'RenamedPrimary' } });
    fireEvent.click(screen.getByTestId('design-runtime-add-story-0-0'));
    fireEvent.change(screen.getByTestId('design-runtime-story-export-0-0-1'), { target: { value: 'Secondary' } });
    fireEvent.click(screen.getByTestId('design-runtime-add-source'));
    const componentId = (screen.getByTestId('design-runtime-component-id-1') as HTMLInputElement).value;
    const codeId = (screen.getByTestId('design-runtime-code-id-1') as HTMLInputElement).value;
    fireEvent.change(screen.getByTestId('design-runtime-framework-1'), { target: { value: 'vue' } });
    fireEvent.change(screen.getByTestId('design-runtime-source-path-1'), { target: { value: 'src/Card.vue' } });
    expect((screen.getByTestId('design-runtime-export-name-1') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(screen.getByTestId('design-runtime-add-story-source-1'));
    fireEvent.change(screen.getByTestId('design-runtime-story-source-1-0'), { target: { value: 'src/Card.stories.ts' } });
    fireEvent.change(screen.getByTestId('design-runtime-story-export-1-0-0'), { target: { value: 'Plain' } });
    fireEvent.click(screen.getByTestId('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce());
    const request = vi.mocked(provider.compileProjectDesignRuntime).mock.calls[0]![1];
    expect(request.selections).toMatchObject([
      { framework: 'react', sourcePath: 'src/Button.tsx', exportName: 'Button', metadataExportName: 'ButtonPolicy', storySources: [{ sourcePath: 'src/Button.stories.ts', selections: [{ id: storyId, exportName: 'RenamedPrimary' }, { exportName: 'Secondary' }] }] },
      { framework: 'vue', sourcePath: 'src/Card.vue', exportName: 'default', componentId, codeComponentId: codeId, storySources: [{ sourcePath: 'src/Card.stories.ts', selections: [{ exportName: 'Plain' }] }] },
    ]);
    expect(new Set(request.selections.flatMap((selection) => selection.storySources?.flatMap((source) => source.selections.map((story) => story.id)) ?? [])).size).toBe(3);
    expect(JSON.stringify(request)).not.toContain('sourceText');
  });

  it.each(['body', 'constructor'])('restores selected metadata and story identities, and explicitly rebinds the %s slot', async (slotName) => {
    const state = designRuntimeState();
    state.registry!.components[0]!.slots = { [slotName]: { accepts: ['text'], required: false, multiple: true, source: { kind: 'manual', sourcePath: 'src/Button.tsx', exportName: 'ButtonPolicy' } } };
    state.registry!.components[0]!.stories = [{ id: 'primary-stable', name: 'Primary example', exportName: 'Primary', args: { variant: 'secondary' }, argTypes: {}, source: { kind: 'storybook', sourcePath: 'src/Button.stories.ts', exportName: 'Primary' } }];
    state.codeIndex.components[0]!.slots = { children: { kind: 'react-node', required: false, multiple: true } };
    state.bindings.bindings[0]!.slotMappings = [{ designSlot: slotName, codeSlot: 'children' }];
    const unbound = structuredClone(state);
    unbound.revision = 2;
    unbound.bindings.bindings = [{ schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button', status: 'unbound', verified: false }];
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    vi.mocked(provider.deleteProjectDesignRuntimeBinding).mockResolvedValue({ state: unbound });
    render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByText('Primary example');
    expect((screen.getByTestId('design-runtime-metadata-export-0') as HTMLInputElement).value).toBe('ButtonPolicy');
    expect((screen.getByTestId('design-runtime-story-source-0-0') as HTMLSelectElement).value).toBe('src/Button.stories.ts');
    expect((screen.getByTestId('design-runtime-story-id-0-0-0') as HTMLInputElement).value).toBe('primary-stable');
    expect((screen.getByTestId(`design-runtime-slot-mapping-${slotName}`) as HTMLSelectElement).value).toBe('children');
    fireEvent.click(screen.getByTestId('design-runtime-unbind'));
    await waitFor(() => expect(screen.getByTestId('design-runtime-binding-status').textContent).toBe('Unbound'));
    fireEvent.change(screen.getByTestId(`design-runtime-slot-mapping-${slotName}`), { target: { value: '' } });
    fireEvent.change(screen.getByTestId(`design-runtime-slot-mapping-${slotName}`), { target: { value: 'children' } });
    fireEvent.click(screen.getByTestId('design-runtime-bind'));
    await waitFor(() => expect(provider.putProjectDesignRuntimeBinding).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.putProjectDesignRuntimeBinding).mock.calls[0]![2]).toMatchObject({ expectedRevision: 2, binding: { slotMappings: [{ designSlot: slotName, codeSlot: 'children' }] } });
  });

  it('keeps original compilation sources, identities and metadata after retargeting a binding and reopening', async () => {
    const initial = designRuntimeState();
    const button = initial.registry!.components[0]!;
    button.slots = { body: { accepts: ['text'], required: false, multiple: true, source: { kind: 'manual', sourcePath: 'src/Button.tsx', exportName: 'ButtonPolicy' } } };
    initial.codeIndex.components[0]!.slots = { children: { kind: 'react-node', required: false, multiple: true } };
    initial.bindings.bindings[0]!.slotMappings = [{ designSlot: 'body', codeSlot: 'children' }];
    const cardSource = { kind: 'typescript' as const, sourcePath: 'src/Card.tsx', exportName: 'Card' };
    initial.registry!.components.push({ ...structuredClone(button), id: 'card', name: 'Card', source: cardSource,
      slots: { body: { accepts: ['text'], required: false, multiple: true, source: { kind: 'manual', sourcePath: 'src/Card.tsx', exportName: 'CardPolicy' } } },
    });
    initial.codeIndex.components.push({ ...structuredClone(initial.codeIndex.components[0]!), id: 'code/Card', name: 'Card', source: cardSource, sourcePath: cardSource.sourcePath, exportName: 'Card' });
    initial.bindings.bindings.push({ schemaVersion: 1, id: 'card-binding', componentRef: 'ds:test/card', framework: 'react', status: 'bound', verified: true, codeComponentId: 'code/Card', slotMappings: [{ designSlot: 'body', codeSlot: 'children' }] });
    const retargeted = structuredClone(initial);
    retargeted.revision = 2;
    retargeted.bindings.bindings[0] = { schemaVersion: 1, id: 'button-binding', componentRef: 'ds:test/button', framework: 'react', status: 'bound', verified: true, codeComponentId: 'code/Card', slotMappings: [{ designSlot: 'body', codeSlot: 'children' }] };
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: initial });
    vi.mocked(provider.putProjectDesignRuntimeBinding).mockResolvedValue({ state: retargeted });
    const first = render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByTestId('design-runtime-code-select');
    fireEvent.change(screen.getByTestId('design-runtime-code-select'), { target: { value: 'code/Card' } });
    fireEvent.change(screen.getByTestId('design-runtime-slot-mapping-body'), { target: { value: 'children' } });
    fireEvent.click(screen.getByTestId('design-runtime-bind'));
    await screen.findByText('Revision 2');
    expect(vi.mocked(provider.putProjectDesignRuntimeBinding).mock.calls[0]![2].binding).toMatchObject({ componentRef: 'ds:test/button', codeComponentId: 'code/Card' });
    first.unmount();
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: retargeted });
    render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByTestId('design-runtime-code-select');
    expect((screen.getByTestId('design-runtime-code-select') as HTMLSelectElement).value).toBe('code/Card');
    expect((screen.getByTestId('design-runtime-source-path-0') as HTMLSelectElement).value).toBe('src/Button.tsx');
    expect((screen.getByTestId('design-runtime-code-id-0') as HTMLInputElement).value).toBe('code/Button');
    fireEvent.click(screen.getByTestId('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.compileProjectDesignRuntime).mock.calls[0]![1]).toMatchObject({ expectedRevision: 2, selections: [
      { sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'code/Button', metadataExportName: 'ButtonPolicy' },
      { sourcePath: 'src/Card.tsx', exportName: 'Card', componentId: 'card', codeComponentId: 'code/Card', metadataExportName: 'CardPolicy' },
    ] });
  });

  it('allows viewers to browse and validate while disabling every mutation', async () => {
    vi.mocked(provider.validateProjectDesignRuntimeUsage).mockResolvedValue({ revision: 1, diagnostics: [{
      schemaVersion: 1, code: 'ODDS1003', severity: 'error', message: 'Variant is not allowed.', path: ['props', 'variant'], allowedValues: ['primary', 'secondary'],
    }] });
    render(<DesignRuntimePanel {...panelProps} viewerOnly />);
    await screen.findByTestId('design-runtime-component-select');
    expect(screen.getByText(/Read-only access/)).toBeTruthy();
    expect(screen.getByTestId('design-runtime-compile').closest('fieldset')?.disabled).toBe(true);
    for (const action of ['bind', 'unbind', 'revalidate']) expect((screen.getByTestId(`design-runtime-${action}`) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('design-runtime-component-select') as HTMLSelectElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('design-runtime-prop-include-variant'));
    fireEvent.change(screen.getByTestId('design-runtime-prop-variant'), { target: { value: 'filled' } });
    fireEvent.click(screen.getByTestId('design-runtime-validate'));
    await screen.findByText('ODDS1003');
    expect(provider.validateProjectDesignRuntimeUsage).toHaveBeenCalledWith(expect.objectContaining({ workspaceContext }), { component: 'ds:test/button', props: { variant: 'filled' } });
    expect(screen.getByText('Allowed values: "primary", "secondary"')).toBeTruthy();
    expect(screen.getByText('props → variant')).toBeTruthy();
    expect(provider.putProjectDesignRuntimeBinding).not.toHaveBeenCalled();
  });

  it('uses the current revision for explicit unbind and bind operations', async () => {
    const unbound = designRuntimeState(2);
    unbound.bindings.bindings = [{ schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button', status: 'unbound', verified: false }];
    vi.mocked(provider.deleteProjectDesignRuntimeBinding).mockResolvedValue({ state: unbound });
    render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByTestId('design-runtime-unbind');
    fireEvent.click(screen.getByTestId('design-runtime-unbind'));
    await waitFor(() => expect(screen.getByTestId('design-runtime-binding-status').textContent).toBe('Unbound'));
    fireEvent.click(screen.getByTestId('design-runtime-bind'));
    await waitFor(() => expect(screen.getByTestId('design-runtime-binding-status').textContent).toBe('Bound'));
    expect(provider.putProjectDesignRuntimeBinding).toHaveBeenCalledWith(expect.any(Object), 'button-binding', {
      expectedRevision: 2,
      binding: { schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button', status: 'bound', verified: true, codeComponentId: 'code/Button', propMappings: [], slotMappings: [] },
    });
  });

  it.each(['project', 'workspace'] as const)('discards late reads and drafts when the %s identity changes', async (boundary) => {
    const old = deferred<ProjectDesignRuntimeResponse>();
    vi.mocked(provider.getProjectDesignRuntime).mockReturnValueOnce(old.promise);
    const { rerender } = render(<DesignRuntimePanel {...panelProps} />);
    const nextState = designRuntimeState(7);
    nextState.registry!.components[0]!.name = 'Current component';
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: nextState });
    const nextProps = boundary === 'project' ? { ...panelProps, projectId: 'project-b' }
      : { ...panelProps, workspaceContext: workspaceContextFixture({ workspaceId: 'workspace-b', workspaceMemberId: 'member-b' }) };
    rerender(<DesignRuntimePanel {...nextProps} />);
    await screen.findByText('Revision 7');
    const oldState = designRuntimeState(99);
    oldState.registry!.components[0]!.name = 'Old component';
    await act(async () => old.resolve({ state: oldState }));
    expect(screen.queryByText('Revision 99')).toBeNull();
    expect(screen.queryByText('Old component')).toBeNull();
    expect(vi.mocked(provider.getProjectDesignRuntime).mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(vi.mocked(provider.getProjectDesignRuntime).mock.calls[1]![0]).toMatchObject({ projectId: nextProps.projectId, workspaceContext: nextProps.workspaceContext });
  });

  it('discards a late mutation response after switching projects', async () => {
    const old = deferred<ProjectDesignRuntimeResponse>();
    vi.mocked(provider.deleteProjectDesignRuntimeBinding).mockReturnValueOnce(old.promise);
    const { rerender } = render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByTestId('design-runtime-unbind');
    fireEvent.click(screen.getByTestId('design-runtime-unbind'));
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: designRuntimeState(7) });
    rerender(<DesignRuntimePanel {...panelProps} projectId="project-b" />);
    await screen.findByText('Revision 7');
    await act(async () => old.resolve({ state: designRuntimeState(99) }));
    expect(screen.queryByText('Revision 99')).toBeNull();
    expect(screen.queryByText('Changes saved.')).toBeNull();
  });

  it('keeps a conflicting compile draft, refreshes state, and requires an explicit retry with the new revision', async () => {
    vi.mocked(provider.compileProjectDesignRuntime).mockRejectedValueOnce(new provider.ProjectDesignRuntimeError(409, {
      code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Revision changed.', details: { currentRevision: 7 },
    }));
    const { unmount } = render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByTestId('design-runtime-component-select');
    fireEvent.change(screen.getByTestId('design-runtime-export-name-0'), { target: { value: 'DraftButton' } });
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: designRuntimeState(7) });
    fireEvent.click(screen.getByTestId('design-runtime-compile'));
    await screen.findByText(/The registry changed/);
    expect(screen.getByText('Revision 7')).toBeTruthy();
    expect((screen.getByTestId('design-runtime-export-name-0') as HTMLInputElement).value).toBe('DraftButton');
    expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provider.compileProjectDesignRuntime).mock.calls[1]![1].expectedRevision).toBe(7);
    unmount();
  });

  it('reports a failed conflict refresh without claiming that the latest revision loaded', async () => {
    vi.mocked(provider.compileProjectDesignRuntime).mockRejectedValueOnce(new provider.ProjectDesignRuntimeError(409, {
      code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Revision changed.', details: { currentRevision: 7 },
    }));
    render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByTestId('design-runtime-component-select');
    vi.mocked(provider.getProjectDesignRuntime).mockRejectedValueOnce(new Error('Refresh unavailable.'));
    fireEvent.click(screen.getByTestId('design-runtime-compile'));
    await screen.findByText('Revision changed. Refresh unavailable.');
    expect(screen.queryByText(/latest revision is loaded/)).toBeNull();
    expect(screen.getByText('Revision 1')).toBeTruthy();
    expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce();
  });
});
