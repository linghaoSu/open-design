import express, { type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatRunStatusResponse, DesignGenerationReport, DesignGenerationTaskProjection, RunResultPackageResponse } from '@open-design/contracts';
import { createChatRunService } from '../../src/runtimes/runs.js';
import { type ChatRun, projectDesignGenerationMessageFields } from '../../src/runtimes/chat-run-records.js';
import { registerRunRoutes, type RegisterRunRoutesDeps } from '../../src/routes/runs.js';
import { registerProjectConversationRoutes, type RegisterProjectConversationRoutesDeps } from '../../src/routes/project/conversations.js';
import { closeDatabase, getConversation, getMessage, getProject, insertConversation, insertProject, listConversations, listMessages, openDatabase, updateConversation, updateProject, upsertMessage } from '../../src/db.js';

function report(runId: string, attempt: 0 | 1, decision: DesignGenerationReport['decision'] = 'repair_required'): DesignGenerationReport {
  return { schemaVersion: 1, executionId: 'execution', runId, attempt, mode: 'guided', policyDigest: 'sha256:' + 'a'.repeat(64),
    projectRevision: 3, decision, reasonCodes: [], diagnostics: [], outputs: [], validation: null,
    inventory: { baselineDigest: 'sha256:' + 'b'.repeat(64), sourceDigest: 'sha256:' + 'c'.repeat(64), complete: true, changed: ['Screen.tsx'], deleted: [] } };
}
function task(initialRunId: string, activeRunId = initialRunId, viewedRunId = initialRunId, overrides: Partial<DesignGenerationTaskProjection> = {}): DesignGenerationTaskProjection {
  return { schemaVersion: 1, executionId: 'execution', projectId: 'project', conversationId: 'conversation',
    initialRunId, activeRunId, nextRunId: viewedRunId === activeRunId ? null : activeRunId,
    attempt: activeRunId === initialRunId ? 0 : 1, repairLimit: 1, status: activeRunId === initialRunId ? 'running' : 'repairing', latestReport: null, ...overrides };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function makeRuns(projectRunState: (run: ChatRun) => void, runsLogDir: string | null = null) {
  return createChatRunService({
    createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    projectRunState: projectRunState as unknown as null, runsLogDir: runsLogDir as unknown as null,
    shutdownGraceMs: 10, ttlMs: 60_000,
  });
}

describe('daemon generation projections', () => {
  it('projects start, diagnostics and physical terminal status before the durable snapshot and end event', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'od-generation-projection-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const observed: string[] = [];
    const runs = makeRuns((run) => {
      observed.push(run.status);
      run.designGenerationExecutionId = 'execution'; run.designGenerationAttempt = 0;
      run.designGeneration = report(run.id, 0, 'not_applicable');
      run.designGenerationTask = task(run.id, run.id, run.id, {
        status: run.status === 'succeeded' ? 'succeeded' : 'running', latestReport: run.designGeneration,
      });
    }, directory);
    const run = runs.create({ projectId: 'project', conversationId: 'conversation' });
    run.status = 'running';
    expect(runs.emit(run, 'start', {})!.data.designGenerationTask.status).toBe('running');
    expect(runs.emit(run, 'diagnostic', { type: 'design_generation', report: report(run.id, 0) })!.data.designGenerationTask.executionId).toBe('execution');
    runs.finish(run, 'succeeded', 0, null);
    expect(observed).toContain('succeeded');
    expect(run.events.at(-1)).toMatchObject({ event: 'end', data: { status: 'succeeded', designGenerationTask: { status: 'succeeded' } } });
    expect(JSON.parse(readFileSync(path.join(directory, run.id, 'state.json'), 'utf8'))).toMatchObject({
      status: 'succeeded', designGenerationExecutionId: 'execution', designGenerationAttempt: 0,
      designGeneration: { runId: run.id, attempt: 0 },
    });
  });

  it('retains the physical failure attempt across restart while deriving the latest repair projection afresh', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'od-generation-restart-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const initialRuns = makeRuns((run) => {
      run.designGenerationExecutionId = 'execution'; run.designGenerationAttempt = 0;
      run.designGeneration = report(run.id, 0); run.designGenerationTask = task(run.id);
    }, directory);
    const initial = initialRuns.create({ projectId: 'project', conversationId: 'conversation', assistantMessageId: 'message' });
    initialRuns.finish(initial, 'failed', 1, null);
    const statePath = path.join(directory, initial.id, 'state.json');
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(saved).not.toHaveProperty('designGenerationTask');
    // Old or foreign run snapshots are never logical-task authority.
    writeFileSync(statePath, JSON.stringify({ ...saved, designGenerationTask: task(initial.id, initial.id, initial.id, { executionId: 'forged' }) }));
    const restoredRuns = makeRuns((run) => {
      expect(run.designGenerationAttempt).toBe(0);
      run.designGenerationTask = task(initial.id, 'repair', run.id, { latestReport: report(initial.id, 0) });
    }, directory);
    const restored = restoredRuns.get(initial.id)!;
    expect(restored).not.toHaveProperty('designGenerationTask');
    const status = restoredRuns.statusBody(restored);
    expect(status).toMatchObject({ status: 'failed', designGeneration: { attempt: 0, runId: initial.id },
      designGenerationTask: { executionId: 'execution', activeRunId: 'repair', attempt: 1, status: 'repairing' } });
  });

  it('only overlays an owned assistant row with a matching physical report, scope and immutable identity', () => {
    const run = { id: 'initial', projectId: 'project', conversationId: 'conversation', assistantMessageId: 'message', designGenerationExecutionId: 'execution', designGenerationAttempt: 0 as const };
    const status = { id: 'initial', projectId: 'project', conversationId: 'conversation', designGeneration: report('initial', 0), designGenerationTask: task('initial', 'repair') } as ChatRunStatusResponse;
    const message = { id: 'message', role: 'assistant', runId: 'initial' };
    expect(projectDesignGenerationMessageFields(run, status, message, 'project', 'conversation')).toMatchObject({ designGenerationAttempt: 0, designGenerationTask: { attempt: 1 } });
    for (const other of [{ ...message, id: 'sibling' }, { ...message, role: 'user' }, { ...message, runId: 'repair' }]) {
      expect(projectDesignGenerationMessageFields(run, status, other, 'project', 'conversation')).toEqual({});
    }
    expect(projectDesignGenerationMessageFields(run, status, message, 'project', 'sibling')).toEqual({});
    expect(projectDesignGenerationMessageFields({ ...run, designGenerationExecutionId: 'other' }, status, message, 'project', 'conversation')).toEqual({});
    expect(projectDesignGenerationMessageFields(run, { ...status, designGeneration: report('repair', 1, 'blocked') }, message, 'project', 'conversation')).not.toHaveProperty('designGeneration');
  });
});

