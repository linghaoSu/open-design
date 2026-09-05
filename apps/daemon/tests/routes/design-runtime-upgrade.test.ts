import Database from 'better-sqlite3';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDesignRuntimeApplyUpgradeResponseSchema, ProjectDesignRuntimeReviewUpgradeResponseSchema } from '@open-design/contracts';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';
import { upgradeFixture } from '../fixtures/design-runtime/design-system-upgrade.js';

async function withUpgrade(run: (fixture: {
  fixture: ReturnType<typeof upgradeFixture>;
  store: ReturnType<typeof createDesignRuntimeStore>;
  db: Database.Database;
  file: string;
  authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  request: (path: string, input: unknown, projectId?: string) => Promise<{ status: number; json: any }>;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'od-upgrade-http-'));
  const file = join(dir, 'state.sqlite');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'), ('other');");
  migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db);
  const fixture = upgradeFixture();
  const { projectId: _id, projectSources: _sources, ...state } = fixture.context;
  store.write('project', 0, { ...state, schemaVersion: 1, registry: fixture.from.package.registry }, [fixture.from, fixture.to]);
  const service = createProjectDesignRuntimeService({ store, readSource: async () => { throw new Error('An exact upgrade must never read mutable project source.'); } });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true);
  const app = express(); app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    await run({ fixture, store, db, file, authorize, request: async (path, input, projectId = 'project') => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}/design-runtime/upgrades/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      return { status: response.status, json: await response.json() };
    } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
}

const proof = (review: { id: string; baseDigest: string; planDigest: string; plan: unknown }) => ({ expectedRevision: 1, reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, plan: review.plan });

