import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { DesignGenerationReport, DesignGenerationTaskProjection } from '@open-design/contracts';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

interface StubServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

let stub: StubServer | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (stub) await stub.close();
  stub = null;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = null;
});

interface StubResponse {
  statusCode?: number;
  body?: unknown;
  events?: Array<{ event: string; data: unknown }>;
}

async function startRunStubServer(resumable: boolean, responses: Record<string, StubResponse> = {}): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let taskFollowEnabled = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw,
        headers: req.headers,
      };
      requests.push(captured);
      res.setHeader('content-type', 'application/json');
      const response = responses[`${captured.method} ${captured.url}`];
      if (response) {
        res.statusCode = response.statusCode ?? 200;
        if (response.events) {
          res.setHeader('content-type', 'text/event-stream');
          res.end(response.events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
        } else res.end(JSON.stringify(response.body));
        return;
      }

      if (captured.method === 'GET' && captured.url === '/api/runs/run-1') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          id: 'run-1',
          projectId: 'project-1',
          conversationId: 'conversation-1',
          agentId: 'claude',
          status: 'failed',
          resumable,
        }));
        return;
      }

      if (
        captured.method === 'GET'
        && (captured.url === '/api/runs' || captured.url === '/api/runs?projectId=project-1')
      ) {
        res.statusCode = 200;
        res.end(JSON.stringify({ runs: [] }));
        return;
      }

      if (
        captured.method === 'GET'
        && captured.url === '/api/runs/run-1/result-package'
      ) {
        res.statusCode = 200;
        res.end(JSON.stringify({ run: { id: 'run-1', status: 'completed' } }));
        return;
      }

      if (
        captured.method === 'POST'
        && captured.url === '/api/runs/run-1/cancel'
      ) {
        res.statusCode = 200;
        res.end(JSON.stringify({
          ok: true,
          run: {
            id: taskFollowEnabled ? 'run-2' : 'run-1',
            ...(taskFollowEnabled
              ? {
                  strategyTask: {
                    taskExecutionId: 'task-1',
                    activeRunId: 'run-2',
                    outcome: 'canceled',
                    terminal: true,
                  },
                }
              : {}),
          },
        }));
        return;
      }

      if (captured.method === 'POST' && captured.url === '/api/runs') {
        const body = JSON.parse(captured.body || '{}') as { taskExecutionId?: string };
        taskFollowEnabled = body.taskExecutionId === 'task-1';
        res.statusCode = 200;
        res.end(JSON.stringify({
          runId: taskFollowEnabled ? 'run-1' : 'run-2',
          ...(taskFollowEnabled ? { taskExecutionId: 'task-1' } : {}),
        }));
        return;
      }

      if (captured.method === 'POST' && captured.url === '/api/import/folder') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          project: { id: 'imported-project' },
          conversationId: 'imported-conversation',
        }));
        return;
      }

      if (
        captured.method === 'GET'
        && (captured.url === '/api/runs/run-1/events' || captured.url === '/api/runs/run-2/events')
      ) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        if (taskFollowEnabled && captured.url === '/api/runs/run-1/events') {
          res.end('event: end\ndata: {"status":"succeeded","strategyTask":{"taskExecutionId":"task-1","activeRunId":"run-2","nextRunId":"run-2","outcome":"running","terminal":false}}\n\n');
        } else if (taskFollowEnabled && captured.url === '/api/runs/run-2/events') {
          res.end('event: end\ndata: {"status":"succeeded","strategyTask":{"taskExecutionId":"task-1","activeRunId":"run-2","outcome":"completed","terminal":true}}\n\n');
        } else {
          res.end('event: end\ndata: {"status":"completed"}\n\n');
        }
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'unexpected-request', message: captured.url } }));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('stub server has no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
      code: failed.code ?? 1,
    };
  }
}