async function mount() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'od-generation-http-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(directory, { dataDir: directory });
  cleanups.push(() => closeDatabase());
  mkdirSync(path.join(directory, 'project'));
  insertProject(db, { id: 'project', name: 'Project', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'conversation', projectId: 'project', title: 'Task', createdAt: 1, updatedAt: 1 });
  const projections = new Map<string, DesignGenerationTaskProjection>();
  const runs = makeRuns((run) => {
    const projection = projections.get(run.id);
    if (!projection) { delete run.designGenerationTask; return; }
    run.designGenerationTask = { ...projection, status: run.id === projection.activeRunId && run.status === 'canceled' ? 'canceled' : projection.status };
  });
  const initial = runs.create({ projectId: 'project', conversationId: 'conversation', assistantMessageId: 'initial-message' }) as unknown as ChatRun;
  const repair = runs.create({ projectId: 'project', conversationId: 'conversation', assistantMessageId: 'repair-message' }) as unknown as ChatRun;
  Object.assign(initial, { status: 'failed', designGenerationExecutionId: 'execution', designGenerationAttempt: 0, designGeneration: report(initial.id, 0) });
  Object.assign(repair, { status: 'running', designGenerationExecutionId: 'execution', designGenerationAttempt: 1 });
  for (const run of [initial, repair]) {
    projections.set(run.id, task(initial.id, repair.id, run.id, { latestReport: report(initial.id, 0) }));
    upsertMessage(db, 'conversation', { id: run.assistantMessageId, role: 'assistant', content: run.id, timestamp: 1, runId: run.id, runStatus: run.status });
  }
  const app = express(); app.use(express.json());
  const http = { sendApiError: (res: Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }),
    createSseResponse: () => ({ send() {}, end() {}, cleanup() {} }) };
  const paths = { BRANDS_DIR: directory, PROJECTS_DIR: directory, RUNTIME_DATA_DIR: directory };
  registerRunRoutes(app, { db, design: { runs }, http, paths, agents: {}, chat: {}, plugins: {}, telemetry: {}, messages: {}, internalRuns: {} } as unknown as RegisterRunRoutesDeps);
  registerProjectConversationRoutes(app, { db, design: { runs }, http, paths, projectStore: { getProject, updateProject },
    conversations: { getConversation, insertConversation, listConversations, updateConversation, getMessage, listMessages, upsertMessage },
    ids: { randomId: () => 'generated' }, appConfig: { readAppConfig: async () => ({}) }, agents: { getAgentDef: () => null },
  } as unknown as RegisterProjectConversationRoutesDeps);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, db, runs, initial, repair, projections };
}

