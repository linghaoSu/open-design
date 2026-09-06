import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../../src/storage/design-runtime-store.js';
import { createProjectDesignRuntimeService } from '../../../src/services/design-runtime/project-service.js';
import { createDesignSystemVersion } from '../../../src/services/design-runtime/design-system-version.js';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';
import type { ProjectDesignRuntimeState, UIIRDocument } from '@open-design/contracts';

let db: Database.Database;
afterEach(() => db?.close());
function setup() {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'), ('other');");
  migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db);
  const pkg = packageFixture();
  const readSource = vi.fn(async (_project: string, path: string) => {
    const file = pkg.source.files.find((entry) => entry.path === path);
    if (!file || file.encoding !== 'utf8') throw new Error('Missing UTF-8 source');
    return file.content;
  });
  const service = createProjectDesignRuntimeService({ store, readSource });
  return { store, service, readSource, pkg };
}
const activation = (expectedRevision: number, version = '1.0.0') => ({ expectedRevision, designSystemId: 'acme', version, range: '^1.0.0' });
const document: UIIRDocument = { schemaVersion: 1, id: 'design', screens: [{ schemaVersion: 1, type: 'screen', id: 'Applications', children: [{ schemaVersion: 1, type: 'component', id: 'save', ref: 'ds:acme/Button', props: { label: 'Save' } }] }] };

