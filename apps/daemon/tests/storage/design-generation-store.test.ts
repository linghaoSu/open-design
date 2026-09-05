import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesignGenerationStore } from '../../src/storage/design-generation-store.js';
import { generationExecutionFixture, generationReportFixture } from '../fixtures/design-runtime/design-generation.js';

let db: Database.Database;
afterEach(() => db?.close());
function setup() {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
  return createDesignGenerationStore(db);
}
describe('durable design generation execution', () => {
  it('rehydrates frozen policy, baseline and report with every physical Run mapped to one execution', () => {
    const store = setup(); const first = store.create(generationExecutionFixture());
    const production = store.update(0, { ...first, latestRunId: 'run-production' });
    expect(store.forRun('run-first')).toEqual(production); expect(store.forRun('run-production')).toEqual(production);
    const finished = store.update(1, { ...production, status: 'terminal', report: generationReportFixture(production) });
    const reopened = createDesignGenerationStore(db);
    expect(reopened.forRun('run-first')).toEqual(finished);
    expect(() => reopened.update(2, { ...finished, status: 'active', report: null })).toThrow('stale Run');
  });
  it('rejects stale duplicate claims and immutable policy/baseline/attempt rewrites', () => {
    const store = setup(); const first = store.create(generationExecutionFixture());
    for (const changed of [
      { ...first, policy: { ...first.policy, mode: 'explore' as const } },
      { ...first, attempt: 1 as const }, { ...first, semanticDigest: `sha256:${'a'.repeat(64)}` },
    ]) expect(() => store.update(0, changed)).toThrow('cannot be rewritten');
    store.update(0, { ...first, latestRunId: 'run-production' });
    expect(() => store.update(0, { ...first, latestRunId: 'run-duplicate' })).toThrow('stale Run');
    expect(store.forRun('run-duplicate')).toBeNull();
  });
  it('rejects malformed persisted report authority instead of trusting a ready flag', () => {
    const store = setup(); const first = store.create(generationExecutionFixture());
    expect(() => store.update(0, { ...first, status: 'terminal', report: { ...generationReportFixture(first), runId: 'foreign-run' } })).toThrow('must match');
    expect(() => store.update(0, { ...first, status: 'terminal', report: { ...generationReportFixture(first), mode: 'explore', decision: 'advisory' } })).toThrow('must match');
    expect(() => store.update(0, { ...first, status: 'terminal', report: { ...generationReportFixture(first), inventory: { ...generationReportFixture(first).inventory, baselineDigest: `sha256:${'b'.repeat(64)}` } } })).toThrow('must match');
    const corrupted = { ...first, report: { ...generationReportFixture(first), decision: 'accepted' } };
    db.prepare('UPDATE design_generation_executions SET execution_json = ? WHERE id = ?').run(JSON.stringify(corrupted), first.id);
    expect(() => store.read(first.id)).toThrow('Accepted delivery');
  });
});
