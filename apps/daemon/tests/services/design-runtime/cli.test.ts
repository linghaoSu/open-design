import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectComponentDefinition, ProjectDesignRuntimeState, ReferenceGraphQueryResult, ResolvedUIIRResult, SharedComponentDraft, SharedComponentImpact, ValidationDiagnostic } from '@open-design/contracts';
import { instantiateDesignSystemMigrationRecipe } from '../../../src/services/design-runtime/migration-recipes.js';
import { upgradeFixture } from '../../fixtures/design-runtime/design-system-upgrade.js';
import { reviewDesignSystemUpgrade, applyDesignSystemUpgrade } from '../../../src/services/design-runtime/design-system-upgrade.js';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';
import { mixedProjectCompilerRequest } from '../../fixtures/design-runtime/compiler-selections.js';
import { createDesignSystemVersion } from '../../../src/services/design-runtime/design-system-version.js';
import { localHandoffFixture } from '../../fixtures/design-runtime/handoff.js';
import { createHandoff } from '../../../src/services/design-runtime/handoff.js';
import { emitHandoffCode } from '../../../src/services/design-runtime/handoff-emitter.js';

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
    projectCodeIndex: { schemaVersion: 1, id: 'acme', components: [] },
    bindings: { schemaVersion: 1, id: 'acme', bindings: [{ schemaVersion: 1, id: 'binding:acme/Button', componentRef: 'ds:acme/button', framework: 'react', status: 'bound', verified: true, codeComponentId: 'acme/Button' }] },
    projectComponents: { schemaVersion: 1, id: 'acme', components: [] },
    document: null,
    sharedChanges: { schemaVersion: 1, id: 'acme', drafts: [], history: [] },
    dependencies: { schemaVersion: 1, id: 'acme', dependencies: [] },
    lock: { schemaVersion: 1, id: 'acme', dependencies: [] },
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

