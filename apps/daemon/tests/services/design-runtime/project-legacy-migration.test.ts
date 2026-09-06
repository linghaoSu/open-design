import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../../src/storage/design-runtime-store.js';
import { createProjectDesignRuntimeService } from '../../../src/services/design-runtime/project-service.js';
import { legacyMigrationFixture, legacyMigrationProof } from '../../fixtures/design-runtime/legacy-migration.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'), ('other');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db); const fixture = legacyMigrationFixture(); let identity = 'workspace-a/root-a/account-a';
  const readSourceFile = vi.fn(async (path: string) => { const file = fixture.files.get(path); if (!file) throw new Error('Missing'); return structuredClone(file); });
  const acquireMigrationAuthority = vi.fn(async () => { const captured = identity; const assertCurrentSync = () => { if (identity !== captured) throw new Error('Authority changed'); }; return { identity: captured, readSourceFile,
    assertCurrent: async () => assertCurrentSync(), assertCurrentSync }; });
  const service = createProjectDesignRuntimeService({ store, readSource: async () => { throw new Error('Migration must use binary-capable authority'); }, acquireMigrationAuthority });
  return { ...fixture, db, store, service, readSourceFile, acquireMigrationAuthority, changeIdentity: () => { identity = 'workspace-b/root-b/account-b'; } };
}