describe('generation HTTP authority and recovery', () => {
  it('restores both physical messages under the current repair task and rejects client generation claims', async () => {
    const { base, initial, repair } = await mount();
    const url = `${base}/api/projects/project/conversations/conversation/messages`;
    const response = await fetch(url); expect(response.status).toBe(200);
    const { messages } = await response.json() as { messages: ChatMessage[] };
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ runId: initial.id, designGenerationExecutionId: 'execution', designGenerationAttempt: 0,
      designGeneration: { runId: initial.id, attempt: 0 }, designGenerationTask: { activeRunId: repair.id, attempt: 1 } });
    expect(messages[1]).toMatchObject({ runId: repair.id, designGenerationAttempt: 1, designGenerationTask: { activeRunId: repair.id } });
    const write = await fetch(`${url}/initial-message`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      ...messages[0], designGenerationExecutionId: 'forged', designGenerationAttempt: 1, designGenerationTask: task('forged'), designGeneration: report('forged', 0),
    }) });
    expect(write.status).toBe(200);
    expect((await write.json() as { message: ChatMessage }).message).toMatchObject({ designGenerationExecutionId: 'execution', designGenerationAttempt: 0, designGeneration: { runId: initial.id } });
    const forged = await fetch(`${url}/forged`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      id: 'forged', role: 'assistant', timestamp: 2, content: 'spoof', runId: initial.id, designGenerationTask: task(initial.id), designGenerationExecutionId: 'execution', designGenerationAttempt: 0,
    }) });
    expect(forged.status).toBe(200);
    expect((await forged.json() as { message: ChatMessage }).message).not.toHaveProperty('designGenerationTask');
  });

  it('returns the active repair and both report projections at the result-package top level', async () => {
    const { base, initial, repair, projections } = await mount();
    repair.status = 'failed'; repair.designGeneration = report(repair.id, 1, 'blocked');
    for (const run of [initial, repair]) projections.set(run.id, task(initial.id, repair.id, run.id, { status: 'blocked', latestReport: repair.designGeneration }));
    const response = await fetch(`${base}/api/runs/${initial.id}/result-package`);
    expect(response.status).toBe(200);
    const body = await response.json() as RunResultPackageResponse;
    expect(body).toMatchObject({ run: { id: repair.id, status: 'failed' }, designGeneration: { runId: repair.id, attempt: 1, decision: 'blocked' },
      designGenerationTask: { activeRunId: repair.id, status: 'blocked' } });
    expect(body.run).not.toHaveProperty('designGenerationTask');
  });

  it('cancels the active repair when a reconnecting caller cancels its failed predecessor', async () => {
    const { base, initial, repair } = await mount();
    const response = await fetch(`${base}/api/runs/${initial.id}/cancel`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, run: { id: repair.id, status: 'canceled', designGenerationTask: { status: 'canceled' } } });
    expect(initial.status).toBe('failed');
  });

  it.each(['result-package', 'cancel'])('rejects a %s redirect into a sibling conversation', async (operation) => {
    const { base, initial, repair } = await mount(); repair.conversationId = 'sibling';
    const response = await fetch(`${base}/api/runs/${initial.id}/${operation}`, { method: operation === 'cancel' ? 'POST' : 'GET' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'DESIGN_GENERATION_AUTHORITY_CONFLICT' } });
    expect(repair.status).toBe('running');
  });

  it('rejects cancellation and result following when the child belongs to another execution', async () => {
    const { base, initial, repair, projections } = await mount();
    projections.set(repair.id, task(initial.id, repair.id, repair.id, { executionId: 'other' }));
    for (const operation of ['result-package', 'cancel']) {
      const response = await fetch(`${base}/api/runs/${initial.id}/${operation}`, { method: operation === 'cancel' ? 'POST' : 'GET' });
      expect(response.status).toBe(409);
    }
    expect(repair.status).toBe('running');
  });

  it('fails closed when strategy and generation advertise different successors', async () => {
    const { base, initial, repair } = await mount();
    initial.strategyTask = { taskExecutionId: 'strategy', strategy: { id: 'od-next-strategy', version: '1', packageHash: 'd'.repeat(64), snapshotId: 'snapshot' },
      inputStage: 'production', outcome: 'running', route: 'full_plan', executionMode: 'complex', activeRunId: repair.id, nextRunId: 'other', terminal: false };
    for (const operation of ['result-package', 'cancel']) {
      const response = await fetch(`${base}/api/runs/${initial.id}/${operation}`, { method: operation === 'cancel' ? 'POST' : 'GET' });
      expect(response.status).toBe(409);
    }
    expect(repair.status).toBe('running');
  });

  it('does not return an intermediate child when the same execution has already advanced', async () => {
    const { base, initial, repair, projections } = await mount();
    projections.set(repair.id, task(initial.id, 'new-current', repair.id));
    const response = await fetch(`${base}/api/runs/${initial.id}/result-package`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'DESIGN_GENERATION_AUTHORITY_CONFLICT' } });
  });
});
