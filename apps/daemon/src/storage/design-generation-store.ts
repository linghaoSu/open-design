import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { DesignGenerationExecutionSchema, parseDesignRepairTurnV1, type DesignGenerationExecution } from '@open-design/contracts';

export class DesignGenerationConflictError extends Error {
  constructor(message = 'Design generation execution changed; a stale Run cannot accept delivery.') { super(message); this.name = 'DesignGenerationConflictError'; }
}
export function migrateDesignGenerationStore(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS design_generation_executions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    latest_run_id TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, execution_json TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS design_generation_runs (
    run_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES design_generation_executions(id) ON DELETE CASCADE
  ); CREATE TABLE IF NOT EXISTS design_generation_project_heads (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL REFERENCES design_generation_executions(id) ON DELETE CASCADE
  ); CREATE TABLE IF NOT EXISTS design_generation_contended (
    execution_id TEXT PRIMARY KEY REFERENCES design_generation_executions(id) ON DELETE CASCADE
  );`);
}
export interface DesignGenerationStore {
  isCurrent(id: string): boolean;
  markContended(runIds: readonly string[]): void;
  read(id: string): DesignGenerationExecution | null;
  forRun(runId: string): DesignGenerationExecution | null;
  create(execution: DesignGenerationExecution): DesignGenerationExecution;
  update(expectedRevision: number, execution: DesignGenerationExecution): DesignGenerationExecution;
  reproveTerminal(expectedRevision: number, execution: DesignGenerationExecution): DesignGenerationExecution;
  claimRepair(expectedRevision: number, input: { executionId: string; sourceRunId: string; runId: string; finalText: string }): DesignGenerationExecution;
}
/** Uses the existing daemon database; no independent data-root or process authority. */
export function createDesignGenerationStore(db: Database.Database): DesignGenerationStore {
  migrateDesignGenerationStore(db);
  const read = (id: string) => {
    const row = db.prepare('SELECT execution_json FROM design_generation_executions WHERE id = ?').get(id) as { execution_json: string } | undefined;
    if (!row) return null;
    const execution = DesignGenerationExecutionSchema.parse(JSON.parse(row.execution_json));
    if (execution.repair) {
      const repair = execution.repair; const envelope = parseDesignRepairTurnV1(repair.finalText);
      if (repair.finalTextDigest !== `sha256:${createHash('sha256').update(repair.finalText).digest('hex')}` || envelope.executionId !== execution.id
        || envelope.sourceRunId !== repair.sourceRunId || JSON.stringify(envelope.policy) !== JSON.stringify(execution.policy)
        || JSON.stringify(envelope.report) !== JSON.stringify(repair.sourceReport)) throw new DesignGenerationConflictError('Persisted repair evidence failed its canonical identity proof.');
    }
    return execution;
  };
  const persist = (expectedRevision: number, input: DesignGenerationExecution, reproveTerminal = false, claimRepair = false) => {
    const execution = DesignGenerationExecutionSchema.parse({ ...input, revision: expectedRevision + 1 });
    return db.transaction(() => {
      const previous = read(execution.id);
      if (!previous || previous.revision !== expectedRevision) throw new DesignGenerationConflictError();
      if (reproveTerminal) {
        if (previous.status !== 'terminal' || !previous.report || !['accepted', 'advisory'].includes(previous.report.decision)
          || execution.status !== 'terminal' || execution.latestRunId !== previous.latestRunId
          || !execution.report || ![previous.report.decision, 'blocked', 'canceled'].includes(execution.report.decision)) throw new DesignGenerationConflictError('Only a terminal success candidate may be re-proved or degraded.');
      } else if (previous.status === 'terminal') throw new DesignGenerationConflictError();
      // No refresh, continuation, or publication reentry may rewrite frozen identity.
      if (claimRepair && (previous.attempt !== 0 || previous.repair || previous.report?.decision !== 'repair_required' || execution.attempt !== 1 || !execution.repair || execution.repair.sourceRunId !== previous.latestRunId || execution.repair.runId !== execution.latestRunId || execution.status !== 'active' || execution.report)) throw new DesignGenerationConflictError('Only one pending initial failure can claim a design repair.');
      if (previous.projectId !== execution.projectId || previous.conversationId !== execution.conversationId || previous.authorityKey !== execution.authorityKey || previous.initialRunId !== execution.initialRunId || JSON.stringify(previous.policy) !== JSON.stringify(execution.policy) || (previous.baselineStatus === 'ready' && (execution.baselineStatus !== 'ready' || JSON.stringify(previous.baseline) !== JSON.stringify(execution.baseline))) || previous.semanticDigest !== execution.semanticDigest || !claimRepair && (previous.attempt !== execution.attempt || JSON.stringify(previous.repair) !== JSON.stringify(execution.repair))) throw new DesignGenerationConflictError('Frozen generation identity and attempt cannot be rewritten.');
      const changed = db.prepare('UPDATE design_generation_executions SET latest_run_id = ?, revision = ?, execution_json = ? WHERE id = ? AND revision = ?').run(execution.latestRunId, execution.revision, JSON.stringify(execution), execution.id, expectedRevision);
      if (changed.changes !== 1) throw new DesignGenerationConflictError();
      if (execution.latestRunId !== previous.latestRunId) db.prepare('INSERT INTO design_generation_runs (run_id, execution_id) VALUES (?, ?)').run(execution.latestRunId, execution.id);
      return execution;
    })();
  };
  return {
    read,
    isCurrent(id) {
      return !!db.prepare('SELECT 1 FROM design_generation_project_heads h WHERE h.execution_id = ? AND NOT EXISTS (SELECT 1 FROM design_generation_contended c WHERE c.execution_id = h.execution_id)').get(id);
    },
    markContended(runIds) {
      db.transaction(() => { for (const runId of runIds) db.prepare('INSERT OR IGNORE INTO design_generation_contended (execution_id) SELECT execution_id FROM design_generation_runs WHERE run_id = ?').run(runId); })();
    },
    forRun(runId) {
      const row = db.prepare('SELECT execution_id FROM design_generation_runs WHERE run_id = ?').get(runId) as { execution_id: string } | undefined;
      return row ? read(row.execution_id) : null;
    },
    create(input) {
      const execution = DesignGenerationExecutionSchema.parse(input);
      if (execution.revision !== 0 || execution.attempt !== 0 || execution.status !== 'active' || execution.report || execution.initialRunId !== execution.latestRunId) throw new DesignGenerationConflictError('A new generation execution must start at attempt zero.');
      return db.transaction(() => {
        db.prepare('INSERT INTO design_generation_executions (id, project_id, latest_run_id, revision, execution_json) VALUES (?, ?, ?, ?, ?)').run(execution.id, execution.projectId, execution.latestRunId, 0, JSON.stringify(execution));
        db.prepare('INSERT INTO design_generation_runs (run_id, execution_id) VALUES (?, ?)').run(execution.initialRunId, execution.id);
        db.prepare('INSERT INTO design_generation_project_heads (project_id, execution_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET execution_id = excluded.execution_id').run(execution.projectId, execution.id);
        return execution;
      })();
    },
    update: (revision, input) => persist(revision, input),
    reproveTerminal: (revision, input) => persist(revision, input, true),
    claimRepair(revision, input) {
      const execution = read(input.executionId);
      if (!execution || execution.latestRunId !== input.sourceRunId || !execution.report || execution.baselineStatus !== 'ready') throw new DesignGenerationConflictError('Repair requires a current initial source report.');
      const envelope = parseDesignRepairTurnV1(input.finalText);
      if (envelope.executionId !== execution.id || envelope.sourceRunId !== input.sourceRunId || JSON.stringify(envelope.policy) !== JSON.stringify(execution.policy) || JSON.stringify(envelope.report) !== JSON.stringify(execution.report)) throw new DesignGenerationConflictError('Repair final text must contain the exact frozen policy and source report.');
      return persist(revision, { ...execution, latestRunId: input.runId, attempt: 1, status: 'active', report: null,
        repair: { schemaVersion: 1, sourceRunId: input.sourceRunId, runId: input.runId, finalText: input.finalText,
          finalTextDigest: `sha256:${createHash('sha256').update(input.finalText).digest('hex')}`, sourceReport: execution.report } }, false, true);
    },
  };
}