function generationReport(overrides: Partial<DesignGenerationReport> = {}): DesignGenerationReport {
  return {
    schemaVersion: 1, executionId: 'generation-1', runId: 'run-2', attempt: 1, mode: 'guided',
    policyDigest: `sha256:${'a'.repeat(64)}`, projectRevision: 1, decision: 'not_applicable',
    reasonCodes: [], diagnostics: [], outputs: [], validation: null,
    inventory: { baselineDigest: `sha256:${'b'.repeat(64)}`, sourceDigest: `sha256:${'c'.repeat(64)}`, complete: true, changed: [], deleted: [] },
    ...overrides,
  };
}

function generationTask(overrides: Partial<DesignGenerationTaskProjection> = {}): DesignGenerationTaskProjection {
  return {
    schemaVersion: 1, executionId: 'generation-1', projectId: 'project-1', conversationId: 'conversation-1',
    initialRunId: 'run-1', activeRunId: 'run-2', nextRunId: 'run-2', attempt: 1, repairLimit: 1,
    status: 'repairing', latestReport: generationReport({ runId: 'run-1', attempt: 0, decision: 'repair_required' }),
    ...overrides,
  };
}

function generationReplies(
  task = generationTask(),
  childTask = generationTask({ status: 'succeeded', nextRunId: null, latestReport: generationReport() }),
): Record<string, StubResponse> {
  const status = (id: string, projection: DesignGenerationTaskProjection) => ({
    id, projectId: projection.projectId, conversationId: projection.conversationId,
    status: projection.status === 'succeeded' ? 'succeeded' : 'failed', designGenerationTask: projection,
  });
  return {
    'GET /api/runs/run-1': { body: status('run-1', task) },
    'GET /api/runs/run-2': { body: status('run-2', childTask) },
    'GET /api/runs/run-1/events': { events: [{ event: 'end', data: { ...status('run-1', task), designGeneration: task.latestReport } }] },
    'GET /api/runs/run-2/events': { events: [{ event: 'end', data: { ...status('run-2', childTask), designGeneration: childTask.latestReport } }] },
  };
}

