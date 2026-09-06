import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDesignRepairTurnV1 } from '@open-design/contracts';
import { strategyPackageHashFromDigests } from '@open-design/plugin-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase, upsertMessage } from '../../../src/db.js';
import { createSnapshot } from '../../../src/plugins/snapshots.js';
import { pinAssistantMessageOnRunCreate } from '../../../src/runtimes/chat-run-messages.js';
import {
  createInternalRunCreationService,
  type InternalPhysicalRun,
  type InternalRunCreateInput,
  type InternalRunRegistry,
} from '../../../src/services/internal-run-service.js';
import { createDesignGenerationService } from '../../../src/services/design-runtime/generation-execution.js';
import { prepareDesignGenerationRepair } from '../../../src/services/design-runtime/generation-repair.js';
import { createDesignGenerationStore } from '../../../src/storage/design-generation-store.js';
import { createDesignRuntimeStore } from '../../../src/storage/design-runtime-store.js';
import { OdNextMachineProtocolStream } from '../../../src/strategies/od-next/protocol.js';
import {
  cancelStrategyTaskExecution,
  createStrategyTaskExecution,
  getStrategyTaskExecution,
  getStrategyTaskExecutionByRunId,
} from '../../../src/strategies/task-store.js';
import { generationExecutionFixture, generationReportFixture } from '../../fixtures/design-runtime/design-generation.js';
import { strategyTaskCreateIdentityFixture } from '../../strategies/strategy-task-test-fixtures.js';

