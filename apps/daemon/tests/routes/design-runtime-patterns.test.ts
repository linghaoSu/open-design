import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDesignRuntimePatternsResponseSchema, ProjectDesignRuntimePatternResponseSchema, ProjectDesignRuntimeInstantiatePatternResponseSchema } from '@open-design/contracts';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../src/services/design-runtime/design-system-version.js';
import { packageFixture } from '../fixtures/design-runtime/design-system-version.js';

async function withPatterns(run: (value: {
  store: ReturnType<typeof createDesignRuntimeStore>; authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  readSource: ReturnType<typeof vi.fn<(projectId: string, path: string) => Promise<string>>>;
  request: (method: string, suffix: string, input?: unknown, projectId?: string) => Promise<{ status: number; json: any }>;
}) => Promise<void>) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'), ('empty');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db); const version = createDesignSystemVersion(packageFixture());
  store.write('project', 0, { ...store.read('project'), registry: version.package.registry,
    codeIndex: { ...version.package.codeIndex, id: 'project' }, bindings: { ...version.package.bindings, id: 'project' },
    dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: version.package.id, version: version.package.version }] }, lock: createProjectDesignSystemLock('project', [version]) }, [version]);
  const readSource = vi.fn(async (_projectId: string, _path: string) => { throw new Error('Patterns must use frozen bytes.'); });
  const service = createProjectDesignRuntimeService({ store, readSource });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true); const app = express(); app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run({ store, authorize, readSource, request: async (method, suffix, input, projectId = 'project') => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}/design-runtime${suffix}`, { method, ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) });
    return { status: response.status, json: await response.json() };
  } }); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}
const input = () => ({ expectedRevision: 1, instanceId: 'resource-list', destinationScreenId: 'draft-screen', props: { title: 'Applications' },
  slots: { actions: [{ schemaVersion: 1, type: 'component', id: 'action', ref: 'ds:acme/Button' }] },
  document: { schemaVersion: 1, id: 'draft-document', screens: [{ schemaVersion: 1, type: 'screen', id: 'draft-screen', name: 'Applications', children: [] }] } });

describe('project pattern HTTP', () => {
  it('retrieves exact patterns and previews a new unsaved screen without changing state or reading mutable source', () => withPatterns(async ({ store, request, authorize, readSource }) => {
    const before = store.read('project'); const catalog = store.listVersions('project');
    const list = await request('GET', '/patterns?query=resources');
    expect(list.status).toBe(200); expect(ProjectDesignRuntimePatternsResponseSchema.parse(list.json).dependency).toEqual(before.lock.dependencies[0]);
    const detail = await request('GET', '/patterns/ResourceList');
    expect(detail.status).toBe(200); expect(ProjectDesignRuntimePatternResponseSchema.parse(detail.json).pattern.name).toBe('Resource list');
    const result = await request('POST', '/patterns/ResourceList/instantiate', input());
    expect(result.status).toBe(200); expect(ProjectDesignRuntimeInstantiatePatternResponseSchema.parse(result.json)).toMatchObject({ revision: 1, patternId: 'ResourceList', node: { type: 'component', slots: { header: [{ text: 'Applications' }] } } });
    expect(authorize.mock.calls.map((call) => call[3])).toEqual([{ mode: 'read' }, { mode: 'read' }, { mode: 'read' }]);
    expect(store.read('project')).toEqual(before); expect(store.listVersions('project')).toEqual(catalog); expect(readSource).not.toHaveBeenCalled();
  }));
  it('rejects unauthorized access and caller-supplied authority before reading state or catalog', () => withPatterns(async ({ store, authorize, request }) => {
    const read = vi.spyOn(store, 'read'); const catalog = vi.spyOn(store, 'readVersion');
    authorize.mockImplementation(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request('GET', '/patterns')).status).toBe(403); expect((await request('POST', '/patterns/ResourceList/instantiate', input())).status).toBe(403);
    expect(read).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); authorize.mockResolvedValue(true);
    for (const extra of [{ lock: {} }, { projectComponents: {} }, { registry: {} }, { package: {} }, { version: 'latest' }, { patternId: 'Other' }]) expect((await request('POST', '/patterns/ResourceList/instantiate', { ...input(), ...extra })).status).toBe(400);
    expect(read).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled();
    const stale = await request('POST', '/patterns/ResourceList/instantiate', { ...input(), expectedRevision: 0 });
    expect(stale.status).toBe(409); expect(stale.json.error.details).toMatchObject({ expectedRevision: 0, currentRevision: 1 });
  }));
  it('returns nonadoptable diagnostics for invalid configuration and collisions anywhere in the submitted draft', () => withPatterns(async ({ request, store }) => {
    const invalid = await request('POST', '/patterns/ResourceList/instantiate', { ...input(), props: { title: 5 } });
    expect(invalid.status).toBe(200); expect(ProjectDesignRuntimeInstantiatePatternResponseSchema.parse(invalid.json)).toMatchObject({ node: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS1005' })]) });
    const valid = await request('POST', '/patterns/ResourceList/instantiate', input());
    const draft = input();
    const document = { ...draft.document, screens: [...draft.document.screens, { schemaVersion: 1, type: 'screen', id: 'other-screen', children: [{ schemaVersion: 1, type: 'text', id: valid.json.node.id, text: 'Existing node' }] }] };
    const collision = await request('POST', '/patterns/ResourceList/instantiate', { ...draft, document });
    expect(collision.status).toBe(200); expect(collision.json).toMatchObject({ node: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4001' })]) });
    expect(store.read('project').document).toBeNull(); expect(store.read('project').revision).toBe(1);
  }));
  it('reports a missing active lock explicitly and never selects a version from another project', () => withPatterns(async ({ request, readSource }) => {
    for (const suffix of ['/patterns', '/patterns/ResourceList']) {
      const result = await request('GET', suffix, undefined, 'empty'); expect(result.status).toBe(400);
      expect(result.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_VERSION_INVALID', details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS5001' })]) } });
    }
    expect(readSource).not.toHaveBeenCalled();
  }));
});
