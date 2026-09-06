import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReactComponentPreview } from '../../src/providers/react-component-preview';
import { ProjectDesignRuntimeError } from '../../src/providers/design-runtime';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { componentPreviewFixture } from '../helpers/react-component-preview-fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('component preview provider', () => {
  const scope = { projectId: 'proj-1', workspaceContext: null };
  it('carries JSON and exact workspace authority through an analytics-style fetch wrapper', async () => {
    const result = componentPreviewFixture();
    const underlying = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => underlying(url, { ...init, headers: { ...init.headers, 'x-analytics': 'enabled' } }));
    const signal = new AbortController().signal;
    const workspaceContext = workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' });
    expect(await createReactComponentPreview({ ...scope, workspaceContext, signal }, { sourcePath: 'Card.tsx' })).toEqual(result);
    const [url, options] = underlying.mock.calls[0]!;
    expect(url).toBe('/api/projects/proj-1/design-runtime/component-preview');
    const headers = new Headers(options.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-od-workspace-id')).toBe('team'); expect(headers.get('x-od-workspace-member-id')).toBe('member');
    expect(options.signal).toBe(signal); expect(options.cache).toBe('no-store');
    expect(JSON.parse(options.body)).toEqual({ sourcePath: 'Card.tsx' });
  });
  it('rejects traversal, code-valued props, and reserved JSON keys before network access', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(createReactComponentPreview(scope, { sourcePath: '../Card.tsx' })).rejects.toThrow();
    await expect(createReactComponentPreview(scope, { sourcePath: 'Card.tsx', props: { callback: (() => {}) as never } })).rejects.toThrow();
    await expect(createReactComponentPreview(scope, { sourcePath: 'Card.tsx', props: JSON.parse('{"__proto__":{}}') })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['projectId', 'sourcePath', 'requestedExport', 'requestedProps'] as const)('rejects a valid response with mismatched %s', async (field) => {
    const result = componentPreviewFixture({ [field]: field === 'requestedProps' ? { extra: true } : field === 'sourcePath' ? 'Other.tsx' : field === 'requestedExport' ? 'default' : 'other' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
    await expect(createReactComponentPreview(scope, { sourcePath: 'Card.tsx' })).rejects.toThrow('does not match');
  });
  it('accepts reordered JSON keys but preserves typed daemon errors', async () => {
    const props = { item: { title: 'Title', count: 2 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(componentPreviewFixture({ requestedProps: { item: { count: 2, title: 'Title' } } }))));
    await expect(createReactComponentPreview(scope, { sourcePath: 'Card.tsx', props })).resolves.toBeTruthy();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'FORBIDDEN', message: 'Read denied' } }, { status: 403 })));
    await expect(createReactComponentPreview(scope, { sourcePath: 'Card.tsx' })).rejects.toBeInstanceOf(ProjectDesignRuntimeError);
  });
});