interface TestRun extends InternalPhysicalRun {
  conversationId?: string;
  assistantMessageId?: string;
  currentPrompt?: string;
  createdAt: number;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const action of cleanup.splice(0).reverse()) action();
});

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'od-generation-repair-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(directory, { dataDir: directory });
  cleanup.push(closeDatabase);
  db.prepare('INSERT INTO projects(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('project', 'Project', 1, 1);
  db.prepare('INSERT INTO conversations(id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('conversation', 'project', 'Conversation', 1, 1);
  upsertMessage(db, 'conversation', { id: 'repair-message', role: 'assistant', content: 'Pending repair', events: [] });

  const state = createDesignRuntimeStore(db);
  const original = state.read('project');
  state.write('project', original.revision, { ...original, validationSettings: { ...original.validationSettings, mode: 'strict' } });
  const executions = createDesignGenerationStore(db);
  const authority = { projectId: 'project', conversationId: 'conversation', scope: 'workspace-account' };
  let currentScope = authority.scope;
  const generation = createDesignGenerationService({
    state, executions, root: () => directory, currentScope: () => currentScope, observeTargetPackages: async () => [],
  });
  const started = await generation.start('source-run', authority);
  const ready = { ...started, baselineStatus: 'ready' as const, baseline: generationExecutionFixture().baseline };
  const initialExecution = executions.update(started.revision, {
    ...ready,
    report: {
      ...generationReportFixture(ready),
      projectRevision: state.read('project').revision,
      decision: 'repair_required',
      diagnostics: [{ schemaVersion: 1, code: 'ODDS6005', severity: 'error', message: '修复 <Button> & 间距。\n保留冻结约束。' }],
    },
  });

  const assetDigests = [{ path: './SKILL.md', sha256: 'a'.repeat(64) }, { path: './assets/task-profiles/prototype.md', sha256: 'b'.repeat(64) }];
  const snapshot = createSnapshot(db, {
    projectId: 'project', conversationId: 'conversation', runId: null,
    pluginId: 'od-next-strategy', pluginVersion: '2.0.0', manifestSourceDigest: 'manifest-digest',
    strategy: {
      schema: 'open-design.applied-strategy/v2', id: 'od-next-strategy', version: '2.0.0',
      packageHash: strategyPackageHashFromDigests(assetDigests), assetDigests,
      selectedTaskProfile: { taskType: 'prototype', version: '2.0.0', path: './assets/task-profiles/prototype.md', sha256: 'b'.repeat(64) },
      taskProfileVersions: ['2.0.0'], promptRecipe: 'od-next-plan-build-v2',
    },
    taskKind: 'new-generation', inputs: {}, resolvedContext: { items: [] },
    capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'], assetsStaged: [],
    connectorsRequired: [], connectorsResolved: [], mcpServers: [],
  });
  const initialTask = createStrategyTaskExecution(db, {
    taskExecutionId: 'task', projectId: 'project', conversationId: 'conversation', snapshotId: snapshot.snapshotId,
    selectedAgentId: 'codex', initialRunId: 'source-run', ...strategyTaskCreateIdentityFixture(), createdAt: 100,
  });
  const protocol = new OdNextMachineProtocolStream();
  protocol.push(`<open-design-runtime-state>\n${JSON.stringify({
    schema: 'open-design.strategy-state/v2', route: 'direct_edit', inputStage: 'request',
    outcome: 'completed', executionMode: 'simple', reasonCodes: [],
  })}\n</open-design-runtime-state>\n`);
  const strategy = { task: initialTask, parsed: protocol.finish(), toolUseCount: 1, deliverableValid: true };

  const physicalRuns = new Map<string, TestRun>();
  const createOrReuse = vi.fn((meta: InternalRunCreateInput) => {
    const run: TestRun = {
      id: `repair-${physicalRuns.size + 1}`, status: 'queued', createdAt: 200,
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
      ...(meta.assistantMessageId ? { assistantMessageId: meta.assistantMessageId } : {}),
      ...(meta.currentPrompt === undefined ? {} : { currentPrompt: meta.currentPrompt }),
    };
    physicalRuns.set(run.id, run);
    return { kind: 'created' as const, run };
  });
  const drop = vi.fn((run: TestRun) => { physicalRuns.delete(run.id); });
  const registry: InternalRunRegistry<InternalRunCreateInput, TestRun> = {
    createOrReuse, drop, get: (id) => physicalRuns.get(id) ?? null, prepareRestart: () => null,
    isTerminal: (status) => ['succeeded', 'failed', 'canceled'].includes(status),
    start: (run, starter) => { void starter(); return run; },
  };
  let beforeClaim: (() => void) | undefined;
  const claimAssistantMessage = vi.fn((run: TestRun, options?: Parameters<typeof pinAssistantMessageOnRunCreate>[2]) => {
    beforeClaim?.();
    return pinAssistantMessageOnRunCreate(db, run, options);
  });
  const runs = createInternalRunCreationService({ runs: registry, claimAssistantMessage, analyticsLifecycle: { install: () => undefined } });
  const createMeta = (text: string): InternalRunCreateInput => ({
    projectId: 'project', conversationId: 'conversation', assistantMessageId: 'repair-message', clientRequestId: 'repair-request', agentId: 'codex', currentPrompt: text,
  });
  const input = { db, runs, generation, sourceRunId: 'source-run', authority, canceled: () => false, createMeta, strategy };
  const readMessage = () => db.prepare('SELECT * FROM messages WHERE id = ?').get('repair-message');
  const initialMessage = readMessage();
  return {
    ...input, input, executions, initialExecution, initialTask, initialMessage, physicalRuns, createOrReuse, drop, claimAssistantMessage, readMessage,
    beforeClaim: (action: () => void) => { beforeClaim = action; },
    changeScope: () => { currentScope = 'other-workspace-account'; },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function expectNoChild(f: Fixture) {
  expect(f.physicalRuns.size).toBe(0);
  expect(f.executions.forRun('repair-1')).toBeNull();
  expect(getStrategyTaskExecutionByRunId(f.db, 'repair-1')).toBeNull();
  expect(f.readMessage()).toEqual(f.initialMessage);
}

describe('atomic host design repair preparation', () => {
  it('claims one child in both logical stores and retains exact persisted finalText for stdin', async () => {
    const f = await fixture();
    const result = prepareDesignGenerationRepair(f.input);
    const reopenedGeneration = createDesignGenerationStore(f.db).forRun('repair-1')!;
    const reopenedTask = getStrategyTaskExecutionByRunId(f.db, 'repair-1')!;
    expect(f.createOrReuse).toHaveBeenCalledOnce();
    expect(f.claimAssistantMessage).toHaveBeenCalledOnce();
    expect(f.physicalRuns.size).toBe(1);
    expect(f.readMessage()).toMatchObject({ run_id: 'repair-1', run_status: 'queued' });
    expect(reopenedGeneration).toMatchObject({ initialRunId: 'source-run', latestRunId: 'repair-1', attempt: 1,
      baseline: f.initialExecution.baseline, policy: f.initialExecution.policy, repair: { sourceRunId: 'source-run', sourceReport: f.initialExecution.report } });
    expect(reopenedTask).toMatchObject({ initialRunId: 'source-run', latestRunId: 'repair-1', outcome: 'running',
      route: 'direct_edit', inputStage: 'request', frozenInputIdentity: f.initialTask.frozenInputIdentity });
    expect(reopenedTask.runs).toHaveLength(2);
    expect(result.strategyTask).toEqual(reopenedTask);
    const storedText = reopenedGeneration.repair!.finalText;
    expect(result.text).toBe(storedText);
    expect(reopenedTask.runs[1]!.finalText).toMatchObject({ kind: 'design_repair', text: storedText,
      utf8Bytes: Buffer.byteLength(storedText, 'utf8'), sha256: createHash('sha256').update(storedText, 'utf8').digest('hex') });
    expect(parseDesignRepairTurnV1(storedText)).toMatchObject({ sourceRunId: 'source-run', report: f.initialExecution.report,
      strategy: { taskExecutionId: 'task', taskRunIndex: 1, frozenInputIdentity: f.initialTask.frozenInputIdentity } });
    const stdin = vi.fn(async (run: TestRun) => run.currentPrompt);
    f.runs.start(result.prepared.run, { body: {}, requestAnalyticsContext: null }, stdin);
    expect(stdin).toHaveBeenCalledWith(result.prepared.run);
    await expect(stdin.mock.results[0]!.value).resolves.toBe(storedText);

    expect(() => prepareDesignGenerationRepair(f.input)).toThrow(/current initial failed validation/);
    expect(f.createOrReuse).toHaveBeenCalledOnce();
    expect(f.executions.forRun('source-run')).toEqual(reopenedGeneration);
    expect(getStrategyTaskExecution(f.db, 'task')).toEqual(reopenedTask);
  });

  it('rolls back the strategy verdict and assistant claim when final production proof rejects repair', async () => {
    const f = await fixture();
    f.strategy.deliverableValid = false;
    expect(() => prepareDesignGenerationRepair(f.input)).toThrow(/od_next_canonical_deliverable_invalid/);
    expect(f.drop).toHaveBeenCalledOnce();
    expectNoChild(f);
    expect(f.executions.forRun('source-run')).toEqual(f.initialExecution);
    expect(getStrategyTaskExecution(f.db, 'task')).toEqual(f.initialTask);
  });

  it('rolls back the already-written strategy mapping and assistant claim when final generation authority changes', async () => {
    const f = await fixture();
    f.beforeClaim(f.changeScope);
    const claimRepair = f.generation.claimRepair;
    const finalClaim = vi.spyOn(f.generation, 'claimRepair').mockImplementation((...args) => {
      expect(getStrategyTaskExecutionByRunId(f.db, 'repair-1')?.latestRunId).toBe('repair-1');
      expect(f.readMessage()).toMatchObject({ run_id: 'repair-1' });
      return claimRepair(...args);
    });
    expect(() => prepareDesignGenerationRepair(f.input)).toThrow(/workspace\/account authority changed/);
    expect(finalClaim).toHaveBeenCalledOnce();
    expect(f.drop).toHaveBeenCalledOnce();
    expectNoChild(f);
    expect(f.executions.forRun('source-run')).toEqual(f.initialExecution);
    expect(getStrategyTaskExecution(f.db, 'task')).toEqual(f.initialTask);
  });

  it.each(['before preparation', 'inside the claim'] as const)('rejects cancellation %s without retaining a child', async (phase) => {
    const f = await fixture();
    let canceled = phase === 'before preparation';
    if (!canceled) f.beforeClaim(() => { canceled = true; });
    expect(() => prepareDesignGenerationRepair({ ...f.input, canceled: () => canceled })).toThrow(/canceled/);
    expect(f.createOrReuse).toHaveBeenCalledTimes(phase === 'before preparation' ? 0 : 1);
    expectNoChild(f);
    expect(f.executions.forRun('source-run')).toEqual(f.initialExecution);
    expect(getStrategyTaskExecution(f.db, 'task')).toEqual(f.initialTask);
  });

  it('rejects a stale physical source before allocating a repair', async () => {
    const f = await fixture();
    const continued = f.generation.bindContinuation('source-run', 'newer-run', f.authority);
    expect(() => prepareDesignGenerationRepair(f.input)).toThrow(/current initial failed validation/);
    expect(f.createOrReuse).not.toHaveBeenCalled();
    expectNoChild(f);
    expect(f.executions.forRun('source-run')).toEqual(continued);
    expect(getStrategyTaskExecution(f.db, 'task')).toEqual(f.initialTask);
  });

  it('rejects a strategy canceled after repair text was prepared without reviving its terminal state', async () => {
    const f = await fixture();
    f.beforeClaim(() => cancelStrategyTaskExecution(f.db, { taskExecutionId: 'task', expectedRevision: f.initialTask.revision }));
    expect(() => prepareDesignGenerationRepair(f.input)).toThrow(/active running task stage/);
    expectNoChild(f);
    expect(f.executions.forRun('source-run')).toEqual(f.initialExecution);
    expect(getStrategyTaskExecution(f.db, 'task')).toMatchObject({ outcome: 'canceled', latestRunId: 'source-run', runs: f.initialTask.runs });
  });

  it.each(['assistantMessageId', 'conversationId', 'clientRequestId'] as const)('rejects missing %s before allocating an unscoped child', async (key) => {
    const f = await fixture();
    expect(() => prepareDesignGenerationRepair({ ...f.input, createMeta: (text) => {
      const meta = f.createMeta(text);
      delete meta[key];
      return meta;
    } })).toThrow();
    expect(f.createOrReuse).not.toHaveBeenCalled();
    expectNoChild(f);
    expect(f.executions.forRun('source-run')).toEqual(f.initialExecution);
    expect(getStrategyTaskExecution(f.db, 'task')).toEqual(f.initialTask);
  });
});
