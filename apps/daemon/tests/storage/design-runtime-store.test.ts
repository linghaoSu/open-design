import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageFixture } from '../fixtures/design-runtime/design-system-version.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../src/services/design-runtime/design-system-version.js';
import { closeDatabase, openDatabase } from '../../src/db.js';
import {
  createDesignRuntimeStore,
  DesignRuntimeProjectNotFoundError,
  DesignRuntimeRevisionConflictError,
  migrateDesignRuntimeStore,
} from '../../src/storage/design-runtime-store.js';

describe('design runtime SQLite persistence', () => {
  it('backfills project ownership without rewriting historical state, revision or immutable version bytes', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON'); db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');"); migrateDesignRuntimeStore(db);
      const store = createDesignRuntimeStore(db); const version = createDesignSystemVersion(packageFixture());
      const saved = store.write('project', 0, store.read('project'), [version]);
      const { projectCodeIndex: _projectCode, authoringBase: _authoringBase, ...legacy } = saved;
      const bytes = JSON.stringify(legacy); db.prepare('UPDATE project_design_runtime SET state_json = ? WHERE project_id = ?').run(bytes, 'project');
      const catalog = db.prepare('SELECT version_json FROM project_design_system_versions').get();
      expect(store.read('project')).toEqual(saved);
      expect(db.prepare('SELECT revision, state_json FROM project_design_runtime').get()).toEqual({ revision: 1, state_json: bytes });
      expect(db.prepare('SELECT version_json FROM project_design_system_versions').get()).toEqual(catalog);
      expect(store.readVersion('project', 'acme', '1.0.0')).toEqual(version);
      db.prepare('UPDATE project_design_runtime SET state_json = ?').run(JSON.stringify({ ...legacy, projectCodeIndex: null }));
      expect(() => store.read('project')).toThrow();
    } finally { db.close(); }
  });
  it('is migrated by the production daemon database lifecycle', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-design-runtime-migration-'));
    try {
      const db = openDatabase(dir, { dataDir: dir });
      db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('project', 'Project', 1, 1);
      const store = createDesignRuntimeStore(db);
      store.write('project', 0, store.read('project'));
      closeDatabase();
      expect(createDesignRuntimeStore(openDatabase(dir, { dataDir: dir })).read('project').revision).toBe(1);
    } finally {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds legacy fields on read without rewriting or advancing revision until successful CAS', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
      migrateDesignRuntimeStore(db);
      const store = createDesignRuntimeStore(db);
      const { projectComponents: _components, document: _document, sharedChanges: _changes, dependencies: _dependencies, lock: _lock, ...legacy } = store.read('project');
      legacy.revision = 7;
      const original = JSON.stringify(legacy);
      db.prepare('INSERT INTO project_design_runtime VALUES (?, ?, ?)').run('project', 7, original);
      const upgraded = store.read('project');
      expect(upgraded).toMatchObject({ revision: 7, document: null, projectComponents: { id: 'project', components: [] }, sharedChanges: { id: 'project', drafts: [], history: [] } });
      expect(db.prepare('SELECT state_json FROM project_design_runtime').get()).toEqual({ state_json: original });
      expect(() => store.write('project', 6, upgraded)).toThrow(DesignRuntimeRevisionConflictError);
      expect(db.prepare('SELECT state_json FROM project_design_runtime').get()).toEqual({ state_json: original });
      const written = store.write('project', 7, upgraded);
      expect(written.revision).toBe(8);
      expect(JSON.parse((db.prepare('SELECT state_json FROM project_design_runtime').get() as { state_json: string }).state_json)).toEqual(written);
      db.prepare('UPDATE project_design_runtime SET state_json = ?, revision = 7').run(JSON.stringify({ ...legacy, document: null }));
      expect(() => store.read('project')).toThrow();
    } finally { db.close(); }
  });

  it('reopens aggregate state, rejects stale revisions, and cascades project deletion', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-design-runtime-store-'));
    let db = new Database(path.join(dir, 'state.sqlite'));
    try {
      db.pragma('foreign_keys = ON');
      db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
      migrateDesignRuntimeStore(db);
      const store = createDesignRuntimeStore(db);
      const initial = store.read('project');
      expect(initial).toMatchObject({ revision: 0, registry: null });
      const definition = { schemaVersion: 1 as const, id: 'Label', name: 'Label', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1 as const, type: 'text' as const, id: 'label-text', text: 'Saved' } };
      const written = store.write('project', 0, {
        ...initial,
        projectComponents: { ...initial.projectComponents, components: [definition] },
        document: { schemaVersion: 1, id: 'design', screens: [{ schemaVersion: 1, type: 'screen', id: 'screen', children: [{ schemaVersion: 1, type: 'instance', id: 'label', ref: 'local:Label', overrides: [] }] }] },
        sharedChanges: { ...initial.sharedChanges, history: [{ schemaVersion: 1, componentRef: 'local:Label', definition, changeId: 'created' }] },
      });
      expect(written.revision).toBe(1);
      expect(() => store.write('project', 0, initial)).toThrow(DesignRuntimeRevisionConflictError);
      expect(() => store.write('missing', 0, initial)).toThrow(DesignRuntimeProjectNotFoundError);
      db.close();
      db = new Database(path.join(dir, 'state.sqlite'));
      db.pragma('foreign_keys = ON');
      migrateDesignRuntimeStore(db);
      const reopened = createDesignRuntimeStore(db);
      expect(reopened.read('project')).toEqual(written);
      expect(() => reopened.write('project', 1, { ...written, codeIndex: { ...written.codeIndex, id: 'other' }, projectCodeIndex: { ...written.projectCodeIndex, id: 'other' }, bindings: { ...written.bindings, id: 'other' }, projectComponents: { ...written.projectComponents, id: 'other' }, sharedChanges: { ...written.sharedChanges, id: 'other' }, dependencies: { ...written.dependencies, id: 'other' }, lock: { ...written.lock, id: 'other' } })).toThrow('belong');
      expect(reopened.read('project')).toEqual(written);
      db.prepare('DELETE FROM projects WHERE id = ?').run('project');
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_design_runtime').get()).toEqual({ count: 0 });
      expect(() => reopened.read('project')).toThrow(DesignRuntimeProjectNotFoundError);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('project version catalog transactions', () => {
  it('reopens exact bytes and lock, isolates project catalogs, and rolls back catalog insertion with failed CAS/immutability', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-design-version-store-'));
    let db = new Database(path.join(dir, 'state.sqlite'));
    try {
      db.pragma('foreign_keys = ON');
      db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project'), ('other');");
      migrateDesignRuntimeStore(db);
      let store = createDesignRuntimeStore(db);
      const version = createDesignSystemVersion(packageFixture());
      const initial = store.read('project');
      const next = { ...initial, registry: version.package.registry,
        codeIndex: { ...version.package.codeIndex, id: 'project' }, bindings: { ...version.package.bindings, id: 'project' },
        dependencies: { ...initial.dependencies, dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] },
        lock: createProjectDesignSystemLock('project', [version]),
      };
      const written = store.write('project', 0, next, [version]);
      const nextVersion = createDesignSystemVersion(packageFixture('1.1.0'));
      expect(() => store.write('project', 0, next, [nextVersion])).toThrow(DesignRuntimeRevisionConflictError);
      expect(store.readVersion('project', 'acme', '1.1.0')).toBeNull();
      const conflicting = createDesignSystemVersion({ ...version.package, name: 'Changed' });
      expect(() => store.write('project', 1, written, [nextVersion, conflicting])).toThrow('immutable');
      expect(store.readVersion('project', 'acme', '1.1.0')).toBeNull();
      expect(store.read('project')).toEqual(written);
      expect(store.readVersion('other', 'acme', '1.0.0')).toBeNull();
      db.close();
      db = new Database(path.join(dir, 'state.sqlite'));
      db.pragma('foreign_keys = ON');
      migrateDesignRuntimeStore(db);
      store = createDesignRuntimeStore(db);
      expect(store.read('project')).toEqual(written);
      expect(store.readVersion('project', 'acme', '1.0.0')).toEqual(version);
      expect(JSON.stringify(store.listVersions('project'))).not.toContain('return null');
      db.prepare('DELETE FROM projects WHERE id = ?').run('project');
      expect(db.prepare('SELECT COUNT(*) AS count FROM project_design_system_versions').get()).toEqual({ count: 0 });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('adds dependency fields to Phase4/5 rows only as a complete pair, preserving revision until CAS', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
      migrateDesignRuntimeStore(db);
      const store = createDesignRuntimeStore(db);
      const { dependencies: _dependencies, lock: _lock, ...legacy } = store.read('project');
      legacy.revision = 9;
      const original = JSON.stringify(legacy);
      db.prepare('INSERT INTO project_design_runtime VALUES (?, ?, ?)').run('project', 9, original);
      const state = store.read('project');
      expect(state.dependencies.dependencies).toEqual([]);
      expect(state.lock.dependencies).toEqual([]);
      expect(state.revision).toBe(9);
      expect(db.prepare('SELECT state_json FROM project_design_runtime').get()).toEqual({ state_json: original });
      expect(() => store.write('project', 8, state)).toThrow(DesignRuntimeRevisionConflictError);
      expect(store.write('project', 9, state).revision).toBe(10);
      db.prepare('UPDATE project_design_runtime SET state_json = ?, revision = 9').run(JSON.stringify({ ...legacy, lock: state.lock }));
      expect(() => store.read('project')).toThrow();
    } finally { db.close(); }
  });
});

