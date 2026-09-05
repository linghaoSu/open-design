// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDesignRuntimeState } from '@open-design/contracts';
import { DesignGenerationTargetsPanel } from '../../src/components/DesignGenerationTargetsPanel';
import { DesignRuntimeValidationPanel } from '../../src/components/DesignRuntimeValidationPanel';
import * as provider from '../../src/providers/design-runtime';
import { emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { validationSettingsFixture } from '../helpers/design-validation-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';
vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'), getProjectDesignRuntimeGenerationTargets: vi.fn(), saveProjectDesignRuntimeGenerationTargets: vi.fn(), getProjectDesignRuntimeValidationSettings: vi.fn() }));
const scope = { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }) };
const files = [{ name: 'src/Existing.tsx' }]; const field = (id: string) => screen.getByTestId(id) as HTMLInputElement;
async function ready() { await waitFor(() => expect(field('generation-targets-refresh').disabled).toBe(false)); }
function server() {
  let state = emptyDesignRuntimeState(1);
  vi.mocked(provider.getProjectDesignRuntimeGenerationTargets).mockImplementation(async () => structuredClone({ revision: state.revision, targets: state.generationTargets }));
  vi.mocked(provider.getProjectDesignRuntimeValidationSettings).mockResolvedValue(validationSettingsFixture(1));
  vi.mocked(provider.saveProjectDesignRuntimeGenerationTargets).mockImplementation(async (_scope, input) => {
    if (input.expectedRevision !== state.revision) throw new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Changed', details: { currentRevision: state.revision } });
    state = { ...state, revision: state.revision + 1, generationTargets: input.targets }; return { state: structuredClone(state) };
  });
  return { get state() { return state; }, advance() { state = { ...state, revision: state.revision + 1 }; } };
}
function Harness({ viewerOnly = false, accepted = vi.fn() }: { viewerOnly?: boolean; accepted?: (state: ProjectDesignRuntimeState) => void }) {
  const [state, setState] = useState(emptyDesignRuntimeState(1));
  return <DesignGenerationTargetsPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} onState={(next) => { accepted(next); setState(next); }}/>;
}
function add(index = 0) {
  fireEvent.click(field('generation-targets-add'));
  fireEvent.change(field(`generation-target-path-${index}`), { target: { value: `future/Applications${index}.tsx` } });
  fireEvent.change(field(`generation-target-export-${index}`), { target: { value: 'Applications' } });
  fireEvent.change(field(`generation-target-screen-${index}`), { target: { value: `new-screen-${index}` } });
}
beforeEach(() => vi.resetAllMocks()); afterEach(() => { cleanup(); resetWorkspaceAccountGeneration(); });
describe('saved generation target authoring', () => {
  it('allows future file and semantic IDs and explicitly saves them, then reloads exact targets', async () => {
    const stored = server(); const accepted = vi.fn(); const view = render(<StrictMode><Harness accepted={accepted}/></StrictMode>); await ready(); add();
    expect(provider.saveProjectDesignRuntimeGenerationTargets).not.toHaveBeenCalled(); expect(stored.state.generationTargets.outputs).toEqual([]);
    fireEvent.click(field('generation-targets-save')); await ready(); expect(accepted).toHaveBeenCalledOnce();
    expect(stored.state.generationTargets.outputs).toEqual([{ sourcePath: 'future/Applications0.tsx', exportName: 'Applications', screenId: 'new-screen-0' }]);
    expect(vi.mocked(provider.saveProjectDesignRuntimeGenerationTargets).mock.calls[0]![1]).toEqual({ expectedRevision: 1, targets: stored.state.generationTargets });
    view.unmount(); render(<Harness/>); await ready(); expect(field('generation-target-path-0').value).toBe('future/Applications0.tsx'); expect(field('generation-target-screen-0').value).toBe('new-screen-0');
  });
  it('preserves dirty rows across refresh and requires a deliberate rebase before saving', async () => {
    const stored = server(); render(<Harness/>); await ready(); add(); stored.advance(); fireEvent.click(field('generation-targets-refresh')); await ready();
    expect(field('generation-target-path-0').value).toBe('future/Applications0.tsx'); expect(field('generation-targets-save').disabled).toBe(true);
    fireEvent.click(field('generation-targets-rebase')); fireEvent.click(field('generation-targets-save')); await ready();
    expect(vi.mocked(provider.saveProjectDesignRuntimeGenerationTargets).mock.calls[0]![1].expectedRevision).toBe(2);
  });
  it('retains edits after a conflict and never retries a mutation automatically', async () => {
    const stored = server(); render(<Harness/>); await ready(); add(); stored.advance(); fireEvent.click(field('generation-targets-save')); await ready();
    expect(provider.saveProjectDesignRuntimeGenerationTargets).toHaveBeenCalledOnce(); expect(field('generation-targets-rebase')).toBeTruthy(); expect(field('generation-target-screen-0').value).toBe('new-screen-0');
  });
  it('rejects duplicate screen targets before HTTP and saves an explicit empty target list', async () => {
    const stored = server(); render(<Harness/>); await ready(); add(); add(1);
    fireEvent.change(field('generation-target-screen-1'), { target: { value: 'new-screen-0' } }); fireEvent.click(field('generation-targets-save')); expect(provider.saveProjectDesignRuntimeGenerationTargets).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(field('generation-target-delete-1')); fireEvent.click(field('generation-target-delete-0')); fireEvent.click(field('generation-targets-save')); await ready(); expect(stored.state.generationTargets.outputs).toEqual([]);
  });
  it('allows viewers to inspect raw targets but disables mutation', async () => {
    server(); render(<Harness viewerOnly/>); await ready(); expect(provider.getProjectDesignRuntimeGenerationTargets).toHaveBeenCalled(); expect(field('generation-targets-add').disabled).toBe(true); expect(field('generation-targets-save').disabled).toBe(true);
  });
  it.each(['account', 'permission', 'revision'] as const)('cancels a pending save when %s changes and ignores late state', async (change) => {
    server(); let resolve!: (value: { state: ProjectDesignRuntimeState }) => void;
    vi.mocked(provider.saveProjectDesignRuntimeGenerationTargets).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const props = { scope, state: emptyDesignRuntimeState(1), files, viewerOnly: false, onState: vi.fn() }; const view = render(<DesignGenerationTargetsPanel {...props}/>); await ready(); add(); fireEvent.click(field('generation-targets-save'));
    const signal = vi.mocked(provider.saveProjectDesignRuntimeGenerationTargets).mock.calls[0]![0].signal;
    if (change === 'account') advanceWorkspaceAccountGeneration(scope.workspaceContext.workspaceId);
    view.rerender(<DesignGenerationTargetsPanel {...props} {...(change === 'permission' ? { viewerOnly: true } : change === 'revision' ? { state: emptyDesignRuntimeState(2) } : {})}/>); await ready();
    expect(signal?.aborted).toBe(true); await act(async () => resolve({ state: emptyDesignRuntimeState(99) })); expect(props.onState).not.toHaveBeenCalled();
  });
  it('is discoverable in Validation and loads without a valid main state or selected validation sources', async () => {
    server(); render(<DesignRuntimeValidationPanel scope={scope} state={null} files={files} viewerOnly={false} onState={vi.fn()}/>);
    await waitFor(() => expect(field('generation-targets-open').disabled).toBe(false)); expect(provider.getProjectDesignRuntimeGenerationTargets).not.toHaveBeenCalled();
    fireEvent.click(field('generation-targets-open')); await ready(); add(); fireEvent.click(field('generation-targets-save')); await ready(); expect(provider.saveProjectDesignRuntimeGenerationTargets).toHaveBeenCalledOnce();
  });
});
