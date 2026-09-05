import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDesignRuntimeGenerationTargetsResponseSchema, ProjectDesignRuntimeResponseSchema } from '@open-design/contracts';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';
const targets = { schemaVersion: 1, outputs: [{ sourcePath: 'future/Applications.tsx', exportName: 'Applications', screenId: 'applications' }] };
async function fixture(run: (value: { store: ReturnType<typeof createDesignRuntimeStore>; authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>; readSource: ReturnType<typeof vi.fn>; request(method: string, input?: unknown, projectId?: string): Promise<{ status: number; json: any }> }) => Promise<void>) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'), ('other');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db); const readSource = vi.fn(async () => { throw new Error('Authoring does not read source.'); });
  const service = createProjectDesignRuntimeService({ store, readSource }); const authorize = vi.fn<AuthorizeProjectRequest>(async () => true); const app = express(); app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize }); const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run({ store, readSource, authorize, request: async (method, input, projectId = 'project') => {
    const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}/design-runtime/generation/targets`, { method, ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) });
    return { status: result.status, json: await result.json() };
  } }); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}
describe('generation target HTTP', () => {
  it('authors future outputs with one aggregate CAS and no source/catalog access or document creation', () => fixture(async ({ store, request, readSource, authorize }) => {
    const before = store.read('project'); const catalog = vi.spyOn(store, 'readVersion');
    const initial = await request('GET'); expect(ProjectDesignRuntimeGenerationTargetsResponseSchema.parse(initial.json)).toEqual({ revision: 0, targets: { schemaVersion: 1, outputs: [] } });
    const saved = await request('PUT', { expectedRevision: 0, targets }); expect(saved.status).toBe(200);
    expect(ProjectDesignRuntimeResponseSchema.parse(saved.json).state).toEqual({ ...before, revision: 1, generationTargets: targets });
    expect((await request('GET')).json).toEqual({ revision: 1, targets });
    const conflict = await request('PUT', { expectedRevision: 0, targets: { schemaVersion: 1, outputs: [] } }); expect(conflict.status).toBe(409); expect(conflict.json.error.details).toMatchObject({ expectedRevision: 0, currentRevision: 1 });
    expect(store.read('project').generationTargets).toEqual(targets); expect((await request('GET', undefined, 'other')).json.targets.outputs).toEqual([]);
    expect(readSource).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); expect(authorize.mock.calls[1]![3]).toEqual({ mode: 'write', capability: 'writeFiles' });
  }));
  it('remains authorable with a missing exact package and preserves the lock and saved mode', () => fixture(async ({ store, request, readSource }) => {
    const state = store.read('project'); const digest = `sha256:${'a'.repeat(64)}`;
    const broken = store.write('project', 0, { ...state, registry: { schemaVersion: 1, id: 'acme', components: [] }, validationSettings: { ...state.validationSettings, mode: 'strict' }, dependencies: { ...state.dependencies, dependencies: [{ designSystemId: 'acme', version: '1.0.0' }] }, lock: { ...state.lock, dependencies: [{ designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } }] } });
    const catalog = vi.spyOn(store, 'readVersion'); expect((await request('GET')).status).toBe(200);
    const saved = await request('PUT', { expectedRevision: 1, targets }); expect(saved.status).toBe(200); expect(saved.json.state).toEqual({ ...broken, revision: 2, generationTargets: targets });
    expect(readSource).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled();
  }));
  it('authorizes before state I/O and rejects invalid input without mutation', () => fixture(async ({ store, request, authorize }) => {
    const read = vi.spyOn(store, 'read'); const write = vi.spyOn(store, 'write');
    authorize.mockImplementation(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request('GET')).status).toBe(403); expect((await request('PUT', { expectedRevision: 0, targets })).status).toBe(403); expect(read).not.toHaveBeenCalled();
    authorize.mockResolvedValue(true);
    for (const input of [{ expectedRevision: 0, targets, ready: true }, { expectedRevision: 0, targets: { ...targets, outputs: [{ sourcePath: '/absolute.tsx' }] } }]) expect((await request('PUT', input)).status).toBe(400);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  }));
});
