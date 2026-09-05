import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compileProjectDesignRuntime,
  saveProjectDesignRuntimeDocument,
  validateProjectDesignRuntimeDocument,
  resolveProjectDesignRuntimeDocument,
  getProjectDesignRuntimeReferences,
  searchProjectDesignRuntimeProjectComponents,
  getProjectDesignRuntimeDeletion,
  getProjectDesignRuntimeHistory,
  stageProjectDesignRuntimeComponent,
  getProjectDesignRuntimeChange,
  publishProjectDesignRuntimeComponent,
  discardProjectDesignRuntimeComponent,
  undoProjectDesignRuntimeComponent,
  deleteProjectDesignRuntimeComponent,
  detachProjectDesignRuntimeInstance,
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
    const document = { schemaVersion: 1 as const, id: 'design', screens: [] };
    const definition = { schemaVersion: 1 as const, id: 'Local', name: 'Local', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1 as const, type: 'text' as const, id: 'text', text: 'Local' } };
    const draft = { schemaVersion: 1, id: 'draft', componentRef: 'local:Local', baseDefinition: null, proposedDefinition: definition, source: { type: 'edit' } };
    const references = { schemaVersion: 1, target: 'local:Local', directUsages: [], transitiveUsages: [], affectedScreens: [], chains: [], cycles: [], diagnostics: [] };
    const resolution = { schemaVersion: 1, document, origins: [], diagnostics: [] };
    const impact = { schemaVersion: 1, componentRef: 'local:Local', baseRevision: 0, proposedRevision: 1, usages: references, current: resolution, proposed: resolution, diagnostics: [] };
    const stage = { expectedRevision: 1, draftId: 'draft', expectedDefinitionRevision: 0, definition };
    const publish = { expectedRevision: 1, expectedDefinitionRevision: 0 };
    const undo = { expectedRevision: 1, draftId: 'undo', expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 };
    const deletion = { expectedRevision: 1, action: { type: 'detach' as const } };
    const detach = { instance: { schemaVersion: 1 as const, type: 'instance' as const, id: 'instance', ref: 'local:Local', overrides: [] }, mode: 'guided' as const };
    const cases = [
      { run: () => saveProjectDesignRuntimeDocument(scope, { ...revision, document }), path: '/document', method: 'PUT', response: { state }, body: { ...revision, document } },
      { run: () => validateProjectDesignRuntimeDocument(scope, { document }), path: '/document/validate', method: 'POST', response: { revision: 1, resolution }, body: { document } },
      { run: () => resolveProjectDesignRuntimeDocument(scope), path: '/document/resolve', method: 'GET', response: { revision: 1, resolution }, body: undefined },
      { run: () => getProjectDesignRuntimeReferences(scope, 'local:Local'), path: '/references?componentRef=local%3ALocal', method: 'GET', response: { revision: 1, references }, body: undefined },
      { run: () => searchProjectDesignRuntimeProjectComponents(scope, 'local & button'), path: '/project-components?query=local%20%26%20button', method: 'GET', response: { revision: 1, components: [definition] }, body: undefined },
      { run: () => getProjectDesignRuntimeDeletion(scope, 'Local'), path: '/project-components/Local/deletion', method: 'GET', response: { revision: 1, analysis: { schemaVersion: 1, componentRef: 'local:Local', canDelete: true, usages: references, diagnostics: [] } }, body: undefined },
      { run: () => getProjectDesignRuntimeHistory(scope, 'Local'), path: '/project-components/Local/history', method: 'GET', response: { revision: 1, history: [] }, body: undefined },
      { run: () => stageProjectDesignRuntimeComponent(scope, stage), path: '/component-changes', method: 'POST', response: { state, draft, impact }, body: stage },
      { run: () => getProjectDesignRuntimeChange(scope, 'draft'), path: '/component-changes/draft', method: 'GET', response: { revision: 1, draft, impact }, body: undefined },
      { run: () => publishProjectDesignRuntimeComponent(scope, 'draft', publish), path: '/component-changes/draft/publish', method: 'POST', response: { state, impact }, body: publish },
      { run: () => discardProjectDesignRuntimeComponent(scope, 'draft', revision), path: '/component-changes/draft', method: 'DELETE', response: { state }, body: revision },
      { run: () => undoProjectDesignRuntimeComponent(scope, 'Local', undo), path: '/project-components/Local/undo', method: 'POST', response: { state, draft, impact }, body: undo },
      { run: () => deleteProjectDesignRuntimeComponent(scope, 'Local', deletion), path: '/project-components/Local', method: 'DELETE', response: { state }, body: deletion },
      { run: () => detachProjectDesignRuntimeInstance(scope, detach), path: '/instances/detach', method: 'POST', response: { revision: 1, node: definition.template, origins: [{ nodeId: 'text', sourceNodeId: 'text', instancePath: [] }], diagnostics: [] }, body: detach },
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

  it('rejects malformed stage revision input before issuing a mutation request', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(() => stageProjectDesignRuntimeComponent({ projectId: 'p', workspaceContext: null }, {
      expectedRevision: 1, draftId: 'draft', expectedDefinitionRevision: 2,
      definition: { schemaVersion: 1, id: 'Local', name: 'Local', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, type: 'text', id: 'text', text: '' } },
    })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
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
      code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Revision changed.', details: { currentRevision: 7, currentDefinitionRevision: 3, diagnostics: [diagnostic] },
    } }), { status: 409 })));
    const outcome = getProjectDesignRuntime({ projectId: 'p', workspaceContext: null });
    await expect(outcome).rejects.toBeInstanceOf(ProjectDesignRuntimeError);
    await expect(outcome).rejects.toMatchObject({ status: 409, currentRevision: 7, currentDefinitionRevision: 3, diagnostics: [diagnostic], message: 'Revision changed.' });
  });
});
