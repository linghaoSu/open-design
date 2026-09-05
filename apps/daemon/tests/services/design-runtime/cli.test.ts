import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectDesignRuntimeState, ValidationDiagnostic } from '@open-design/contracts';

const daemonRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../../src/cli.ts', import.meta.url));
const tsxEntry = fileURLToPath(new URL('../../../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const projectId = 'project /#1';
const prefix = `/api/projects/${encodeURIComponent(projectId)}/design-runtime`;

interface RequestRecord { method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown }
type Reply = { status?: number; body: unknown };
let server: http.Server | undefined;
let tempRoot: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function state(revision = 7): ProjectDesignRuntimeState {
  return {
    schemaVersion: 1, revision,
    registry: { schemaVersion: 1, id: 'acme', components: [{ schemaVersion: 1, id: 'button', name: 'Button', props: {} }] },
    codeIndex: { schemaVersion: 1, id: 'acme', components: [{ schemaVersion: 1, id: 'acme/Button', framework: 'react', name: 'Button', exportName: 'Button', sourcePath: 'src/Button.tsx', props: {} }] },
    bindings: { schemaVersion: 1, id: 'acme', bindings: [{ schemaVersion: 1, id: 'binding:acme/Button', componentRef: 'ds:acme/button', framework: 'react', status: 'bound', verified: true, codeComponentId: 'acme/Button' }] },
  };
}

async function startServer(reply: (request: RequestRecord) => Reply = () => ({ body: { state: state() } })) {
  const requests: RequestRecord[] = [];
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const request = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) as unknown : undefined };
      requests.push(request);
      const response = reply(request);
      res.writeHead(response.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test HTTP listener');
  return { requests, url: `http://127.0.0.1:${address.port}` };
}

function runCli(args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [tsxEntry, cliEntry, ...args], {
      cwd: daemonRoot,
      timeout: 15_000,
      env: { ...process.env, OD_SKIP_BROWSER: '1' },
    }, (error, stdout, stderr) => {
      const code = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

async function inputFile(value: unknown): Promise<string> {
  tempRoot ??= await mkdtemp(join(tmpdir(), 'od-design-runtime-cli-'));
  const file = join(tempRoot, 'request.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}

const compileRequest = {
  designSystemId: 'acme',
  selections: [{ sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'acme/Button' }],
};
const scope = ['--workspace', 'workspace-1', '--workspace-member', 'member-1'];

describe('od design-runtime CLI dispatcher', () => {
  it('advertises commands and JSON, stdin, workspace and revision options through real help', async () => {
    const result = await runCli(['design-runtime', '--help']);
    expect(result.code, result.stderr).toBe(0);
    for (const text of ['compile <projectId>', 'revalidate <projectId> <bindingId>', '--prompt-file <path|->', '--workspace <id>', '--workspace-member <id>', '--expected-revision <n>', '--json']) {
      expect(result.stdout).toContain(text);
    }
    expect((await runCli(['--help'])).stdout).toContain('od design-runtime');
  });

  it('gets state and searches both indexes through encoded project endpoints', async () => {
    const stub = await startServer((request) => ({ body: request.url === prefix
      ? { state: state() }
      : { revision: 7, components: request.url.includes('/code-components') ? state().codeIndex.components : state().registry!.components } }));
    for (const command of ['get', 'components', 'code-components']) {
      const result = await runCli(['design-runtime', command, projectId, ...(command === 'get' ? [] : ['--query', 'Button + icon']), '--json', '--daemon-url', stub.url]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveProperty(command === 'get' ? 'state' : 'components');
    }
    expect(stub.requests.map((request) => request.url)).toEqual([prefix, `${prefix}/components?query=Button+%2B+icon`, `${prefix}/code-components?query=Button+%2B+icon`]);
    expect(stub.requests.every((request) => request.headers['x-od-workspace-id'] === undefined)).toBe(true);
  });

  it('compiles a file request with one revision read and exact workspace headers on both calls', async () => {
    const stub = await startServer((request) => ({ body: { state: state(request.method === 'GET' ? 7 : 8) } }));
    const file = await inputFile(compileRequest);
    const result = await runCli(['design-runtime', 'compile', projectId, '--prompt-file', file, '--json', '--daemon-url', stub.url, ...scope]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ state: state(8) });
    expect(stub.requests.map((request) => `${request.method} ${request.url}`)).toEqual([`GET ${prefix}`, `POST ${prefix}/compile`]);
    expect(stub.requests[1]!.body).toEqual({ ...compileRequest, expectedRevision: 7 });
    expect(stub.requests[1]!.body).not.toHaveProperty('sourceText');
    for (const request of stub.requests) {
      expect(request.headers['x-od-workspace-id']).toBe('workspace-1');
      expect(request.headers['x-od-workspace-member-id']).toBe('member-1');
    }
  });

  it.each(['body', 'flag'] as const)('honors an explicit %s revision without a preliminary read', async (source) => {
    const stub = await startServer();
    const input = source === 'body' ? { ...compileRequest, expectedRevision: 3 } : compileRequest;
    const result = await runCli(['design-runtime', 'compile', projectId, '--prompt-file', '-', ...(source === 'flag' ? ['--expected-revision', '3'] : []), '--json', '--daemon-url', stub.url], JSON.stringify(input));
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.body).toEqual({ ...compileRequest, expectedRevision: 3 });
  });

  it('binds from stdin using the declared binding identity without reading project sources locally', async () => {
    const stub = await startServer();
    const binding = state().bindings.bindings[0]!;
    const result = await runCli(['design-runtime', 'bind', projectId, '--prompt-file', '-', '--expected-revision', '7', '--json', '--daemon-url', stub.url], JSON.stringify({ binding }));
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: 'PUT', url: `${prefix}/bindings/binding%3Aacme%2FButton`, body: { expectedRevision: 7, binding } });
  });

  it.each([['unbind', 'DELETE', ''], ['revalidate', 'POST', '/revalidate']] as const)('%s sends CAS and encoded binding identity', async (command, method, suffix) => {
    const stub = await startServer();
    const result = await runCli(['design-runtime', command, projectId, 'binding:acme/Button', '--expected-revision', '7', '--json', '--daemon-url', stub.url, ...scope]);
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method, url: `${prefix}/bindings/binding%3Aacme%2FButton${suffix}`, body: { expectedRevision: 7 } });
    expect(stub.requests[0]!.headers['x-od-workspace-member-id']).toBe('member-1');
  });

  it.each([true, false])('resolve returns exact structured result with exit status (ok=%s)', async (ok) => {
    const resolution = ok
      ? { ok: true, component: state().registry!.components[0], codeComponent: state().codeIndex.components[0] }
      : { ok: false, diagnostics: [{ schemaVersion: 1, code: 'ODDS3002', severity: 'error', message: 'Binding is stale.' }] };
    const stub = await startServer(() => ({ body: { revision: 7, resolution } }));
    const result = await runCli(['design-runtime', 'resolve', projectId, 'binding:acme/Button', '--json', '--daemon-url', stub.url]);
    expect(result.code).toBe(ok ? 0 : 1);
    expect(JSON.parse(result.stdout)).toEqual({ revision: 7, resolution });
    expect(result.stderr).toBe('');
    expect(stub.requests[0]!.url).toBe(`${prefix}/bindings/binding%3Aacme%2FButton/resolve`);
  });

  it.each(['valid', 'warning', 'error'] as const)('validate reports %s diagnostics and uses meaningful process status', async (severity) => {
    const diagnostics: ValidationDiagnostic[] = severity === 'valid' ? [] : [{ schemaVersion: 1, code: 'ODDS1003', severity, message: 'Invalid variant.', allowedValues: ['primary'] }];
    const stub = await startServer(() => ({ body: { revision: 7, diagnostics } }));
    const input = { component: 'ds:acme/button', props: { variant: 'filled' } };
    const result = await runCli(['design-runtime', 'validate', projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify(input));
    expect(result.code).toBe(severity === 'error' ? 1 : 0);
    expect(JSON.parse(result.stdout)).toEqual({ revision: 7, diagnostics });
    expect(result.stderr).toBe('');
    expect(stub.requests[0]).toMatchObject({ method: 'POST', url: `${prefix}/validate`, body: input });
  });

  it('preserves canonical HTTP conflict details and never retries a rejected mutation', async () => {
    const body = { error: { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'The project snapshot changed.', details: { expectedRevision: 3, currentRevision: 7 } } };
    const stub = await startServer(() => ({ status: 409, body }));
    const result = await runCli(['design-runtime', 'unbind', projectId, 'binding:acme/Button', '--expected-revision', '3', '--json', '--daemon-url', stub.url]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toEqual({ status: 409, ...body });
    expect(stub.requests).toHaveLength(1);
  });

  it('prints structural diagnostics from canonical error.details for human-readable failures', async () => {
    const stub = await startServer(() => ({ status: 422, body: { error: { code: 'VALIDATION_FAILED', message: 'Binding cannot resolve.', details: { diagnostics: [{ code: 'ODDS3001', message: 'Missing component.' }] } } } }));
    const result = await runCli(['design-runtime', 'revalidate', projectId, 'binding:acme/Button', '--expected-revision', '7', '--daemon-url', stub.url]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('VALIDATION_FAILED: Binding cannot resolve.');
    expect(result.stderr).toContain('ODDS3001');
  });

  it.each([
    ['get', projectId, '--unknown'],
    ['get', projectId, '--query', 'ignored'],
    ['compile', projectId],
    ['get', projectId, '--json', '--json'],
    ['unbind', projectId, 'binding', '--expected-revision', '-1'],
    ['unbind', projectId, 'binding', '--expected-revision', 'NaN'],
    ['unbind', projectId, 'binding', '--expected-revision='],
  ])('rejects malformed arguments before HTTP: %j', async (...args) => {
    const stub = await startServer();
    const result = await runCli(['design-runtime', ...args, '--daemon-url', stub.url]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('BAD_REQUEST');
    expect(stub.requests).toEqual([]);
  });

  it.each([['--workspace', 'workspace-1'], ['--workspace-member', 'member-1']])('uses existing CLI policy to reject partial workspace scope %j', async (...partial) => {
    const stub = await startServer();
    const result = await runCli(['design-runtime', 'get', projectId, ...partial, '--json', '--daemon-url', stub.url]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('workspace-context-required');
    expect(stub.requests).toEqual([]);
  });

  it.each([
    { ...compileRequest, expectedRevision: 1 },
    { ...compileRequest, selections: [{ ...compileRequest.selections[0], sourceText: 'unauthorized inline source' }] },
    { ...compileRequest, selections: [{ ...compileRequest.selections[0], sourcePath: '../outside.tsx' }] },
  ])('rejects conflicting revisions or noncanonical compile input before HTTP %#', async (input) => {
    const stub = await startServer();
    const result = await runCli(['design-runtime', 'compile', projectId, '--prompt-file', '-', '--expected-revision', '7', '--json', '--daemon-url', stub.url], JSON.stringify(input));
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe('BAD_REQUEST');
    expect(stub.requests).toEqual([]);
  });

  it.each(['{', '[]', JSON.stringify({ ...compileRequest, expectedRevision: null })])('rejects malformed JSON requests without reading project state: %s', async (input) => {
    const stub = await startServer();
    const result = await runCli(['design-runtime', 'compile', projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url], input);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.code).toBe('BAD_REQUEST');
    expect(stub.requests).toEqual([]);
  });

  it('rejects malformed daemon success payloads rather than presenting an empty successful result', async () => {
    const stub = await startServer(() => ({ body: { state: { revision: 7 } } }));
    const result = await runCli(['design-runtime', 'get', projectId, '--json', '--daemon-url', stub.url]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.message).toContain('Daemon response did not match the contract');
  });
});
