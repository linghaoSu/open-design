// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignPreviewPanel } from '../../src/components/DesignPreviewPanel';
import { DESIGN_PREVIEW_CHANNEL, designPreviewFrameDocument } from '../../src/components/design-preview-frame';
import * as provider from '../../src/providers/design-runtime';
import { previewUiFixture } from '../helpers/design-preview-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof provider>('../../src/providers/design-runtime'), createProjectDesignRuntimePreview: vi.fn() }));
const scope = { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }) };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(provider.createProjectDesignRuntimePreview).mockResolvedValue(previewUiFixture().result); });
afterEach(cleanup);

describe('real component preview panel', () => {
  it('starts with screen selection and keeps optional selectors collapsed until advanced settings are opened', async () => {
    const { state, result } = previewUiFixture();
    result.request.kind = 'production-handoff'; result.request.framework = 'vue';
    result.sides.forEach((side) => { side.kind = 'production-handoff'; });
    vi.mocked(provider.createProjectDesignRuntimePreview).mockResolvedValue(result);
    render(<DesignPreviewPanel scope={scope} state={state} />);
    const advanced = screen.getByTestId('design-preview-advanced') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(screen.getByTestId('design-preview-screen-home').closest('details')).toBeNull();
    for (const selector of ['kind', 'framework', 'draft']) expect(screen.getByTestId(`design-preview-${selector}`).closest('details')).toBe(advanced);
    fireEvent.click(advanced.querySelector('summary')!);
    expect(advanced.open).toBe(true);
    fireEvent.change(screen.getByTestId('design-preview-kind'), { target: { value: 'production-handoff' } });
    fireEvent.change(screen.getByTestId('design-preview-framework'), { target: { value: 'vue' } });
    expect(provider.createProjectDesignRuntimePreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('design-preview-build'));
    await screen.findByTestId('design-preview-frame-current-home');
    expect(provider.createProjectDesignRuntimePreview).toHaveBeenCalledWith(expect.objectContaining(scope), expect.objectContaining({ kind: 'production-handoff', framework: 'vue', screenIds: ['home'] }));
  });

  it('offers the structure page instead of an unusable preview form when no screens exist', () => {
    const { state } = previewUiFixture(); const open = vi.fn();
    const view = render(<DesignPreviewPanel scope={scope} state={{ ...state, document: null }} onOpenStructure={open} />);
    expect(screen.getByTestId('design-preview-empty').textContent).toContain('Save a semantic screen');
    expect(screen.queryByTestId('design-preview-build')).toBeNull(); expect(screen.queryByTestId('design-preview-advanced')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Project structure' }));
    expect(open).toHaveBeenCalledOnce(); expect(provider.createProjectDesignRuntimePreview).not.toHaveBeenCalled();
    view.rerender(<DesignPreviewPanel scope={scope} state={{ ...state, document: { ...state.document!, screens: [] } }} onOpenStructure={open} />);
    expect(screen.getByTestId('design-preview-open-structure')).toBeTruthy(); expect(screen.queryByTestId('design-preview-build')).toBeNull();
  });

  it('builds only on explicit action using saved revision and workspace, and accepts only this opaque frame identity', async () => {
    render(<StrictMode><DesignPreviewPanel scope={scope} state={previewUiFixture().state} /></StrictMode>);
    expect(provider.createProjectDesignRuntimePreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('design-preview-build')); fireEvent.click(screen.getByTestId('design-preview-build'));
    const frame = await screen.findByTestId('design-preview-frame-current-home') as HTMLIFrameElement;
    expect(provider.createProjectDesignRuntimePreview).toHaveBeenCalledOnce(); expect(vi.mocked(provider.createProjectDesignRuntimePreview).mock.calls[0]).toEqual([expect.objectContaining(scope), expect.objectContaining({ expectedRevision: 2, kind: 'semantic-design', framework: 'react', screenIds: ['home'] })]);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts'); expect(frame.srcdoc).toContain("frame-src 'none'");
    const nonce = frame.srcdoc.match(/nonce="([^"]+)"/)![1]; const data = { channel: DESIGN_PREVIEW_CHANNEL, nonce, status: 'rendered' };
    fireEvent(window, new MessageEvent('message', { source: window, origin: 'null', data }));
    expect(screen.getByTestId('design-preview-status-current-home').dataset.status).toBe('loading');
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: { ...data, nonce: 'old' } }));
    expect(screen.getByTestId('design-preview-status-current-home').dataset.status).toBe('loading');
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data }));
    expect(screen.getByTestId('design-preview-status-current-home').dataset.status).toBe('rendered');
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data: { ...data, status: 'error', message: 'Blocked capability' } }));
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, origin: 'null', data }));
    expect(screen.getByTestId('design-preview-status-current-home').dataset.status).toBe('error'); expect(screen.getByRole('alert').textContent).toContain('Blocked capability');
  });
  it('keeps unavailable proposed sides and full affected-screen evidence visible instead of rendering stale implementation', async () => {
    const { state, result } = previewUiFixture(); const comparison = { type: 'shared-draft' as const, draftId: 'draft', expectedDefinitionRevision: 2 };
    result.request.comparison = comparison; result.impact = { source: 'shared-reference-graph', affectedScreens: [{ kind: 'screen', documentId: 'document', screenId: 'home' }, { kind: 'screen', documentId: 'document', screenId: 'other' }], diagnostics: [] };
    const error = { schemaVersion: 1 as const, severity: 'error' as const, code: 'ODDS7001' as const, message: 'Local binding is stale.' };
    result.sides.push({ ...structuredClone(result.sides[0]!), role: 'proposed', screens: [{ screenId: 'home', sourcePath: 'src/Home.tsx', exportName: 'Home', bundle: null, diagnostics: [error] }] });
    vi.mocked(provider.createProjectDesignRuntimePreview).mockResolvedValue(result);
    render(<DesignPreviewPanel scope={scope} state={state} selection={{ id: 'selection', comparison, screenIds: ['home'] }} />);
    expect((screen.getByTestId('design-preview-advanced') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('design-preview-comparison').closest('details')).toBeNull();
    fireEvent.click(screen.getByTestId('design-preview-build')); await screen.findByText('Local binding is stale.');
    expect(screen.getByTestId('design-preview-impact').textContent).toContain('home, other'); expect(screen.queryByTestId('design-preview-frame-proposed-home')).toBeNull();
    fireEvent.click(screen.getByTestId('design-preview-clear-comparison')); expect(screen.queryByTestId('design-preview-comparison')).toBeNull(); expect(screen.queryByTestId('design-preview-frame-current-home')).toBeNull();
  });
  it('aborts and ignores late responses on scope changes and invalidates bundles after a revision change', async () => {
    const { state, result } = previewUiFixture(); let resolve!: (value: typeof result) => void;
    vi.mocked(provider.createProjectDesignRuntimePreview).mockReturnValue(new Promise((done) => { resolve = done; }));
    const view = render(<DesignPreviewPanel scope={scope} state={state} />); fireEvent.click(screen.getByTestId('design-preview-build'));
    const authority = vi.mocked(provider.createProjectDesignRuntimePreview).mock.calls[0]![0];
    view.rerender(<DesignPreviewPanel scope={{ ...scope, projectId: 'other' }} state={state} />); expect(authority.signal?.aborted).toBe(true);
    await act(async () => { resolve(result); }); expect(screen.queryByTestId('design-preview-frame-current-home')).toBeNull();
    view.rerender(<DesignPreviewPanel scope={scope} state={state} />); vi.mocked(provider.createProjectDesignRuntimePreview).mockResolvedValue(result); fireEvent.click(screen.getByTestId('design-preview-build')); await screen.findByTestId('design-preview-frame-current-home');
    view.rerender(<DesignPreviewPanel scope={scope} state={{ ...state, revision: 3 }} />); await waitFor(() => expect(screen.queryByTestId('design-preview-frame-current-home')).toBeNull());
  });
  it('keeps script-closing values encoded inside both documents and refuses unsafe frame identities', () => {
    const { result } = previewUiFixture(); const bundle = { ...result.sides[0]!.screens[0]!.bundle!, javascript: 'window.value="</script><img src=https://example.invalid>\u2028";' };
    const document = designPreviewFrameDocument(bundle, 'safe-frame-identity');
    expect(document).not.toContain('</script><img'); expect(document).not.toContain('https://example.invalid');
    expect(document).toContain('sandbox="allow-scripts"'); expect(document).not.toContain('allow-same-origin');
    expect(() => designPreviewFrameDocument(bundle, 'bad"nonce')).toThrow();
  });
});
