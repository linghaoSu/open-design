import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  ProjectDesignRuntimeCodeComponentsResponseSchema, ProjectDesignRuntimeEmitHandoffResponseSchema,
  ProjectDesignRuntimeHandoffResponseSchema, ProjectDesignRuntimeRegisterLocalBindingResponseSchema,
  ProjectDesignRuntimeRefreshCodeResponseSchema, ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema, ProjectDesignRuntimeStateSchema,
  type ComponentFramework, type ProjectDesignRuntimeRegisterLocalBindingRequest,
} from '@open-design/contracts';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import { localHandoffFixture } from '../fixtures/design-runtime/handoff.js';
import { packageFixture } from '../fixtures/design-runtime/design-system-version.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../src/services/design-runtime/design-system-version.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';

async function withProject(run: (fixture: {
  request: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  sources: Map<string, string>; registration: ProjectDesignRuntimeRegisterLocalBindingRequest;
  service: ReturnType<typeof createProjectDesignRuntimeService>; store: ReturnType<typeof createDesignRuntimeStore>;
  readSource: ReturnType<typeof vi.fn<(projectId: string, sourcePath: string) => Promise<string>>>;
  authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  initial: ReturnType<typeof localHandoffFixture>;
}) => Promise<void>, framework: ComponentFramework = 'react', designSystem = true) {
  const db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db); const initial = localHandoffFixture(framework); const snapshot = initial.snapshot;
  const code = snapshot.projectCodeIndex.components[0]!; const binding = snapshot.bindings.bindings.find((entry) => entry.componentRef.startsWith('local:'))!;
  if (binding.status !== 'bound') throw new Error('fixture binding');
  const registration: ProjectDesignRuntimeRegisterLocalBindingRequest = { expectedRevision: 1,
    source: { framework, sourcePath: code.sourcePath, exportName: code.exportName, codeComponentId: code.id }, binding };
  const sources = new Map(snapshot.versions.flatMap((version) => version.package.source.files.map((file) => [file.path, file.content] as const)));
  sources.set(code.sourcePath, snapshot.projectSources[0]!.sourceText);
  store.write('project', 0, { ...store.read('project'), registry: designSystem ? snapshot.registry : null,
    codeIndex: designSystem ? { ...snapshot.baseCodeIndex, id: 'project' } : { schemaVersion: 1, id: 'project', components: [] },
    projectComponents: snapshot.projectComponents, document: snapshot.document,
    bindings: { schemaVersion: 1, id: 'project', bindings: designSystem ? snapshot.bindings.bindings.filter((entry) => entry.componentRef.startsWith('ds:')) : [] },
    dependencies: designSystem ? snapshot.dependencies : { schemaVersion: 1, id: 'project', dependencies: [] },
    lock: designSystem ? snapshot.lock : { schemaVersion: 1, id: 'project', dependencies: [] },
  }, designSystem ? snapshot.versions : []);
  const readSource = vi.fn(async (_projectId: string, sourcePath: string) => { const source = sources.get(sourcePath); if (source === undefined) throw new Error('Source unavailable'); return source; });
  const service = createProjectDesignRuntimeService({ store, readSource, observeTargetPackages: async (_projectId, names) => names.map((name) => ({ name, installation: { status: 'observed', version: '1.2.0' } })) });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true); const app = express(); app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run({ sources, registration, initial, service, store, readSource, authorize,
    request: async (method, path, body) => { const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/project/design-runtime${path}`, {
      method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }); return { status: response.status, json: await response.json() }; },
  }); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}

describe('project code and engineering handoff HTTP authority', () => {
  it.each(['react', 'vue'] as const)('registers and preserves %s local production code under a frozen lock, then emits read-only source', (framework) => withProject(async ({ request, registration, store, initial }) => {
    const absent = await request('POST', '/handoffs', { expectedRevision: 1, id: 'handoff', framework });
    expect(ProjectDesignRuntimeHandoffResponseSchema.parse(absent.json).result.manifest?.ready).toBe(false);
    const bound = await request('POST', '/project-code-components/register-binding', registration); expect(bound.status).toBe(200);
    const { state } = ProjectDesignRuntimeRegisterLocalBindingResponseSchema.parse(bound.json);
    expect(state.projectCodeIndex.components.map((entry) => entry.id)).toEqual(['project/card']);
    expect(state.codeIndex.components).toEqual(initial.snapshot.baseCodeIndex.components);
    expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET', '')).json).state.projectCodeIndex).toEqual(state.projectCodeIndex);
    expect(ProjectDesignRuntimeCodeComponentsResponseSchema.parse((await request('GET', '/code-components')).json).components).toHaveLength(2);
    expect(ProjectDesignRuntimeCodeComponentsResponseSchema.parse((await request('GET', '/project-code-components')).json).components).toHaveLength(1);
    const result = await request('POST', '/handoffs/emit', { expectedRevision: 2, id: 'handoff', framework, outputs: [{ screenId: 'main', sourcePath: `src/screens/Main.${framework === 'react' ? 'tsx' : 'vue'}`, exportName: framework === 'react' ? 'Main' : 'default' }] });
    expect(result.status).toBe(200); const emitted = ProjectDesignRuntimeEmitHandoffResponseSchema.parse(result.json);
    expect(emitted.handoff.manifest?.ready).toBe(true); expect(emitted.code.ok).toBe(true);
    expect(emitted.code.files[0]!.content).toContain('filled'); expect(emitted.code.files[0]!.content).not.toContain('@acme/ui');
    expect(store.read('project')).toEqual(state); expect(JSON.stringify(state)).not.toContain('sourceText');
  }, framework));

  it('supports local-only projects without inventing a design system, while rejecting DS bindings in that state', () => withProject(async ({ request, registration, store }) => {
    const registered = await request('POST', '/project-code-components/register-binding', registration);
    const { state } = ProjectDesignRuntimeRegisterLocalBindingResponseSchema.parse(registered.json); expect(state.registry).toBeNull();
    expect((await request('POST', '/validate', { component: 'local:card', props: { tone: 'primary' } })).json.diagnostics).toEqual([]);
    expect(ProjectDesignRuntimeHandoffResponseSchema.parse((await request('POST', '/handoffs', { expectedRevision: 2, id: 'local-only', framework: 'react' })).json).result.manifest?.ready).toBe(true);
    const ds = { ...registration.binding, componentRef: 'ds:invented/card', definitionRevision: undefined };
    expect((await request('PUT', '/bindings/another', { expectedRevision: 2, binding: { ...ds, id: 'another' } })).status).toBe(400);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, bindings: { ...state.bindings, bindings: [ds] } }).success).toBe(false);
    expect(store.read('project')).toEqual(state);
  }, 'react', false));

  it('retains unavailable registered paths, persists broken/stale status, and repairs only after an explicit refresh/revalidation', () => withProject(async ({ request, registration, sources, store }) => {
    await request('POST', '/project-code-components/register-binding', registration);
    const path = registration.source.sourcePath; const source = sources.get(path)!; const route = `/project-code-components/${encodeURIComponent(registration.source.codeComponentId)}/refresh`;
    sources.delete(path);
    let response = await request('POST', route, { expectedRevision: 2 }); expect(response.status).toBe(200);
    let refreshed = ProjectDesignRuntimeRefreshCodeResponseSchema.parse(response.json);
    expect(refreshed.diagnostics[0]?.code).toBe('ODDS7004'); expect(refreshed.state.projectCodeIndex.components[0]?.sourcePath).toBe(path);
    expect(refreshed.state.bindings.bindings.find((entry) => entry.id === registration.binding.id)?.status).toBe('broken');
    sources.set(path, source); response = await request('POST', route, { expectedRevision: 3 });
    refreshed = ProjectDesignRuntimeRefreshCodeResponseSchema.parse(response.json);
    expect(refreshed.state.bindings.bindings.find((entry) => entry.id === registration.binding.id)?.status).toBe('broken');
    const bindingRoute = `/bindings/${encodeURIComponent(registration.binding.id)}`;
    expect((await request('POST', `${bindingRoute}/revalidate`, { expectedRevision: 4 })).status).toBe(200);
    expect(ProjectDesignRuntimeResolveResponseSchema.parse((await request('GET', `${bindingRoute}/resolve`)).json).resolution.ok).toBe(true);
    sources.set(path, source.replace("'filled'|'outline'", 'number').replace("='outline'", '=1'));
    response = await request('POST', route, { expectedRevision: 5 }); refreshed = ProjectDesignRuntimeRefreshCodeResponseSchema.parse(response.json);
    expect(refreshed.state.bindings.bindings.find((entry) => entry.id === registration.binding.id)?.status).toBe('stale');
    expect((await request('POST', `${bindingRoute}/revalidate`, { expectedRevision: 6 })).status).toBe(400);
    expect(store.read('project').revision).toBe(6);
  }));

  it('reuses proven frozen DS code for a local relationship without duplicating ownership, then checks editable source after clearing the lock', () => withProject(async ({ request, registration, store, service, readSource }) => {
    const version = createDesignSystemVersion(packageFixture('2.0.0')); const pkg = version.package;
    const state = store.write('project', 1, { ...store.read('project'), registry: pkg.registry,
      codeIndex: { ...pkg.codeIndex, id: 'project' }, bindings: { ...pkg.bindings, id: 'project' },
      dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^2.0.0' }] },
      lock: createProjectDesignSystemLock('project', [version]),
    }, [version]);
    const binding = { ...registration.binding, codeComponentId: 'ui/Button', propMappings: [{ designProp: 'tone', codeProp: 'variant' }] };
    const bound = await request('PUT', '/bindings/local%2Fcard', { expectedRevision: state.revision, binding });
    expect(bound.status).toBe(200);
    expect(ProjectDesignRuntimeResponseSchema.parse(bound.json).state.projectCodeIndex.components).toEqual([]);
    expect((await request('GET', '/bindings/local%2Fcard/resolve')).json.resolution.ok).toBe(true);
    expect(readSource).not.toHaveBeenCalled();
    const cleared = service.clearDependency('project', { expectedRevision: 3 });
    const missing = await request('POST', '/bindings/local%2Fcard/revalidate', { expectedRevision: cleared.revision });
    expect(missing.status).toBe(400); expect(missing.json.error.details.diagnostics[0].code).toBe('ODDS7004');
    expect(readSource).toHaveBeenCalledWith('project', 'src/Button.tsx');
    expect(store.read('project').revision).toBe(cleared.revision);
  }));

  it('rejects missing history and a valid catalog snapshot returned under the wrong exact selected version', () => withProject(async ({ request, store }) => {
    const fromVersion = { designSystemId: 'acme', version: '0.9.0' };
    const input = { expectedRevision: 1, id: 'history', framework: 'react' };
    const missing = ProjectDesignRuntimeHandoffResponseSchema.parse((await request('POST', '/handoffs', { ...input, changeContextSelection: { sharedChangeIds: ['unknown'] } })).json);
    expect(missing.result.manifest).toBeNull(); expect(missing.result.diagnostics[0]?.code).toBe('ODDS7001');
    const original = store.readVersion.bind(store); const active = original('project', 'acme', '1.0.0')!;
    vi.spyOn(store, 'readVersion').mockImplementation((projectId, designSystemId, version) => version === '0.9.0' ? active : original(projectId, designSystemId, version));
    const wrong = ProjectDesignRuntimeHandoffResponseSchema.parse((await request('POST', '/handoffs', { ...input, changeContextSelection: { fromVersion } })).json);
    expect(wrong.result.manifest).toBeNull(); expect(wrong.result.diagnostics[0]?.message).toContain('exact catalog identity');
    expect(store.read('project').revision).toBe(1);
  }));

  it('preserves project ownership through clear, compile, publication and initial activation', () => withProject(async ({ request, registration, initial, service, store }) => {
    const registered = ProjectDesignRuntimeRegisterLocalBindingResponseSchema.parse((await request('POST', '/project-code-components/register-binding', registration)).json).state;
    let state = service.clearDependency('project', { expectedRevision: registered.revision });
    const code = initial.snapshot.baseCodeIndex.components[0]!;
    state = await service.compile('project', { expectedRevision: state.revision, designSystemId: 'acme', selections: [{ sourcePath: code.sourcePath, exportName: code.exportName, componentId: 'panel', codeComponentId: code.id, framework: 'react', packageName: '@acme/ui', metadataExportName: 'PanelPolicy' }] });
    expect(state.projectCodeIndex).toEqual(registered.projectCodeIndex);
    const published = await service.publishCurrent('project', { expectedRevision: state.revision, name: 'Acme', version: '1.1.0', sourcePaths: [code.sourcePath], constraints: initial.snapshot.versions[0]!.package.constraints });
    const pkg = store.readVersion('project', 'acme', '1.1.0')!.package;
    expect(pkg.codeIndex.components.map((entry) => entry.id)).toEqual([code.id]); expect(pkg.bindings.bindings.every((entry) => entry.componentRef.startsWith('ds:'))).toBe(true);
    state = service.activateDependency('project', { expectedRevision: published.state.revision, designSystemId: 'acme', version: '1.1.0', range: '^1.0.0' });
    expect(state.projectCodeIndex).toEqual(registered.projectCodeIndex);
    expect(state.bindings.bindings.find((entry) => entry.id === registration.binding.id)).toEqual(registration.binding);
  }));

  it('invalidates local revision proof on template publication and derives selected history from durable records', () => withProject(async ({ request, registration, service, store }) => {
    await request('POST', '/project-code-components/register-binding', registration);
    const definition = structuredClone(store.read('project').projectComponents.components[0]!); definition.revision++;
    definition.template.id = 'new-label'; definition.propMappings[0]!.nodeId = 'new-label';
    service.stageComponent('project', { expectedRevision: 2, draftId: 'template-change', expectedDefinitionRevision: 2, definition });
    const published = service.publishComponent('project', 'template-change', { expectedRevision: 3, expectedDefinitionRevision: 2 });
    expect(published.state.bindings.bindings.find((entry) => entry.id === registration.binding.id)).toMatchObject({ status: 'stale', definitionRevision: 2 });
    const requestBody = { expectedRevision: 4, id: 'history-handoff', framework: 'react', changeContextSelection: { sharedChangeIds: ['template-change'] } };
    const result = ProjectDesignRuntimeHandoffResponseSchema.parse((await request('POST', '/handoffs', requestBody)).json).result;
    expect(result.manifest?.changeContext?.sharedRevisions?.[0]).toMatchObject({ changeId: 'template-change', definition: { revision: 3 } });
    expect(result.manifest?.ready).toBe(false);
    expect((await request('POST', '/handoffs', { ...requestBody, changeContext: { sharedRevisions: [] } })).status).toBe(400);
    expect((await request('POST', '/bindings/local%2Fcard/revalidate', { expectedRevision: 4 })).status).toBe(200);
    expect(store.read('project').bindings.bindings.find((entry) => entry.id === registration.binding.id)).toMatchObject({ status: 'bound', definitionRevision: 3 });
  }));

  it('authorizes before source reads, rejects caller evidence, and detects asynchronous CAS races without writes', () => withProject(async ({ request, registration, readSource, authorize, service, store }) => {
    authorize.mockImplementationOnce(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request('POST', '/project-code-components/register-binding', registration)).status).toBe(403); expect(readSource).not.toHaveBeenCalled();
    expect((await request('POST', '/project-code-components/register-binding', { ...registration, source: { ...registration.source, sourceText: 'injected' } })).status).toBe(400);
    expect((await request('POST', '/handoffs', { expectedRevision: 1, id: 'spoofed', framework: 'react', snapshot: {} })).status).toBe(400);
    expect(readSource).not.toHaveBeenCalled();
    await request('POST', '/project-code-components/register-binding', registration);
    let release!: (text: string) => void; const source = readSource.mock.results[0]!.value;
    readSource.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = service.handoff('project', { expectedRevision: 2, id: 'racing', framework: 'react' });
    const changed = service.unbind('project', registration.binding.id, { expectedRevision: 2 });
    release(await source);
    await expect(pending).rejects.toMatchObject({ expectedRevision: 2, currentRevision: 3 });
    expect(store.read('project')).toEqual(changed);
  }));
});
