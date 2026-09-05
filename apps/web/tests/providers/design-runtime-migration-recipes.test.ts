import { afterEach, describe, expect, it, vi } from 'vitest';
import { listProjectDesignRuntimeMigrationRecipes, instantiateProjectDesignRuntimeMigrationRecipe } from '../../src/providers/design-runtime';
import { migrationFixture } from '../helpers/design-runtime-migration-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
afterEach(() => vi.unstubAllGlobals());
describe('published recipe provider', () => {
  it('calls the exact shared endpoints with authority, cancellation and canonical plan bodies', async () => {
    const { recipe, request, result } = migrationFixture();
    const scope = { projectId: 'project / one', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }), signal: new AbortController().signal };
    for (const test of [
      { run: () => listProjectDesignRuntimeMigrationRecipes(scope, 'test', '2.0.0+release'), path: '/versions/test/2.0.0%2Brelease/migrations', method: 'GET', body: undefined, response: { revision: 1, recipes: [recipe] } },
      { run: () => instantiateProjectDesignRuntimeMigrationRecipe(scope, request), path: '/upgrades/recipes', method: 'POST', body: request, response: result },
    ]) {
      const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(test.response))); vi.stubGlobal('fetch', fetch);
      await expect(test.run()).resolves.toEqual(test.response);
      const [url, init] = fetch.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/projects/project%20%2F%20one/design-runtime${test.path}`); expect(init.method).toBe(test.method); expect(init.signal).toBe(scope.signal);
      expect(new Headers(init.headers).get('x-od-workspace-id')).toBe('team'); expect(new Headers(init.headers).get('x-od-workspace-member-id')).toBe('member');
      expect(init.body ? JSON.parse(String(init.body)) : undefined).toEqual(test.body);
    }
  });
  it('rejects nonexact source selection and client-supplied plan injection before HTTP', () => {
    const { request } = migrationFixture(); const scope = { projectId: 'project', workspaceContext: null }; const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(() => listProjectDesignRuntimeMigrationRecipes(scope, 'test', 'latest')).toThrow();
    expect(() => instantiateProjectDesignRuntimeMigrationRecipe(scope, { ...request, plan: {} } as typeof request)).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
