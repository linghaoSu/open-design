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
    expect(readSource).toHaveBeenCalledExactlyOnceWith('project', 'src/Button.tsx');
    const version = service.version('project', 'acme', '1.1.0').version;
    expect(version.package.tokens).toEqual(pkg.tokens);
    expect(version.package.patterns).toEqual(pkg.patterns);
    expect(version.package.constraints).toEqual(pkg.constraints);
    expect(version.package.source.files).toHaveLength(1);
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
