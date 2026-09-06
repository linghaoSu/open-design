import { execFile } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultProjectDesignValidationSettings, LegacyDesignSystemMigrationReviewSchema,
  type LegacyDesignSystemMigrationPlan, type ProjectDesignRuntimeState } from '@open-design/contracts';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';

const daemonRoot = fileURLToPath(new URL('../../../', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../../src/cli.ts', import.meta.url));
const tsxEntry = fileURLToPath(new URL('../../../../../node_modules/tsx/dist/cli.mjs', import.meta.url));
const prefix = '/api/projects/project/design-runtime';
interface RequestRecord { method: string; url: string; headers: http.IncomingHttpHeaders; body: unknown }
let server: http.Server | undefined;
let scratch: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function fixture(canApply = true) {
  const pkg = packageFixture(); pkg.tokens.tokens = []; pkg.patterns.patterns = []; pkg.registry.components = pkg.registry.components.filter((component) => component.id === 'Button');
  const digest = `sha256:${'a'.repeat(64)}`; const sourceDigest = `sha256:${'b'.repeat(64)}`;
  const plan: LegacyDesignSystemMigrationPlan = { schemaVersion: 1, designSystemId: pkg.id, name: pkg.name, version: pkg.version, mode: 'guided', sourcePaths: pkg.source.files.map((file) => file.path),
    selections: [{ sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'Button', codeComponentId: 'ui/Button', packageName: '@acme/ui' }], constraints: pkg.constraints, codeCompatibility: pkg.codeCompatibility };
  const state: ProjectDesignRuntimeState = { schemaVersion: 1, revision: 7, registry: null, validationSettings: defaultProjectDesignValidationSettings(), generationTargets: { schemaVersion: 1, outputs: [] },
    codeIndex: { schemaVersion: 1, id: 'project', components: [] }, projectCodeIndex: { schemaVersion: 1, id: 'project', components: [] }, bindings: { schemaVersion: 1, id: 'project', bindings: [] },
    projectComponents: { schemaVersion: 1, id: 'project', components: [] }, document: null, sharedChanges: { schemaVersion: 1, id: 'project', drafts: [], history: [] },
    dependencies: { schemaVersion: 1, id: 'project', dependencies: [] }, lock: { schemaVersion: 1, id: 'project', dependencies: [] } };
  const review = LegacyDesignSystemMigrationReviewSchema.parse({ schemaVersion: 1, id: 'legacy-proof', projectId: 'project', baseRevision: 7, baseDigest: digest, planDigest: digest, sourceDigest,
    files: plan.sourcePaths.map((path) => ({ path, digest, byteLength: 20 })), candidate: canApply ? { schemaVersion: 1, package: pkg, digest, sourceDigest } : null,
    tokens: [], compiledComponentRefs: canApply ? ['ds:acme/Button'] : [], preservedSourcePaths: plan.sourcePaths,
    diagnostics: canApply ? [] : [{ schemaVersion: 1, code: 'ODDS9001', severity: 'error', message: 'No convertible facts.' }], canApply });
  const version = { id: pkg.id, name: pkg.name, version: pkg.version, digest, sourceDigest };
  const applied = { state: { ...state, revision: 8, registry: pkg.registry,
    validationSettings: { ...state.validationSettings, mode: plan.mode },
    dependencies: { ...state.dependencies, dependencies: [{ designSystemId: pkg.id, version: pkg.version }] },
    lock: { ...state.lock, dependencies: [{ designSystemId: pkg.id, version: pkg.version, digest, source: { type: 'bundle', digest: sourceDigest } }] },
  }, review, version };
  const proof = { plan, reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, sourceDigest: review.sourceDigest };
  return { state, plan, review, applied, proof };
}

async function startServer(reply: (request: RequestRecord) => { status?: number; body: unknown }) {
  const requests: RequestRecord[] = [];
  server = http.createServer((req, res) => {
    let text = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const record = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) as unknown : undefined }; requests.push(record);
      const result = reply(record); res.writeHead(result.status ?? 200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No mock HTTP listener');
  return { requests, url: `http://127.0.0.1:${address.port}` };
}

function runCli(args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [tsxEntry, cliEntry, 'design-runtime', ...args], { cwd: daemonRoot, timeout: 15_000, env: { ...process.env, OD_SKIP_BROWSER: '1' } }, (error, stdout, stderr) => {
      resolve({ code: error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

describe('legacy migration CLI', () => {
  it('reviews stdin JSON with one revision read and exact Workspace authority, preserving source and compile selections', async () => {
    const data = fixture(); const stub = await startServer(({ method }) => ({ body: method === 'GET' ? { state: data.state } : { revision: 7, review: data.review } }));
    const result = await runCli(['review-legacy', 'project', '--prompt-file', '-', '--json', '--workspace', 'team', '--workspace-member', 'member', '--daemon-url', stub.url], JSON.stringify({ plan: data.plan }));
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ revision: 7, review: data.review });
    expect(stub.requests.map(({ method, url }) => [method, url])).toEqual([['GET', prefix], ['POST', `${prefix}/legacy-migration/review`]]);
    expect(stub.requests[1]!.body).toEqual({ expectedRevision: 7, plan: data.plan });
    for (const request of stub.requests) expect(request.headers).toMatchObject({ 'x-od-workspace-id': 'team', 'x-od-workspace-member-id': 'member' });
  });
  it('applies a file-supplied exact proof once with an explicit revision', async () => {
    const data = fixture(); const stub = await startServer(() => ({ body: data.applied }));
    scratch = await mkdtemp(join(tmpdir(), 'od-legacy-cli-')); const file = join(scratch, 'proof.json'); await writeFile(file, JSON.stringify(data.proof));
    const result = await runCli(['apply-legacy', 'project', '--prompt-file', file, '--expected-revision', '7', '--json', '--daemon-url', stub.url]);
    expect(result.code, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(data.applied);
    expect(stub.requests).toHaveLength(1); expect(stub.requests[0]).toMatchObject({ method: 'POST', url: `${prefix}/legacy-migration/apply`, body: { expectedRevision: 7, ...data.proof } });
  });
  it('prints a reviewable source/count summary and returns failure for a blocked review without applying', async () => {
    const data = fixture(false); const stub = await startServer(() => ({ body: { revision: 7, review: data.review } }));
    const result = await runCli(['review-legacy', 'project', '--prompt-file', '-', '--expected-revision', '7', '--daemon-url', stub.url], JSON.stringify({ plan: data.plan }));
    expect(result.code).toBe(1); expect(result.stdout).toContain('Compiled components: 0'); expect(result.stdout).toContain('Preserved source: DESIGN.md');
    expect(result.stdout).toContain('not Strict ready'); expect(result.stdout).toContain('ODDS9001'); expect(stub.requests).toHaveLength(1);
  });
  it('preserves source conflict diagnostics after one CAS read and never retries application', async () => {
    const data = fixture(); const body = { error: { code: 'DESIGN_RUNTIME_LEGACY_MIGRATION_CONFLICT', message: 'Source bytes changed.', details: { diagnostics: [{ schemaVersion: 1, severity: 'error', code: 'ODDS9002', message: 'Review again.' }] } } };
    const stub = await startServer(({ method }) => method === 'GET' ? { body: { state: data.state } } : { status: 409, body });
    const result = await runCli(['apply-legacy', 'project', '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify(data.proof));
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(JSON.parse(result.stderr)).toEqual({ status: 409, ...body }); expect(stub.requests).toHaveLength(2);
  });
  it('rejects missing proof, source text, traversal and Strict migration before any HTTP', async () => {
    const data = fixture(); const stub = await startServer(() => ({ body: {} }));
    for (const [command, input] of [
      ['apply-legacy', { plan: data.plan }], ['review-legacy', { plan: { ...data.plan, sourceText: 'injected' } }],
      ['review-legacy', { plan: { ...data.plan, sourcePaths: ['../tokens.css'] } }], ['review-legacy', { plan: { ...data.plan, mode: 'strict' } }],
    ] as const) {
      const result = await runCli([command, 'project', '--prompt-file', '-', '--json', '--daemon-url', stub.url], JSON.stringify(input));
      expect(result.code, result.stderr).toBe(2);
    }
    expect(stub.requests).toHaveLength(0);
  });
  it('rejects a foreign project review before emitting success evidence', async () => {
    const data = fixture(); const stub = await startServer(() => ({ body: { revision: 7, review: { ...data.review, projectId: 'foreign' } } }));
    const result = await runCli(['review-legacy', 'project', '--prompt-file', '-', '--expected-revision', '7', '--json', '--daemon-url', stub.url], JSON.stringify({ plan: data.plan }));
    expect(result.code).toBe(1); expect(result.stdout).toBe(''); expect(JSON.parse(result.stderr).error.code).toBe('INTERNAL_ERROR');
  });
});
