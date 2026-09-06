import { workspaceContextFixture } from '../helpers/workspace-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reattachDaemonRun, type DaemonReattachOptions } from '../../src/providers/daemon';
import { generationReport as report, generationTask as task, generationStrategy as strategy } from '../helpers/design-generation-fixtures';
import { artifactValidationFixture } from '../helpers/design-validation-fixtures';

const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const end = (designGenerationTask: ReturnType<typeof task>, extra = {}) => event('end', { status: 'succeeded', code: 0, designGenerationTask, ...extra });
const repaired = () => task({ activeRunId: 'repair', nextRunId: 'repair', attempt: 1, status: 'repairing', latestReport: report('initial', 0, 'repair_required') });
const completed = () => task({ activeRunId: 'repair', attempt: 1, status: 'succeeded', latestReport: report('repair', 1) });
function setup(streams: Record<string, string>, statuses: Record<string, unknown> = {}) {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    const match = /^\/api\/runs\/([^/?]+)(\/events|\/cancel)?/.exec(url)!;
    if (match?.[2] === '/cancel') return Response.json({ ok: true });
    if (match?.[2] === '/events') return new Response(streams[match[1]!] ?? '', { headers: { 'Content-Type': 'text/event-stream' } });
    if (match) {
      const id = match[1]!;
      const lastEnd = streams[id]?.split('\n\n').filter(frame => frame.startsWith('event: end\n')).at(-1);
      const payload = lastEnd ? JSON.parse(lastEnd.split('\ndata: ')[1]!) : undefined;
      const status = Object.hasOwn(statuses, id) ? statuses[id] : payload;
      if (status) return Response.json({ id, projectId: 'project', conversationId: 'conversation', ...status });
    }
    throw Error(`Unexpected request ${url} ${init?.method ?? ''}`);
  }));
  const handlers = { onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(), onAgentEvent: vi.fn() };
  const options: DaemonReattachOptions = { runId: 'initial', projectId: 'project', conversationId: 'conversation', signal: new AbortController().signal,
    handlers, onRunStatus: vi.fn(), onRunCreated: vi.fn(), onDesignGeneration: vi.fn() };
  return { options, handlers, requests };
}
afterEach(() => vi.unstubAllGlobals());

