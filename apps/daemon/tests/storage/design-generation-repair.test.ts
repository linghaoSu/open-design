import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDesignRepairTurnV1, serializeDesignRepairTurnV1 } from '@open-design/contracts';
import { createDesignGenerationStore } from '../../src/storage/design-generation-store.js';
import { generationExecutionFixture, generationReportFixture } from '../fixtures/design-runtime/design-generation.js';

let db: Database.Database;
afterEach(() => { db?.close(); });
function fixture() {
  db = new Database(':memory:'); db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
  const store = createDesignGenerationStore(db); const first = store.create(generationExecutionFixture());
  const initial = store.update(0, { ...first, report: { ...generationReportFixture(first), decision: 'repair_required' } });
  const text = serializeDesignRepairTurnV1({ executionId: initial.id, sourceRunId: initial.latestRunId, policy: initial.policy, report: initial.report!, strategy: null });
  const input = { executionId: initial.id, sourceRunId: initial.latestRunId, runId: 'repair-run', finalText: text };
  return { store, initial, input };
}
describe('single durable host design repair claim', () => {
  it('atomically claims one physical successor with original report, policy and baseline through reopen', () => {
    const { store, initial, input } = fixture(); const repair = store.claimRepair(initial.revision, input);
    expect(repair).toMatchObject({ attempt: 1, latestRunId: 'repair-run', baseline: initial.baseline, policy: initial.policy, report: null,
      repair: { sourceRunId: initial.latestRunId, sourceReport: { attempt: 0, decision: 'repair_required' } } });
    expect(parseDesignRepairTurnV1(repair.repair!.finalText).invocationKind).toBe('design_repair');
    const reopened = createDesignGenerationStore(db); expect(reopened.forRun(initial.latestRunId)).toEqual(repair); expect(reopened.forRun('repair-run')).toEqual(repair);
    expect(() => reopened.claimRepair(initial.revision, input)).toThrow();
    expect(() => reopened.update(repair.revision, { ...repair, attempt: 0 })).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM design_generation_runs').get()).toEqual({ n: 2 });
  });
  it('rejects changed policy/report text before claiming any child', () => {
    const { store, initial, input } = fixture(); const envelope = parseDesignRepairTurnV1(input.finalText);
    const changed = serializeDesignRepairTurnV1({ ...envelope, report: { ...envelope.report, projectRevision: 99 } });
    expect(() => store.claimRepair(initial.revision, { ...input, finalText: changed })).toThrow('exact frozen');
    expect(store.forRun(input.runId)).toBeNull(); expect(store.read(initial.id)?.attempt).toBe(0);
    expect(() => store.claimRepair(initial.revision, { ...input, finalText: ` ${input.finalText}` })).toThrow('canonical');
  });
  it('fails closed on tampered durable envelope bytes and never silently regenerates the turn', () => {
    const { store, initial, input } = fixture(); const repair = store.claimRepair(initial.revision, input);
    const corrupt = { ...repair, repair: { ...repair.repair!, finalText: `${repair.repair!.finalText} ` } };
    db.prepare('UPDATE design_generation_executions SET execution_json=? WHERE id=?').run(JSON.stringify(corrupt), repair.id);
    expect(() => createDesignGenerationStore(db).forRun('repair-run')).toThrow('canonical');
  });
});