describe('od run CLI', () => {
  it('ends watch successfully at authenticated input waiting without an automatic child', async () => {
    const task = generationTask({ activeRunId: 'run-1', nextRunId: null, attempt: 0, status: 'awaiting_input', latestReport: generationReport({ runId: 'run-1', attempt: 0 }) });
    const body = { id: 'run-1', projectId: task.projectId, conversationId: task.conversationId, status: 'succeeded', designGenerationTask: task,
      strategyTask: { taskExecutionId: 'strategy-1', activeRunId: 'run-1', terminal: false, outcome: 'clarification_required' } };
    stub = await startRunStubServer(true, { 'GET /api/runs/run-1': { body }, 'GET /api/runs/run-1/events': { events: [{ event: 'end', data: body }] } });
    const result = await runCli(['run', 'watch', 'run-1', '--json', '--daemon-url', stub.baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim()).data.designGenerationTask.status).toBe('awaiting_input');
    expect(stub.requests.map(({ url }) => url)).toEqual(['/api/runs/run-1/events', '/api/runs/run-1']);
  });

  it.each(['missing-strategy', 'not-waiting', 'failed-physical'] as const)('rejects unproven waiting-input state: %s', async mismatch => {
    const task = generationTask({ activeRunId: 'run-1', nextRunId: null, attempt: 0, status: 'awaiting_input', latestReport: generationReport({ runId: 'run-1', attempt: 0 }) });
    const body = { id: 'run-1', projectId: task.projectId, conversationId: task.conversationId, status: mismatch === 'failed-physical' ? 'failed' : 'succeeded', designGenerationTask: task,
      ...(mismatch === 'missing-strategy' ? {} : { strategyTask: { taskExecutionId: 'strategy-1', activeRunId: 'run-1', terminal: false, outcome: mismatch === 'not-waiting' ? 'running' : 'clarification_required' } }) };
    stub = await startRunStubServer(true, { 'GET /api/runs/run-1': { body }, 'GET /api/runs/run-1/events': { events: [{ event: 'end', data: body }] } });
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('waiting for input');
    expect(stub.requests.some(({ url }) => url === '/api/runs/run-2/events')).toBe(false);
  });

  it('follows an existing historical clarification pointer then stops at input waiting', async () => {
    const task = generationTask({ status: 'awaiting_input', attempt: 0, latestReport: generationReport({ runId: 'run-2', attempt: 0 }) });
    const replies = generationReplies(task, { ...task, nextRunId: null });
    for (const id of ['run-1', 'run-2']) {
      const body = { ...(replies[`GET /api/runs/${id}`]!.body as Record<string, unknown>), status: 'succeeded',
        strategyTask: { taskExecutionId: 'strategy-1', activeRunId: 'run-2', nextRunId: id === 'run-1' ? 'run-2' : null, outcome: 'clarification_required', terminal: false } };
      replies[`GET /api/runs/${id}`] = { body };
      replies[`GET /api/runs/${id}/events`] = { events: [{ event: 'end', data: body }] };
    }
    stub = await startRunStubServer(true, replies);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.filter(({ url }) => url.endsWith('/events')).map(({ url }) => url)).toEqual(['/api/runs/run-1/events', '/api/runs/run-2/events']);
    expect(result.stdout).toContain('"status":"awaiting_input"');
  });

  it('follows the host repair after a failed physical attempt with authenticated status checks', async () => {
    stub = await startRunStubServer(true, generationReplies());
    const result = await runCli(['run', 'watch', 'run-1', '--workspace', 'team', '--workspace-member', 'member', '--daemon-url', stub.baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /api/runs/run-1/events', 'GET /api/runs/run-1', 'GET /api/runs/run-2',
      'GET /api/runs/run-2/events', 'GET /api/runs/run-2',
    ]);
    for (const request of stub.requests) {
      expect(request.headers['x-od-workspace-id']).toBe('team');
      expect(request.headers['x-od-workspace-member-id']).toBe('member');
    }
    const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0].data).toMatchObject({ status: 'failed', designGeneration: { attempt: 0 }, designGenerationTask: { attempt: 1, status: 'repairing' } });
    expect(events[1].data.designGenerationTask.status).toBe('succeeded');
  });

  it.each(['blocked', 'canceled'] as const)('returns failure only at the logical %s outcome', async (status) => {
    const child = generationTask({ status, nextRunId: null, latestReport: generationReport({ decision: status }) });
    stub = await startRunStubServer(true, generationReplies(generationTask(), child));
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`design generation ${status}`);
    expect(result.stdout).toContain(`"status":"${status}"`);
    expect(stub.requests.some(({ url }) => url === '/api/runs/run-2/events')).toBe(true);
  });

  it('retains normal Full Plan stages before the one design repair', async () => {
    const responses: Record<string, StubResponse> = {};
    for (let index = 1; index <= 4; index++) {
      const activeRunId = `run-${Math.min(index + 1, 4)}`;
      const task = generationTask({ activeRunId, nextRunId: index === 4 ? null : activeRunId,
        attempt: index < 3 ? 0 : 1, status: index < 3 ? 'running' : index === 3 ? 'repairing' : 'succeeded',
        latestReport: index === 4 ? generationReport({ runId: 'run-4' }) : null });
      const body = { id: `run-${index}`, projectId: task.projectId, conversationId: task.conversationId,
        status: index === 3 ? 'failed' : 'succeeded', designGenerationTask: task,
        strategyTask: { taskExecutionId: 'strategy-1', activeRunId, nextRunId: task.nextRunId, terminal: index === 4 } };
      responses[`GET /api/runs/run-${index}`] = { body };
      responses[`GET /api/runs/run-${index}/events`] = { events: [{ event: 'end', data: body }] };
    }
    stub = await startRunStubServer(true, responses);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.filter(({ url }) => url.endsWith('/events')).map(({ url }) => url)).toEqual([
      '/api/runs/run-1/events', '/api/runs/run-2/events', '/api/runs/run-3/events', '/api/runs/run-4/events',
    ]);
  });

  it('never follows a transient diagnostic when the final event has no authorized successor', async () => {
    const replies = generationReplies();
    replies['GET /api/runs/run-1/events'] = { events: [
      { event: 'diagnostic', data: { type: 'design_generation', report: generationReport(), designGenerationTask: generationTask() } },
      { event: 'end', data: { status: 'failed' } },
    ] };
    stub = await startRunStubServer(true, replies);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.map(({ url }) => url)).toEqual(['/api/runs/run-1/events']);
    expect(result.stdout).toContain('"event":"diagnostic"');
  });

  it('recovers a missing end event only through authoritative terminal status', async () => {
    const replies = generationReplies();
    replies['GET /api/runs/run-1/events'] = { events: [{ event: 'text_delta', data: { text: 'working' } }] };
    stub = await startRunStubServer(true, replies);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.some(({ url }) => url === '/api/runs/run-2/events')).toBe(true);
  });

  it('uses the current authorized successor when historical end events lag behind status', async () => {
    const replies = generationReplies();
    const sourceStatus = replies['GET /api/runs/run-1']!.body as Record<string, unknown>;
    sourceStatus.designGenerationTask = generationTask({ activeRunId: 'run-3', nextRunId: 'run-3' });
    const task = generationTask({ activeRunId: 'run-3', nextRunId: null, status: 'succeeded', latestReport: generationReport({ runId: 'run-3' }) });
    const body = { id: 'run-3', projectId: task.projectId, conversationId: task.conversationId, status: 'succeeded', designGenerationTask: task };
    replies['GET /api/runs/run-3'] = { body };
    replies['GET /api/runs/run-3/events'] = { events: [{ event: 'end', data: body }] };
    stub = await startRunStubServer(true, replies);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.filter(({ url }) => url.endsWith('/events')).map(({ url }) => url)).toEqual(['/api/runs/run-1/events', '/api/runs/run-3/events']);
  });

  it.each(['malformed end', 'nonterminal status'] as const)('rejects %s before following a successor', async (kind) => {
    const replies = generationReplies();
    if (kind === 'malformed end') replies['GET /api/runs/run-1/events'] = { events: [{ event: 'end', data: { status: 'failed', designGenerationTask: null } }] };
    else (replies['GET /api/runs/run-1']!.body as Record<string, unknown>).status = 'running';
    stub = await startRunStubServer(true, replies);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run watch failed');
    expect(stub.requests.some(({ url }) => url === '/api/runs/run-2/events')).toBe(false);
  });

  it.each([
    ['execution', { executionId: 'foreign', latestReport: null }],
    ['project', { projectId: 'foreign' }],
    ['conversation', { conversationId: 'foreign' }],
    ['initial run', { initialRunId: 'foreign' }],
    ['attempt reset', { attempt: 0, status: 'running', latestReport: null }],
    ['second repair', { attempt: 2, latestReport: null }],
  ] as const)('rejects child %s drift before opening its event stream', async (_label, change) => {
    const replies = generationReplies();
    const child = replies['GET /api/runs/run-2']!.body as Record<string, unknown>;
    child.designGenerationTask = { ...child.designGenerationTask as object, ...change };
    stub = await startRunStubServer(true, replies);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run watch failed');
    expect(stub.requests.some(({ url }) => url === '/api/runs/run-2/events')).toBe(false);
  });

  it.each(['projection', 'status scope', 'unauthorized', 'cycle'] as const)('rejects %s disagreement without following it', async (kind) => {
    const replies = generationReplies();
    if (kind === 'projection') {
      const body = replies['GET /api/runs/run-1']!.body as Record<string, unknown>;
      body.strategyTask = { activeRunId: 'foreign', nextRunId: 'foreign', terminal: false };
    } else if (kind === 'status scope') {
      (replies['GET /api/runs/run-2']!.body as Record<string, unknown>).projectId = 'foreign';
    } else if (kind === 'unauthorized') {
      replies['GET /api/runs/run-2'] = { statusCode: 403, body: { error: { code: 'FORBIDDEN' } } };
    } else {
      const body = replies['GET /api/runs/run-2']!.body as Record<string, unknown>;
      body.designGenerationTask = generationTask({ activeRunId: 'run-1', nextRunId: 'run-1' });
    }
    stub = await startRunStubServer(true, replies);
    const result = await runCli(['run', 'watch', 'run-1', '--daemon-url', stub.baseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run watch failed');
    expect(stub.requests.some(({ url }) => url === '/api/runs/run-2/events')).toBe(false);
  });

  it('shows logical generation status beside physical status and keeps JSON evidence intact', async () => {
    const task = generationTask();
    const run = { id: 'run-1', status: 'failed', designGenerationTask: task };
    stub = await startRunStubServer(true, {
      'GET /api/runs': { body: { runs: [run] } },
      'GET /api/runs/run-1/result-package': { body: { run, designGeneration: task.latestReport, designGenerationTask: task } },
      'POST /api/runs/run-1/cancel': { body: { ok: true, run: { ...run, designGenerationTask: { ...task, status: 'canceled' } } } },
    });
    for (const args of [['list'], ['result-package', 'run-1'], ['cancel', 'run-1']]) {
      const result = await runCli(['run', ...args, '--daemon-url', stub.baseUrl]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('generation=generation-1');
      expect(result.stdout).toContain('attempt=1/1');
      expect(result.stdout).toContain(args[0] === 'cancel' ? 'generation-status=canceled' : 'generation-status=repairing');
    }
    const json = await runCli(['run', 'result-package', 'run-1', '--json', '--daemon-url', stub.baseUrl]);
    expect(JSON.parse(json.stdout)).toMatchObject({ designGeneration: { attempt: 0 }, designGenerationTask: task });
  });

  it('keeps one --skill backward compatible and sends multiple ids canonically', async () => {
    stub = await startRunStubServer(true);
    const single = await runCli([
      'run', 'start', '--project', 'project-1', '--skill', 'frontend-design',
      '--daemon-url', stub.baseUrl,
    ]);
    expect(single.code, single.stderr).toBe(0);
    expect(JSON.parse(stub.requests[0]!.body)).toMatchObject({
      skillId: 'frontend-design',
    });
    expect(JSON.parse(stub.requests[0]!.body).skillIds).toBeUndefined();

    const multiple = await runCli([
      'run', 'start', '--project', 'project-1',
      '--skill', 'frontend-design, imagegen,frontend-design',
      '--daemon-url', stub.baseUrl,
    ]);
    expect(multiple.code, multiple.stderr).toBe(0);
    expect(JSON.parse(stub.requests[1]!.body)).toMatchObject({
      skillId: 'frontend-design',
      skillIds: ['frontend-design', 'imagegen'],
    });
  });

  it('continues a resumable run through the normal run creation API', async () => {
    stub = await startRunStubServer(true);

    const result = await runCli([
      'run',
      'continue',
      'run-1',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('[run] continued run-1 as run-2\n');
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/runs/run-1',
      'POST /api/runs',
    ]);
    expect(JSON.parse(stub.requests[1]!.body)).toMatchObject({
      projectId: 'project-1',
      conversationId: 'conversation-1',
      agentId: 'claude',
      analyticsHints: { entryFrom: 'resume_continue' },
    });
    expect(JSON.parse(stub.requests[1]!.body).message).toContain(
      'The previous turn was interrupted by a transient failure.',
    );
    for (const request of stub.requests) {
      expect(request.headers['x-od-workspace-id']).toBeUndefined();
      expect(request.headers['x-od-workspace-member-id']).toBeUndefined();
    }
  });

  it('refuses to continue a run without a safe recoverable native session', async () => {
    stub = await startRunStubServer(false);

    const result = await runCli([
      'run',
      'continue',
      'run-1',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Run run-1 does not have a safe recoverable native session.');
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/runs/run-1',
    ]);
  });

  it('forwards explicit Workspace scope through continue status and creation requests', async () => {
    stub = await startRunStubServer(true);

    const result = await runCli([
      'run',
      'continue',
      'run-1',
      '--workspace',
      'team-workspace',
      '--workspace-member',
      'creator-member',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(stub.requests).toHaveLength(2);
    for (const request of stub.requests) {
      expect(request.headers['x-od-workspace-id']).toBe('team-workspace');
      expect(request.headers['x-od-workspace-member-id']).toBe('creator-member');
    }
  });

  it.each([
    {
      label: 'list',
      args: ['run', 'list', '--json'],
      requests: ['GET /api/runs'],
    },
    {
      label: 'project list',
      args: ['run', 'list', '--project', 'project-1', '--json'],
      requests: ['GET /api/runs?projectId=project-1'],
    },
    {
      label: 'info',
      args: ['run', 'info', 'run-1'],
      requests: ['GET /api/runs/run-1'],
    },
    {
      label: 'result package',
      args: ['run', 'result-package', 'run-1', '--json'],
      requests: ['GET /api/runs/run-1/result-package'],
    },
    {
      label: 'cancel',
      args: ['run', 'cancel', 'run-1'],
      requests: ['POST /api/runs/run-1/cancel'],
    },
    {
      label: 'redesign',
      args: ['run', 'redesign', '--project', 'project-1', '--json'],
      requests: ['POST /api/runs'],
    },
    {
      label: 'redesign import and start',
      args: ['run', 'redesign', '--path', DAEMON_ROOT, '--json'],
      requests: ['POST /api/import/folder', 'POST /api/runs'],
    },
    {
      label: 'start and follow',
      args: ['run', 'start', '--project', 'project-1', '--follow'],
      requests: ['POST /api/runs', 'GET /api/runs/run-2/events'],
    },
    {
      label: 'watch',
      args: ['run', 'watch', 'run-1'],
      requests: ['GET /api/runs/run-1/events'],
    },
  ])('forwards explicit Workspace scope for $label requests', async ({ args, requests }) => {
    stub = await startRunStubServer(true);

    const result = await runCli([
      ...args,
      '--workspace',
      'team-workspace',
      '--workspace-member',
      'creator-member',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual(requests);
    for (const request of stub.requests) {
      expect(request.headers['x-od-workspace-id']).toBe('team-workspace');
      expect(request.headers['x-od-workspace-member-id']).toBe('creator-member');
    }
  });

  it('keeps no-scope run creation and streaming requests headerless', async () => {
    stub = await startRunStubServer(true);

    const result = await runCli([
      'run',
      'start',
      '--project',
      'project-1',
      '--follow',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runs',
      'GET /api/runs/run-2/events',
    ]);
    for (const request of stub.requests) {
      expect(request.headers['x-od-workspace-id']).toBeUndefined();
      expect(request.headers['x-od-workspace-member-id']).toBeUndefined();
    }
  });

  it('uses an explicit task continuation handle and follows every projected active Run', async () => {
    stub = await startRunStubServer(true);
    tempDir = await mkdtemp(join(tmpdir(), 'od-run-task-chain-'));
    const promptFile = join(tempDir, 'answer.txt');
    await writeFile(promptFile, 'Desktop first', 'utf8');

    const result = await runCli([
      'run',
      'start',
      '--project',
      'project-1',
      '--task-execution',
      'task-1',
      '--prompt-file',
      promptFile,
      '--follow',
      '--daemon-url',
      stub.baseUrl,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'POST /api/runs',
      'GET /api/runs/run-1/events',
      'GET /api/runs/run-2/events',
    ]);
    expect(JSON.parse(stub.requests[0]!.body)).toMatchObject({
      projectId: 'project-1',
      taskExecutionId: 'task-1',
      message: 'Desktop first',
    });
    const events = result.stdout
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line));
    expect(events).toHaveLength(2);
    expect(events[0].data.strategyTask).toMatchObject({
      activeRunId: 'run-2',
      terminal: false,
    });
    expect(events[1].data.strategyTask).toMatchObject({
      outcome: 'completed',
      terminal: true,
    });

    const canceled = await runCli([
      'run',
      'cancel',
      'run-1',
      '--daemon-url',
      stub.baseUrl,
    ]);
    expect(canceled.code, canceled.stderr).toBe(0);
    expect(canceled.stdout).toContain('[run] cancelled run-2');
    expect(canceled.stdout).toContain('task\ttask-1\tactive=run-2\toutcome=canceled');
  });
});
