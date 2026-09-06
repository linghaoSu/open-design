// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactComponentPreview } from '../../src/components/ReactComponentPreview';
import { COMPONENT_PREVIEW_CHANNEL } from '../../src/components/react-component-preview-frame';
import * as provider from '../../src/providers/react-component-preview';
import { componentPreviewFixture } from '../helpers/react-component-preview-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/react-component-preview', () => ({ createReactComponentPreview: vi.fn() }));
vi.mock('../../src/components/PreviewDrawOverlay', () => ({ PreviewDrawOverlay: ({ children }: { children: React.ReactNode }) => children }));
const props = { projectId: 'proj-1', sourcePath: 'Card.tsx', sourceIdentity: 'v1', workspaceContext: null };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const frame = () => screen.getByTestId('react-component-preview-frame') as HTMLIFrameElement;
function report(status: string, revision = 1, overrides: Partial<MessageEventInit> = {}) {
  const iframe = frame(); const nonce = iframe.srcdoc.match(/nonce="([^"]+)"/)![1];
  fireEvent(window, new MessageEvent('message', { source: iframe.contentWindow, origin: 'null', data: { channel: COMPONENT_PREVIEW_CHANNEL, nonce, revision, status, message: 'Render failed' }, ...overrides }));
}

describe('standalone React component preview', () => {
  it('edits complete JSON props for unresolved or forwarded shapes while retaining the last valid frame', async () => {
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({ controls: [], effectiveProps: {}, mockProps: {}, callbacks: [] }));
    render(<ReactComponentPreview {...props} layout="component" />);
    await screen.findByTestId('react-component-preview-frame');
    await act(async () => {});
    const originalFrame = frame(); const post = vi.spyOn(originalFrame.contentWindow!, 'postMessage'); fireEvent.load(originalFrame);
    report('error', post.mock.calls.at(-1)![0].revision as number);
    expect(screen.getByText(/local preview wrapper/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit JSON props' }));
    const editor = screen.getByLabelText('All preview props (JSON)');
    expect(editor).toBeVisible(); expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: '{"user":{"name":"Ada"},"items":[{"label":"Real value"}]}' } });
    expect(post.mock.calls.at(-1)![0].props).toEqual({ user: { name: 'Ada' }, items: [{ label: 'Real value' }] });
    const last = post.mock.calls.at(-1)![0];
    for (const value of ['{', '{"__proto__":{"polluted":true}}', '[]']) {
      fireEvent.change(editor, { target: { value } });
      expect(editor).toHaveAttribute('aria-invalid', 'true');
      expect(post.mock.calls.at(-1)![0]).toBe(last);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Reset props' }));
    expect(editor).toHaveValue('{}'); expect(editor).not.toHaveAttribute('aria-invalid');
    expect(frame()).toBe(originalFrame); expect(provider.createReactComponentPreview).toHaveBeenCalledOnce();
  });
  it('embeds real preview and props with a collapsed export selector without restarting the frame when layout changes', async () => {
    const request = { exportName: 'CompactCard', nonce: 0 };
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({ requestedExport: 'CompactCard', selectedExport: 'CompactCard' }));
    const view = render(<ReactComponentPreview {...props} layout="component" componentPreviewRequest={request} />);
    await screen.findByTestId('react-component-preview-frame');
    const originalFrame = frame();
    const picker = screen.getByLabelText('Component export');
    expect(picker).not.toBeVisible();
    expect(picker.closest('details')?.open).toBe(false);
    expect(screen.getByLabelText('title')).toBeVisible();
    expect(screen.getByText('Type: string · TypeScript')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry preview' })).not.toBeVisible();
    expect(screen.getByRole('heading', { name: 'Preview props' }).parentElement).toContainElement(screen.getByRole('button', { name: 'Reset props' }));
    fireEvent.click(picker.closest('details')!.querySelector('summary')!);
    expect(screen.getByText('Type: string · TypeScript')).toBeVisible();
    fireEvent.click(picker.closest('details')!.querySelector('summary')!);
    expect(provider.createReactComponentPreview).toHaveBeenLastCalledWith(expect.any(Object), { sourcePath: 'Card.tsx', exportName: 'CompactCard' });
    const post = vi.spyOn(originalFrame.contentWindow!, 'postMessage');
    fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Inline title' } });
    fireEvent.change(screen.getByLabelText('items'), { target: { value: '[{"label":"Inline item"}]' } });
    expect(post.mock.calls.at(-1)?.[0].props).toMatchObject({ title: 'Inline title', items: [{ label: 'Inline item' }] });
    expect(provider.createReactComponentPreview).toHaveBeenCalledOnce();
    view.rerender(<ReactComponentPreview {...props} componentPreviewRequest={request} />);
    expect(screen.getByLabelText('Component export')).toBeVisible();
    expect(frame()).toBe(originalFrame);
    expect(screen.getByLabelText('title')).toHaveValue('Inline title');
    fireEvent.click(screen.getByRole('button', { name: 'Reset props' }));
    expect(post.mock.calls.at(-1)?.[0].props).toEqual(componentPreviewFixture().effectiveProps);
    expect(provider.createReactComponentPreview).toHaveBeenCalledOnce();
  });
  it('keeps component render errors and retry visible while preview details stay collapsed', async () => {
    render(<ReactComponentPreview {...props} layout="component" />);
    await screen.findByTestId('react-component-preview-frame');
    const originalFrame = frame();
    const post = vi.spyOn(originalFrame.contentWindow!, 'postMessage'); fireEvent.load(originalFrame);
    const revision = post.mock.calls.at(-1)![0].revision as number;
    report('error', revision);
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByLabelText('Component export').closest('details')?.open).toBe(false);
    const retry = within(screen.getByRole('alert').parentElement!).getByRole('button', { name: 'Retry preview' });
    expect(retry).toBeVisible(); fireEvent.click(retry);
    report('rendered', revision + 1);
    expect(frame()).toBe(originalFrame);
    expect(screen.getByTestId('react-component-preview-status')).toHaveAttribute('data-status', 'rendered');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(provider.createReactComponentPreview).toHaveBeenCalledOnce();
  });
  it('opens the requested named export and reapplies repeated requests for the same file', async () => {
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({ requestedExport: 'CompactCard', selectedExport: 'CompactCard' }));
    const view = render(<ReactComponentPreview {...props} componentPreviewRequest={{ exportName: 'CompactCard', nonce: 1 }} />);
    await screen.findByLabelText('title');
    expect(provider.createReactComponentPreview).toHaveBeenLastCalledWith(expect.any(Object), { sourcePath: 'Card.tsx', exportName: 'CompactCard' });
    expect(screen.getByLabelText('Component export')).toHaveValue('CompactCard');
    fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Previous request draft' } });
    view.rerender(<ReactComponentPreview {...props} componentPreviewRequest={{ exportName: 'CompactCard', nonce: 2 }} />);
    await waitFor(() => expect(screen.getByLabelText('title')).toHaveValue('Sample title'));
    expect(provider.createReactComponentPreview).toHaveBeenCalledTimes(2);
  });
  it.each(['workspace', 'component'] as const)('keeps an unavailable requested export with diagnostics instead of falling back in %s layout', async (layout) => {
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({
      requestedExport: 'MissingCard', selectedExport: null, bundle: null, controls: [], effectiveProps: {}, mockProps: {}, callbacks: [],
      diagnostics: [{ schemaVersion: 1, code: 'ODDS8002', severity: 'error', message: 'Export MissingCard is not a component candidate.' }],
    }));
    render(<ReactComponentPreview {...props} layout={layout} componentPreviewRequest={{ exportName: 'MissingCard', nonce: 1 }} />);
    expect(await screen.findByText('Export MissingCard is not a component candidate.')).toBeVisible();
    expect(provider.createReactComponentPreview).toHaveBeenLastCalledWith(expect.any(Object), { sourcePath: 'Card.tsx', exportName: 'MissingCard' });
    expect(screen.getByLabelText('Component export')).toHaveValue('MissingCard');
    expect(screen.queryByTestId('react-component-preview-frame')).toBeNull();
    if (layout === 'component') {
      expect(screen.getByLabelText('Component export')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Retry preview' })).toBeVisible();
    }
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({ requestedExport: 'CompactCard', selectedExport: 'CompactCard' }));
    fireEvent.change(screen.getByLabelText('Component export'), { target: { value: 'CompactCard' } });
    await screen.findByTestId('react-component-preview-frame');
    expect(provider.createReactComponentPreview).toHaveBeenLastCalledWith(expect.any(Object), { sourcePath: 'Card.tsx', exportName: 'CompactCard' });
  });
  it('automatically loads mocks, preserves source defaults, and edits typed props without recompiling', async () => {
    render(<ReactComponentPreview {...props} />);
    await screen.findByTestId('react-component-preview-frame');
    expect(provider.createReactComponentPreview).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1', workspaceContext: null, signal: expect.any(AbortSignal) }), { sourcePath: 'Card.tsx' });
    expect(screen.getByLabelText('title')).toHaveValue('Sample title'); expect(screen.getByLabelText('count')).toHaveValue(3);
    expect(screen.getByText(/Sample props are for this preview only/)).toBeTruthy();
    expect(screen.getByText('Type: string · TypeScript')).toBeTruthy();
    expect(screen.getByText(/Mock callback:/)).toBeTruthy(); expect(screen.queryByRole('textbox', { name: 'onClick' })).toBeNull();
    const post = vi.spyOn(frame().contentWindow!, 'postMessage'); fireEvent.load(frame());
    expect(post.mock.calls.at(-1)?.[0].props).not.toHaveProperty('count');
    fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Edited title' } });
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '7' } });
    fireEvent.change(screen.getByLabelText('active'), { target: { value: 'false' } });
    fireEvent.change(screen.getByLabelText('variant'), { target: { value: '"large"' } });
    expect(post.mock.calls.at(-1)?.[0].props).toMatchObject({ title: 'Edited title', count: 7, active: false, variant: 'large' });
    expect(provider.createReactComponentPreview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Use source default' }));
    expect(post.mock.calls.at(-1)?.[0].props).not.toHaveProperty('count');
    fireEvent.click(screen.getByRole('button', { name: 'Reset props' }));
    expect(screen.getByLabelText('title')).toHaveValue('Sample title');
    expect(post.mock.calls.at(-1)?.[0].props).toEqual(componentPreviewFixture().effectiveProps);
  });
  it('treats prototype member names as ordinary props on first render, edit, and reset', async () => {
    const values = { constructor: 'Sample constructor', toString: 'Sample string' };
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({
      controls: ['constructor', 'toString'].map((name) => ({ name, kind: 'string', required: true, provenance: 'unknown', hasDefault: false })),
      effectiveProps: values, mockProps: values, callbacks: [],
    }));
    render(<ReactComponentPreview {...props} />); await screen.findByTestId('react-component-preview-frame');
    expect(screen.getByLabelText('constructor')).toHaveValue('Sample constructor');
    expect(screen.getByLabelText('toString')).toHaveValue('Sample string');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText('Type: string · Type not identified')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('constructor'), { target: { value: 'Edited constructor' } });
    expect(screen.getByLabelText('constructor')).toHaveValue('Edited constructor');
    fireEvent.click(screen.getByRole('button', { name: 'Reset sample value' }));
    expect(screen.getByLabelText('constructor')).toHaveValue('Sample constructor');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('retains invalid JSON as a draft and allows safe nullable and union overrides', async () => {
    render(<ReactComponentPreview {...props} />); await screen.findByTestId('react-component-preview-frame');
    const post = vi.spyOn(frame().contentWindow!, 'postMessage');
    fireEvent.change(screen.getByLabelText('items'), { target: { value: '[{' } });
    expect(screen.getByRole('alert').textContent).toContain('previous value');
    expect(post.mock.calls.every(([message]) => JSON.stringify(message.props.items) === JSON.stringify(componentPreviewFixture().effectiveProps.items))).toBe(true);
    fireEvent.change(screen.getByLabelText('items'), { target: { value: '{"wrong":"shape"}' } });
    expect(post.mock.calls.at(-1)?.[0].props.items).toEqual({ wrong: 'shape' });
    fireEvent.change(screen.getByLabelText('items'), { target: { value: 'null' } });
    expect(post.mock.calls.at(-1)?.[0].props.items).toBeNull();
    fireEvent.change(screen.getByLabelText('items'), { target: { value: '[{"label":"Actual item"}]' } });
    expect(post.mock.calls.at(-1)?.[0].props.items).toEqual([{ label: 'Actual item' }]); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('ignores foreign and stale render reports and recovers from errors through a props update', async () => {
    render(<ReactComponentPreview {...props} />); await screen.findByTestId('react-component-preview-frame');
    report('rendered', 1, { source: window }); report('rendered', 1, { origin: window.location.origin }); report('rendered', 0);
    expect(screen.getByTestId('react-component-preview-status').dataset.status).toBe('loading');
    report('error'); report('rendered'); expect(screen.getByTestId('react-component-preview-status').dataset.status).toBe('error');
    fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Recovered' } });
    report('error', 1); report('rendered', 2);
    expect(screen.getByTestId('react-component-preview-status').dataset.status).toBe('rendered'); expect(screen.queryByRole('alert')).toBeNull();
    report('error', 2); fireEvent.click(screen.getByRole('button', { name: 'Retry preview' })); report('rendered', 3);
    expect(screen.getByTestId('react-component-preview-status').dataset.status).toBe('rendered'); expect(provider.createReactComponentPreview).toHaveBeenCalledOnce();
  });
  it('compiles a newly selected export and resets prior props', async () => {
    render(<ReactComponentPreview {...props} />); await screen.findByLabelText('title');
    fireEvent.change(screen.getByLabelText('title'), { target: { value: 'Previous export edit' } });
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({ requestedExport: 'CompactCard', selectedExport: 'CompactCard' }));
    fireEvent.change(screen.getByLabelText('Component export'), { target: { value: 'CompactCard' } });
    await waitFor(() => expect(screen.getByLabelText('title')).toHaveValue('Sample title'));
    expect(vi.mocked(provider.createReactComponentPreview).mock.calls[1]![1]).toEqual({ sourcePath: 'Card.tsx', exportName: 'CompactCard' });
  });
  it.each(['source', 'workspace', 'project'] as const)('aborts and discards old requests after %s identity changes', async (identity) => {
    let resolve!: (value: ReturnType<typeof componentPreviewFixture>) => void;
    vi.mocked(provider.createReactComponentPreview).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const view = render(<ReactComponentPreview {...props} />);
    const signal = vi.mocked(provider.createReactComponentPreview).mock.calls[0]![0].signal;
    vi.mocked(provider.createReactComponentPreview).mockReturnValue(new Promise(() => {}));
    view.rerender(<ReactComponentPreview {...props} {...(identity === 'source' ? { sourceIdentity: 'v2' } : identity === 'workspace' ? { workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }) } : { projectId: 'other' })} />);
    expect(signal?.aborted).toBe(true); await act(async () => resolve(componentPreviewFixture()));
    expect(screen.queryByTestId('react-component-preview-frame')).toBeNull();
  });
  it('keeps diagnostics actionable when no export can be bundled and retries the read', async () => {
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture({ bundle: null, diagnostics: [{ schemaVersion: 1, code: 'ODDS8002', severity: 'error', message: 'Missing local import: ./Card.css' }] }));
    render(<ReactComponentPreview {...props} />); await screen.findByText('Missing local import: ./Card.css');
    expect(screen.queryByTestId('react-component-preview-frame')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reset props' })).toBeDisabled();
    vi.mocked(provider.createReactComponentPreview).mockResolvedValue(componentPreviewFixture());
    fireEvent.click(screen.getByRole('button', { name: 'Retry preview' })); await screen.findByTestId('react-component-preview-frame');
    expect(provider.createReactComponentPreview).toHaveBeenCalledTimes(2);
  });
});
