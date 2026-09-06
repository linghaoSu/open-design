import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDesignRuntimeReviewLegacyMigrationResponseSchema, ProjectDesignRuntimeApplyLegacyMigrationResponseSchema } from '@open-design/contracts';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';
import { legacyMigrationFixture, legacyMigrationProof } from '../fixtures/design-runtime/legacy-migration.js';

async function fixture(run: (value: {
  store: ReturnType<typeof createDesignRuntimeStore>; authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  readSourceFile: ReturnType<typeof vi.fn<(path: string) => Promise<import('@open-design/contracts').DesignSystemSourceFile>>>;
  plan: ReturnType<typeof legacyMigrationFixture>['plan'];
  request(action: string, body: unknown): Promise<{ status: number; json: any }>;
}) => Promise<void>) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db); const { files, plan } = legacyMigrationFixture();
  const readSourceFile = vi.fn(async (path: string) => { const file = files.get(path); if (!file) throw new Error('Missing source'); return structuredClone(file); });
  const service = createProjectDesignRuntimeService({ store, readSource: async () => { throw new Error('Unexpected text-only read'); },
    acquireMigrationAuthority: async () => ({ identity: 'authorized-project-root', readSourceFile, assertCurrent: async () => {}, assertCurrentSync: () => {} }) });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true); const app = express(); app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run({ store, authorize, plan, readSourceFile, request: async (action, body) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/project/design-runtime/legacy-migration/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }); return { status: response.status, json: await response.json() };
  } }); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}
describe('legacy migration HTTP authority and atomic publication', () => {
  it('returns canonical review/apply DTOs through read/write authority with a single publication', () => fixture(async ({ store, request, plan, authorize }) => {
    const before = store.read('project');
    const response = await request('review', { expectedRevision: 0, plan }); expect(response.status).toBe(200);
    const { review } = ProjectDesignRuntimeReviewLegacyMigrationResponseSchema.parse(response.json);
    expect(review.canApply).toBe(true); expect(store.read('project')).toEqual(before);
    expect(authorize.mock.calls.map((call) => call[3])).toEqual([{ mode: 'read' }, { mode: 'read' }]); authorize.mockClear();
    const result = await request('apply', legacyMigrationProof(plan, review)); expect(result.status).toBe(200);
    const applied = ProjectDesignRuntimeApplyLegacyMigrationResponseSchema.parse(result.json);
    expect(applied.state.revision).toBe(1); expect(applied.version.digest).toBe(review.candidate!.digest);
    expect(authorize.mock.calls.map((call) => call[3])).toEqual([{ mode: 'write', capability: 'writeFiles' }, { mode: 'write', capability: 'writeFiles' }]);
    expect(store.listVersions('project')).toHaveLength(1);
  }));

  it('authorizes before source/state I/O and does not accept source text, traversal or malformed proof inputs', () => fixture(async ({ store, request, plan, authorize, readSourceFile }) => {
    const read = vi.spyOn(store, 'read'); const write = vi.spyOn(store, 'write');
    authorize.mockImplementation(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request('review', { expectedRevision: 0, plan })).status).toBe(403);
    expect((await request('apply', {})).status).toBe(403); expect(read).not.toHaveBeenCalled(); expect(readSourceFile).not.toHaveBeenCalled();
    authorize.mockResolvedValue(true);
    for (const changed of [
      { ...plan, sourceText: ':root {}' }, { ...plan, sourcePaths: ['../private'] },
      { ...plan, selections: [{ ...plan.selections[0], sourceText: 'injected' }] }, { ...plan, mode: 'strict' },
    ]) expect((await request('review', { expectedRevision: 0, plan: changed })).status).toBe(400);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(readSourceFile).not.toHaveBeenCalled();
  }));

  it('does not publish when write permission is revoked in the final source verification read', () => fixture(async ({ store, request, plan, authorize, readSourceFile }) => {
    const response = await request('review', { expectedRevision: 0, plan }); const review = response.json.review;
    let allowed = true; let calls = 0; const originalRead = readSourceFile.getMockImplementation()!;
    authorize.mockImplementation(async (_req, res) => { if (allowed) return true; res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Write permission revoked' } }); return false; });
    readSourceFile.mockImplementation(async (path) => { const file = await originalRead(path); if (++calls === plan.sourcePaths.length * 2) allowed = false; return file; });
    const write = vi.spyOn(store, 'write'); const denied = await request('apply', legacyMigrationProof(plan, review));
    expect(denied.status).toBe(403); expect(write).not.toHaveBeenCalled(); expect(store.read('project').revision).toBe(0); expect(store.listVersions('project')).toEqual([]);
  }));

  it('exposes stale review and CAS as structured conflicts and blocked reviews as explicit non-publication', () => fixture(async ({ store, request, plan }) => {
    const review = (await request('review', { expectedRevision: 0, plan })).json.review;
    const invalid = await request('apply', { ...legacyMigrationProof(plan, review), sourceDigest: `sha256:${'f'.repeat(64)}` });
    expect(invalid.status).toBe(409); expect(invalid.json.error.code).toBe('DESIGN_RUNTIME_LEGACY_MIGRATION_CONFLICT'); expect(invalid.json.error.details.diagnostics[0].code).toBe('ODDS9004');
    const { tokenStylesheet: _, ...withoutTokens } = plan;
    const prosePlan = { ...withoutTokens, selections: [], sourcePaths: ['DESIGN.md'] };
    const blocked = (await request('review', { expectedRevision: 0, plan: prosePlan })).json.review;
    expect(blocked.canApply).toBe(false); const failed = await request('apply', legacyMigrationProof(prosePlan, blocked));
    expect(failed.status).toBe(400); expect(failed.json.error.code).toBe('DESIGN_RUNTIME_LEGACY_MIGRATION_INVALID');
    store.write('project', 0, store.read('project'));
    const stale = await request('apply', legacyMigrationProof(plan, review)); expect(stale.status).toBe(409); expect(stale.json.error.details).toMatchObject({ expectedRevision: 0, currentRevision: 1 });
    expect(store.listVersions('project')).toEqual([]);
  }));
});
