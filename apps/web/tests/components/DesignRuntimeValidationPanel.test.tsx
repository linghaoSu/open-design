// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDesignRuntimeState } from '@open-design/contracts';
import { DesignRuntimeValidationPanel } from '../../src/components/DesignRuntimeValidationPanel';
import { DesignRuntimePanel } from '../../src/components/DesignRuntimePanel';
import * as provider from '../../src/providers/design-runtime';
import { emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { artifactValidationFixture, validationSettingsFixture } from '../helpers/design-validation-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';

vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'),
  getProjectDesignRuntimeValidationSettings: vi.fn(), saveProjectDesignRuntimeValidationSettings: vi.fn(), validateProjectDesignRuntimeArtifacts: vi.fn(), getProjectDesignRuntime: vi.fn(),
}));
const scope = { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }) };
const files = [{ name: 'screen.html' }];
const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
async function ready() { await waitFor(() => expect(input('validation-refresh').disabled).toBe(false)); }
function server() {
  let state = emptyDesignRuntimeState(1);
  const settings = () => ({ ...validationSettingsFixture(state.revision), settings: state.validationSettings });
  vi.mocked(provider.getProjectDesignRuntimeValidationSettings).mockImplementation(async () => structuredClone(settings()));
  vi.mocked(provider.getProjectDesignRuntime).mockImplementation(async () => ({ state: structuredClone(state) }));
  vi.mocked(provider.saveProjectDesignRuntimeValidationSettings).mockImplementation(async (_scope, request) => {
    if (request.expectedRevision !== state.revision) throw new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Changed', details: { currentRevision: state.revision } });
    state = { ...state, revision: state.revision + 1, validationSettings: request.settings }; return { state: structuredClone(state) };
  });
  vi.mocked(provider.validateProjectDesignRuntimeArtifacts).mockImplementation(async () => ({ revision: state.revision, result: { ...artifactValidationFixture(), mode: state.validationSettings.mode } }));
  return { get state() { return state; }, advance() { state = { ...state, revision: state.revision + 1 }; }, changePolicy() { state = { ...state, revision: state.revision + 1, validationSettings: { ...state.validationSettings, projectConstraints: { ...state.validationSettings.projectConstraints, guided: { ...state.validationSettings.projectConstraints.guided, rawCss: { ...state.validationSettings.projectConstraints.guided.rawCss, colors: 'warning' } } } } }; } };
}
function Harness({ viewerOnly = false, accepted = vi.fn() }: { viewerOnly?: boolean; accepted?: (state: ProjectDesignRuntimeState) => void }) {
  const [state, setState] = useState(emptyDesignRuntimeState(1));
  return <DesignRuntimeValidationPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} onState={(next) => { accepted(next); setState(next); }} />;
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => { cleanup(); resetWorkspaceAccountGeneration(); });

