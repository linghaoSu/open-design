// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignHandoffPanel } from '../../src/components/DesignHandoffPanel';
import * as provider from '../../src/providers/design-runtime';
import * as registry from '../../src/providers/registry';
import { handoffUiFixture } from '../helpers/design-handoff-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof provider>('../../src/providers/design-runtime'),
  registerProjectDesignRuntimeLocalBinding: vi.fn(), createProjectDesignRuntimeHandoff: vi.fn(), emitProjectDesignRuntimeHandoff: vi.fn(),
  getProjectDesignRuntime: vi.fn(), refreshProjectDesignRuntimeCodeComponent: vi.fn(), putProjectDesignRuntimeBinding: vi.fn(),
}));
vi.mock('../../src/providers/registry', () => ({ fetchProjectFiles: vi.fn() }));
const scope = { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'team-a', workspaceMemberId: 'member-a' }) };
const props = () => ({ scope, state: handoffUiFixture().state, files: [{ name: 'src/Card.tsx' }], viewerOnly: false, onState: vi.fn() });
const element = (id: string) => screen.getByTestId(id) as HTMLInputElement;
beforeEach(() => { vi.clearAllMocks(); const fixture = handoffUiFixture(); vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: fixture.state }); vi.mocked(provider.createProjectDesignRuntimeHandoff).mockResolvedValue({ revision: 2, result: fixture.result }); });
afterEach(cleanup);

