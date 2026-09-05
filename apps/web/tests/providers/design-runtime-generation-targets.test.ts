import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectDesignRuntimeGenerationTargets, saveProjectDesignRuntimeGenerationTargets } from '../../src/providers/design-runtime';
import { emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
afterEach(() => vi.unstubAllGlobals());
const targets = { schemaVersion: 1 as const, outputs: [{ sourcePath: 'future/Applications.tsx', exportName: 'Applications', screenId: 'applications' }] };
describe('generation targets provider', () => {
  it('reads and saves canonical targets over authorized cancellable HTTP', async () => {
    const scope = { projectId: 'project / one', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }), signal: new AbortController().signal };
    for (const test of [
      { run: () => getProjectDesignRuntimeGenerationTargets(scope), method: 'GET', body: undefined, response: { revision: 3, targets } },
      { run: () => saveProjectDesignRuntimeGenerationTargets(scope, { expectedRevision: 3, targets }), method: 'PUT', body: { expectedRevision: 3, targets }, response: { state: { ...emptyDesignRuntimeState(4), generationTargets: targets } } },
    ]) {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(test.response))); vi.stubGlobal('fetch', fetch); await expect(test.run()).resolves.toEqual(test.response);
      const [url, init] = fetch.mock.calls[0]! as [string, RequestInit]; expect(url).toBe('/api/projects/project%20%2F%20one/design-runtime/generation/targets'); expect(init.method).toBe(test.method); expect(init.signal).toBe(scope.signal);
      expect(new Headers(init.headers).get('x-od-workspace-id')).toBe('team'); expect(new Headers(init.headers).get('x-od-workspace-member-id')).toBe('member'); expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(test.body);
    }
  });
  it('rejects invalid targets before I/O and invalid authoritative response shapes', async () => {
    const scope = { projectId: 'project', workspaceContext: null }; const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => saveProjectDesignRuntimeGenerationTargets(scope, { expectedRevision: 0, targets: { schemaVersion: 1, outputs: [{ sourcePath: '../escape.tsx' }] } })).toThrow(); expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(new Response(JSON.stringify({ revision: 3, targets, ready: true }))); await expect(getProjectDesignRuntimeGenerationTargets(scope)).rejects.toThrow();
  });
});