describe('od design-runtime production handoff dispatcher', () => {
  it('registers a local implementation from a file with one CAS read and exact workspace headers', async () => {
    const fixture = localHandoffFixture(); const binding = fixture.snapshot.bindings.bindings.find((entry) => entry.componentRef.startsWith('local:'))!;
    const code = fixture.snapshot.projectCodeIndex.components[0]!;
    const input = { source: { framework: code.framework, sourcePath: code.sourcePath, exportName: code.exportName, codeComponentId: code.id }, binding };
    const stub = await startServer(({ method }) => ({ body: method === 'GET' ? { state: state() } : { state: state(8), binding, diagnostics: [] } }));
    const output = await runCli(['design-runtime', 'register-local-binding', projectId, '--prompt-file', await inputFile(input), '--json', '--daemon-url', stub.url, ...scope]);
    expect(output.code, output.stderr).toBe(0); expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1]).toMatchObject({ method: 'POST', url: `${prefix}/project-code-components/register-binding`, body: { ...input, expectedRevision: 7 } });
    for (const request of stub.requests) expect(request.headers['x-od-workspace-member-id']).toBe('member-1');
    expect(JSON.parse(output.stdout).binding.propMappings).toEqual(binding.propMappings);
  });
  it('lists owned code and refreshes an encoded code ID, returning broken-source diagnostics as failure after the persisted change', async () => {
    const code = localHandoffFixture().snapshot.projectCodeIndex.components[0]!;
    const diagnostic = { schemaVersion: 1, severity: 'error', code: 'ODDS7004', message: 'Source unavailable.' };
    const stub = await startServer(({ method }) => ({ body: method === 'GET' ? { revision: 7, components: [code] } : { state: state(8), diagnostics: [diagnostic] } }));
    const listed = await runCli(['design-runtime', 'project-code-components', projectId, '--query', 'Card + text', '--json', '--daemon-url', stub.url]);
    expect(listed.code).toBe(0); expect(JSON.parse(listed.stdout).components).toEqual([code]);
    const refreshed = await runCli(['design-runtime', 'refresh-code-component', projectId, code.id, '--expected-revision', '7', '--json', '--daemon-url', stub.url]);
    expect(refreshed.code).toBe(1); expect(JSON.parse(refreshed.stdout).state.revision).toBe(8); expect(refreshed.stderr).toBe('');
    expect(stub.requests.map((request) => request.url)).toEqual([`${prefix}/project-code-components?query=Card+%2B+text`, `${prefix}/project-code-components/project%2Fcard/refresh`]);
  });
  it.each(['react', 'vue'] as const)('creates a read-only %s handoff and emits actual source to stdout without writing output files', async (framework) => {
    const fixture = localHandoffFixture(framework); fixture.projectRevision = 7;
    const result = createHandoff(fixture); if (!result.manifest) throw new Error('Fixture has no manifest');
    const outputs = [{ screenId: 'main', sourcePath: `nested/Main.${framework === 'vue' ? 'vue' : 'tsx'}`, exportName: framework === 'vue' ? 'default' : 'Main' }];
    const code = emitHandoffCode({ manifest: result.manifest, outputs });
    const stub = await startServer(({ url }) => ({ body: url.endsWith('/emit') ? { revision: 7, handoff: result, code } : { revision: 7, result } }));
    const input = { expectedRevision: 7, id: 'handoff', framework };
    const created = await runCli(['design-runtime', 'handoff', projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify(input));
    expect(created.code, created.stderr).toBe(0); expect(JSON.parse(created.stdout).result.manifest.ready).toBe(true);
    const emitted = await runCli(['design-runtime', 'emit-handoff', projectId, '--prompt-file', '-', '--daemon-url', stub.url], JSON.stringify({ ...input, outputs }));
    expect(emitted.code, emitted.stderr).toBe(0); expect(emitted.stdout).toContain(`File: ${outputs[0]!.sourcePath}`); expect(emitted.stdout).toContain('filled');
    expect(stub.requests).toHaveLength(2); expect(stub.requests[1]!.body).toEqual({ ...input, outputs });
  });
  it('prints actionable not-ready diagnostics and rejects caller evidence, traversal and extra positionals before HTTP', async () => {
    const failure = { schemaVersion: 1, manifest: null, diagnostics: [{ schemaVersion: 1, code: 'ODDS7001', severity: 'error', message: 'Register the missing local implementation.' }] };
    const stub = await startServer(() => ({ body: { revision: 7, result: failure } }));
    const input = { expectedRevision: 7, id: 'handoff', framework: 'react' };
    for (const extra of [{ snapshot: {} }, { targetPackages: [] }, { changeContext: {} }]) {
      const invalid = await runCli(['design-runtime', 'handoff', projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify({ ...input, ...extra }));
      expect(invalid.code).toBe(2);
    }
    expect((await runCli(['design-runtime', 'refresh-code-component', projectId, '../code', '--expected-revision', '7', '--json', '--daemon-url', stub.url])).code).toBe(2);
    expect((await runCli(['design-runtime', 'handoff', projectId, 'extra', '--json', '--daemon-url', stub.url])).code).toBe(2);
    expect(stub.requests).toHaveLength(0);
    const result = await runCli(['design-runtime', 'handoff', projectId, '--prompt-file', '-', '--daemon-url', stub.url], JSON.stringify(input));
    expect(result.code).toBe(1); expect(result.stdout).toContain('ODDS7001'); expect(result.stderr).toBe('');
  });
  it('reports handoff revision conflicts without retry or an implicit revision change', async () => {
    const body = { error: { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Changed', details: { expectedRevision: 7, currentRevision: 8 } } };
    const stub = await startServer(() => ({ status: 409, body }));
    const result = await runCli(['design-runtime', 'handoff', projectId, '--prompt-file', '-', '--expected-revision', '7', '--json', '--daemon-url', stub.url], JSON.stringify({ id: 'handoff', framework: 'vue' }));
    expect(result.code).toBe(1); expect(JSON.parse(result.stderr)).toEqual({ status: 409, ...body }); expect(stub.requests).toHaveLength(1);
  });
});

function sharedFixture() {
  const definition: ProjectComponentDefinition = { schemaVersion: 1, id: 'Card', name: 'Card', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, id: 'label', type: 'text', text: 'Current' } };
  const proposed: ProjectComponentDefinition = { ...definition, revision: 2, template: { ...definition.template, type: 'text', text: 'Proposed' } };
  const draft: SharedComponentDraft = { schemaVersion: 1, id: 'edit-card', componentRef: 'local:Card', baseDefinition: definition, proposedDefinition: proposed, source: { type: 'edit' } };
  const owner = { kind: 'screen' as const, documentId: 'design', screenId: 'screen' };
  const usage = { schemaVersion: 1 as const, owner, nodeId: 'card-instance', target: 'local:Card', path: ['screens', 0, 'children', 0] };
  const references: ReferenceGraphQueryResult = { schemaVersion: 1, target: 'local:Card', directUsages: [usage], transitiveUsages: [owner], affectedScreens: [owner], chains: [[usage]], cycles: [], diagnostics: [] };
  const resolved: ResolvedUIIRResult = { schemaVersion: 1, document: { schemaVersion: 1, id: 'design', screens: [] }, origins: [], diagnostics: [] };
  const impact: SharedComponentImpact = { schemaVersion: 1, componentRef: 'local:Card', baseRevision: 1, proposedRevision: 2, usages: references, current: resolved, proposed: resolved, diagnostics: [] };
  const current = state();
  current.projectComponents.components = [definition];
  current.document = { schemaVersion: 1, id: 'design', screens: [] };
  current.sharedChanges.drafts = [draft];
  return { definition, proposed, draft, references, resolved, impact, current };
}

describe('od design-runtime CLI dispatcher', () => {
  it('forwards explicit framework, slot policy and grouped story selections through canonical compile JSON', async () => {
    const { request } = mixedProjectCompilerRequest(7);
    const stub = await startServer();
    const result = await runCli(['design-runtime', 'compile', projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url, ...scope], JSON.stringify(request));
    expect(result.code, result.stderr).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.body).toEqual(request);
    expect(stub.requests[0]!.headers['x-od-workspace-id']).toBe('workspace-1');
    expect(JSON.stringify(stub.requests[0]!.body)).not.toContain('sourceText');
  });
  it('advertises commands and JSON, stdin, workspace and revision options through real help', async () => {
    const result = await runCli(['design-runtime', '--help']);
    expect(result.code, result.stderr).toBe(0);
    for (const text of ['compile <projectId>', 'revalidate <projectId> <bindingId>', 'save-document <projectId>', 'references <projectId> <componentRef>', 'stage <projectId>', 'publish <projectId> <draftId>', 'detach <projectId>', 'version <projectId> <designSystemId> <exactVersion>', 'import-version <projectId>', 'publish-version <projectId>', 'activate-dependency <projectId>', 'clear-dependency <projectId>', 'resolve-dependency <projectId>', '--prompt-file <path|->', '--workspace <id>', '--workspace-member <id>', '--expected-revision <n>', '--json']) {
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

describe('od design-runtime version and exact dependency CLI', () => {
  function versionFixture(exactVersion = '1.0.0') {
    const version = createDesignSystemVersion(packageFixture(exactVersion));
    const summary = { id: version.package.id, name: version.package.name, version: version.package.version, digest: version.digest, sourceDigest: version.sourceDigest };
    return { version, summary };
  }

  it('lists versions and reads only the explicit exact version, including encoded SemVer build metadata', async () => {
    const { version, summary } = versionFixture('1.0.0-beta.1+build.2');
    const stub = await startServer((request) => ({ body: request.url.endsWith('/versions') ? { revision: 7, versions: [summary] } : { revision: 7, version } }));
    const list = await runCli(['design-runtime', 'versions', projectId, '--json', '--daemon-url', stub.url, ...scope]);
    expect(list.code, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual({ revision: 7, versions: [summary] });
    const exact = await runCli(['design-runtime', 'version', projectId, 'acme', version.package.version, '--json', '--daemon-url', stub.url, ...scope]);
    expect(exact.code, exact.stderr).toBe(0);
    expect(JSON.parse(exact.stdout)).toEqual({ revision: 7, version });
    expect(stub.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET ${prefix}/versions`, `GET ${prefix}/versions/acme/1.0.0-beta.1%2Bbuild.2`]);
    expect(stub.requests.every((request) => request.headers['x-od-workspace-member-id'] === 'member-1')).toBe(true);
  });

  it('imports a complete frozen package from a JSON file with one revision read and unchanged source bytes', async () => {
    const { version, summary } = versionFixture();
    const response = { state: state(8), version: summary };
    const stub = await startServer((request) => ({ body: request.method === 'GET' ? { state: state() } : response }));
    const file = await inputFile({ package: version.package });
    const result = await runCli(['design-runtime', 'import-version', projectId, '--prompt-file', file, '--json', '--daemon-url', stub.url, ...scope]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(response);
    expect(stub.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET ${prefix}`, `POST ${prefix}/versions`]);
    expect(stub.requests[1]!.body).toEqual({ package: version.package, expectedRevision: 7 });
    expect(stub.requests.every((request) => request.headers['x-od-workspace-id'] === 'workspace-1')).toBe(true);
    expect(JSON.parse(result.stdout).state.lock.dependencies).toEqual([]);
  });

  it('rejects a substituted version in a successful daemon response', async () => {
    const { version } = versionFixture('1.1.0');
    const stub = await startServer(() => ({ body: { revision: 7, version } }));
    const result = await runCli(['design-runtime', 'version', projectId, 'acme', '1.0.0', '--json', '--daemon-url', stub.url]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.message).toContain('different design-system identity or exact version');
    expect(stub.requests).toHaveLength(1);
  });

  it('publishes selected project-relative paths through the daemon and prints exact identity and digests', async () => {
    const { summary } = versionFixture();
    const input = { name: 'Acme UI', version: '1.0.0', sourcePaths: ['src/Button.tsx', 'DESIGN.md'] };
    const stub = await startServer(() => ({ body: { state: state(8), version: summary } }));
    const result = await runCli(['design-runtime', 'publish-version', projectId, '--prompt-file', '-', '--expected-revision', '7', '--daemon-url', stub.url], JSON.stringify(input));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Published: acme@1.0.0');
    expect(result.stdout).toContain(`Package digest: ${summary.digest}`);
    expect(result.stdout).toContain(`Source digest: ${summary.sourceDigest}`);
    expect(result.stdout).toContain('Dependency: (none)');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]).toMatchObject({ method: 'POST', url: `${prefix}/versions/publish-current`, body: { ...input, expectedRevision: 7 } });
  });

  it('activates explicit range/version intent, resolves the lock and clears it with CAS through the same authority', async () => {
    const { version } = versionFixture();
    const activated = state(8);
    activated.dependencies.dependencies = [{ designSystemId: 'acme', version: '^1.0.0' }];
    activated.lock.dependencies = [{ designSystemId: 'acme', version: '1.0.0', digest: version.digest, source: { type: 'bundle', digest: version.sourceDigest } }];
    const resolution = { schemaVersion: 1, ok: true, versions: [version], diagnostics: [] };
    const stub = await startServer((request) => ({ body: request.url.endsWith('/resolve') ? { revision: 8, resolution } : { state: request.method === 'DELETE' ? state(9) : activated } }));
    const input = { expectedRevision: 7, designSystemId: 'acme', version: '1.0.0', range: '^1.0.0' };
    const activate = await runCli(['design-runtime', 'activate-dependency', projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url, ...scope], JSON.stringify(input));
    expect(activate.code, activate.stderr).toBe(0);
    expect(JSON.parse(activate.stdout).state).toEqual(activated);
    const resolve = await runCli(['design-runtime', 'resolve-dependency', projectId, '--json', '--daemon-url', stub.url, ...scope]);
    expect(resolve.code, resolve.stderr).toBe(0);
    expect(JSON.parse(resolve.stdout)).toEqual({ revision: 8, resolution });
    const clear = await runCli(['design-runtime', 'clear-dependency', projectId, '--expected-revision', '8', '--json', '--daemon-url', stub.url, ...scope]);
    expect(clear.code, clear.stderr).toBe(0);
    expect(JSON.parse(clear.stdout).state.lock.dependencies).toEqual([]);
    expect(stub.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: `${prefix}/dependency`, body: input },
      { method: 'GET', url: `${prefix}/dependency/resolve`, body: undefined },
      { method: 'DELETE', url: `${prefix}/dependency`, body: { expectedRevision: 8 } },
    ]);
    expect(stub.requests.every((request) => request.headers['x-od-workspace-member-id'] === 'member-1')).toBe(true);
  });

  it('returns exact-lock resolution failures without attempting to select or fetch a newer version', async () => {
    const resolution = { schemaVersion: 1, ok: false, versions: [], diagnostics: [{ schemaVersion: 1, code: 'ODDS5003', severity: 'error', message: 'Locked acme@1.0.0 is unavailable.' }] };
    const stub = await startServer(() => ({ body: { revision: 7, resolution } }));
    const result = await runCli(['design-runtime', 'resolve-dependency', projectId, '--json', '--daemon-url', stub.url]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ revision: 7, resolution });
    expect(stub.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET ${prefix}/dependency/resolve`]);
  });

  it('preserves immutable publication and aggregate revision errors without retrying', async () => {
    const errors = [
      { code: 'DESIGN_RUNTIME_VERSION_IMMUTABLE', message: 'Published version is immutable.', details: { designSystemId: 'acme', version: '1.0.0', diagnostics: [{ schemaVersion: 1, code: 'ODDS5006', severity: 'error', message: 'Cannot overwrite acme@1.0.0.' }] } },
      { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Project revision changed.', details: { expectedRevision: 7, currentRevision: 8 } },
    ];
    const stub = await startServer((request) => ({ status: 409, body: { error: request.url.endsWith('/publish-current') ? errors[0] : errors[1] } }));
    const publication = await runCli(['design-runtime', 'publish-version', projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify({ expectedRevision: 7, name: 'Acme', version: '1.0.0', sourcePaths: ['src/Button.tsx'] }));
    expect(publication.code).toBe(1);
    expect(JSON.parse(publication.stderr)).toEqual({ status: 409, error: errors[0] });
    const clear = await runCli(['design-runtime', 'clear-dependency', projectId, '--expected-revision', '7', '--json', '--daemon-url', stub.url]);
    expect(clear.code).toBe(1);
    expect(JSON.parse(clear.stderr)).toEqual({ status: 409, error: errors[1] });
    expect(stub.requests).toHaveLength(2);
  });

  it('rejects implicit latest, incomplete identities, noncanonical bundles and local path bypass before HTTP', async () => {
    const stub = await startServer();
    const cases = [
      { args: ['version', projectId, 'acme'] },
      { args: ['version', projectId, 'acme', 'latest'] },
      { args: ['version', projectId, 'acme', '^1.0.0'] },
      { args: ['version', projectId, 'acme', '1.0.0', 'extra'] },
      { args: ['versions', projectId, '--query', 'latest'] },
      { args: ['resolve-dependency', projectId, 'latest'] },
      { args: ['activate-dependency', projectId, '--prompt-file', '-'], input: { designSystemId: 'acme', range: '^1.0.0' } },
      { args: ['activate-dependency', projectId, '--prompt-file', '-'], input: { designSystemId: 'acme', version: 'latest', range: '*' } },
      { args: ['publish-version', projectId, '--prompt-file', '-'], input: { name: 'Acme', version: '1.0.0', sourcePaths: ['../outside.tsx'] } },
      { args: ['publish-version', projectId, '--prompt-file', '-'], input: { name: 'Acme', version: '1.0.0', sourcePaths: ['src/Button.tsx'], sourceText: 'inline bypass' } },
      { args: ['import-version', projectId, '--prompt-file', '-'], input: { package: { id: 'acme', version: '1.0.0' } } },
    ];
    for (const entry of cases) {
      const result = await runCli(['design-runtime', ...entry.args, '--json', '--daemon-url', stub.url], JSON.stringify(entry.input));
      expect(result.code, entry.args.join(' ')).toBe(2);
      expect(JSON.parse(result.stderr).error.code).toBe('BAD_REQUEST');
    }
    expect(stub.requests).toEqual([]);
  });
});

describe('od design-runtime document and shared component CLI', () => {
  it('saves a document from a local JSON file with one CAS read and workspace scope on both calls', async () => {
    const { current } = sharedFixture();
    const stub = await startServer((request) => ({ body: { state: { ...current, revision: request.method === 'GET' ? 7 : 8 } } }));
    const input = { document: current.document };
    const file = await inputFile(input);
    const result = await runCli(['design-runtime', 'save-document', projectId, '--prompt-file', file, '--json', '--daemon-url', stub.url, ...scope]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).state.revision).toBe(8);
    expect(stub.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET ${prefix}`, `PUT ${prefix}/document`]);
    expect(stub.requests[1]!.body).toEqual({ ...input, expectedRevision: 7 });
    for (const request of stub.requests) expect(request.headers).toMatchObject({ 'x-od-workspace-id': 'workspace-1', 'x-od-workspace-member-id': 'member-1' });
  });

  it('reads all document, local component, usage, history and draft views through canonical endpoints', async () => {
    const fixture = sharedFixture();
    const cases = [
      { command: 'resolve-document', args: [], path: '/document/resolve', body: { revision: 7, resolution: fixture.resolved } },
      { command: 'project-components', args: ['--query', 'Card + header'], path: '/project-components?query=Card+%2B+header', body: { revision: 7, components: [fixture.definition] } },
      { command: 'references', args: ['local:Card'], path: '/references?componentRef=local%3ACard', body: { revision: 7, references: fixture.references } },
      { command: 'deletion', args: ['Card'], path: '/project-components/Card/deletion', body: { revision: 7, analysis: { schemaVersion: 1, componentRef: 'local:Card', canDelete: false, usages: fixture.references, diagnostics: [] } } },
      { command: 'history', args: ['Card'], path: '/project-components/Card/history', body: { revision: 7, history: [{ schemaVersion: 1, componentRef: 'local:Card', definition: fixture.definition, changeId: null }] } },
      { command: 'inspect', args: ['edit-card'], path: '/component-changes/edit-card', body: { revision: 7, draft: fixture.draft, impact: fixture.impact } },
    ];
    const stub = await startServer((request) => ({ body: cases.find((entry) => `${prefix}${entry.path}` === request.url)!.body }));
    for (const entry of cases) {
      const result = await runCli(['design-runtime', entry.command, projectId, ...entry.args, '--json', '--daemon-url', stub.url, ...scope]);
      expect(result.code, `${entry.command}: ${result.stderr}`).toBe(entry.command === 'deletion' ? 1 : 0);
      expect(JSON.parse(result.stdout)).toEqual(entry.body);
      expect(result.stderr).toBe('');
    }
    expect(stub.requests.map(({ method, url }) => `${method} ${url}`)).toEqual(cases.map((entry) => `GET ${prefix}${entry.path}`));
    expect(stub.requests.every((request) => request.headers['x-od-workspace-member-id'] === 'member-1')).toBe(true);
  });

  it('validates a document and materializes an instance from stdin without fetching or changing state', async () => {
    const fixture = sharedFixture();
    const node = fixture.definition.template;
    const detachResponse = { revision: 7, node, origins: [{ nodeId: node.id, sourceNodeId: node.id, instancePath: [{ instanceId: 'card-instance', componentRef: 'local:Card', definitionRevision: 1 }] }], diagnostics: [] };
    const stub = await startServer((request) => ({ body: request.url.endsWith('/detach') ? detachResponse : { revision: 7, resolution: fixture.resolved } }));
    const requests = [
      { command: 'validate-document', input: { document: fixture.current.document }, path: '/document/validate' },
      { command: 'detach', input: { instance: { schemaVersion: 1, id: 'card-instance', type: 'instance', ref: 'local:Card', overrides: [] }, mode: 'guided' }, path: '/instances/detach' },
    ];
    for (const entry of requests) {
      const result = await runCli(['design-runtime', entry.command, projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify(entry.input));
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toHaveProperty('revision', 7);
    }
    expect(stub.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual(requests.map((entry) => ({ method: 'POST', url: `${prefix}${entry.path}`, body: entry.input })));
  });

  it('stages, publishes, discards, stages undo and deletes using explicit CAS and unchanged definition intent', async () => {
    const fixture = sharedFixture();
    const published = { ...fixture.current, revision: 8, projectComponents: { ...fixture.current.projectComponents, components: [fixture.proposed] }, sharedChanges: { ...fixture.current.sharedChanges, drafts: [], history: [{ schemaVersion: 1 as const, componentRef: 'local:Card', definition: fixture.proposed, changeId: fixture.draft.id }] } };
    const undo = { ...fixture.draft, id: 'undo-card', baseDefinition: fixture.proposed, proposedDefinition: { ...fixture.definition, revision: 3 }, source: { type: 'undo' as const, definitionRevision: 1 } };
    const undoState = { ...published, sharedChanges: { ...published.sharedChanges, drafts: [undo], history: [...published.sharedChanges.history, { schemaVersion: 1 as const, componentRef: 'local:Card', definition: fixture.definition, changeId: null }] } };
    const cases = [
      { command: 'stage', args: [], path: '/component-changes', method: 'POST', input: { draftId: fixture.draft.id, expectedDefinitionRevision: 1, definition: fixture.proposed }, response: { state: fixture.current, draft: fixture.draft, impact: fixture.impact } },
      { command: 'publish', args: ['edit-card'], path: '/component-changes/edit-card/publish', method: 'POST', input: { expectedDefinitionRevision: 1 }, response: { state: published, impact: fixture.impact } },
      { command: 'discard', args: ['edit-card'], path: '/component-changes/edit-card', method: 'DELETE', input: undefined, response: { state: published } },
      { command: 'undo', args: ['Card'], path: '/project-components/Card/undo', method: 'POST', input: { draftId: 'undo-card', expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 }, response: { state: undoState, draft: undo, impact: { ...fixture.impact, baseRevision: 2, proposedRevision: 3 } } },
      { command: 'delete', args: ['Card'], path: '/project-components/Card', method: 'DELETE', input: { action: { type: 'replace', replacementRef: 'ds:acme/button' } }, response: { state: published } },
    ];
    const stub = await startServer((request) => ({ body: cases.find((entry) => `${prefix}${entry.path}` === request.url)!.response }));
    for (const entry of cases) {
      const result = await runCli(['design-runtime', entry.command, projectId, ...entry.args, ...(entry.input ? ['--prompt-file', '-'] : []), '--expected-revision', '7', '--json', '--daemon-url', stub.url, ...scope], JSON.stringify(entry.input));
      expect(result.code, `${entry.command}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(entry.response);
    }
    expect(stub.requests.map(({ method, url, body }) => ({ method, url, body }))).toEqual(cases.map((entry) => ({ method: entry.method, url: `${prefix}${entry.path}`, body: { ...entry.input, expectedRevision: 7 } })));
    expect(stub.requests.every((request) => request.headers['x-od-workspace-id'] === 'workspace-1')).toBe(true);
  });

  it('prints useful impact, reference chains and retained-draft diagnostics when a staged change is blocked', async () => {
    const fixture = sharedFixture();
    const diagnostic: ValidationDiagnostic = { schemaVersion: 1, code: 'ODDS1003', severity: 'error', message: 'Existing override is invalid.', nodeId: 'card-instance' };
    const impact = { ...fixture.impact, proposed: { ...fixture.resolved, document: null, diagnostics: [diagnostic] }, diagnostics: [diagnostic] };
    const stub = await startServer(() => ({ body: { state: fixture.current, draft: fixture.draft, impact } }));
    const result = await runCli(['design-runtime', 'stage', projectId, '--prompt-file', '-', '--daemon-url', stub.url], JSON.stringify({ expectedRevision: 7, draftId: fixture.draft.id, expectedDefinitionRevision: 1, definition: fixture.proposed }));
    expect(result.code).toBe(1);
    expect(result.stderr).toBe('');
    for (const text of ['Draft saved: edit-card', 'definition revision 1 -> 2', '1 affected screens', 'design/screen', 'Chain: local:Card <- design/screen', 'ODDS1003']) expect(result.stdout).toContain(text);
    expect(stub.requests).toHaveLength(1);
  });

  it('returns validation and strict detach errors as canonical JSON with exit 1', async () => {
    const fixture = sharedFixture();
    const diagnostics = [{ schemaVersion: 1, code: 'ODDS4006', severity: 'error', message: 'Strict mode rejects design-system detach.' }];
    const stub = await startServer((request) => ({ body: request.url.endsWith('/detach')
      ? { revision: 7, node: null, origins: [], diagnostics }
      : { revision: 7, resolution: { ...fixture.resolved, document: null, diagnostics } } }));
    for (const entry of [
      { command: 'validate-document', input: { document: fixture.current.document } },
      { command: 'detach', input: { instance: { schemaVersion: 1, id: 'button-instance', type: 'instance', ref: 'ds:acme/button', overrides: [] }, mode: 'strict' } },
    ]) {
      const result = await runCli(['design-runtime', entry.command, projectId, '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify(entry.input));
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('ODDS4006');
    }
    expect(stub.requests).toHaveLength(2);
  });

  it('preserves component revision conflict details without retrying publication', async () => {
    const body = { error: { code: 'DESIGN_RUNTIME_COMPONENT_CHANGE_CONFLICT', message: 'The published component revision changed.', details: { expectedDefinitionRevision: 1, currentDefinitionRevision: 2, diagnostics: [] } } };
    const stub = await startServer((request) => request.method === 'GET' ? { body: { state: state() } } : { status: 409, body });
    const result = await runCli(['design-runtime', 'publish', projectId, 'edit-card', '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify({ expectedDefinitionRevision: 1 }));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ status: 409, ...body });
    expect(stub.requests.map(({ method }) => method)).toEqual(['GET', 'POST']);
    expect(stub.requests[1]!.body).toEqual({ expectedRevision: 7, expectedDefinitionRevision: 1 });
  });

  it('rejects missing definition intent, unsafe delete intent and unsupported options before any HTTP', async () => {
    const fixture = sharedFixture();
    const stub = await startServer();
    const cases = [
      { args: ['publish', projectId, 'edit-card', '--prompt-file', '-'], input: {} },
      { args: ['stage', projectId, '--prompt-file', '-'], input: { draftId: 'edit-card', definition: fixture.proposed } },
      { args: ['delete', projectId, 'Card', '--prompt-file', '-'], input: { action: { type: 'replace', replacementRef: 'local:Card' } } },
      { args: ['undo', projectId, 'Card', '--prompt-file', '-'], input: { draftId: 'undo-card', expectedDefinitionRevision: 2, restoreDefinitionRevision: 2 } },
      { args: ['detach', projectId, '--prompt-file', '-', '--expected-revision', '7'], input: {} },
      { args: ['references', projectId, 'Card'] },
      { args: ['history', projectId, 'local:Card'] },
      { args: ['inspect', projectId, 'edit-card', 'extra'] },
      { args: ['resolve-document', projectId, 'extra'] },
      { args: ['deletion', projectId] },
    ];
    for (const entry of cases) {
      const result = await runCli(['design-runtime', ...entry.args, '--json', '--daemon-url', stub.url], JSON.stringify(entry.input));
      expect(result.code, entry.args.join(' ')).toBe(2);
      expect(JSON.parse(result.stderr).error.code).toBe('BAD_REQUEST');
    }
    expect(stub.requests).toEqual([]);
  });
});


describe('reviewed upgrade CLI', () => {
  function upgradeData(blocked = false) {
    const fixture = upgradeFixture();
    const plan = blocked ? { ...fixture.plan, rules: [], bindingDecisions: [] } : fixture.plan;
    const review = reviewDesignSystemUpgrade(fixture.context, fixture.from, fixture.to, plan);
    const input = { plan, reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest };
    const { projectId: _id, projectSources: _sources, ...contextState } = fixture.context;
    const previous = { ...contextState, schemaVersion: 1 as const, registry: fixture.from.package.registry };
    return { fixture, review, input, previous };
  }

  it.each([false, true])('reviews using canonical JSON and reports nonapplicable impact without a mutation (blocked=%s)', async (blocked) => {
    const { fixture, review, previous } = upgradeData(blocked);
    const { requests, url } = await startServer(({ method }) => ({ body: method === 'GET' ? { state: previous } : { revision: previous.revision, review } }));
    const result = await runCli(['design-runtime', 'review-upgrade', projectId, '--daemon-url', url, '--json', '--prompt-file', '-'], JSON.stringify({ plan: review.plan }));
    expect(result.code).toBe(blocked ? 1 : 0);
    expect(JSON.parse(result.stdout)).toEqual({ revision: fixture.context.revision, review });
    expect(result.stderr).toBe('');
    expect(requests.map(({ method, url }) => [method, url])).toEqual([['GET', prefix], ['POST', `${prefix}/upgrades/review`]]);
    expect(requests[1]!.body).toEqual({ expectedRevision: previous.revision, plan: review.plan });
  });

  it('applies a file-supplied complete proof with an explicit revision and workspace authority', async () => {
    const { fixture, review, input, previous } = upgradeData();
    const applied = applyDesignSystemUpgrade(fixture.context, fixture.from, fixture.to, input);
    const { review: _review, ...next } = applied;
    const response = { state: { ...previous, ...next, registry: fixture.to.package.registry, revision: previous.revision + 1 }, review };
    const { requests, url } = await startServer(() => ({ body: response }));
    tempRoot = await mkdtemp(join(tmpdir(), 'od-upgrade-cli-'));
    const file = join(tempRoot, 'apply.json'); await writeFile(file, JSON.stringify(input));
    const result = await runCli(['design-runtime', 'apply-upgrade', projectId, '--daemon-url', url, '--json', '--prompt-file', file, '--expected-revision', String(previous.revision), '--workspace', 'team', '--workspace-member', 'member']);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(response);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: `${prefix}/upgrades/apply`, body: { ...input, expectedRevision: previous.revision }, headers: { 'x-od-workspace-id': 'team', 'x-od-workspace-member-id': 'member' } });
  });

  it('fetches an omitted apply revision once and preserves canonical conflict diagnostics without retry', async () => {
    const { input, previous } = upgradeData();
    const error = { error: { code: 'DESIGN_RUNTIME_UPGRADE_CONFLICT', message: 'The plan changed.', details: { diagnostics: [{ schemaVersion: 1, code: 'ODDS5002', severity: 'error', message: 'Review again.' }] } } };
    const { requests, url } = await startServer(({ method }) => method === 'GET' ? { body: { state: previous } } : { status: 409, body: error });
    const result = await runCli(['design-runtime', 'apply-upgrade', projectId, '--daemon-url', url, '--json', '--prompt-file', '-'], JSON.stringify(input));
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(JSON.parse(result.stderr)).toEqual({ status: 409, ...error });
    expect(requests).toHaveLength(2); expect(requests[1]!.body).toEqual({ ...input, expectedRevision: previous.revision });
  });

  it('rejects incomplete apply proof and duplicate migration targets before any HTTP call', async () => {
    const { fixture } = upgradeData();
    const { requests, url } = await startServer();
    for (const [command, input] of [['apply-upgrade', { plan: fixture.plan }], ['review-upgrade', { plan: { ...fixture.plan, rules: [fixture.plan.rules[0], fixture.plan.rules[0]] } }]] as const) {
      const result = await runCli(['design-runtime', command, projectId, '--daemon-url', url, '--json', '--prompt-file', '-'], JSON.stringify(input));
      expect(result.code).toBe(2); expect(JSON.parse(result.stderr).error.code).toBe('BAD_REQUEST');
    }
    expect(requests).toHaveLength(0);
  });
});


describe('migration recipe CLI', () => {
  function recipeData() {
    const base = upgradeFixture();
    const recipe = { schemaVersion: 1 as const, id: 'button-v2', name: 'Button v2', from: { version: base.from.package.version, digest: base.from.digest }, rules: base.plan.rules, packageBindingDecisions: [] };
    const to = createDesignSystemVersion({ ...base.to.package, migrations: [recipe] });
    const input = { designSystemId: to.package.id, version: to.package.version, recipeId: recipe.id, planId: 'cli-choice', targetRange: '2.0.0' };
    const { designSystemId: _id, version: _version, ...request } = input;
    const response = { revision: base.context.revision, ...instantiateDesignSystemMigrationRecipe(base.context, base.from, to, request) };
    return { recipe, input, response };
  }
  it('lists exact recipes through the same metadata endpoint', async () => {
    const { recipe } = recipeData();
    const response = { revision: 8, recipes: [recipe] };
    const { requests, url } = await startServer(() => ({ body: response }));
    const result = await runCli(['design-runtime', 'migration-recipes', projectId, 'acme', '2.0.0', '--daemon-url', url, '--json']);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(response);
    expect(requests.map(({ method, url }) => [method, url])).toEqual([['GET', `${prefix}/versions/acme/2.0.0/migrations`]]);
  });
  it('reads a JSON recipe choice from stdin, fetches revision once and returns a plan without review or apply', async () => {
    const { input, response } = recipeData();
    const { requests, url } = await startServer(({ method }) => ({ body: method === 'GET' ? { state: state(8) } : response }));
    const result = await runCli(['design-runtime', 'use-migration-recipe', projectId, '--daemon-url', url, '--json', '--prompt-file', '-'], JSON.stringify(input));
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual(response);
    expect(requests.map(({ method, url }) => [method, url])).toEqual([['GET', prefix], ['POST', `${prefix}/upgrades/recipes`]]);
    expect(requests[1]!.body).toEqual({ ...input, expectedRevision: 8 });
  });
  it('rejects a mutable target or injected plan before HTTP and never retries a stale recipe choice', async () => {
    const { input } = recipeData();
    const error = { error: { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Stale snapshot', details: { expectedRevision: 8, currentRevision: 9 } } };
    const { requests, url } = await startServer(() => ({ status: 409, body: error }));
    for (const invalid of [{ ...input, version: 'latest' }, { ...input, plan: {} }]) {
      const result = await runCli(['design-runtime', 'use-migration-recipe', projectId, '--daemon-url', url, '--json', '--prompt-file', '-'], JSON.stringify(invalid));
      expect(result.code).toBe(2);
    }
    expect(requests).toHaveLength(0);
    const result = await runCli(['design-runtime', 'use-migration-recipe', projectId, '--daemon-url', url, '--json', '--expected-revision', '8', '--prompt-file', '-'], JSON.stringify(input));
    expect(result.code).toBe(1); expect(JSON.parse(result.stderr)).toEqual({ status: 409, ...error }); expect(requests).toHaveLength(1);
  });
});
