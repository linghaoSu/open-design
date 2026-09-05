import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { defaultProjectDesignValidationSettings, ProjectDesignRuntimeValidationSettingsResponseSchema, ProjectDesignRuntimeValidateArtifactsResponseSchema } from '@open-design/contracts';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import { validationFixture } from '../fixtures/design-runtime/validation-benchmark.js';

async function withValidation(run: (context: {
  fixture: ReturnType<typeof validationFixture>;
  db: Database.Database;
  store: ReturnType<typeof createDesignRuntimeStore>;
  files: Map<string, string>;
  readSource: ReturnType<typeof vi.fn<(projectId: string, path: string) => Promise<string>>>;
  authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
}) => Promise<void>) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
  migrateDesignRuntimeStore(db); const store = createDesignRuntimeStore(db);
  const fixture = validationFixture(); const snapshot = fixture.snapshot;
  store.write('project', 0, { ...store.read('project'), validationSettings: fixture.settings,
    registry: snapshot.registry, codeIndex: { ...snapshot.baseCodeIndex, id: 'project' }, projectCodeIndex: snapshot.projectCodeIndex,
    bindings: snapshot.bindings, projectComponents: snapshot.projectComponents, document: snapshot.document,
    dependencies: snapshot.dependencies, lock: snapshot.lock,
  }, snapshot.versions);
  const files = new Map([...fixture.sources.map((file) => [file.sourcePath, file.sourceText] as const), ...snapshot.versions[0]!.package.source.files.filter((file) => file.encoding === 'utf8').map((file) => [file.path, file.content] as const)]);
  const readSource = vi.fn(async (_projectId: string, path: string) => { const bytes = files.get(path); if (bytes === undefined) throw new Error('Missing'); return bytes; });
  const service = createProjectDesignRuntimeService({ store, readSource, observeTargetPackages: async () => fixture.snapshot.targetPackages });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true);
  const app = express(); app.use(express.json()); registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    await run({ fixture, db, store, files, readSource, authorize, request: async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/project/design-runtime${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, json: await response.json() };
    } });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}
const selection = (fixture: ReturnType<typeof validationFixture>, expectedRevision = 1) => ({ expectedRevision, sources: fixture.sources.map(({ sourceText: _bytes, ...file }) => file), outputs: fixture.outputs });