describe('project immutable versions and exact dependency service', () => {
  it('preserves complete published metadata and unselected asset bytes after unlock, reopen, and publication', async () => {
    const { service, store, pkg, readSource } = setup();
    pkg.origin = { type: 'git', repository: 'https://example.com/acme.git', commit: 'a'.repeat(40) };
    pkg.migrations = [{ schemaVersion: 1, id: 'previous', name: 'Previous release', from: { version: '0.9.0', digest: `sha256:${'b'.repeat(64)}` }, rules: [], packageBindingDecisions: [] }];
    pkg.source.files.push({ path: 'brand.txt', encoding: 'utf8', content: '\ufeffBrand\r\n' });
    service.importVersion('project', { expectedRevision: 0, package: pkg });
    const locked = service.activateDependency('project', activation(1));
    const original = JSON.stringify(store.readVersion('project', 'acme', '1.0.0'));
    const editable = service.clearDependency('project', { expectedRevision: locked.revision });
    const reopened = createProjectDesignRuntimeService({ store: createDesignRuntimeStore(db), readSource });
    await reopened.publishCurrent('project', { expectedRevision: editable.revision, name: 'Acme UI', version: '1.1.0', sourcePaths: ['src/Button.tsx'], constraints: pkg.constraints });
    const next = store.readVersion('project', 'acme', '1.1.0')!.package;
    for (const key of ['tokens', 'patterns', 'constraints', 'codeCompatibility', 'origin', 'migrations'] as const) expect(next[key], key).toEqual(pkg[key]);
    expect(next.source).toEqual(createDesignSystemVersion(pkg).package.source);
    expect(JSON.stringify(store.readVersion('project', 'acme', '1.0.0'))).toBe(original);
  });

  it('restores an explicitly selected legacy baseline without replacing current component edits or guessing latest', async () => {
    const { service, store, pkg, readSource } = setup();
    service.importVersion('project', { expectedRevision: 0, package: pkg });
    let state = service.activateDependency('project', activation(1));
    state = service.clearDependency('project', { expectedRevision: state.revision });
    const edited = structuredClone(state); edited.registry!.components[0]!.name = 'Edited label';
    state = store.write('project', state.revision, edited);
    const { authoringBase: _base, ...legacy } = state;
    const bytes = JSON.stringify(legacy);
    db.prepare('UPDATE project_design_runtime SET state_json = ?').run(bytes);
    const newer = packageFixture('1.1.0'); newer.tokens.tokens = [];
    state = service.importVersion('project', { expectedRevision: state.revision, package: newer }).state;
    expect(state.authoringBase).toBeNull();
    await expect(service.publishCurrent('project', { expectedRevision: state.revision, name: pkg.name, version: '1.2.0', sourcePaths: [], constraints: pkg.constraints })).rejects.toThrow('Select an exact authoring baseline');
    expect(readSource).not.toHaveBeenCalled();
    expect(() => service.restoreAuthoringBase('project', { expectedRevision: state.revision - 1, designSystemId: 'acme', version: '1.0.0' })).toThrow('changed');
    expect(() => service.restoreAuthoringBase('project', { expectedRevision: state.revision, designSystemId: 'other', version: '1.0.0' })).toThrow('working design system');
    const restored = service.restoreAuthoringBase('project', { expectedRevision: state.revision, designSystemId: 'acme', version: '1.0.0' });
    expect(restored.registry).toEqual(edited.registry);
    expect(restored.bindings).toEqual(state.bindings);
    expect(restored.lock.dependencies).toEqual([]);
    expect(restored.authoringBase?.version).toBe('1.0.0');
    const published = await service.publishCurrent('project', { expectedRevision: restored.revision, name: pkg.name, version: '1.2.0', sourcePaths: [] });
    expect(store.readVersion('project', 'acme', '1.2.0')!.package.tokens).toEqual(pkg.tokens);
    expect(published.state.authoringBase?.version).toBe('1.2.0');
    expect(readSource).not.toHaveBeenCalled();
  });

  it('retains the editing baseline through a real source recompile', async () => {
    const { service, store, pkg, readSource } = setup();
    pkg.registry.components = pkg.registry.components.filter((component) => component.id === 'Button');
    pkg.patterns.patterns = [{ schemaVersion: 1, id: 'ButtonPattern', name: 'Button pattern', props: {}, propMappings: [], slots: {}, slotMappings: [], template: { schemaVersion: 1, type: 'component', id: 'button', ref: 'ds:acme/Button' } }];
    service.importVersion('project', { expectedRevision: 0, package: pkg });
    let state = service.activateDependency('project', activation(1));
    state = service.clearDependency('project', { expectedRevision: state.revision });
    const changed = pkg.source.files[0]!.content.replace('return null', 'return <button>Updated</button>');
    readSource.mockResolvedValue(changed);
    state = await service.compile('project', { expectedRevision: state.revision, designSystemId: 'acme', selections: [{ sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'Button', codeComponentId: 'ui/Button', packageName: '@acme/ui' }] });
    expect(state.authoringBase?.version).toBe('1.0.0');
    await service.publishCurrent('project', { expectedRevision: state.revision, name: pkg.name, version: '1.1.0', sourcePaths: ['src/Button.tsx'] });
    const next = store.readVersion('project', 'acme', '1.1.0')!.package;
    expect(next.patterns).toEqual(pkg.patterns);
    expect(next.tokens).toEqual(pkg.tokens);
    expect(next.source.files.find((file) => file.path === 'src/Button.tsx')!.content).toBe(changed);
    expect(store.readVersion('project', 'acme', '1.0.0')!.package.source).toEqual(createDesignSystemVersion(pkg).package.source);
  });

  it('advances an unlocked baseline so consecutive publications retain the latest metadata and newly selected files', async () => {
    const { service, store, pkg, readSource } = setup();
    service.importVersion('project', { expectedRevision: 0, package: pkg });
    let state = service.activateDependency('project', activation(1));
    state = service.clearDependency('project', { expectedRevision: state.revision });
    const tokens = structuredClone(pkg.tokens);
    tokens.tokens.push({ schemaVersion: 1, id: 'color.new', name: 'New color', cssVariable: '--color-new', type: 'color', value: '#123456' });
    readSource.mockImplementation(async (_project, path) => path === 'notes.txt' ? '\ufeffNew file\r\n' : 'Updated design notes\r\n');
    const second = await service.publishCurrent('project', { expectedRevision: state.revision, name: pkg.name, version: '1.1.0', sourcePaths: ['DESIGN.md', 'notes.txt'], tokens });
    expect(second.state.authoringBase?.version).toBe('1.1.0');
    readSource.mockClear();
    const reopened = createProjectDesignRuntimeService({ store: createDesignRuntimeStore(db), readSource });
    const third = await reopened.publishCurrent('project', { expectedRevision: second.state.revision, name: pkg.name, version: '1.2.0', sourcePaths: [] });
    const secondPackage = store.readVersion('project', 'acme', '1.1.0')!.package;
    expect(store.readVersion('project', 'acme', '1.2.0')!.package).toEqual({ ...secondPackage, version: '1.2.0' });
    expect(third.state.authoringBase?.version).toBe('1.2.0');
    expect(readSource).not.toHaveBeenCalled();
    const imported = reopened.importVersion('project', { expectedRevision: third.state.revision, package: packageFixture('2.0.0') });
    expect(imported.state.authoringBase).toEqual(third.state.authoringBase);
  });

  it('publishes selected binary bytes with final source and authority fences, rejecting drift atomically', async () => {
    const { service, store, pkg, readSource } = setup();
    service.importVersion('project', { expectedRevision: 0, package: pkg });
    const state = service.activateDependency('project', activation(1));
    const readSourceFile = vi.fn(async (path: string) => ({ path, encoding: 'base64' as const, content: 'AP/+gA==' }));
    const assertCurrent = vi.fn(async () => {}); const assertCurrentSync = vi.fn(); const reauthorize = vi.fn(async () => {});
    const publication = createProjectDesignRuntimeService({ store, readSource, acquirePublicationAuthority: async () => ({ identity: 'authority', readSourceFile, assertCurrent, assertCurrentSync }) });
    const request = { expectedRevision: state.revision, name: pkg.name, version: '1.1.0', sourcePaths: ['assets/pixel.bin'] };
    const published = await publication.publishCurrent('project', request, reauthorize);
    expect(store.readVersion('project', 'acme', '1.1.0')!.package.source.files.find((file) => file.path === 'assets/pixel.bin')).toEqual({ path: 'assets/pixel.bin', encoding: 'base64', content: 'AP/+gA==' });
    expect(readSource).not.toHaveBeenCalled();
    expect(reauthorize.mock.invocationCallOrder[0]).toBeGreaterThan(assertCurrent.mock.invocationCallOrder[0]!);
    expect(assertCurrentSync.mock.invocationCallOrder[0]).toBeGreaterThan(reauthorize.mock.invocationCallOrder[0]!);
    readSourceFile.mockResolvedValueOnce({ path: 'assets/pixel.bin', encoding: 'base64', content: 'AA==' });
    await expect(publication.publishCurrent('project', { ...request, expectedRevision: published.state.revision, version: '1.2.0' })).rejects.toThrow('source changed');
    expect(store.readVersion('project', 'acme', '1.2.0')).toBeNull();
    expect(store.read('project')).toEqual(published.state);
    await expect(publication.publishCurrent('project', { ...request, expectedRevision: published.state.revision, version: '1.2.0' }, async () => { throw new Error('Permission revoked'); })).rejects.toThrow('Permission revoked');
    expect(store.readVersion('project', 'acme', '1.2.0')).toBeNull();
    expect(store.read('project')).toEqual(published.state);
    assertCurrentSync.mockImplementationOnce(() => { throw new Error('Authority changed'); });
    await expect(publication.publishCurrent('project', { ...request, expectedRevision: published.state.revision, version: '1.2.0' })).rejects.toThrow('Authority changed');
    expect(store.readVersion('project', 'acme', '1.2.0')).toBeNull();
    expect(store.read('project')).toEqual(published.state);
  });

  it('publishes source bytes outside aggregate, pins explicitly, preserves overrides and blocks direct upgrades', async () => {
    const { service, store, pkg, readSource } = setup();
    const imported = service.importVersion('project', { expectedRevision: 0, package: pkg });
    expect(imported.state.registry).toBeNull();
    expect(imported.version).toMatchObject({ id: 'acme', version: '1.0.0' });
    expect(JSON.stringify(service.get('project'))).not.toContain('return null');
    expect(service.versions('project').versions).toEqual([imported.version]);
    expect(service.version('project', 'acme', '1.0.0').version.package).toEqual(createDesignSystemVersion(pkg).package);
    expect(service.versions('other').versions).toEqual([]);
    expect(() => service.version('other', 'acme', '1.0.0')).toThrow('not in this project');
    let state = service.activateDependency('project', activation(1));
    expect(state.document).toBeNull();
    expect(state.lock.dependencies[0]?.source.digest).toBe(imported.version.sourceDigest);
    expect(service.resolveDependency('project').resolution.ok).toBe(true);
    expect(service.resolveDocument('project').resolution.document?.screens).toEqual([]);
    state = service.saveDocument('project', { expectedRevision: state.revision, document });
    state = service.unbind('project', state.bindings.bindings[0]!.id, { expectedRevision: state.revision });
    state = service.activateDependency('project', activation(state.revision));
    expect(state.bindings.bindings[0]?.status).toBe('unbound');
    expect(service.version('project', 'acme', '1.0.0').version.package.bindings.bindings[0]?.status).toBe('bound');
    await expect(service.compile('project', { expectedRevision: state.revision, designSystemId: 'acme', selections: [{ sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'Button', codeComponentId: 'ui/Button' }] })).rejects.toMatchObject({ code: 'DESIGN_RUNTIME_REGISTRY_LOCKED' });
    expect(readSource).not.toHaveBeenCalled();
    const published = service.importVersion('project', { expectedRevision: state.revision, package: packageFixture('1.1.0') });
    expect(() => service.activateDependency('project', activation(published.state.revision, '1.1.0'))).toThrow('reviewed');
    expect(store.read('project')).toEqual(published.state);
    state = service.clearDependency('project', { expectedRevision: published.state.revision });
    expect(state.registry).toEqual(pkg.registry);
    expect(state.document).toEqual(document);
    expect(state.lock.dependencies).toEqual([]);
  });

  it('requires matching working metadata and compatible project content before initial pinning', () => {
    const { service, store, pkg } = setup();
    let state = service.importVersion('project', { expectedRevision: 0, package: pkg }).state;
    state = store.write('project', state.revision, { ...state, registry: pkg.registry, codeIndex: { ...pkg.codeIndex, id: 'project' }, bindings: { ...pkg.bindings, id: 'project' } });
    const different = structuredClone(state);
    different.registry!.components[0]!.name = 'Different';
    state = store.write('project', state.revision, different);
    expect(() => service.activateDependency('project', activation(state.revision))).toThrow('same working');
    expect(store.read('project')).toEqual(state);
    state = store.write('project', state.revision, { ...state, registry: pkg.registry });
    const badRange = { ...activation(state.revision), range: '^2.0.0' };
    expect(() => service.activateDependency('project', badRange)).toThrow('cannot be verified');
    expect(store.read('project')).toEqual(state);
    expect(service.activateDependency('project', activation(state.revision)).registry).toEqual(pkg.registry);
  });

  it('uses frozen registry after mutable source/working metadata changes and diagnoses missing or tampered bytes everywhere', () => {
    const { service, store, pkg, readSource } = setup();
    service.importVersion('project', { expectedRevision: 0, package: pkg });
    let state = service.activateDependency('project', activation(1));
    readSource.mockResolvedValue('export function Different() {}');
    const changed = structuredClone(state);
    changed.registry!.components = [];
    state = store.write('project', state.revision, changed);
    expect(service.validateDocument('project', { document }).resolution.document).not.toBeNull();
    expect(service.get('project').registry).toEqual(pkg.registry);
    expect(readSource).not.toHaveBeenCalled();
    const saved = store.readVersion('project', 'acme', '1.0.0')!;
    const tampered = structuredClone(saved);
    tampered.package.source.files[0]!.content += 'tampered';
    db.prepare('UPDATE project_design_system_versions SET version_json = ? WHERE project_id = ?').run(JSON.stringify(tampered), 'project');
    const failed = service.resolveDependency('project').resolution;
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics.length).toBeGreaterThan(0);
    const calls = [
      () => service.get('project'), () => service.resolveDocument('project'),
      () => service.validateDocument('project', { document }), () => service.references('project', 'ds:acme/Button'),
      () => service.projectComponents('project'), () => service.inspectComponentChange('project', 'draft'),
      () => service.saveDocument('project', { expectedRevision: state.revision, document }),
      () => service.stageComponent('project', { expectedRevision: state.revision, draftId: 'draft', expectedDefinitionRevision: 0, definition: { schemaVersion: 1, id: 'Label', name: 'Label', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, type: 'text', id: 'text', text: 'Hello' } } }),
    ];
    calls.forEach((call) => expect(call).toThrow('cannot be verified'));
    expect(store.read('project')).toEqual(state);
    db.prepare('DELETE FROM project_design_system_versions WHERE project_id = ?').run('project');
    expect(service.resolveDependency('project').resolution.diagnostics[0]?.code).toBe('ODDS5003');
    expect(() => service.resolveDocument('project')).toThrow('cannot be verified');
    expect(service.clearDependency('project', { expectedRevision: state.revision }).lock.dependencies).toEqual([]);
  });

  it('publishes only explicitly selected sources, preserves locked author metadata, and rolls back asynchronous CAS races', async () => {
    const { service, store, pkg, readSource } = setup();
    service.importVersion('project', { expectedRevision: 0, package: pkg });
    const state = service.activateDependency('project', activation(1));
    const request = { expectedRevision: state.revision, name: 'Acme UI', version: '1.1.0', sourcePaths: ['src/Button.tsx'] };
    const published = await service.publishCurrent('project', request);
    expect(readSource.mock.calls).toEqual([['project', 'src/Button.tsx'], ['project', 'src/Button.tsx']]);
    const version = service.version('project', 'acme', '1.1.0').version;
    expect(version.package.tokens).toEqual(pkg.tokens);
    expect(version.package.patterns).toEqual(pkg.patterns);
    expect(version.package.constraints).toEqual(pkg.constraints);
    expect(version.package.source).toEqual(createDesignSystemVersion(pkg).package.source);
    expect(published.state.lock.dependencies[0]?.version).toBe('1.0.0');
    readSource.mockClear();
    await expect(service.publishCurrent('project', { ...request, expectedRevision: published.state.revision, sourcePaths: ['src/Button.tsx', 'src/Button.tsx'] })).rejects.toThrow();
    expect(readSource).not.toHaveBeenCalled();
    let release!: (source: string) => void;
    readSource.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = service.publishCurrent('project', { ...request, expectedRevision: published.state.revision, version: '1.2.0' });
    const newer = store.write('project', published.state.revision, published.state);
    release(pkg.source.files.find((entry) => entry.path === 'src/Button.tsx')!.content);
    await expect(pending).rejects.toMatchObject({ expectedRevision: published.state.revision, currentRevision: newer.revision });
    expect(store.readVersion('project', 'acme', '1.2.0')).toBeNull();
    expect(store.read('project')).toEqual(newer);
  });

  it('keeps aggregate and catalog unchanged after immutable or invalid source publication', async () => {
    const { service, store, pkg, readSource } = setup();
    let state: ProjectDesignRuntimeState = service.importVersion('project', { expectedRevision: 0, package: pkg }).state;
    const bytes = store.readVersion('project', 'acme', '1.0.0');
    expect(() => service.importVersion('project', { expectedRevision: state.revision, package: { ...pkg, name: 'Overwritten' } })).toThrow('immutable');
    expect(store.read('project')).toEqual(state);
    expect(store.readVersion('project', 'acme', '1.0.0')).toEqual(bytes);
    state = service.activateDependency('project', activation(state.revision));
    readSource.mockResolvedValue('export function Different() {}');
    await expect(service.publishCurrent('project', { expectedRevision: state.revision, name: 'Acme', version: '1.2.0', sourcePaths: ['src/Button.tsx'] })).rejects.toThrow();
    expect(store.read('project')).toEqual(state);
    expect(store.readVersion('project', 'acme', '1.2.0')).toBeNull();
  });
});
