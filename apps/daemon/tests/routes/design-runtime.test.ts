import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ProjectDesignRuntimeCodeComponentsResponseSchema,
  ProjectDesignRuntimeVersionsResponseSchema,
  ProjectDesignRuntimeVersionResponseSchema,
  ProjectDesignRuntimePublishVersionResponseSchema,
  ProjectDesignRuntimeDependencyResponseSchema,
  ProjectDesignRuntimeDocumentResponseSchema,
  ProjectDesignRuntimeReferencesResponseSchema,
  ProjectDesignRuntimeProjectComponentsResponseSchema,
  ProjectDesignRuntimeDeletionResponseSchema,
  ProjectDesignRuntimeHistoryResponseSchema,
  ProjectDesignRuntimeStageComponentResponseSchema,
  ProjectDesignRuntimeChangeResponseSchema,
  ProjectDesignRuntimePublishComponentResponseSchema,
  ProjectDesignRuntimeDetachResponseSchema,
  ProjectDesignRuntimeComponentsResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema,
  ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeValidateResponseSchema,
} from '@open-design/contracts';
import { createDesignSystemVersion } from '../../src/services/design-runtime/design-system-version.js';
import { packageFixture } from '../fixtures/design-runtime/design-system-version.js';
import { mixedProjectCompilerRequest } from '../fixtures/design-runtime/compiler-selections.js';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';

const selection = { sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'ui/Button' };
const localDefinition = {
  schemaVersion: 1 as const, id: 'LocalButton', name: 'Local Button', revision: 1,
  props: { variant: { type: 'enum' as const, values: ['primary', 'secondary'], required: false, default: 'primary' } },
  template: { schemaVersion: 1 as const, type: 'component' as const, id: 'button-template', ref: 'ds:test/button' },
  propMappings: [{ prop: 'variant', nodeId: 'button-template', path: ['props', 'variant'] as ['props', string] }],
};
const semanticDocument = { schemaVersion: 1, id: 'design', screens: [{ schemaVersion: 1, type: 'screen', id: 'Applications', children: [{ schemaVersion: 1, type: 'instance', id: 'submit', ref: 'local:LocalButton', overrides: [] }] }] };
const compileRequest = { expectedRevision: 0, designSystemId: 'test', selections: [selection] };

