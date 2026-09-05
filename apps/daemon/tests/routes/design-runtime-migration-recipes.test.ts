import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDesignRuntimeMigrationRecipesResponseSchema, ProjectDesignRuntimeMigrationRecipeResponseSchema, type DesignSystemMigrationRecipe } from '@open-design/contracts';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../src/services/design-runtime/design-system-version.js';
import { upgradeFixture } from '../fixtures/design-runtime/design-system-upgrade.js';

async function withRecipes(run: (value: {
  store: ReturnType<typeof createDesignRuntimeStore>; service: ReturnType<typeof createProjectDesignRuntimeService>;
  recipe: DesignSystemMigrationRecipe; to: ReturnType<typeof createDesignSystemVersion>;
  authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  readSource: ReturnType<typeof vi.fn<(projectId: string, path: string) => Promise<string>>>;
  request: (method: string, suffix: string, input?: unknown, projectId?: string) => Promise<{ status: number; json: any }>;
}) => Promise<void>) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'), ('other');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db); const base = upgradeFixture();
  const recipe: DesignSystemMigrationRecipe = { schemaVersion: 1, id: 'button-v2', name: 'Button v2', from: { version: base.from.package.version, digest: base.from.digest }, rules: base.plan.rules,
    packageBindingDecisions: [{ type: 'use-target-package', bindingId: base.from.package.bindings.bindings[0]!.id, targetBindingId: base.to.package.bindings.bindings[0]!.id }] };
  const to = createDesignSystemVersion({ ...base.to.package, migrations: [recipe] });
  const { projectId: _id, projectSources: _sources, ...context } = base.context;
  store.write('project', 0, { ...store.read('project'), ...context, registry: base.from.package.registry }, [base.from, to]);
  const readSource = vi.fn(async (_projectId: string, path: string) => {
    const file = to.package.source.files.find((entry) => entry.path === path); if (!file || file.encoding !== 'utf8') throw new Error('Missing UTF8 source'); return file.content;
  });
  const service = createProjectDesignRuntimeService({ store, readSource });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true); const app = express(); app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run({ store, service, recipe, to, authorize, readSource, request: async (method, suffix, input, projectId = 'project') => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${projectId}/design-runtime${suffix}`, { method, ...(input === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }) });
    return { status: response.status, json: await response.json() };
  } }); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}
const input = { expectedRevision: 1, designSystemId: 'acme', version: '2.0.0', recipeId: 'button-v2', planId: 'chosen', targetRange: '2.0.0' };
describe('published migration recipe HTTP', () => {
  it('lists exact authored recipes and instantiates a normal editable plan through read-only authority without source reads or writes', () => withRecipes(async ({ store, recipe, request, readSource, authorize }) => {
    const before = store.read('project'); const catalog = store.listVersions('project');
    const listed = await request('GET', '/versions/acme/2.0.0/migrations');
    expect(listed.status).toBe(200); expect(ProjectDesignRuntimeMigrationRecipesResponseSchema.parse(listed.json)).toEqual({ revision: 1, recipes: [recipe] });
    const selected = await request('POST', '/upgrades/recipes', input);
    expect(selected.status).toBe(200);
    const result = ProjectDesignRuntimeMigrationRecipeResponseSchema.parse(selected.json);
    expect(result.plan).toMatchObject({ id: 'chosen', rules: recipe.rules, bindingDecisions: recipe.packageBindingDecisions });
    expect(result.diagnostics).toEqual([]); expect(store.read('project')).toEqual(before); expect(store.listVersions('project')).toEqual(catalog);
    expect(readSource).not.toHaveBeenCalled(); expect(authorize.mock.calls.map((call) => call[3])).toEqual([{ mode: 'read' }, { mode: 'read' }]);
  }));
  it('enforces auth before catalog access, exact project scoping, malformed-input rejection and revision conflicts', () => withRecipes(async ({ store, request, authorize }) => {
    const read = vi.spyOn(store, 'read'); const catalog = vi.spyOn(store, 'readVersion');
    authorize.mockImplementation(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request('GET', '/versions/acme/2.0.0/migrations')).status).toBe(403); expect((await request('POST', '/upgrades/recipes', input)).status).toBe(403);
    expect(read).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled(); authorize.mockResolvedValue(true);
    expect((await request('POST', '/upgrades/recipes', { ...input, plan: {} })).status).toBe(400); expect(read).not.toHaveBeenCalled();
    expect((await request('GET', '/versions/acme/2.0.0/migrations', undefined, 'other')).status).toBe(404);
    expect((await request('POST', '/upgrades/recipes', { ...input, expectedRevision: 0 })).json.error).toMatchObject({ code: 'DESIGN_RUNTIME_REVISION_CONFLICT', details: { expectedRevision: 0, currentRevision: 1 } });
    expect(store.read('project').revision).toBe(1);
  }));
  it('preserves recipe metadata on publish-current and permits explicit clearing without mutating older versions', () => withRecipes(async ({ store, service, to, recipe }) => {
    const previous = store.read('project');
    store.write('project', 1, { ...previous, registry: to.package.registry, codeIndex: { ...to.package.codeIndex, id: 'project' }, bindings: { ...to.package.bindings, id: 'project' }, document: null,
      projectComponents: { ...previous.projectComponents, components: [] }, lock: createProjectDesignSystemLock('project', [to]), dependencies: { ...previous.dependencies, dependencies: [{ designSystemId: 'acme', version: '2.0.0' }] } });
    const sourcePaths = to.package.source.files.filter((entry) => entry.encoding === 'utf8').map((entry) => entry.path);
    const published = await service.publishCurrent('project', { expectedRevision: 2, name: to.package.name, version: '2.1.0', sourcePaths });
    expect(store.readVersion('project', 'acme', '2.1.0')?.package.migrations).toEqual([recipe]);
    await service.publishCurrent('project', { expectedRevision: published.state.revision, name: to.package.name, version: '2.2.0', sourcePaths, migrations: [] });
    expect(store.readVersion('project', 'acme', '2.2.0')?.package.migrations).toEqual([]);
    expect(store.readVersion('project', 'acme', '2.0.0')).toEqual(to);
  }));
});