describe('DesignHandoffPanel', () => {
  it('preserves typed value transformations on unrelated source edits and uses exact local revision plus workspace scope', async () => {
    const input = props(); const fixture = handoffUiFixture(3);
    vi.mocked(provider.registerProjectDesignRuntimeLocalBinding).mockResolvedValue({ state: fixture.state, binding: fixture.binding, diagnostics: [] });
    render(<StrictMode><DesignHandoffPanel {...input} /></StrictMode>);
    fireEvent.change(element('handoff-source-path'), { target: { value: 'src/renamed/Card.tsx' } });
    expect(element('handoff-local-component').disabled).toBe(true);
    fireEvent.click(element('handoff-register-local')); fireEvent.click(element('handoff-register-local'));
    await waitFor(() => expect(input.onState).toHaveBeenCalledOnce());
    expect(provider.registerProjectDesignRuntimeLocalBinding).toHaveBeenCalledOnce();
    const [authority, request] = vi.mocked(provider.registerProjectDesignRuntimeLocalBinding).mock.calls[0]!;
    expect(authority).toMatchObject(scope); expect(request.expectedRevision).toBe(2);
    expect(request.binding.definitionRevision).toBe(3); expect(request.binding.propMappings).toEqual(fixture.binding.propMappings);
    expect(request.source.sourcePath).toBe('src/renamed/Card.tsx'); expect(request.source).not.toHaveProperty('sourceText');
  });
  it('supports existing DS code, rejects malformed mappings locally and retains a conflicted draft without retry', async () => {
    const input = props(); vi.mocked(provider.putProjectDesignRuntimeBinding).mockRejectedValue(new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Changed', details: { currentRevision: 3 } }));
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: handoffUiFixture(3).state });
    render(<DesignHandoffPanel {...input} />);
    fireEvent.change(element('handoff-binding-mode'), { target: { value: 'existing' } });
    fireEvent.change(element('handoff-prop-mappings'), { target: { value: '{invalid' } });
    fireEvent.click(element('handoff-register-local')); await screen.findByRole('alert');
    expect(provider.putProjectDesignRuntimeBinding).not.toHaveBeenCalled();
    fireEvent.change(element('handoff-prop-mappings'), { target: { value: JSON.stringify(handoffUiFixture().binding.propMappings) } });
    fireEvent.click(element('handoff-register-local'));
    await waitFor(() => expect(input.onState).toHaveBeenCalled());
    expect(provider.putProjectDesignRuntimeBinding).toHaveBeenCalledOnce(); expect(element('handoff-prop-mappings').value).toContain('valueTransform');
    expect(screen.getByText(/Your binding draft is preserved/)).toBeTruthy();
  });
  it('shows readiness and emitted source, then invalidates downloads when the project revision changes', async () => {
    const input = props(); const fixture = handoffUiFixture();
    const code = { schemaVersion: 1 as const, ok: true, files: [{ screenId: 'home', sourcePath: 'nested/Home.tsx', exportName: 'Home', language: 'tsx' as const, content: 'export function Home(){ return <Card appearance="filled"/>; }' }], diagnostics: [] };
    vi.mocked(provider.emitProjectDesignRuntimeHandoff).mockResolvedValue({ revision: 2, handoff: fixture.result, code });
    const view = render(<DesignHandoffPanel {...input} />);
    fireEvent.click(element('handoff-create')); await waitFor(() => expect(element('handoff-readiness').textContent).toBe('Ready'));
    fireEvent.change(element('handoff-output-path-home'), { target: { value: 'nested/Home.tsx' } });
    fireEvent.click(element('handoff-emit')); await screen.findByTestId('handoff-emitted-file');
    expect(vi.mocked(provider.emitProjectDesignRuntimeHandoff).mock.calls[0]![1]).toMatchObject({ expectedRevision: 2, framework: 'react', outputs: [{ screenId: 'home', sourcePath: 'nested/Home.tsx' }] });
    expect(screen.getByText(code.files[0]!.content)).toBeTruthy();
    view.rerender(<DesignHandoffPanel {...input} state={handoffUiFixture(3).state} />);
    expect(element('handoff-readiness').textContent).toBe('Not ready');
    expect((screen.getByRole('button', { name: 'Download code' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('refreshes project file suggestions with exact authority and preserves broken-source diagnostics', async () => {
    const input = props(); vi.mocked(registry.fetchProjectFiles).mockResolvedValue([{ name: 'src/New.vue' }] as never);
    const diagnostic = { schemaVersion: 1 as const, code: 'ODDS7004' as const, severity: 'error' as const, message: 'Source unavailable.' };
    vi.mocked(provider.refreshProjectDesignRuntimeCodeComponent).mockResolvedValue({ state: handoffUiFixture(3).state, diagnostics: [diagnostic] });
    render(<DesignHandoffPanel {...input} />); fireEvent.click(element('handoff-refresh-files'));
    await waitFor(() => expect(registry.fetchProjectFiles).toHaveBeenCalledOnce());
    expect(vi.mocked(registry.fetchProjectFiles).mock.calls[0]).toEqual(['project', expect.objectContaining({ workspaceContext: scope.workspaceContext, fresh: true, requireAuthoritative: true })]);
    await waitFor(() => expect(input.onState).toHaveBeenCalled());
    fireEvent.click(element('handoff-refresh-code-project/Card')); await screen.findByText('Source unavailable.');
    expect(provider.refreshProjectDesignRuntimeCodeComponent).toHaveBeenCalledWith(expect.objectContaining(scope), 'project/Card', { expectedRevision: 2 });
  });
  it('allows viewer handoff reads while preventing source mutations and ignores late responses after scope changes', async () => {
    const input = props(); let resolve!: (value: Awaited<ReturnType<typeof provider.createProjectDesignRuntimeHandoff>>) => void;
    vi.mocked(provider.createProjectDesignRuntimeHandoff).mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<DesignHandoffPanel {...input} viewerOnly />);
    expect(element('handoff-register-local').closest('fieldset')!.disabled).toBe(true);
    expect(element('handoff-refresh-code-project/Card').disabled).toBe(true);
    fireEvent.click(element('handoff-create')); const authority = vi.mocked(provider.createProjectDesignRuntimeHandoff).mock.calls[0]![0];
    view.rerender(<DesignHandoffPanel {...input} viewerOnly scope={{ ...scope, projectId: 'other' }} />);
    expect(authority.signal?.aborted).toBe(true);
    await act(async () => { resolve({ revision: 2, result: handoffUiFixture().result }); });
    expect(screen.queryByTestId('handoff-result')).toBeNull(); expect(input.onState).not.toHaveBeenCalled();
  });
});
