import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import {
  ProjectDesignRuntimeStateSchema,
  DesignSystemVersionSchema,
  type DesignSystemVersion,
  type ProjectDesignRuntimeVersionSummary,
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

export class DesignRuntimeImmutableVersionError extends Error {
  constructor(readonly designSystemId: string, readonly version: string) {
    super(`Published version ${designSystemId}@${version} is immutable.`);
    this.name = 'DesignRuntimeImmutableVersionError';
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
    CREATE TABLE IF NOT EXISTS project_design_system_versions (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      design_system_id TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      digest TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      version_json TEXT NOT NULL,
      PRIMARY KEY (project_id, design_system_id, version)
    );
  `);
}

export interface DesignRuntimeStore {
  read(projectId: string): ProjectDesignRuntimeState;
  listVersions(projectId: string): ProjectDesignRuntimeVersionSummary[];
  readVersion(projectId: string, designSystemId: string, version: string): DesignSystemVersion | null;
  write(projectId: string, expectedRevision: number, state: ProjectDesignRuntimeState, versions?: readonly DesignSystemVersion[]): ProjectDesignRuntimeState;
}

export function createDesignRuntimeStore(db: Database.Database): DesignRuntimeStore {
  const projectExists = db.prepare('SELECT id FROM projects WHERE id = ?');
  const select = db.prepare('SELECT revision, state_json FROM project_design_runtime WHERE project_id = ?');
  const insert = db.prepare('INSERT INTO project_design_runtime (project_id, revision, state_json) VALUES (?, ?, ?)');
  const update = db.prepare('UPDATE project_design_runtime SET revision = ?, state_json = ? WHERE project_id = ? AND revision = ?');

  const selectVersion = db.prepare('SELECT version_json FROM project_design_system_versions WHERE project_id = ? AND design_system_id = ? AND version = ?');
  const selectVersions = db.prepare('SELECT design_system_id AS id, name, version, digest, source_digest AS sourceDigest FROM project_design_system_versions WHERE project_id = ? ORDER BY design_system_id COLLATE BINARY, version COLLATE BINARY');
  const insertVersion = db.prepare('INSERT INTO project_design_system_versions (project_id, design_system_id, version, name, digest, source_digest, version_json) VALUES (?, ?, ?, ?, ?, ?, ?)');

  function requireProject(projectId: string): void {
    if (!projectExists.get(projectId)) throw new DesignRuntimeProjectNotFoundError();
  }
  function listVersions(projectId: string): ProjectDesignRuntimeVersionSummary[] {
    requireProject(projectId);
    return selectVersions.all(projectId) as ProjectDesignRuntimeVersionSummary[];
  }
  function readVersion(projectId: string, designSystemId: string, version: string): DesignSystemVersion | null {
    requireProject(projectId);
    const row = selectVersion.get(projectId, designSystemId, version) as { version_json: string } | undefined;
    // Verification stays in the shared package evaluator, including diagnostics for malformed content.
    return row ? JSON.parse(row.version_json) as DesignSystemVersion : null;
  }

  function read(projectId: string): ProjectDesignRuntimeState {
    requireProject(projectId);
    const row = select.get(projectId) as { revision: number; state_json: string } | undefined;
    const additions = {
      projectComponents: { schemaVersion: 1, id: projectId, components: [] },
      document: null,
      sharedChanges: { schemaVersion: 1, id: projectId, drafts: [], history: [] },
    };
    const dependencyAdditions = {
      dependencies: { schemaVersion: 1, id: projectId, dependencies: [] },
      lock: { schemaVersion: 1, id: projectId, dependencies: [] },
    };
    const persisted: unknown = row ? JSON.parse(row.state_json) : {
      schemaVersion: 1,
      revision: 0,
      registry: null,
      codeIndex: { schemaVersion: 1, id: projectId, components: [] },
      projectCodeIndex: { schemaVersion: 1, id: projectId, components: [] },
      bindings: { schemaVersion: 1, id: projectId, bindings: [] },
      ...additions,
      ...dependencyAdditions,
    };
    // Only the complete legacy shape receives additive defaults. Partial new snapshots remain errors.
    const legacy = persisted !== null && typeof persisted === 'object' && !Array.isArray(persisted)
      && ['projectComponents', 'document', 'sharedChanges'].every((key) => !Object.hasOwn(persisted, key));
    const inherited = legacy ? { ...persisted, ...additions } : persisted;
    const legacyDependencies = inherited !== null && typeof inherited === 'object' && !Array.isArray(inherited)
      && ['dependencies', 'lock'].every((key) => !Object.hasOwn(inherited, key));
    const withDependencies = legacyDependencies ? { ...inherited, ...dependencyAdditions } : inherited;
    const legacyProjectCode = withDependencies !== null && typeof withDependencies === 'object' && !Array.isArray(withDependencies) && !Object.hasOwn(withDependencies, 'projectCodeIndex');
    const withProjectCode = legacyProjectCode ? { ...withDependencies, projectCodeIndex: { schemaVersion: 1, id: projectId, components: [] } } : withDependencies;
    const state = ProjectDesignRuntimeStateSchema.parse(withProjectCode);
    if (state.codeIndex.id !== projectId || state.projectCodeIndex.id !== projectId || state.bindings.id !== projectId || state.projectComponents.id !== projectId || state.sharedChanges.id !== projectId || state.dependencies.id !== projectId || state.lock.id !== projectId || (row && state.revision !== row.revision)) {
      throw new Error('Persisted design runtime identity or revision is inconsistent.');
    }
    return state;
  }

  const write = db.transaction((projectId: string, expectedRevision: number, state: ProjectDesignRuntimeState, versions: readonly DesignSystemVersion[] = []) => {
    const current = read(projectId);
    if (current.revision !== expectedRevision) {
      throw new DesignRuntimeRevisionConflictError(expectedRevision, current.revision);
    }
    const next = ProjectDesignRuntimeStateSchema.parse({ ...state, revision: expectedRevision + 1 });
    if (next.codeIndex.id !== projectId || next.projectCodeIndex.id !== projectId || next.bindings.id !== projectId || next.projectComponents.id !== projectId || next.sharedChanges.id !== projectId || next.dependencies.id !== projectId || next.lock.id !== projectId) {
      throw new Error('Design runtime state must belong to its project.');
    }
    for (const input of versions) {
      const version = DesignSystemVersionSchema.parse(input);
      const previous = readVersion(projectId, version.package.id, version.package.version);
      if (previous && !isDeepStrictEqual(previous, version)) throw new DesignRuntimeImmutableVersionError(version.package.id, version.package.version);
      if (!previous) insertVersion.run(projectId, version.package.id, version.package.version, version.package.name, version.digest, version.sourceDigest, JSON.stringify(version));
    }
    if (current.revision === 0) {
      insert.run(projectId, next.revision, JSON.stringify(next));
    } else {
      const result = update.run(next.revision, JSON.stringify(next), projectId, expectedRevision);
      if (result.changes !== 1) throw new DesignRuntimeRevisionConflictError(expectedRevision, read(projectId).revision);
    }
    return next;
  });
  return { read, listVersions, readVersion, write: (projectId, expectedRevision, state, versions) => write.immediate(projectId, expectedRevision, state, versions) };
}
