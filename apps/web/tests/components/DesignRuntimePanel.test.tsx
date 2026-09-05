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
      binding: { schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button', status: 'bound', verified: true, codeComponentId: 'code/Button', propMappings: [] },
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
