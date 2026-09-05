// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignRuntimePatterns } from '../../src/components/DesignRuntimePatterns';
import { ProjectStructurePanel } from '../../src/components/ProjectStructurePanel';
import * as provider from '../../src/providers/design-runtime';
import { designPatternFixture } from '../helpers/design-pattern-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'), listProjectDesignRuntimePatterns: vi.fn(), getProjectDesignRuntimePattern: vi.fn(), instantiateProjectDesignRuntimePattern: vi.fn(), saveProjectDesignRuntimeDocument: vi.fn() }));
const scope = { projectId: 'project', workspaceContext: null };
const field = (id: string) => screen.getByTestId(id) as HTMLInputElement;
function mockProvider() {
  const value = designPatternFixture();
  vi.mocked(provider.listProjectDesignRuntimePatterns).mockResolvedValue({ revision: 1, schemaVersion: 1, dependency: value.dependency, patterns: [value.pattern] });
  vi.mocked(provider.getProjectDesignRuntimePattern).mockResolvedValue({ revision: 1, schemaVersion: 1, dependency: value.dependency, pattern: value.pattern });
  vi.mocked(provider.instantiateProjectDesignRuntimePattern).mockResolvedValue(value.result);
  return value;
}
function setup(viewerOnly = false) {
  const value = mockProvider(); const props = { scope, state: value.state, document: value.document, screenId: 'applications', viewerOnly, disabled: false, sourceIdentity: [], onAdd: vi.fn(), onBusyChange: vi.fn() };
  const mounted = render(<DesignRuntimePatterns {...props} />); return { value, props, mounted };
}
async function configure() {
  fireEvent.click(field('pattern-load')); await screen.findByTestId('pattern-select');
  fireEvent.change(field('pattern-select'), { target: { value: 'ResourceList' } }); await screen.findByTestId('pattern-instance-id');
  fireEvent.change(field('pattern-instance-id'), { target: { value: 'list' } });
  fireEvent.click(field('semantic-explicit-pattern-config-title')); fireEvent.change(field('semantic-prop-pattern-config-title'), { target: { value: 'Applications' } });
  const slot = within(screen.getByTestId('pattern-slot-items')); fireEvent.click(slot.getByTestId('semantic-add-node-root'));
  fireEvent.change(slot.getByRole('textbox'), { target: { value: 'First resource' } });
}
beforeEach(() => vi.resetAllMocks()); afterEach(cleanup);
describe('pattern authoring', () => {
  it('retrieves and configures through shared editors, then previews before explicit draft adoption', async () => {
    const { value, props } = setup(); expect(provider.listProjectDesignRuntimePatterns).not.toHaveBeenCalled(); await configure();
    expect(props.onAdd).not.toHaveBeenCalled(); fireEvent.click(field('pattern-preview')); await screen.findByTestId('pattern-result');
    expect(props.onAdd).not.toHaveBeenCalled(); const [authority, id, request] = vi.mocked(provider.instantiateProjectDesignRuntimePattern).mock.calls[0]!;
    expect(authority).toMatchObject(scope); expect(id).toBe('ResourceList'); expect(request).toMatchObject({ ...value.request, slots: { items: [{ type: 'text', text: 'First resource' }] } });
    expect(request.document).toBe(value.document); fireEvent.click(field('pattern-add')); expect(props.onAdd).toHaveBeenCalledExactlyOnceWith(value.result.node); expect(provider.saveProjectDesignRuntimeDocument).not.toHaveBeenCalled();
  });
  it('allows viewers to inspect/configure/preview but disables adding', async () => {
    const { props } = setup(true); await configure(); fireEvent.click(field('pattern-preview')); await screen.findByTestId('pattern-add');
    expect(field('pattern-add').disabled).toBe(true); fireEvent.click(field('pattern-add')); expect(props.onAdd).not.toHaveBeenCalled();
  });
  it.each(['document', 'state', 'source', 'permission', 'account', 'config'] as const)('invalidates a completed preview when %s changes', async (change) => {
    const { value, props, mounted } = setup(); await configure(); fireEvent.click(field('pattern-preview')); await screen.findByTestId('pattern-add');
    if (change === 'config') fireEvent.change(field('pattern-instance-id'), { target: { value: 'new-instance' } });
    else mounted.rerender(<DesignRuntimePatterns {...props} {...(change === 'document' ? { document: structuredClone(value.document) } : change === 'state' ? { state: { ...value.state, revision: 2 } } : change === 'source' ? { sourceIdentity: ['changed'] } : change === 'permission' ? { viewerOnly: true } : { scope: { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'other', workspaceMemberId: 'member' }) } })} />);
    expect(screen.queryByTestId('pattern-add')).toBeNull(); expect(props.onAdd).not.toHaveBeenCalled();
  });
  it('aborts and ignores late responses after an authoring draft change', async () => {
    const { value, props, mounted } = setup(); let resolve!: (response: typeof value.result) => void;
    vi.mocked(provider.instantiateProjectDesignRuntimePattern).mockReturnValue(new Promise((done) => { resolve = done; }));
    await configure(); fireEvent.click(field('pattern-preview')); const authority = vi.mocked(provider.instantiateProjectDesignRuntimePattern).mock.calls[0]![0];
    mounted.rerender(<DesignRuntimePatterns {...props} document={structuredClone(value.document)} />); expect(authority.signal?.aborted).toBe(true);
    await act(async () => resolve(value.result)); expect(screen.queryByTestId('pattern-result')).toBeNull(); expect(props.onAdd).not.toHaveBeenCalled();
  });
  it('shows server diagnostics without exposing partial output and rejects stale returned source proof', async () => {
    const { value } = setup(); await configure();
    vi.mocked(provider.instantiateProjectDesignRuntimePattern).mockResolvedValueOnce({ ...value.result, node: null, origins: [], diagnostics: [{ schemaVersion: 1, severity: 'error', code: 'ODDS1004', message: 'Invalid slot composition.' }] });
    fireEvent.click(field('pattern-preview')); await screen.findByText(/Invalid slot composition/); expect(screen.queryByTestId('pattern-add')).toBeNull();
    vi.mocked(provider.instantiateProjectDesignRuntimePattern).mockResolvedValueOnce({ ...value.result, dependency: { ...value.dependency, source: { ...value.dependency.source, digest: `sha256:${'b'.repeat(64)}` } } });
    fireEvent.click(field('pattern-preview')); await screen.findByText('This preview no longer matches the project or draft. Preview again.'); expect(screen.queryByTestId('pattern-add')).toBeNull();
  });
  it('uses the existing screen draft/save workflow and retains stable emitted IDs on save', async () => {
    const value = mockProvider(); const onState = vi.fn();
    vi.mocked(provider.saveProjectDesignRuntimeDocument).mockImplementation(async (_scope, request) => ({ state: { ...value.state, revision: 2, document: request.document } }));
    render(<ProjectStructurePanel scope={scope} state={value.state} viewerOnly={false} onState={onState} />);
    fireEvent.click(field('structure-patterns-open')); await configure(); fireEvent.click(field('pattern-preview')); await screen.findByTestId('pattern-add'); fireEvent.click(field('pattern-add'));
    expect(provider.saveProjectDesignRuntimeDocument).not.toHaveBeenCalled(); expect(onState).not.toHaveBeenCalled(); expect(field('structure-save-document').disabled).toBe(false);
    fireEvent.click(field('structure-save-document')); await waitFor(() => expect(onState).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.saveProjectDesignRuntimeDocument).mock.calls[0]![1]).toEqual({ expectedRevision: 1, document: { ...value.document, screens: [{ ...value.document.screens[0]!, children: [value.result.node] }] } });
  });
});
