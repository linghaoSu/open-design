import { afterEach, describe, expect, it, vi } from 'vitest';
import * as provider from '../../src/providers/design-runtime';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { handoffUiFixture } from '../helpers/design-handoff-fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('local binding and handoff providers', () => {
  it('uses shared DTOs, encoded paths, exact workspace authority, cancellation and JSON evidence boundaries', async () => {
    const { state, source, binding, result } = handoffUiFixture();
    const scope = { projectId: 'project / one', workspaceContext: workspaceContextFixture({ workspaceId: 'team-a', workspaceMemberId: 'member-a' }), signal: new AbortController().signal };
    const registration = { expectedRevision: 2, source, binding }; const handoff = { expectedRevision: 2, id: 'handoff', framework: 'react' as const };
    const emit = { ...handoff, outputs: [{ screenId: 'home', sourcePath: 'src/Home.tsx', exportName: 'Home' }] };
    const cases = [
      { run: () => provider.searchProjectDesignRuntimeOwnedCodeComponents(scope, 'Card + header'), path: '/project-code-components?query=Card%20%2B%20header', method: 'GET', body: undefined, response: { revision: 2, components: state.projectCodeIndex.components } },
      { run: () => provider.registerProjectDesignRuntimeLocalBinding(scope, registration), path: '/project-code-components/register-binding', method: 'POST', body: registration, response: { state, binding, diagnostics: [] } },
      { run: () => provider.refreshProjectDesignRuntimeCodeComponent(scope, 'project/Card', { expectedRevision: 2 }), path: '/project-code-components/project%2FCard/refresh', method: 'POST', body: { expectedRevision: 2 }, response: { state, diagnostics: [] } },
      { run: () => provider.createProjectDesignRuntimeHandoff(scope, handoff), path: '/handoffs', method: 'POST', body: handoff, response: { revision: 2, result } },
      { run: () => provider.emitProjectDesignRuntimeHandoff(scope, emit), path: '/handoffs/emit', method: 'POST', body: emit, response: { revision: 2, handoff: result, code: { schemaVersion: 1, ok: true, files: [], diagnostics: [] } } },
    ];
    for (const entry of cases) {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry.response))); vi.stubGlobal('fetch', fetch);
      await expect(entry.run()).resolves.toEqual(entry.response);
      const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/projects/project%20%2F%20one/design-runtime${entry.path}`); expect(init.method).toBe(entry.method);
      expect(init.signal).toBe(scope.signal); expect(init.cache).toBe('no-store');
      expect(new Headers(init.headers).get('x-od-workspace-member-id')).toBe('member-a');
      expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(entry.body);
      expect(String(init.body)).not.toContain('sourceText');
    }
  });
  it('rejects caller bytes, path escapes and mismatched response revisions, retaining structured failures', async () => {
    const { source, binding, result } = handoffUiFixture(); const scope = { projectId: 'project', workspaceContext: null };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => provider.registerProjectDesignRuntimeLocalBinding(scope, { expectedRevision: 2, source: { ...source, sourceText: 'injected' }, binding } as never)).toThrow();
    expect(() => provider.emitProjectDesignRuntimeHandoff(scope, { expectedRevision: 2, id: 'handoff', framework: 'react', outputs: [{ screenId: 'home', sourcePath: '../Home.tsx', exportName: 'Home' }] })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ revision: 3, result })));
    await expect(provider.createProjectDesignRuntimeHandoff(scope, { expectedRevision: 2, id: 'handoff', framework: 'react' })).rejects.toThrow();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Changed', details: { expectedRevision: 2, currentRevision: 4 } } }), { status: 409 }));
    await expect(provider.refreshProjectDesignRuntimeCodeComponent(scope, source.codeComponentId, { expectedRevision: 2 })).rejects.toMatchObject({ status: 409, currentRevision: 4 });
  });
});
