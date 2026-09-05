import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDesignRuntimePreviewResponseSchema } from '@open-design/contracts';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import { DesignPreviewError } from '../../src/services/design-runtime/preview-preparation.js';
import type { ProjectPreviewAuthority } from '../../src/services/design-runtime/project-preview.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';

async function fixture(run: (value: { store: ReturnType<typeof createDesignRuntimeStore>; authority: ProjectPreviewAuthority; authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>; acquire: ReturnType<typeof vi.fn>; request(input: unknown): Promise<{ status: number; json: any }> }) => Promise<void>) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db);
  store.write('project', 0, { ...store.read('project'), document: { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, id: 'home', type: 'screen', children: [{ schemaVersion: 1, id: 'label', type: 'text', text: 'Actual semantic text' }] }] } });
  const authority: ProjectPreviewAuthority = { readSource: async () => { throw new Error('Missing project source'); }, observeTargetPackages: async () => [], assertCurrent: async () => {} };
  const acquire = vi.fn(async () => authority);
  const service = createProjectDesignRuntimeService({ store, readSource: async () => { throw new Error('The generic unbounded reader must not be used for previews.'); }, acquirePreviewAuthority: acquire });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true); const app = express(); app.use(express.json()); registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run({ store, authority, authorize, acquire, request: async (input) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/project/design-runtime/previews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: response.status, json: await response.json() };
  } }); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}
const selection = { expectedRevision: 1, id: 'preview', framework: 'react', kind: 'semantic-design', screenIds: ['home'] };
describe('verified preview HTTP authority', () => {
  it.each(['react', 'vue'])('returns actual %s browser bundles without changing state or writing authored output paths', (framework) => fixture(async ({ store, request, authorize }) => {
    const before = store.read('project'); const write = vi.spyOn(store, 'write');
    const response = await request({ ...selection, framework, outputs: [{ screenId: 'home', sourcePath: `future/Home.${framework === 'react' ? 'tsx' : 'vue'}`, exportName: framework === 'react' ? 'Home' : 'default' }] });
    expect(response.status).toBe(200); const result = ProjectDesignRuntimePreviewResponseSchema.parse(response.json);
    expect(result.sides[0]!.screens[0]!.bundle?.javascript).toContain('Actual semantic text'); expect(result.sides[0]!.screens[0]!.diagnostics).toEqual([]);
    expect(store.read('project')).toEqual(before); expect(write).not.toHaveBeenCalled(); expect(authorize).toHaveBeenCalledTimes(2); expect(authorize.mock.calls[0]![3]).toEqual({ mode: 'read' });
  }));
  it('authorizes before any I/O and reauthorizes after asynchronous preparation', () => fixture(async ({ request, authorize, acquire }) => {
    authorize.mockImplementation(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request(selection)).status).toBe(403); expect(acquire).not.toHaveBeenCalled();
    authorize.mockResolvedValueOnce(true);
    expect((await request(selection)).status).toBe(403); expect(acquire).toHaveBeenCalledOnce();
  }));
  it('rejects caller evidence, stale revisions and changed scoped authority with canonical errors', () => fixture(async ({ request, acquire, authority }) => {
    expect((await request({ ...selection, projectRoot: '/private' })).status).toBe(400); expect(acquire).not.toHaveBeenCalled();
    const revision = await request({ ...selection, expectedRevision: 0 }); expect(revision.status).toBe(409); expect(revision.json.error.details).toMatchObject({ expectedRevision: 0, currentRevision: 1 });
    let changed = false; authority.assertCurrent = async () => { if (changed) throw new DesignPreviewError('CONFLICT', 'Workspace changed.'); };
    authority.observeTargetPackages = async () => { changed = true; return []; };
    const conflict = await request(selection); expect(conflict.status).toBe(409); expect(conflict.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_PREVIEW_CONFLICT', details: { diagnostics: [{ code: 'ODDS8001' }] } });
  }));
});
