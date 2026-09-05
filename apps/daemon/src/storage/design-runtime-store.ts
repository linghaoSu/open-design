import type Database from 'better-sqlite3';
import {
  ProjectDesignRuntimeStateSchema,
  type ProjectDesignRuntimeState,
} from '@open-design/contracts';

export class DesignRuntimeRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly currentRevision: number) {
    super('Design runtime changed; refresh the project state before applying this change.');
    this.name = 'DesignRuntimeRevisionConflictError';
  }
}

export class DesignRuntimeProjectNotFoundError extends Error {
  constructor() {
    super('Project not found.');
    this.name = 'DesignRuntimeProjectNotFoundError';
  }
}

/** Uses the daemon database already opened from the resolved runtime data root. */
export function migrateDesignRuntimeStore(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_design_runtime (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      state_json TEXT NOT NULL
    );
  `);
}

export interface DesignRuntimeStore {
  read(projectId: string): ProjectDesignRuntimeState;
  write(projectId: string, expectedRevision: number, state: ProjectDesignRuntimeState): ProjectDesignRuntimeState;
}

export function createDesignRuntimeStore(db: Database.Database): DesignRuntimeStore {
  const projectExists = db.prepare('SELECT id FROM projects WHERE id = ?');
  const select = db.prepare('SELECT revision, state_json FROM project_design_runtime WHERE project_id = ?');
  const insert = db.prepare('INSERT INTO project_design_runtime (project_id, revision, state_json) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE project_design_runtime SET revision = ?, state_json = ? WHERE project_id = ? AND revision = ?');

  function read(projectId: string): ProjectDesignRuntimeState {
    if (!projectExists.get(projectId)) throw new DesignRuntimeProjectNotFoundError();
    const row = select.get(projectId) as { revision: number; state_json: string } | undefined;
    const state = ProjectDesignRuntimeStateSchema.parse(row ? JSON.parse(row.state_json) : {
      schemaVersion: 1,
      revision: 0,
      registry: null,
      codeIndex: { schemaVersion: 1, id: projectId, components: [] },
      bindings: { schemaVersion: 1, id: projectId, bindings: [] },
    });
    if (state.codeIndex.id !== projectId || state.bindings.id !== projectId || (row && state.revision !== row.revision)) {
      throw new Error('Persisted design runtime identity or revision is inconsistent.');
    }
    return state;
  }

  const write = db.transaction((projectId: string, expectedRevision: number, state: ProjectDesignRuntimeState) => {
    const current = read(projectId);
    if (current.revision !== expectedRevision) {
      throw new DesignRuntimeRevisionConflictError(expectedRevision, current.revision);
    }
    const next = ProjectDesignRuntimeStateSchema.parse({ ...state, revision: expectedRevision + 1 });
    if (next.codeIndex.id !== projectId || next.bindings.id !== projectId) {
      throw new Error('Design runtime state must belong to its project.');
    }
    if (current.revision === 0) {
      insert.run(projectId, next.revision, JSON.stringify(next));
    } else {
      const result = update.run(next.revision, JSON.stringify(next), projectId, expectedRevision);
      if (result.changes !== 1) throw new DesignRuntimeRevisionConflictError(expectedRevision, read(projectId).revision);
    }
    return next;
  });
  return { read, write: (projectId, expectedRevision, state) => write.immediate(projectId, expectedRevision, state) };
}
