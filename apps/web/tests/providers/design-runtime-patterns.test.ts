import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectDesignRuntimePattern, instantiateProjectDesignRuntimePattern, listProjectDesignRuntimePatterns } from '../../src/providers/design-runtime';
import { designPatternFixture } from '../helpers/design-pattern-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
afterEach(() => vi.unstubAllGlobals());
describe('pattern provider', () => {
  it('uses the same project-authorized HTTP routes and draft DTOs with cancellation', async () => {
    const value = designPatternFixture(); const scope = { projectId: 'project / one', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }), signal: new AbortController().signal };
    for (const test of [
      { run: () => listProjectDesignRuntimePatterns(scope, 'resource list'), path: '/patterns?query=resource%20list', method: 'GET', body: undefined, response: { revision: 1, schemaVersion: 1, dependency: value.dependency, patterns: [value.pattern] } },
      { run: () => getProjectDesignRuntimePattern(scope, value.pattern.id), path: '/patterns/ResourceList', method: 'GET', body: undefined, response: { revision: 1, schemaVersion: 1, dependency: value.dependency, pattern: value.pattern } },
      { run: () => instantiateProjectDesignRuntimePattern(scope, value.pattern.id, value.request), path: '/patterns/ResourceList/instantiate', method: 'POST', body: value.request, response: value.result },
    ]) {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(test.response))); vi.stubGlobal('fetch', fetch);
      await expect(test.run()).resolves.toEqual(test.response);
      const [url, init] = fetch.mock.calls[0]! as [string, RequestInit]; expect(url).toBe(`/api/projects/project%20%2F%20one/design-runtime${test.path}`); expect(init.method).toBe(test.method); expect(init.signal).toBe(scope.signal);
      expect(new Headers(init.headers).get('x-od-workspace-id')).toBe('team'); expect(new Headers(init.headers).get('x-od-workspace-member-id')).toBe('member');
      expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(test.body);
    }
  });
  it('rejects invalid path IDs and injected authoritative package/registry context before HTTP', () => {
    const value = designPatternFixture(); const scope = { projectId: 'project', workspaceContext: null }; const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => getProjectDesignRuntimePattern(scope, '../escape')).toThrow();
    for (const extra of [{ lock: {} }, { projectComponents: {} }, { registry: {} }, { version: 'latest' }]) expect(() => instantiateProjectDesignRuntimePattern(scope, value.pattern.id, { ...value.request, ...extra })).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
