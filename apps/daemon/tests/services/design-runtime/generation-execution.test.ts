import Database from 'better-sqlite3';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../../src/storage/design-runtime-store.js';
import { createDesignGenerationStore } from '../../../src/storage/design-generation-store.js';
import { createDesignGenerationService } from '../../../src/services/design-runtime/generation-execution.js';
import { captureGenerationInventory } from '../../../src/services/design-runtime/generation-inventory.js';
import { validationFixture } from '../../fixtures/design-runtime/validation-benchmark.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-generation-execution-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const db = new Database(':memory:'); cleanup.push(() => { db.close(); });
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');"); migrateDesignRuntimeStore(db);
  const state = createDesignRuntimeStore(db); const executions = createDesignGenerationStore(db);
  const authority = { projectId: 'project', conversationId: 'conversation', scope: 'account-workspace' };
  let captureHook: (() => void) | undefined;
  const service = createDesignGenerationService({ state, executions, root: () => root, currentScope: () => authority.scope,
    observeTargetPackages: async () => [], capture: async (directory) => { captureHook?.(); return captureGenerationInventory(directory); } });
  const write = async (name: string, content: string) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  return { root, db, state, executions, authority, service, write, hook: (value: () => void) => { captureHook = value; } };
}
describe('generation execution policy and actual source authority', () => {
  it('keeps unchanged questions inapplicable and does not hide unsupported source behind a question', async () => {
    const f = await fixture(); const current = f.state.read('project'); f.state.write('project', 0, { ...current, validationSettings: { ...current.validationSettings, mode: 'guided' } });
    const first = await f.service.start('question', f.authority); expect(first.baselineStatus).toBe('pending');
    await expect(f.service.complete('question', f.authority, { production: false, canceled: () => false })).rejects.toThrow('baseline');
    await f.service.captureBaseline('question', f.authority);
    const report = await f.service.complete('question', f.authority, { production: false, canceled: () => false });
    expect(report.decision).toBe('not_applicable'); expect(report.validation).toBeNull();
    await f.service.start('writes', f.authority, 'question');
    await f.write('Hidden.svelte', '<button style="color:red">Hidden</button>');
    const changed = await f.service.complete('writes', f.authority, { production: false, canceled: () => false });
    expect(changed).toMatchObject({ decision: 'blocked', inventory: { complete: false, changed: ['Hidden.svelte'] } });
  });
  it('captures current targets and semantic authoring at final validation start', async () => {
    const f = await fixture(); const request = validationFixture('react'); const original = f.state.read('project');
    const { snapshot } = request;
    f.state.write('project', 0, { ...original, registry: snapshot.registry, codeIndex: { ...snapshot.baseCodeIndex, id: 'project' },
      bindings: { ...snapshot.bindings, id: 'project' }, dependencies: { ...snapshot.dependencies, id: 'project' }, lock: { ...snapshot.lock, id: 'project' },
      validationSettings: request.settings }, snapshot.versions);
    // The task begins before its new screen, target and source exist.
    const execution = await f.service.start('build', f.authority); await f.service.captureBaseline('build', f.authority);
    const current = f.state.read('project');
    f.state.write('project', current.revision, { ...current, document: snapshot.document, generationTargets: { schemaVersion: 1, outputs: request.outputs } });
    for (const source of request.sources) await f.write(source.sourcePath, source.sourceText);
    const service = createDesignGenerationService({ state: f.state, executions: f.executions, root: () => f.root, currentScope: () => f.authority.scope,
      observeTargetPackages: async () => request.snapshot.targetPackages });
    const report = await service.complete('build', f.authority, { production: true, canceled: () => false });
    expect(report.diagnostics).toEqual([]); expect(report.validation?.diagnostics).toEqual([]);
    expect(report).toMatchObject({ decision: 'accepted', policyDigest: execution.policy.digest, validation: { strictReady: true } });
  });
  it('blocks a saved mode downgrade made while validation is collecting current bytes', async () => {
    const f = await fixture(); const initial = f.state.read('project'); f.state.write('project', 0, { ...initial, validationSettings: { ...initial.validationSettings, mode: 'strict' } });
    await f.service.start('build', f.authority); await f.service.captureBaseline('build', f.authority);
    f.hook(() => { const current = f.state.read('project'); if (current.validationSettings.mode !== 'explore') f.state.write('project', current.revision, { ...current, validationSettings: { ...current.validationSettings, mode: 'explore' } }); });
    const report = await f.service.complete('build', f.authority, { production: true, canceled: () => false });
    expect(report).toMatchObject({ mode: 'strict', decision: 'blocked', reasonCodes: ['DESIGN_GENERATION_AUTHORITY_CONFLICT'] });
  });
  it('preserves one frozen execution and baseline across a non-final planning edit and production', async () => {
    const f = await fixture(); await f.service.start('plan', f.authority); const baseline = await f.service.captureBaseline('plan', f.authority);
    await f.write('planning.html', '<main>Initial plan</main>');
    expect((await f.service.complete('plan', f.authority, { production: false, retainActive: true, canceled: () => false })).decision).toBe('advisory');
    const production = await f.service.start('production', f.authority, 'plan');
    expect(production.id).toBe(baseline.id); expect(production.baseline).toEqual(baseline.baseline);
    await f.service.captureBaseline('production', f.authority);
    await f.write('index.html', '<main>Final</main>');
    const report = await f.service.complete('production', f.authority, { production: true, canonicalEntry: 'index.html', canceled: () => false });
    expect(report.inventory.changed).toEqual(['index.html', 'planning.html']);
    expect(report.decision).toBe('advisory'); expect(f.executions.forRun('plan')?.status).toBe('terminal');
  });
  it('keeps same-authority concurrent Explore runs advisory while never certifying their attribution', async () => {
    const f = await fixture(); await f.service.start('first', f.authority); await f.service.captureBaseline('first', f.authority);
    await f.service.start('second', { ...f.authority, conversationId: 'other-conversation' });
    f.service.markContended(['first', 'second']);
    await f.service.captureBaseline('second', { ...f.authority, conversationId: 'other-conversation' });
    await f.write('index.html', '<main>Concurrent output</main>');
    for (const [runId, authority] of [['first', f.authority], ['second', { ...f.authority, conversationId: 'other-conversation' }]] as const) {
      const report = await f.service.complete(runId, authority, { production: true, canonicalEntry: 'index.html', canceled: () => false });
      expect(report.decision).toBe('advisory'); expect(report.inventory.complete).toBe(false);
      expect(report.diagnostics.some((issue) => issue.message.includes('Concurrent project writes'))).toBe(true);
    }
  });
  it('never certifies concurrent Guided writers or lets an old physical Run complete a newer logical stage', async () => {
    const f = await fixture(); const current = f.state.read('project');
    f.state.write('project', 0, { ...current, validationSettings: { ...current.validationSettings, mode: 'guided' } });
    await f.service.start('first', f.authority); await f.service.captureBaseline('first', f.authority);
    await f.service.start('next-stage', f.authority, 'first');
    await expect(f.service.complete('first', f.authority, { production: true, canceled: () => false })).rejects.toThrow('stale');
    await f.service.start('other', { ...f.authority, conversationId: 'other' }); f.service.markContended(['next-stage', 'other']);
    const report = await f.service.complete('next-stage', f.authority, { production: true, canceled: () => false });
    expect(report).toMatchObject({ decision: 'blocked', reasonCodes: ['DESIGN_GENERATION_AUTHORITY_CONFLICT'] });
  });
  it.each(['scope', 'targets'] as const)('rejects a %s change after final validation captured its authority', async (change) => {
    const f = await fixture(); await f.service.start('build', f.authority); await f.service.captureBaseline('build', f.authority);
    let applied = false;
    f.hook(() => {
      if (applied) return; applied = true;
      if (change === 'scope') f.authority.scope = 'different-account-workspace';
      else { const current = f.state.read('project'); f.state.write('project', current.revision, { ...current, generationTargets: { schemaVersion: 1, outputs: [{ sourcePath: 'different.html' }] } }); }
    });
    const report = await f.service.complete('build', f.authority, { production: true, canceled: () => false });
    expect(report).toMatchObject({ decision: 'blocked', reasonCodes: ['DESIGN_GENERATION_AUTHORITY_CONFLICT'] });
  });
  it.each(['artifact.html', 'artifact.bin'])('rejects a virtual publication path colliding with real %s bytes', async (name) => {
    const sourcePath = `__od_critique__/${name}`;
    const f = await fixture(); await f.write(sourcePath, 'original');
    await f.service.start('build', f.authority); await f.service.captureBaseline('build', f.authority);
    const report = await f.service.complete('build', f.authority, { production: true, canceled: () => false,
      externalSources: [{ sourcePath, language: 'html', sourceText: '<main>Other bytes</main>' }] });
    expect(report).toMatchObject({ decision: 'blocked', reasonCodes: ['DESIGN_GENERATION_AUTHORITY_CONFLICT'] });
    expect(report.diagnostics.some((issue) => issue.message.includes('collides'))).toBe(true);
  });
  it('rejects duplicate baseline claims and terminal/stale physical resumes without resetting evidence', async () => {
    const f = await fixture(); await f.service.start('first', f.authority);
    const claimed = await Promise.allSettled([f.service.captureBaseline('first', f.authority), f.service.captureBaseline('first', f.authority)]);
    expect(claimed.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    f.service.abort('first', 'canceled');
    await expect(f.service.start('first', f.authority)).rejects.toThrow('terminal');
    expect(f.executions.forRun('first')?.report?.decision).toBe('canceled');
  });
  it('cancellation after a read prevents validation acceptance and persists a canceled result', async () => {
    const f = await fixture(); await f.service.start('build', f.authority); await f.service.captureBaseline('build', f.authority);
    let canceled = false; f.hook(() => { canceled = true; });
    const report = await f.service.complete('build', f.authority, { production: true, canceled: () => canceled });
    expect(report.decision).toBe('canceled'); expect(report.validation).toBeNull();
  });
  it.each(['policy', 'document', 'source', 'missing-external'] as const)('rechecks terminal publication evidence after a writer await changes %s', async (change) => {
    const f = await fixture(); await f.service.start('publish', f.authority); await f.service.captureBaseline('publish', f.authority);
    const options = { production: true, canceled: () => false, canonicalEntry: '__od_critique__/artifact.html',
      externalSources: [{ sourcePath: '__od_critique__/artifact.html', language: 'html' as const, sourceText: '<main>Original ship</main>' }] };
    const first = await f.service.complete('publish', f.authority, options); expect(first.decision).toBe('advisory');
    if (change === 'source') await f.write('late.html', '<button style="color:red">Late write</button>');
    else if (change !== 'missing-external') {
      const current = f.state.read('project'); f.state.write('project', current.revision, change === 'policy'
        ? { ...current, validationSettings: { ...current.validationSettings, mode: 'strict' } }
        : { ...current, generationTargets: { schemaVersion: 1, outputs: [{ sourcePath: 'late.html' }] } });
    }
    const report = await f.service.complete('publish', f.authority, change === 'missing-external' ? { production: true, canceled: () => false } : options);
    expect(report).toMatchObject({ decision: 'blocked', reasonCodes: ['DESIGN_GENERATION_AUTHORITY_CONFLICT'] });
    expect(f.executions.forRun('publish')?.report?.decision).toBe('blocked');
  });
  it('re-observes production packages on terminal success and cannot upgrade a degraded report through reentry', async () => {
    const f = await fixture(); const request = validationFixture('react'); const { snapshot } = request;
    const current = f.state.read('project');
    f.state.write('project', 0, { ...current, registry: snapshot.registry, codeIndex: { ...snapshot.baseCodeIndex, id: 'project' },
      bindings: { ...snapshot.bindings, id: 'project' }, dependencies: { ...snapshot.dependencies, id: 'project' }, lock: { ...snapshot.lock, id: 'project' },
      validationSettings: request.settings, document: snapshot.document, generationTargets: { schemaVersion: 1, outputs: request.outputs } }, snapshot.versions);
    let installed = true; let observations = 0;
    const service = createDesignGenerationService({ state: f.state, executions: f.executions, root: () => f.root, currentScope: () => f.authority.scope,
      observeTargetPackages: async (projectId, names) => { expect(projectId).toBe('project'); observations++;
        return installed ? snapshot.targetPackages : names.map((name) => ({ name, installation: { status: 'unknown' as const } })); } });
    await service.start('publish', f.authority); await service.captureBaseline('publish', f.authority);
    const options = { production: true, canceled: () => false, externalSources: request.sources };
    const accepted = await service.complete('publish', f.authority, options); expect(accepted.decision).toBe('accepted');
    expect((await service.complete('publish', f.authority, options)).decision).toBe('accepted');
    installed = false;
    expect((await service.complete('publish', f.authority, options)).decision).toBe('blocked'); expect(observations).toBe(3);
    installed = true;
    await expect(service.complete('publish', f.authority, options)).rejects.toThrow('terminal');
    expect(f.executions.forRun('publish')?.attempt).toBe(0);
  });
  it('joins unsupported external MIME identity to the terminal evidence digest too', async () => {
    const f = await fixture(); await f.service.start('publish', f.authority); await f.service.captureBaseline('publish', f.authority);
    const options = { production: true, canceled: () => false, externalDiagnostics: [{ schemaVersion: 1 as const, code: 'ODDS6005' as const,
      severity: 'error' as const, message: 'Unsupported MIME application/octet-stream; body sha256:original', location: { sourcePath: '__od_critique__/artifact.unsupported', line: 1, column: 1 } }] };
    expect((await f.service.complete('publish', f.authority, options)).decision).toBe('advisory');
    const changed = { ...options, externalDiagnostics: [{ ...options.externalDiagnostics[0]!, message: 'Unsupported MIME application/octet-stream; body sha256:different' }] };
    expect((await f.service.complete('publish', f.authority, changed)).decision).toBe('blocked');
  });
});