describe('reviewed legacy design-system migration', () => {
  it('reviews deterministically without writes and atomically freezes mixed code, stories, scalar tokens and binary source', async () => {
    const { store, service, plan, files, readSourceFile } = setup();
    const originalFiles = structuredClone(files); const original = store.read('project');
    const write = vi.spyOn(store, 'write');
    const first = await service.reviewLegacyMigration('project', { expectedRevision: 0, plan });
    expect(first.review.canApply).toBe(true);
    expect(first.review.tokens.some((record) => record.status === 'unresolved')).toBe(true);
    expect(first.review.candidate!.package.tokens.tokens.map((token) => token.cssVariable)).toContain('--accent');
    expect(first.review.compiledComponentRefs).toEqual(['ds:test/card', 'ds:test/vue-button']);
    expect(first.review.candidate!.package.registry.components.map((component) => component.stories?.length)).toEqual([2, 1]);
    expect(write).not.toHaveBeenCalled(); expect(store.read('project')).toEqual(original); expect(store.listVersions('project')).toEqual([]);
    expect(readSourceFile.mock.calls.map(([path]) => path)).toEqual([...plan.sourcePaths].sort().concat([...plan.sourcePaths].sort()));
    const second = await service.reviewLegacyMigration('project', { expectedRevision: 0, plan }); expect(second).toEqual(first);
    const applied = await service.applyLegacyMigration('project', legacyMigrationProof(plan, first.review));
    expect(write).toHaveBeenCalledTimes(1); expect(applied.state.revision).toBe(1);
    expect(applied.state.validationSettings.mode).toBe('guided'); expect(applied.state.lock.dependencies[0]?.version).toBe('1.0.0');
    expect(store.readVersion('project', 'test', '1.0.0')).toEqual(first.review.candidate);
    expect(service.resolveDependency('project').resolution.ok).toBe(true);
    expect(first.review.candidate!.package.source.files.find((file) => file.path === 'assets/logo.png')).toEqual(files.get('assets/logo.png'));
    expect(files).toEqual(originalFiles); expect(store.listVersions('other')).toEqual([]);
  });

  it('preserves existing local definitions, screens, drafts, target settings and unrelated working fields', async () => {
    const { store, service, plan } = setup(); const before = store.read('project');
    const local = { schemaVersion: 1 as const, id: 'LocalText', name: 'Text', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1 as const, type: 'text' as const, id: 'template', text: 'Keep' } };
    const existing = store.write('project', 0, { ...before, projectComponents: { ...before.projectComponents, components: [local] },
      document: { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, type: 'screen', id: 'screen', children: [{ schemaVersion: 1, type: 'instance', id: 'instance', ref: 'local:LocalText', overrides: [] }] }] },
      generationTargets: { schemaVersion: 1, outputs: [{ screenId: 'screen', sourcePath: 'Screen.tsx', exportName: 'Screen' }] } });
    const review = (await service.reviewLegacyMigration('project', { expectedRevision: 1, plan })).review;
    const result = await service.applyLegacyMigration('project', legacyMigrationProof(plan, review));
    for (const field of ['projectComponents', 'document', 'sharedChanges', 'projectCodeIndex', 'generationTargets'] as const) expect(result.state[field]).toEqual(existing[field]);
    expect(result.state.validationSettings.projectConstraints).toEqual(existing.validationSettings.projectConstraints);
  });

  it('supports token-only bootstrap and refuses prose-only, unsupported-only or invalid selected compiler sources', async () => {
    const { store, service, plan, files } = setup();
    const tokenPlan = { ...plan, selections: [] };
    expect((await service.reviewLegacyMigration('project', { expectedRevision: 0, plan: tokenPlan })).review.canApply).toBe(true);
    const { tokenStylesheet: _, ...prosePlan } = tokenPlan;
    const prose = (await service.reviewLegacyMigration('project', { expectedRevision: 0, plan: { ...prosePlan, sourcePaths: ['DESIGN.md'] } })).review;
    expect(prose.canApply).toBe(false); expect(prose.candidate).toBeNull(); expect(prose.diagnostics.some((entry) => entry.code === 'ODDS9001')).toBe(true);
    files.set('tokens.css', { path: 'tokens.css', encoding: 'utf8', content: ':root { --accent: var(--missing); }' });
    const unsupported = (await service.reviewLegacyMigration('project', { expectedRevision: 0, plan: tokenPlan })).review;
    expect(unsupported.canApply).toBe(false);
    await expect(service.applyLegacyMigration('project', legacyMigrationProof(tokenPlan, unsupported))).rejects.toMatchObject({ kind: 'invalid' });
    files.set(plan.selections[0]!.sourcePath, { path: plan.selections[0]!.sourcePath, encoding: 'utf8', content: 'export const Broken = dynamic();' });
    const invalid = (await service.reviewLegacyMigration('project', { expectedRevision: 0, plan })).review;
    expect(invalid.canApply).toBe(false); expect(invalid.diagnostics.some((entry) => entry.code === 'ODDS6002')).toBe(true);
    expect(store.read('project').revision).toBe(0); expect(store.listVersions('project')).toEqual([]);
  });

  it('rejects tampered reviews, plan changes, source changes and cross-authority reuse without publication', async () => {
    const { store, service, plan, files, changeIdentity } = setup();
    const review = (await service.reviewLegacyMigration('project', { expectedRevision: 0, plan })).review;
    const proof = legacyMigrationProof(plan, review);
    for (const input of [{ ...proof, reviewId: 'forged' }, { ...proof, baseDigest: `sha256:${'f'.repeat(64)}` }, { ...proof, plan: { ...plan, name: 'Different' } }]) await expect(service.applyLegacyMigration('project', input)).rejects.toMatchObject({ kind: 'conflict' });
    const original = files.get('DESIGN.md')!;
    files.set('DESIGN.md', { ...original, content: '# Changed' });
    await expect(service.applyLegacyMigration('project', proof)).rejects.toMatchObject({ kind: 'conflict' }); files.set('DESIGN.md', original);
    changeIdentity(); await expect(service.applyLegacyMigration('project', proof)).rejects.toMatchObject({ kind: 'conflict' });
    await expect(service.applyLegacyMigration('other', proof)).rejects.toMatchObject({ kind: 'conflict' });
    expect(store.read('project').revision).toBe(0); expect(store.listVersions('project')).toEqual([]);
  });

  it('detects source drift inside review and revision/authorization races at apply', async () => {
    const { store, service, plan, readSourceFile } = setup(); const originalRead = readSourceFile.getMockImplementation()!;
    readSourceFile.mockImplementationOnce(async (path) => { const file = await originalRead(path); return { ...file, content: file.content + 'changed' }; });
    await expect(service.reviewLegacyMigration('project', { expectedRevision: 0, plan })).rejects.toMatchObject({ kind: 'conflict' });
    const review = (await service.reviewLegacyMigration('project', { expectedRevision: 0, plan })).review;
    await expect(service.applyLegacyMigration('project', legacyMigrationProof(plan, review), async () => { throw new Error('Permission revoked'); })).rejects.toThrow('Permission revoked');
    expect(store.listVersions('project')).toEqual([]);
    await expect(service.applyLegacyMigration('project', legacyMigrationProof(plan, review), async () => { const state = store.read('project'); store.write('project', 0, state); })).rejects.toMatchObject({ expectedRevision: 0, currentRevision: 1 });
    expect(store.listVersions('project')).toEqual([]); expect(store.read('project').revision).toBe(1);
  });

  it('rejects authority drift during the final source read and enforces source budgets before parsing', async () => {
    const { store, service, plan, files, readSourceFile, changeIdentity } = setup();
    const originalRead = readSourceFile.getMockImplementation()!; let calls = 0;
    readSourceFile.mockImplementation(async (path) => { const file = await originalRead(path); if (++calls === plan.sourcePaths.length * 2) changeIdentity(); return file; });
    await expect(service.reviewLegacyMigration('project', { expectedRevision: 0, plan })).rejects.toMatchObject({ kind: 'conflict' });
    readSourceFile.mockImplementation(originalRead); readSourceFile.mockClear();
    const tooMany = Array.from({ length: 257 }, (_, index) => `asset-${index}.bin`);
    const { tokenStylesheet: _, ...base } = plan;
    await expect(service.reviewLegacyMigration('project', { expectedRevision: 0, plan: { ...base, selections: [], sourcePaths: tooMany } })).rejects.toThrow('256-file');
    expect(readSourceFile).not.toHaveBeenCalled();
    files.set('oversized.txt', { path: 'oversized.txt', encoding: 'utf8', content: 'x'.repeat(4 * 1024 * 1024 + 1) });
    await expect(service.reviewLegacyMigration('project', { expectedRevision: 0, plan: { ...base, selections: [], sourcePaths: ['oversized.txt'] } })).rejects.toThrow('source budget');
    const aggregate = Array.from({ length: 7 }, (_, index) => `chunk-${index}.txt`);
    for (const path of aggregate) files.set(path, { path, encoding: 'utf8', content: 'x'.repeat(4 * 1024 * 1024) });
    await expect(service.reviewLegacyMigration('project', { expectedRevision: 0, plan: { ...base, selections: [], sourcePaths: aggregate } })).rejects.toThrow('source budget');
    expect(store.read('project').revision).toBe(0); expect(store.listVersions('project')).toEqual([]);
  });

  it('uses store transaction rollback for version conflicts and never overwrites an initialized registry', async () => {
    const { store, service, plan, db, readSourceFile } = setup();
    const review = (await service.reviewLegacyMigration('project', { expectedRevision: 0, plan })).review;
    db.exec("CREATE TRIGGER reject_migration_state BEFORE INSERT ON project_design_runtime BEGIN SELECT RAISE(ABORT, 'reject state'); END;");
    await expect(service.applyLegacyMigration('project', legacyMigrationProof(plan, review))).rejects.toThrow('reject state');
    expect(store.listVersions('project')).toEqual([]); expect(store.read('project').revision).toBe(0);
    db.exec('DROP TRIGGER reject_migration_state');
    await service.applyLegacyMigration('project', legacyMigrationProof(plan, review)); readSourceFile.mockClear();
    await expect(service.reviewLegacyMigration('project', { expectedRevision: 1, plan })).rejects.toMatchObject({ kind: 'conflict' });
    expect(readSourceFile).not.toHaveBeenCalled(); expect(store.listVersions('project')).toHaveLength(1);
  });
});