describe('DesignRuntimeValidationPanel', () => {
  it('loads in StrictMode, validates selected files using saved mode, then explicitly saves the mode', async () => {
    const stored = server(); const accepted = vi.fn(); render(<StrictMode><Harness accepted={accepted}/></StrictMode>); await ready();
    fireEvent.change(input('validation-mode'), { target: { value: 'guided' } });
    fireEvent.click(input('validation-source-screen.html')); fireEvent.click(input('validation-run')); await ready();
    expect(provider.validateProjectDesignRuntimeArtifacts).toHaveBeenCalledWith(expect.objectContaining(scope), { expectedRevision: 1, sources: [{ sourcePath: 'screen.html', language: 'html' }], outputs: [{ sourcePath: 'screen.html' }] });
    expect(screen.getByText('ODDS2002')).toBeTruthy(); expect(screen.getByText('screen.html:3:4')).toBeTruthy();
    expect(stored.state.validationSettings.mode).toBe('explore');
    fireEvent.click(input('validation-save-settings')); await ready();
    expect(stored.state.validationSettings.mode).toBe('guided'); expect(accepted).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.saveProjectDesignRuntimeValidationSettings).mock.calls[0]![1]).toMatchObject({ expectedRevision: 1, settings: { mode: 'guided' } });
  });
  it('keeps a dirty mode through refresh and requires explicit rebasing before save', async () => {
    const stored = server(); render(<Harness/>); await ready();
    fireEvent.change(input('validation-mode'), { target: { value: 'strict' } }); stored.advance();
    fireEvent.click(input('validation-refresh')); await ready();
    expect(input('validation-mode').value).toBe('strict'); expect(input('validation-save-settings').disabled).toBe(true);
    fireEvent.click(input('validation-rebase')); fireEvent.click(input('validation-save-settings')); await ready();
    expect(stored.state.validationSettings.mode).toBe('strict'); expect(vi.mocked(provider.saveProjectDesignRuntimeValidationSettings).mock.calls[0]![1].expectedRevision).toBe(2);
  });
  it('preserves a newly authoritative policy when only the mode was edited before refresh and rebase', async () => {
    const stored = server(); render(<Harness/>); await ready();
    fireEvent.change(input('validation-mode'), { target: { value: 'guided' } }); stored.changePolicy();
    fireEvent.click(input('validation-refresh')); await ready(); fireEvent.click(input('validation-rebase')); fireEvent.click(input('validation-save-settings')); await ready();
    expect(stored.state.validationSettings).toMatchObject({ mode: 'guided', projectConstraints: { guided: { rawCss: { colors: 'warning' } } } });
  });
  it('preserves a dirty draft after a 409 and never retries the mutation silently', async () => {
    const stored = server(); render(<Harness/>); await ready();
    fireEvent.change(input('validation-mode'), { target: { value: 'guided' } }); stored.advance(); fireEvent.click(input('validation-save-settings')); await ready();
    expect(provider.saveProjectDesignRuntimeValidationSettings).toHaveBeenCalledOnce(); expect(input('validation-mode').value).toBe('guided'); expect(input('validation-rebase')).toBeTruthy();
  });
  it('allows read-only evaluation while disabling policy mutation', async () => {
    server(); render(<Harness viewerOnly/>); await ready();
    expect(input('validation-mode').disabled).toBe(true); expect(input('validation-save-settings').disabled).toBe(true);
    fireEvent.click(input('validation-source-screen.html')); fireEvent.click(input('validation-run')); await ready();
    expect(provider.validateProjectDesignRuntimeArtifacts).toHaveBeenCalledOnce(); expect(provider.saveProjectDesignRuntimeValidationSettings).not.toHaveBeenCalled();
  });
  it('aborts and ignores stale workspace/account responses', async () => {
    server(); let oldResolve!: (value: ReturnType<typeof validationSettingsFixture>) => void;
    vi.mocked(provider.getProjectDesignRuntimeValidationSettings).mockImplementationOnce(() => new Promise((resolve) => { oldResolve = resolve; }));
    const props = { scope, state: null, files, viewerOnly: false, onState: vi.fn() };
    const view = render(<DesignRuntimeValidationPanel {...props}/>);
    const oldSignal = vi.mocked(provider.getProjectDesignRuntimeValidationSettings).mock.calls[0]![0].signal;
    advanceWorkspaceAccountGeneration(scope.workspaceContext.workspaceId); view.rerender(<DesignRuntimeValidationPanel {...props}/>); await ready();
    await act(async () => { oldResolve({ ...validationSettingsFixture(99), settings: { ...validationSettingsFixture().settings, mode: 'strict' } }); });
    expect(oldSignal?.aborted).toBe(true); expect(input('validation-mode').value).toBe('explore');
  });
  it('keeps the Validation entry reachable when a broken lock prevents the main state read', async () => {
    server(); vi.mocked(provider.getProjectDesignRuntime).mockRejectedValue(new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_DEPENDENCY_INVALID', message: 'Broken lock' }));
    vi.mocked(provider.getProjectDesignRuntimeValidationSettings).mockResolvedValue({ ...validationSettingsFixture(), effectiveConstraints: null,
      diagnostics: [{ schemaVersion: 1, code: 'ODDS5001', severity: 'error', message: 'Exact bytes missing' }], settings: { ...validationSettingsFixture().settings, mode: 'strict' } });
    render(<DesignRuntimePanel projectId="project" workspaceContext={scope.workspaceContext} files={files} viewerOnly={false} onClose={vi.fn()}/>);
    await waitFor(() => expect(input('design-runtime-validation-tab').disabled).toBe(false)); fireEvent.click(input('design-runtime-validation-tab')); await ready();
    expect(screen.getByText(/Exact bytes missing/)).toBeTruthy(); fireEvent.change(input('validation-mode'), { target: { value: 'explore' } });
    expect(input('validation-save-settings').disabled).toBe(false);
  });
});