describe('project validation authority, saved modes and dependency recovery', () => {
  it('validates real selected bytes, effective locked policy and installed facts without writes', () => withValidation(async ({ fixture, store, files, request, authorize }) => {
    const before = store.read('project');
    const response = await request('POST', '/validation/artifacts', selection(fixture));
    expect(response.status).toBe(200);
    expect(ProjectDesignRuntimeValidateArtifactsResponseSchema.parse(response.json)).toMatchObject({ revision: 1, result: { mode: 'strict', policySource: 'locked', accepted: true, strictReady: true } });
    expect(store.read('project')).toEqual(before);
    expect(authorize.mock.calls.at(-1)?.[3]).toEqual({ mode: 'read' });
    files.set('pages/page.css', 'main{color:#f00}');
    const invalid = await request('POST', '/validation/artifacts', selection(fixture));
    expect(invalid.json.result).toMatchObject({ accepted: false, strictReady: false, metrics: { rawColors: 1 }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS2002' })]) });
  }));

  it('preserves locked constraints and selected mode when clearing, and forbids editing hidden fallback policy', () => withValidation(async ({ request, fixture, store }) => {
    const settings = ProjectDesignRuntimeValidationSettingsResponseSchema.parse((await request('GET', '/validation/settings')).json);
    expect(settings.effectiveConstraints).toEqual({ source: 'locked', constraints: fixture.snapshot.versions[0]!.package.constraints });
    const attempted = structuredClone(settings.settings); attempted.projectConstraints.explore.rawCss.colors = 'off';
    expect((await request('PUT', '/validation/settings', { expectedRevision: 1, settings: attempted })).status).toBe(409);
    const changed = await request('PUT', '/validation/settings', { expectedRevision: 1, settings: { ...settings.settings, mode: 'guided' } });
    expect(changed.status).toBe(200);
    const cleared = await request('DELETE', '/dependency', { expectedRevision: 2 });
    expect(cleared.status).toBe(200);
    expect(cleared.json.state.validationSettings).toEqual({ ...settings.settings, mode: 'guided', projectConstraints: fixture.snapshot.versions[0]!.package.constraints });
    expect(store.read('project').document).toEqual(fixture.snapshot.document);
  }));

  it('requires explicit Explore recovery for broken Strict locks and does not silently change mode', () => withValidation(async ({ request, db, store }) => {
    db.prepare('DELETE FROM project_design_system_versions').run();
    expect((await request('GET', '')).status).toBe(409);
    const settings = await request('GET', '/validation/settings');
    expect(settings.status).toBe(200); expect(settings.json.effectiveConstraints).toBeNull(); expect(settings.json.diagnostics.length).toBeGreaterThan(0);
    expect((await request('DELETE', '/dependency', { expectedRevision: 1 })).status).toBe(409);
    expect(store.read('project').validationSettings.mode).toBe('strict');
    const recovery = await request('PUT', '/validation/settings', { expectedRevision: 1, settings: { ...settings.json.settings, mode: 'explore' } });
    expect(recovery.status).toBe(200); expect(recovery.json.state.lock.dependencies).toHaveLength(1);
    expect((await request('DELETE', '/dependency', { expectedRevision: 2 })).status).toBe(200);
    expect(store.read('project').validationSettings.mode).toBe('explore');
  }));

  it('reports missing sources, fences stale reads and rejects injected authority before any file read', () => withValidation(async ({ fixture, files, readSource, request, store }) => {
    const body = selection(fixture);
    expect((await request('POST', '/validation/artifacts', { ...body, mode: 'explore' })).status).toBe(400);
    expect((await request('POST', '/validation/artifacts', { ...body, sources: [{ ...body.sources[0], sourceText: 'fake' }] })).status).toBe(400);
    expect((await request('POST', '/validation/artifacts', { ...body, expectedRevision: 0 })).status).toBe(409);
    expect(readSource).not.toHaveBeenCalled();
    files.delete('pages/page.css');
    const missing = await request('POST', '/validation/artifacts', body);
    expect(missing.status).toBe(200); expect(missing.json.result).toMatchObject({ strictReady: false, coverage: { imports: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6003' })]) });
    let release!: (value: string) => void; let started!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    readSource.mockImplementationOnce(async () => { started(); return new Promise<string>((resolve) => { release = resolve; }); });
    const pending = request('POST', '/validation/artifacts', body); await waiting;
    store.write('project', 1, store.read('project')); release('export function Screen(){return null;}');
    expect((await pending).status).toBe(409);
  }));

  it('reads each selected and proof source path once, and checks route permissions before I/O', () => withValidation(async ({ fixture, store, request, readSource, authorize }) => {
    const state = store.read('project'); store.write('project', 1, { ...state, dependencies: { ...state.dependencies, dependencies: [] }, lock: { ...state.lock, dependencies: [] }, validationSettings: defaultProjectDesignValidationSettings() });
    const body = selection(fixture, 2); body.sources.push({ sourcePath: 'library/button.tsx', language: 'tsx' });
    const response = await request('POST', '/validation/artifacts', body);
    expect(response.status).toBe(200);
    expect(readSource.mock.calls.filter((call) => call[1] === 'library/button.tsx')).toHaveLength(1);
    readSource.mockClear();
    authorize.mockImplementationOnce(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request('POST', '/validation/artifacts', body)).status).toBe(403); expect(readSource).not.toHaveBeenCalled();
    const settings = (await request('GET', '/validation/settings')).json.settings;
    await request('PUT', '/validation/settings', { expectedRevision: 2, settings });
    expect(authorize.mock.calls.at(-1)?.[3]).toEqual({ mode: 'write', capability: 'writeFiles' });
  }));
});