describe('reviewed upgrade HTTP and atomic persistence', () => {
  it('reviews without writes, then persists target lock, authored overrides and wrapper history in one revision across reopen', () => withUpgrade(async ({ fixture, store, request, authorize, file }) => {
    const before = store.read('project');
    const catalog = store.listVersions('project');
    const reviewed = await request('review', { expectedRevision: 1, plan: fixture.plan });
    expect(reviewed.status).toBe(200);
    const { review } = ProjectDesignRuntimeReviewUpgradeResponseSchema.parse(reviewed.json);
    expect(review.canApply).toBe(true); expect(review.affectedScreens).toHaveLength(2);
    expect(store.read('project')).toEqual(before);
    expect(authorize.mock.calls.at(-1)?.[3]).toEqual({ mode: 'read' });
    const applied = await request('apply', proof(review));
    expect(applied.status).toBe(200);
    const result = ProjectDesignRuntimeApplyUpgradeResponseSchema.parse(applied.json);
    expect(result.state.revision).toBe(2);
    expect(result.state.lock.dependencies[0]).toEqual(fixture.plan.to);
    expect(result.state.projectComponents.components.map((entry) => entry.revision)).toEqual([2, 4]);
    expect(result.state.sharedChanges.history).toHaveLength(4);
    expect(result.state.document?.screens[0]?.children[0]).toMatchObject({ overrides: [] });
    expect(result.state.document?.screens[0]?.children[1]).toMatchObject({ overrides: [{ value: 'ghost' }] });
    expect(authorize.mock.calls.at(-1)?.[3]).toEqual({ mode: 'write', capability: 'writeFiles' });
    const reopened = new Database(file);
    try { expect(createDesignRuntimeStore(reopened).read('project')).toEqual(result.state); } finally { reopened.close(); }
    expect(store.listVersions('project')).toEqual(catalog);
    expect(store.readVersion('project', 'acme', '1.0.0')).toEqual(fixture.from);
    expect(store.readVersion('project', 'acme', '2.0.0')).toEqual(fixture.to);
  }));

  it('returns 200 with nonapplicable impact for valid plans and 400 with diagnostics on applying that review', () => withUpgrade(async ({ fixture, store, request }) => {
    const before = store.read('project');
    const reviewed = await request('review', { expectedRevision: 1, plan: { ...fixture.plan, rules: [], bindingDecisions: [] } });
    expect(reviewed.status).toBe(200);
    const { review } = ProjectDesignRuntimeReviewUpgradeResponseSchema.parse(reviewed.json);
    expect(review.canApply).toBe(false); expect(review.diagnostics.length).toBeGreaterThan(0);
    const applied = await request('apply', proof(review));
    expect(applied.status).toBe(400);
    expect(applied.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_UPGRADE_INVALID', details: { review: { canApply: false } } });
    expect(store.read('project')).toEqual(before);
  }));

  it('rejects stale review proofs, changed plans and CAS races without partial migration', () => withUpgrade(async ({ fixture, store, request }) => {
    const before = store.read('project');
    const reviewed = await request('review', { expectedRevision: 1, plan: fixture.plan });
    const input = proof(reviewed.json.review);
    for (const change of [{ baseDigest: `sha256:${'f'.repeat(64)}` }, { plan: { ...fixture.plan, targetRange: '2.0.0' } }]) {
      const result = await request('apply', { ...input, ...change });
      expect(result.status).toBe(409); expect(result.json.error.code).toBe('DESIGN_RUNTIME_UPGRADE_CONFLICT');
      expect(store.read('project')).toEqual(before);
    }
    const original = store.write.bind(store);
    vi.spyOn(store, 'write').mockImplementationOnce((id, revision, state, versions) => {
      original(id, revision, { ...before, document: null });
      return original(id, revision, state, versions);
    });
    const race = await request('apply', input);
    expect(race.status).toBe(409); expect(race.json.error.details).toEqual({ expectedRevision: 1, currentRevision: 2 });
    expect(store.read('project')).toEqual({ ...before, revision: 2, document: null });
  }));

  it('checks auth and malformed input before catalog access; rejects missing locks and unavailable project-scoped versions', () => withUpgrade(async ({ fixture, store, request, authorize }) => {
    const read = vi.spyOn(store, 'read'); const catalog = vi.spyOn(store, 'readVersion');
    authorize.mockImplementation(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    for (const path of ['review', 'apply']) expect((await request(path, {})).status).toBe(403);
    expect(read).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled();
    authorize.mockResolvedValue(true);
    expect((await request('review', { expectedRevision: 1, plan: { ...fixture.plan, rules: [fixture.plan.rules[0], fixture.plan.rules[0]] } })).status).toBe(400);
    expect(read).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled();
    const missing = await request('review', { expectedRevision: 1, plan: { ...fixture.plan, to: { ...fixture.plan.to, version: '3.0.0' } } });
    expect(missing.status).toBe(404); expect(missing.json.error.code).toBe('DESIGN_RUNTIME_VERSION_NOT_FOUND');
    // Other projects do not gain catalog access through a valid exact identity.
    expect((await request('review', { expectedRevision: 0, plan: fixture.plan }, 'other')).status).toBe(404);
    const current = store.read('project');
    store.write('project', 1, { ...current, lock: { ...current.lock, dependencies: [] }, dependencies: { ...current.dependencies, dependencies: [] } });
    const unlocked = await request('review', { expectedRevision: 2, plan: fixture.plan });
    expect(unlocked.status).toBe(409); expect(unlocked.json.error.code).toBe('DESIGN_RUNTIME_UPGRADE_CONFLICT');
  }));

  it('diagnoses tampered exact source and preserves null documents after successful upgrades', () => withUpgrade(async ({ fixture, store, db, request }) => {
    const tampered = structuredClone(fixture.to); tampered.package.source.files[0]!.content += 'tampered';
    db.prepare('UPDATE project_design_system_versions SET version_json = ? WHERE project_id = ? AND version = ?').run(JSON.stringify(tampered), 'project', '2.0.0');
    const before = store.read('project');
    const rejected = await request('review', { expectedRevision: 1, plan: fixture.plan });
    expect(rejected.status).toBe(400); expect(rejected.json.error.code).toBe('DESIGN_RUNTIME_VERSION_INVALID');
    expect(rejected.json.error.details.diagnostics.length).toBeGreaterThan(0); expect(store.read('project')).toEqual(before);
    db.prepare('UPDATE project_design_system_versions SET version_json = ? WHERE project_id = ? AND version = ?').run(JSON.stringify(fixture.to), 'project', '2.0.0');
    store.write('project', 1, { ...before, document: null });
    const review = (await request('review', { expectedRevision: 2, plan: fixture.plan })).json.review;
    const applied = await request('apply', { ...proof(review), expectedRevision: 2 });
    expect(applied.status).toBe(200); expect(applied.json.state.document).toBeNull();
  }));
});
