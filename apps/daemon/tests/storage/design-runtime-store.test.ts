import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/db.js';
import {
  createDesignRuntimeStore,
  DesignRuntimeProjectNotFoundError,
  DesignRuntimeRevisionConflictError,
  migrateDesignRuntimeStore,
} from '../../src/storage/design-runtime-store.js';

describe('design runtime SQLite persistence', () => {
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
      const { projectComponents: _components, document: _document, sharedChanges: _changes, ...legacy } = store.read('project');
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
      expect(() => reopened.write('project', 1, { ...written, codeIndex: { ...written.codeIndex, id: 'other' }, bindings: { ...written.bindings, id: 'other' }, projectComponents: { ...written.projectComponents, id: 'other' }, sharedChanges: { ...written.sharedChanges, id: 'other' } })).toThrow('belong');
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