describe('daemon design generation task following', () => {
  it.each(['not_applicable', 'accepted'] as const)('ends an authenticated waiting stage with %s evidence without claiming delivery or following a child', async decision => {
    const waitingReport = report('initial', 0, decision);
    if (decision === 'accepted') {
      waitingReport.validation = { ...artifactValidationFixture(), mode: 'guided', diagnostics: [], accepted: true };
    }
    const waiting = task({ status: 'awaiting_input', latestReport: waitingReport });
    const { options, handlers, requests } = setup({ initial: event('stdout', { chunk: 'Which layout?' })
      + end(waiting, { strategyTask: { ...strategy('initial'), outcome: 'clarification_required' } }) });
    await reattachDaemonRun(options);
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('Which layout?');
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(options.onRunStatus).toHaveBeenLastCalledWith('succeeded');
    expect(options.onRunCreated).not.toHaveBeenCalled();
    expect(requests).toEqual(['/api/runs/initial/events', '/api/runs/initial']);
    expect(options.onDesignGeneration).toHaveBeenCalledWith({ task: waiting });
  });

  it.each(['missing-strategy', 'not-waiting', 'failed-physical'] as const)('rejects unauthenticated waiting state: %s', async mismatch => {
    const waiting = task({ status: 'awaiting_input', latestReport: report() });
    const extra = { ...(mismatch !== 'missing-strategy' ? { strategyTask: { ...strategy('initial'), outcome: mismatch === 'not-waiting' ? 'running' : 'clarification_required' } } : {}),
      ...(mismatch === 'failed-physical' ? { status: 'failed' } : {}) };
    const { options, handlers } = setup({ initial: end(waiting, extra) });
    await reattachDaemonRun(options);
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalled();
  });

  it('recovers an existing later clarification from a historical predecessor then waits without creating another Run', async () => {
    const waiting = task({ activeRunId: 'clarification', status: 'awaiting_input', latestReport: report('clarification', 0) });
    const { options, handlers, requests } = setup({
      initial: end({ ...waiting, nextRunId: 'clarification' }, { strategyTask: { ...strategy('clarification', 'clarification'), outcome: 'clarification_required' } }),
      clarification: event('stdout', { chunk: 'Which option?' }) + end(waiting, { strategyTask: { ...strategy('clarification'), outcome: 'clarification_required' } }),
    });
    await reattachDaemonRun(options);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('Which option?');
    expect(requests.filter(url => url.endsWith('/events'))).toEqual(['/api/runs/initial/events', '/api/runs/clarification/events']);
    expect(options.onRunCreated).toHaveBeenCalledTimes(1);
  });

  it('keeps one logical completion through a failed initial run and successful repair', async () => {
    const { options, handlers } = setup({
      initial: event('start', { designGenerationTask: task() }) + event('stdout', { chunk: 'Initial. ' })
        + event('diagnostic', { type: 'design_generation', report: report('initial', 0, 'repair_required'), designGenerationTask: repaired() })
        + end(repaired(), { status: 'failed', designGeneration: report('initial', 0, 'repair_required') }),
      repair: event('start', { designGenerationTask: task({ ...repaired(), nextRunId: null }) }) + event('stdout', { chunk: 'Repaired.' })
        + end(completed(), { designGeneration: report('repair', 1) }),
    });
    await reattachDaemonRun(options);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).toHaveBeenCalledExactlyOnceWith('Initial. Repaired.');
    expect(options.onRunCreated).toHaveBeenCalledExactlyOnceWith('repair', undefined, repaired());
    expect(options.onRunStatus).not.toHaveBeenCalledWith('failed');
    expect(options.onDesignGeneration).toHaveBeenCalledWith({ task: completed(), report: report('repair', 1) });
  });

  it('preserves ordinary Full Plan successors at attempt zero before the single repair', async () => {
    const stage = task({ activeRunId: 'production', nextRunId: 'production' });
    const { options, handlers, requests } = setup({
      initial: end(stage, { strategyTask: strategy('production', 'production') }),
      production: end(repaired(), { strategyTask: strategy('repair', 'repair') }),
      repair: end(completed(), { strategyTask: { ...strategy('repair'), terminal: true, outcome: 'completed' } }),
    });
    await reattachDaemonRun(options);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(requests.filter(url => url.endsWith('/events'))).toEqual(['/api/runs/initial/events', '/api/runs/production/events', '/api/runs/repair/events']);
  });

  it('uses REST task truth after reconnect exhaustion without duplicating output', async () => {
    const { options, handlers } = setup({ initial: '', repair: end(completed()) }, { initial: { status: 'failed', designGenerationTask: repaired() } });
    await reattachDaemonRun(options);
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(handlers.onError).not.toHaveBeenCalled();
  });

  it('never follows a successor solely from a diagnostic frame', async () => {
    const { options, handlers, requests } = setup({ initial: event('diagnostic', { type: 'design_generation', report: report('initial', 0, 'repair_required'), designGenerationTask: repaired() })
      + event('end', { status: 'succeeded', code: 0 }) }, { initial: { status: 'succeeded', designGenerationTask: undefined } });
    await reattachDaemonRun(options);
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalled();
    expect(requests).not.toContain('/api/runs/repair/events');
  });

  it.each([{ projectId: 'foreign' }, { conversationId: 'foreign' }])('rejects foreign scope %j before following', async mismatch => {
    const { options, handlers, requests } = setup({ initial: end({ ...repaired(), ...mismatch }) });
    await reattachDaemonRun(options);
    expect(handlers.onError).toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(requests).not.toContain('/api/runs/repair/events');
  });

  it.each([{ executionId: 'foreign', latestReport: null }, { initialRunId: 'foreign' }, { attempt: 0 as const, status: 'running' as const, latestReport: null }])('rejects changed execution or regressed repair attempt %j', async mismatch => {
    const { options, handlers } = setup({ initial: end(repaired()), repair: end({ ...completed(), ...mismatch }) });
    await reattachDaemonRun(options);
    expect(handlers.onError).toHaveBeenCalled();
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it('rejects conflicting strategy and generation successors', async () => {
    const { options, handlers, requests } = setup({ initial: end(repaired(), { strategyTask: strategy('foreign', 'foreign') }) });
    await reattachDaemonRun(options);
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('disagree') }));
    expect(requests).not.toContain('/api/runs/repair/events');
  });

  it('blocks a cyclic physical chain while allowing multiple same-attempt stages', async () => {
    const { options, handlers } = setup({ initial: end(repaired()), repair: end(task({ activeRunId: 'initial', nextRunId: 'initial', attempt: 1, status: 'repairing' })) });
    await reattachDaemonRun(options);
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('cyclic') }));
    expect(handlers.onDone).not.toHaveBeenCalled();
  });

  it('cancels the active repair with the same workspace headers', async () => {
    const { options, handlers, requests } = setup({ initial: end(repaired()), repair: event('start', { designGenerationTask: task({ ...repaired(), nextRunId: null }) })
      + end(task({ ...completed(), status: 'canceled', latestReport: report('repair', 1, 'canceled') }), { status: 'canceled' }) });
    const cancel = new AbortController(); options.cancelSignal = cancel.signal;
    options.workspaceContext = workspaceContextFixture({ workspaceId: 'workspace', workspaceMemberId: 'member' });
    options.onDesignGeneration = update => { if (update.task?.activeRunId === 'repair' && update.task.nextRunId === null) cancel.abort(); };
    await reattachDaemonRun(options);
    expect(requests.filter(url => url.endsWith('/cancel'))).toEqual(['/api/runs/repair/cancel']);
    expect(handlers.onError).not.toHaveBeenCalled();
    const cancelCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/cancel'))!;
    expect(cancelCall[1]?.headers).toBeDefined();
  });

  it('never reports success when validation blocks a physically successful run', async () => {
    const { options, handlers } = setup({ initial: end(task({ status: 'blocked', latestReport: report('initial', 0, 'blocked') })) });
    await reattachDaemonRun(options);
    expect(options.onRunStatus).toHaveBeenCalledWith('failed');
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('blocked') }));
  });

  it('follows fresh source status when a historical end still advertises an earlier Full Plan stage', async () => {
    const oldStage = task({ activeRunId: 'production', nextRunId: 'production' });
    const { options, handlers, requests } = setup({ initial: end(oldStage),
      repair: event('start', { designGenerationTask: task() }) + end(completed()) },
    { initial: { status: 'failed', designGenerationTask: repaired() } });
    await reattachDaemonRun(options);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onDone).toHaveBeenCalledTimes(1);
    expect(requests).not.toContain('/api/runs/production/events');
    expect(requests.indexOf('/api/runs/repair')).toBeLessThan(requests.indexOf('/api/runs/repair/events'));
  });

  it.each(['initial', 'repair'])('authenticates the physical %s identity before following', async id => {
    const { options, handlers, requests } = setup({ initial: end(repaired()), repair: end(completed()) }, {
      [id]: { id: 'foreign', status: 'succeeded', designGenerationTask: id === 'initial' ? repaired() : completed() },
    });
    await reattachDaemonRun(options);
    expect(handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('identity or scope') }));
    expect(handlers.onDone).not.toHaveBeenCalled();
    expect(requests).not.toContain('/api/runs/repair/events');
  });

  it('rejects a successor status in a different conversation even when its task claims the expected scope', async () => {
    const { options, handlers, requests } = setup({ initial: end(repaired()), repair: end(completed()) }, {
      repair: { status: 'succeeded', conversationId: 'foreign', designGenerationTask: completed() },
    });
    await reattachDaemonRun(options);
    expect(handlers.onError).toHaveBeenCalled();
    expect(requests).not.toContain('/api/runs/repair/events');
  });
});
