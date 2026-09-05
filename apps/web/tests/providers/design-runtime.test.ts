import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileProjectDesignRuntime,
  deleteProjectDesignRuntimeBinding,
  getProjectDesignRuntime,
  ProjectDesignRuntimeError,
  putProjectDesignRuntimeBinding,
  revalidateProjectDesignRuntimeBinding,
  resolveProjectDesignRuntimeBinding,
  searchProjectDesignRuntimeCodeComponents,
  searchProjectDesignRuntimeComponents,
  validateProjectDesignRuntimeUsage,
  type ProjectDesignRuntimeScope,
} from '../../src/providers/design-runtime';
import { designRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

afterEach(() => vi.unstubAllGlobals());

describe('project design runtime provider', () => {
  it('carries exact workspace authority, revision bodies, encoded paths, and cancellation on every operation', async () => {
    const state = designRuntimeState();
    const scope: ProjectDesignRuntimeScope = {
      projectId: 'project / one',
      workspaceContext: workspaceContextFixture({ workspaceId: 'team-a', workspaceMemberId: 'member-a' }),
      signal: new AbortController().signal,
    };
    const revision = { expectedRevision: 1 };
    const compile = { ...revision, designSystemId: 'test', selections: [{
      sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'code/Button',
    }] };
    const bind = { ...revision, binding: state.bindings.bindings[0]! };
    const validate = { component: 'ds:test/button', props: { variant: 'primary' } };
    const cases = [
      { run: () => getProjectDesignRuntime(scope), path: '', method: 'GET', response: { state }, body: undefined },
      { run: () => compileProjectDesignRuntime(scope, compile), path: '/compile', method: 'POST', response: { state }, body: compile },
      { run: () => putProjectDesignRuntimeBinding(scope, 'binding/a', bind), path: '/bindings/binding%2Fa', method: 'PUT', response: { state }, body: bind },
      { run: () => deleteProjectDesignRuntimeBinding(scope, 'binding/a', revision), path: '/bindings/binding%2Fa', method: 'DELETE', response: { state }, body: revision },
      { run: () => revalidateProjectDesignRuntimeBinding(scope, 'binding/a', revision), path: '/bindings/binding%2Fa/revalidate', method: 'POST', response: { state }, body: revision },
      { run: () => resolveProjectDesignRuntimeBinding(scope, 'binding/a'), path: '/bindings/binding%2Fa/resolve', method: 'GET', response: { revision: 1, resolution: { ok: true, component: state.registry!.components[0], codeComponent: state.codeIndex.components[0] } }, body: undefined },
      { run: () => validateProjectDesignRuntimeUsage(scope, validate), path: '/validate', method: 'POST', response: { revision: 1, diagnostics: [] }, body: validate },
      { run: () => searchProjectDesignRuntimeComponents(scope, 'button & card'), path: '/components?query=button%20%26%20card', method: 'GET', response: { revision: 1, components: state.registry!.components }, body: undefined },
      { run: () => searchProjectDesignRuntimeCodeComponents(scope, 'button & card'), path: '/code-components?query=button%20%26%20card', method: 'GET', response: { revision: 1, components: state.codeIndex.components }, body: undefined },
    ];
    for (const testCase of cases) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(testCase.response), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(testCase.run()).resolves.toEqual(testCase.response);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/projects/project%20%2F%20one/design-runtime${testCase.path}`);
      expect(init.method).toBe(testCase.method);
      expect(init.signal).toBe(scope.signal);
      expect(init.cache).toBe('no-store');
      const headers = new Headers(init.headers);
      expect(headers.get('x-od-workspace-id')).toBe('team-a');
      expect(headers.get('x-od-workspace-member-id')).toBe('member-a');
      expect(headers.get('x-od-workspace-type')).toBe('team');
      expect(headers.get('x-od-workspace-can-write-synced-files')).toBe('true');
      expect(init.body === undefined ? undefined : JSON.parse(String(init.body))).toEqual(testCase.body);
    }
  });

  it('keeps a null workspace unscoped and rejects malformed successful responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: { revision: 0 } })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(getProjectDesignRuntime({ projectId: 'p', workspaceContext: null })).rejects.toThrow();
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).has('x-od-workspace-id')).toBe(false);
  });

  it('preserves structured diagnostics and conflict revision from the canonical error details', async () => {
    const diagnostic = { schemaVersion: 1, code: 'ODDS1003', severity: 'error', message: 'Invalid variant.', allowedValues: ['primary'] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: {
      code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Revision changed.', details: { currentRevision: 7, diagnostics: [diagnostic] },
    } }), { status: 409 })));
    const outcome = getProjectDesignRuntime({ projectId: 'p', workspaceContext: null });
    await expect(outcome).rejects.toBeInstanceOf(ProjectDesignRuntimeError);
    await expect(outcome).rejects.toMatchObject({ status: 409, currentRevision: 7, diagnostics: [diagnostic], message: 'Revision changed.' });
  });
});
