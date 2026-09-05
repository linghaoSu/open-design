import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectDesignRuntimePreview, ProjectDesignRuntimeError } from '../../src/providers/design-runtime';
import { previewUiFixture } from '../helpers/design-preview-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
afterEach(() => vi.unstubAllGlobals());
describe('preview HTTP provider', () => {
  it('carries canonical selection, workspace headers and cancellation without authoring source evidence', async () => {
    const { result } = previewUiFixture(); const signal = new AbortController().signal;
    const scope = { projectId: 'project / one', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }), signal };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result))); vi.stubGlobal('fetch', fetchMock);
    expect(await createProjectDesignRuntimePreview(scope, result.request)).toEqual(result);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/projects/project%20%2F%20one/design-runtime/previews');
    const options = fetchMock.mock.calls[0]![1]; expect(options.method).toBe('POST'); expect(options.signal).toBe(signal); expect(JSON.parse(options.body)).toEqual(result.request);
    expect(options.headers.get('x-od-workspace-id')).toBe('team'); expect(options.headers.get('x-od-workspace-member-id')).toBe('member');
  });
  it('preserves conflict diagnostics and rejects malformed response identities', async () => {
    const { result } = previewUiFixture(); const scope = { projectId: 'project', workspaceContext: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'DESIGN_RUNTIME_PREVIEW_CONFLICT', message: 'Source changed', details: { diagnostics: [{ schemaVersion: 1, code: 'ODDS8001', severity: 'error', message: 'Source changed' }] } } }), { status: 409 })));
    await expect(createProjectDesignRuntimePreview(scope, result.request)).rejects.toBeInstanceOf(ProjectDesignRuntimeError);
    result.revision++; vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(result))));
    await expect(createProjectDesignRuntimePreview(scope, result.request)).rejects.toThrow();
  });
});