describe('generation target storage migration', () => {
  it('adds only missing targets on read, preserves bytes and revision, then persists canonical targets across reopen', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-generation-targets-')); const file = path.join(dir, 'state.sqlite'); let db = new Database(file);
    try {
      db.pragma('foreign_keys = ON'); db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');"); migrateDesignRuntimeStore(db);
      let store = createDesignRuntimeStore(db); const current = store.write('project', 0, store.read('project'));
      const { generationTargets: _targets, ...legacy } = current; const bytes = JSON.stringify(legacy);
      db.prepare('UPDATE project_design_runtime SET state_json = ?').run(bytes);
      expect(store.read('project')).toEqual(current); expect(db.prepare('SELECT state_json, revision FROM project_design_runtime').get()).toEqual({ state_json: bytes, revision: 1 });
      expect(() => store.write('project', 0, current)).toThrow(DesignRuntimeRevisionConflictError);
      expect(db.prepare('SELECT state_json FROM project_design_runtime').get()).toEqual({ state_json: bytes });
      for (const generationTargets of [null, { schemaVersion: 1 }, { schemaVersion: 1, outputs: [{ sourcePath: '../outside' }] }]) {
        db.prepare('UPDATE project_design_runtime SET state_json = ?').run(JSON.stringify({ ...legacy, generationTargets })); expect(() => store.read('project')).toThrow();
      }
      db.prepare('UPDATE project_design_runtime SET state_json = ?').run(bytes);
      const saved = store.write('project', 1, { ...store.read('project'), generationTargets: { schemaVersion: 1, outputs: [{ sourcePath: 'future/New.tsx', exportName: 'New', screenId: 'new-screen' }] } });
      db.close(); db = new Database(file); db.pragma('foreign_keys = ON'); migrateDesignRuntimeStore(db); store = createDesignRuntimeStore(db);
      expect(store.read('project')).toEqual(saved); expect(saved.revision).toBe(2); expect(saved.document).toBeNull();
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