async function withRoute<T>(run: (fixture: {
  request: (method: string, suffix?: string, body?: unknown) => Promise<{ status: number; json: any }>;
  readSource: ReturnType<typeof vi.fn<(projectId: string, sourcePath: string) => Promise<string>>>;
  authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  catalogRead: MockInstance<ReturnType<typeof createDesignRuntimeStore>['readVersion']>;
  catalogList: MockInstance<ReturnType<typeof createDesignRuntimeStore>['listVersions']>;
  storeRead: MockInstance<ReturnType<typeof createDesignRuntimeStore>['read']>;
}) => Promise<T>): Promise<T> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
  migrateDesignRuntimeStore(db);
  const readSource = vi.fn(async (_projectId: string, _sourcePath: string) => "export function Button(props: { variant?: 'primary' | 'secondary' }) {}");
  const store = createDesignRuntimeStore(db);
  const storeRead = vi.spyOn(store, 'read');
  const catalogRead = vi.spyOn(store, 'readVersion');
  const catalogList = vi.spyOn(store, 'listVersions');
  const service = createProjectDesignRuntimeService({ store, readSource });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true);
  const app = express();
  app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const prefix = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/project/design-runtime`;
  try {
    return await run({
      readSource,
      authorize,
      storeRead, catalogRead, catalogList,
      request: async (method, suffix = '', body) => {
        const response = await fetch(`${prefix}${suffix}`, {
          method,
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        });
        return { status: response.status, json: await response.json() };
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}

describe('project design runtime HTTP routes', () => {
  it('dispatches immutable publication, exact export and dependency lifecycle using canonical responses', async () => {
    await withRoute(async ({ request, readSource, authorize }) => {
      const pkg = packageFixture();
      const imported = await request('POST', '/versions', { expectedRevision: 0, package: pkg });
      expect(imported.status).toBe(200);
      let state = ProjectDesignRuntimePublishVersionResponseSchema.parse(imported.json).state;
      expect(authorize.mock.lastCall?.[3]).toEqual({ mode: 'write', capability: 'writeFiles' });
      expect(ProjectDesignRuntimeVersionsResponseSchema.parse((await request('GET', '/versions')).json).versions[0]?.version).toBe('1.0.0');
      expect(ProjectDesignRuntimeVersionResponseSchema.parse((await request('GET', '/versions/acme/1.0.0')).json).version.package).toEqual(createDesignSystemVersion(pkg).package);
      expect((await request('GET', '/versions/acme/latest')).status).toBe(400);
      expect((await request('GET', '/versions/acme/9.0.0')).status).toBe(404);
      state = ProjectDesignRuntimeResponseSchema.parse((await request('POST', '/dependency', { expectedRevision: state.revision, designSystemId: 'acme', version: '1.0.0', range: '^1.0.0' })).json).state;
      expect(ProjectDesignRuntimeDependencyResponseSchema.parse((await request('GET', '/dependency/resolve')).json).resolution.ok).toBe(true);
      expect(authorize.mock.lastCall?.[3]).toEqual({ mode: 'read' });
      readSource.mockResolvedValue(pkg.source.files.find((entry) => entry.path === 'src/Button.tsx')!.content);
      const next = await request('POST', '/versions/publish-current', { expectedRevision: state.revision, name: pkg.name, version: '1.1.0', sourcePaths: ['src/Button.tsx'] });
      expect(next.status).toBe(200);
      state = ProjectDesignRuntimePublishVersionResponseSchema.parse(next.json).state;
      expect(state.lock.dependencies[0]?.version).toBe('1.0.0');
      expect(readSource).toHaveBeenCalledExactlyOnceWith('project', 'src/Button.tsx');
      const blocked = await request('POST', '/dependency', { expectedRevision: state.revision, designSystemId: 'acme', version: '1.1.0', range: '^1.0.0' });
      expect(blocked.status).toBe(409);
      const immutable = await request('POST', '/versions', { expectedRevision: state.revision, package: { ...pkg, name: 'Overwritten' } });
      expect(immutable.status).toBe(409);
      expect(immutable.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_VERSION_IMMUTABLE', details: { diagnostics: [{ code: 'ODDS5006' }] } });
      const invalid = await request('POST', '/versions', { expectedRevision: state.revision, package: { ...pkg, version: '2.0.0', source: { schemaVersion: 1, files: [{ path: 'wrong.tsx', encoding: 'utf8', content: '' }] } } });
      expect(invalid.status).toBe(400);
      expect(invalid.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_VERSION_INVALID', details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS5005' })]) } });
      const conflict = await request('DELETE', '/dependency', { expectedRevision: 0 });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error.details).toEqual({ expectedRevision: 0, currentRevision: state.revision });
      state = ProjectDesignRuntimeResponseSchema.parse((await request('DELETE', '/dependency', { expectedRevision: state.revision })).json).state;
      expect(state.lock.dependencies).toEqual([]);
      expect(JSON.stringify((await request('GET')).json)).not.toContain('return null');
    });
  });

  it('dispatches compile, search, binding lifecycle, resolve, and diagnostics through shared DTOs', async () => {
    await withRoute(async ({ request, authorize, readSource }) => {
      const initial = await request('GET');
      expect(ProjectDesignRuntimeResponseSchema.parse(initial.json).state.revision).toBe(0);
      const compiled = await request('POST', '/compile', compileRequest);
      expect(compiled.status).toBe(200);
      let state = ProjectDesignRuntimeResponseSchema.parse(compiled.json).state;
      const binding = state.bindings.bindings[0]!;
      const bindingPath = `/bindings/${encodeURIComponent(binding.id)}`;
      expect(readSource).toHaveBeenCalledExactlyOnceWith('project', 'src/Button.tsx');
      expect(ProjectDesignRuntimeComponentsResponseSchema.parse((await request('GET', '/components?query=button')).json).components).toHaveLength(1);
      expect(ProjectDesignRuntimeCodeComponentsResponseSchema.parse((await request('GET', '/code-components?query=src%2FButton')).json).components).toHaveLength(1);
      expect(ProjectDesignRuntimeResolveResponseSchema.parse((await request('GET', `${bindingPath}/resolve`)).json).resolution.ok).toBe(true);
      const invalid = await request('POST', '/validate', { component: 'ds:test/button', props: { variant: 'filled' } });
      expect(ProjectDesignRuntimeValidateResponseSchema.parse(invalid.json).diagnostics[0]?.code).toBe('ODDS1003');
      expect(authorize.mock.lastCall?.[3]).toEqual({ mode: 'read' });
      state = ProjectDesignRuntimeResponseSchema.parse((await request('DELETE', bindingPath, { expectedRevision: state.revision })).json).state;
      expect(state.bindings.bindings[0]?.status).toBe('unbound');
      expect(authorize.mock.lastCall?.[3]).toEqual({ mode: 'write', capability: 'writeFiles' });
      const missingTarget = await request('POST', `${bindingPath}/revalidate`, { expectedRevision: state.revision });
      expect(missingTarget.status).toBe(400);
      expect(missingTarget.json.error.details.diagnostics[0].code).toBe('ODDS3001');
      state = ProjectDesignRuntimeResponseSchema.parse((await request('PUT', bindingPath, { expectedRevision: state.revision, binding })).json).state;
      state = ProjectDesignRuntimeResponseSchema.parse((await request('POST', `${bindingPath}/revalidate`, { expectedRevision: state.revision })).json).state;
      expect(state.bindings.bindings[0]?.status).toBe('bound');
      const conflict = await request('DELETE', bindingPath, { expectedRevision: 1 });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_REVISION_CONFLICT', details: { expectedRevision: 1, currentRevision: state.revision } });
      expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET')).json).state).toEqual(state);
    });
  });

  it('dispatches document, graph, staging, publish, undo, history and explicit deletion through shared DTOs', async () => {
    await withRoute(async ({ request }) => {
      let state = ProjectDesignRuntimeResponseSchema.parse((await request('POST', '/compile', compileRequest)).json).state;
      expect(ProjectDesignRuntimeDocumentResponseSchema.parse((await request('GET', '/document/resolve')).json).resolution.document!.screens).toEqual([]);
      const staged = ProjectDesignRuntimeStageComponentResponseSchema.parse((await request('POST', '/component-changes', { expectedRevision: state.revision, draftId: 'create-local', expectedDefinitionRevision: 0, definition: localDefinition })).json);
      state = staged.state;
      expect(state.document).toBeNull();
      expect(state.projectComponents.components).toEqual([]);
      expect(ProjectDesignRuntimeChangeResponseSchema.parse((await request('GET', '/component-changes/create-local')).json).impact.diagnostics).toEqual([]);
      state = ProjectDesignRuntimePublishComponentResponseSchema.parse((await request('POST', '/component-changes/create-local/publish', { expectedRevision: state.revision, expectedDefinitionRevision: 0 })).json).state;
      expect(state.document).toBeNull();
      expect(ProjectDesignRuntimeProjectComponentsResponseSchema.parse((await request('GET', '/project-components?query=local%20button')).json).components).toHaveLength(1);
      state = ProjectDesignRuntimeResponseSchema.parse((await request('PUT', '/document', { expectedRevision: state.revision, document: semanticDocument })).json).state;
      const references = ProjectDesignRuntimeReferencesResponseSchema.parse((await request('GET', '/references?componentRef=local%3ALocalButton')).json).references;
      expect(references.affectedScreens).toEqual([{ kind: 'screen', documentId: 'design', screenId: 'Applications' }]);
      const invalidDocument = structuredClone(semanticDocument);
      invalidDocument.screens[0]!.children[0]!.ref = 'local:Missing';
      expect(ProjectDesignRuntimeDocumentResponseSchema.parse((await request('POST', '/document/validate', { document: invalidDocument })).json).resolution.document).toBeNull();
      const invalidSave = await request('PUT', '/document', { expectedRevision: state.revision, document: invalidDocument });
      expect(invalidSave.status).toBe(400);
      expect(invalidSave.json.error.details.diagnostics[0].code).toBe('ODDS4002');
      const detached = ProjectDesignRuntimeDetachResponseSchema.parse((await request('POST', '/instances/detach', { instance: semanticDocument.screens[0]!.children[0], mode: 'guided' })).json);
      expect(detached.node).toMatchObject({ type: 'component', ref: 'ds:test/button', props: { variant: 'primary' } });
      expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET')).json).state).toEqual(state);
      const edited = { ...localDefinition, revision: 2, props: { variant: { ...localDefinition.props.variant, default: 'secondary' } } };
      state = ProjectDesignRuntimeStageComponentResponseSchema.parse((await request('POST', '/component-changes', { expectedRevision: state.revision, draftId: 'edit-local', expectedDefinitionRevision: 1, definition: edited })).json).state;
      const conflict = await request('POST', '/component-changes/edit-local/publish', { expectedRevision: state.revision, expectedDefinitionRevision: 0 });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_COMPONENT_CHANGE_CONFLICT', details: { expectedDefinitionRevision: 0, currentDefinitionRevision: 1 } });
      state = ProjectDesignRuntimePublishComponentResponseSchema.parse((await request('POST', '/component-changes/edit-local/publish', { expectedRevision: state.revision, expectedDefinitionRevision: 1 })).json).state;
      expect(ProjectDesignRuntimeHistoryResponseSchema.parse((await request('GET', '/project-components/LocalButton/history')).json).history.map((entry) => entry.definition.revision)).toEqual([1, 2]);
      const undo = ProjectDesignRuntimeStageComponentResponseSchema.parse((await request('POST', '/project-components/LocalButton/undo', { expectedRevision: state.revision, draftId: 'undo-local', expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 })).json);
      expect(undo.draft.proposedDefinition).toMatchObject({ revision: 3, props: { variant: { default: 'primary' } } });
      state = ProjectDesignRuntimeResponseSchema.parse((await request('DELETE', '/component-changes/undo-local', { expectedRevision: undo.state.revision })).json).state;
      expect(ProjectDesignRuntimeDeletionResponseSchema.parse((await request('GET', '/project-components/LocalButton/deletion')).json).analysis.canDelete).toBe(false);
      expect((await request('DELETE', '/project-components/LocalButton', { expectedRevision: state.revision, action: { type: 'reject' } })).status).toBe(400);
      state = ProjectDesignRuntimeResponseSchema.parse((await request('DELETE', '/project-components/LocalButton', { expectedRevision: state.revision, action: { type: 'detach' } })).json).state;
      expect(state.projectComponents.components).toEqual([]);
      expect(state.document!.screens[0]!.children[0]).toMatchObject({ type: 'component', props: { variant: 'secondary' } });
      expect(ProjectDesignRuntimeHistoryResponseSchema.parse((await request('GET', '/project-components/LocalButton/history')).json).history).toHaveLength(2);
      expect((await request('GET', '/component-changes/undo-local')).status).toBe(404);
    });
  });

  it('rejects source text, path traversal and duplicate selections before reading project files', async () => {
    await withRoute(async ({ request, readSource }) => {
      for (const selections of [
        [{ ...selection, sourcePath: '../secret.tsx' }],
        [{ ...selection, sourceText: 'export function Button() {}' }],
        [selection, selection],
        [{ ...selection, storySources: [{ sourcePath: 'src/Button.stories.ts', sourceText: 'injected text', selections: [{ id: 'story', exportName: 'Primary' }] }] }],
        [{ ...selection, storySources: [{ sourcePath: '../outside.stories.ts', selections: [{ id: 'story', exportName: 'Primary' }] }] }],
      ]) {
        const result = await request('POST', '/compile', { ...compileRequest, selections });
        expect(result.status).toBe(400);
        expect(result.json.error.code).toBe('BAD_REQUEST');
      }
      expect(readSource).not.toHaveBeenCalled();
      readSource.mockResolvedValue('export function Button(props: { value: object }) {}');
      const unsupported = await request('POST', '/compile', compileRequest);
      expect(unsupported.status).toBe(400);
      expect(unsupported.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_COMPILATION_FAILED', details: { sourcePath: 'src/Button.tsx', exportName: 'Button' } });
      expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET')).json).state.revision).toBe(0);
    });
  });

  it('compiles mixed framework and Storybook selections through the existing HTTP endpoint', async () => {
    await withRoute(async ({ request, readSource }) => {
      const mixed = mixedProjectCompilerRequest();
      readSource.mockImplementation(async (_projectId, path) => mixed.sources.get(path)!);
      const response = await request('POST', '/compile', mixed.request);
      expect(response.status).toBe(200);
      const state = ProjectDesignRuntimeResponseSchema.parse(response.json).state;
      expect(state.codeIndex.components.map((code) => code.framework)).toEqual(['react', 'vue']);
      expect(state.registry?.components.map((component) => component.stories?.length)).toEqual([2, 1]);
      expect(readSource.mock.calls.map((call) => call[1])).toEqual([...mixed.sources.keys()]);
    });
  });

  it('authorizes every read and write before source reads or persistence access', async () => {
    await withRoute(async ({ request, authorize, readSource, storeRead, catalogRead, catalogList }) => {
      authorize.mockImplementation(async (_req, res) => {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Read-only project.' } });
        return false;
      });
      const calls: [string, string, unknown?][] = [
        ['GET', '/versions'], ['GET', '/versions/acme/1.0.0'], ['POST', '/versions', {}],
        ['POST', '/versions/publish-current', {}], ['POST', '/dependency', {}], ['DELETE', '/dependency', {}], ['GET', '/dependency/resolve'],
        ['GET', ''], ['GET', '/components'], ['GET', '/code-components'],
        ['POST', '/compile', compileRequest],
        ['PUT', '/bindings/missing', {}], ['DELETE', '/bindings/missing', { expectedRevision: 0 }],
        ['POST', '/bindings/missing/revalidate', { expectedRevision: 0 }],
        ['GET', '/bindings/missing/resolve'],
        ['POST', '/validate', { component: 'ds:test/button', props: {} }],
        ['PUT', '/document', {}], ['POST', '/document/validate', {}], ['GET', '/document/resolve'],
        ['GET', '/references?componentRef=local%3ALocalButton'], ['GET', '/project-components'],
        ['GET', '/project-components/LocalButton/deletion'], ['GET', '/project-components/LocalButton/history'],
        ['POST', '/component-changes', {}], ['GET', '/component-changes/draft'],
        ['POST', '/component-changes/draft/publish', {}], ['DELETE', '/component-changes/draft', {}],
        ['POST', '/project-components/LocalButton/undo', {}], ['DELETE', '/project-components/LocalButton', {}],
        ['POST', '/instances/detach', {}],
      ];
      for (const [method, suffix, body] of calls) {
        expect((await request(method, suffix, body)).status).toBe(403);
      }
      expect(readSource).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledTimes(calls.length);
      expect(storeRead).not.toHaveBeenCalled();
      expect(catalogRead).not.toHaveBeenCalled();
      expect(catalogList).not.toHaveBeenCalled();
      authorize.mockResolvedValue(true);
      expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET')).json).state.revision).toBe(0);
    });
  });
});
