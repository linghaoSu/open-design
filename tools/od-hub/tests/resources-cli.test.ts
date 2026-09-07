import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli, type CliResult } from '../src/cli/shim.js';
import { BlobStore } from '../src/server/blob-store.js';
import { createHubServer, type HubServer } from '../src/server/http.js';
import { deriveMemberId, MemoryHubStore } from '../src/server/memory-store.js';
import { manifestDigest, versionIdFor } from '../src/shared/manifest.js';
import { API_FAILURE_LINE, isExactTeamProjectLookupUnavailable } from './daemon-parsers.js';
import {
  hasReadablePublishedVersion,
  isAuthoritativeTeamProjectNotFound,
  isAuthorizedTeamProjectPullUnavailable,
  isMissingResourceError,
  isRetractedHubResourceError,
  isSharedProjectResource,
  parseReceipt,
  parseVersion,
  projectResourceIdFor,
  settlePullBatch,
  toVelaTeamProjectRecord,
  validateReceipt,
} from './daemon-resource-parsers.js';
import { CONTROL_KEY, OTHER_KEY, SEED, TEAM_WORKSPACE } from './helpers.js';

/**
 * CLI contract for `od-vela resource *` / `od-vela team-projects *` against an
 * in-process hub. Shapes and strings are the ones the daemon parsers require:
 *   vela-cli-resource-adapter.ts       parseVersion / isMissingResourceError / isRetractedHubResourceError
 *   vela-cli-resource-pull-batcher.ts  results[].key/ok/error/errorCode
 *   vela-cli-team-projects.ts          TeamProjectWire, --help probe, team_project_not_found
 *   authorized-team-project-pull.ts    receipt schema + 2000 ms window, stage dir identity
 */

let hub: HubServer;
let hubUrl: string;
let store: MemoryHubStore;
let tmp: string;
const ALICE = deriveMemberId('u1', TEAM_WORKSPACE);
const BOB = deriveMemberId('u2', TEAM_WORKSPACE);
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'od-vela-res-'));
  store = new MemoryHubStore(SEED);
  hub = createHubServer({ store, blobs: new BlobStore(path.join(tmp, 'blobs')) });
  hubUrl = (await hub.listen(0)).url;
});

afterAll(async () => {
  await hub.close();
  rmSync(tmp, { recursive: true, force: true });
});

const envFor = (key = CONTROL_KEY, workspace: string | null = TEAM_WORKSPACE) => ({
  VELA_API_URL: hubUrl,
  VELA_CONTROL_KEY: key,
  VELA_WORKSPACE_ID: workspace ?? undefined,
  AMR_HOME: path.join(tmp, 'amr'),
});

const run = (argv: string[], key = CONTROL_KEY, stdin = '') => runCli(argv, envFor(key), { stdin: async () => stdin });

const FORBIDDEN_STDERR = ['unknown command', 'unknown flag:', 'billing_workspace_snapshot_unsupported'];

function expectOk(result: CliResult): Record<string, unknown> {
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.endsWith('\n')).toBe(true);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function expectHttpError(result: CliResult, scope: string, status: number, code: string): void {
  expect(result.stdout).toBe('');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe(`Error: ${scope}: API request failed with status ${status}: ${code}\n`);
  expect(result.stderr.trim()).toMatch(API_FAILURE_LINE);
  for (const banned of FORBIDDEN_STDERR) expect(result.stderr.toLowerCase()).not.toContain(banned);
  expect(isExactTeamProjectLookupUnavailable(result.stderr)).toBe(false);
  expect(isAuthorizedTeamProjectPullUnavailable(result.stderr)).toBe(false);
}

/** A `team-projects list|get|upsert` row must survive the daemon's record parser and be shown (publishedVersionId present). */
function expectDaemonReadableTeamProject(row: Record<string, unknown>) {
  const record = toVelaTeamProjectRecord(row);
  expect(record).not.toBeNull();
  expect(hasReadablePublishedVersion(row)).toBe(true);
  return record!;
}

function writeTree(root: string, files: Record<string, string | { content: string; mode?: number }>): void {
  for (const [rel, spec] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const content = typeof spec === 'string' ? spec : spec.content;
    writeFileSync(file, content);
    if (typeof spec !== 'string' && spec.mode !== undefined) chmodSync(file, spec.mode);
  }
}

function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    out[path.relative(root, abs).split(path.sep).join('/')] = readFileSync(abs, 'utf8');
  }
  return out;
}

const uniq = (() => { let n = 0; return (p: string) => `${p}-${++n}`; })();

describe('resource head', () => {
  it('returns {version:null, versionId:null} for an unknown id (never an error)', async () => {
    const result = await run(['resource', 'head', 'never-pushed', '--ref', 'published', '--json']);
    expect(expectOk(result)).toEqual({ version: null, versionId: null });
    expect(parseVersion(result.stdout)).toBeNull();
  });

  it('a non-published ref is 404 ref_not_found (isMissingResourceError, not retracted)', async () => {
    const result = await run(['resource', 'head', 'x', '--ref', 'latest', '--json']);
    expectHttpError(result, 'resource head', 404, 'ref_not_found');
    expect(isMissingResourceError(result.stderr)).toBe(true);
    expect(isRetractedHubResourceError(result.stderr)).toBe(false);
  });

  it('missing workspace scope is a local error (exit 2)', async () => {
    const result = await runCli(['resource', 'head', 'x', '--ref', 'published', '--json'], envFor(CONTROL_KEY, null));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^Error: resource head: VELA_WORKSPACE_ID/);
  });
});

describe('resource push / pull round-trip', () => {
  it('push dir A (with excludes) -> pull into dir B: byte-identical tree, excluded entries absent, modes preserved', async () => {
    const src = path.join(tmp, 'rt-src');
    writeTree(src, {
      'index.html': '<h1>rt</h1>',
      'assets/style.css': 'h1{color:red}',
      'assets/deep/nested/file.txt': 'deep',
      'bin/run.sh': { content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      'empty.txt': '',
      'dup1.txt': 'same bytes',
      'dup2.txt': 'same bytes',
      // Excluded by the daemon's default rule set (vela-cli-resource-adapter.ts:57-95):
      'node_modules/x/index.js': 'no',
      '.git/HEAD': 'no',
      'dist/bundle.js': 'no',
      'sub/out/gen.js': 'no',
      '.env.local': 'no',
      'sub/.envrc/x': 'no',
      'deriveddata-abc/o': 'no',
      // Kept: regular files whose names collide with directory-only rules.
      'out': 'a file named out',
      'target': 'a file named target',
      'deriveddata-file.txt': 'regular file with dir-only prefix',
      '.gitignore': 'not .git',
    });
    symlinkSync(path.join(src, 'index.html'), path.join(src, 'link.html'));

    const pushed = await run([
      'resource', 'push', 'plugin', 'rt-plugin', src, '--ref', 'published', '--json',
      '--exclude', '.git', '--exclude', 'node_modules', '--exclude', 'dist/', '--exclude', 'out/', '--exclude', 'target/',
      '--exclude-prefix', '.env', '--exclude-prefix', 'deriveddata-/',
      '--metadata-json', JSON.stringify({ localId: 'rt', title: 'Round trip' }),
    ]);
    const version = expectOk(pushed);
    expect(version).toEqual({ version: 1, versionId: expect.stringMatching(/^v1-[0-9a-f]{12}$/) });
    expect(parseVersion(pushed.stdout)).toEqual({ version: 1, versionId: version.versionId });

    const stored = await store.getResourceVersion(TEAM_WORKSPACE, 'rt-plugin', 1);
    expect(stored!.manifest.map((e) => e.path)).toEqual([
      '.gitignore', 'assets/deep/nested/file.txt', 'assets/style.css', 'bin/run.sh', 'deriveddata-file.txt', 'dup1.txt', 'dup2.txt', 'empty.txt', 'index.html', 'out', 'target',
    ]);
    expect(stored!.manifest.find((e) => e.path === 'bin/run.sh')!.mode).toBe(0o755);
    expect(stored!.versionId).toBe(versionIdFor(1, manifestDigest(stored!.manifest)));
    expect((await store.getResource(TEAM_WORKSPACE, 'rt-plugin'))!.metadata).toEqual({ localId: 'rt', title: 'Round trip' });
    // Dedupe: identical bytes uploaded once.
    expect(await hub.blobs.has(sha('same bytes'))).toBe(true);
    expect(readdirSync(path.join(hub.blobs.root, 'tmp'))).toEqual([]);

    const dst = path.join(tmp, 'rt-dst');
    writeTree(dst, { 'stale.txt': 'must disappear', 'index.html': 'old' });
    const before = statSync(dst);
    const pulled = await run(['resource', 'pull', 'plugin', 'rt-plugin', dst, '--ref', 'published', '--json'], OTHER_KEY);
    expect(expectOk(pulled)).toEqual({ version: 1, versionId: version.versionId });
    expect(parseVersion(pulled.stdout)).toEqual({ version: 1, versionId: version.versionId });
    expect(readTree(dst)).toEqual({
      '.gitignore': 'not .git',
      'assets/deep/nested/file.txt': 'deep',
      'assets/style.css': 'h1{color:red}',
      'bin/run.sh': '#!/bin/sh\necho hi\n',
      'deriveddata-file.txt': 'regular file with dir-only prefix',
      'dup1.txt': 'same bytes',
      'dup2.txt': 'same bytes',
      'empty.txt': '',
      'index.html': '<h1>rt</h1>',
      out: 'a file named out',
      target: 'a file named target',
    });
    expect(statSync(path.join(dst, 'bin/run.sh')).mode & 0o777).toBe(0o755);
    // The directory inode was replaced (production pull shape).
    expect(statSync(dst).ino).not.toBe(before.ino);
    expect(existsSync(path.join(dst, 'stale.txt'))).toBe(false);
    // No stage/old directories left behind next to the target.
    expect(readdirSync(tmp).filter((n) => n.includes('rt-dst') && n !== 'rt-dst')).toEqual([]);
  });

  it('pull into a directory that does not exist yet creates it', async () => {
    const dst = path.join(tmp, 'fresh', 'nested', 'dir');
    expect(expectOk(await run(['resource', 'pull', 'plugin', 'rt-plugin', dst, '--ref', 'published', '--json'], OTHER_KEY))).toMatchObject({ version: 1 });
    expect(readTree(dst)['index.html']).toBe('<h1>rt</h1>');
  });

  it('pull of an unknown or tombstoned id -> 404 resource_not_found on stderr and the target is untouched', async () => {
    const dst = path.join(tmp, 'untouched');
    writeTree(dst, { 'keep.txt': 'keep' });
    const missing = await run(['resource', 'pull', 'plugin', 'ghost', dst, '--ref', 'published', '--json']);
    expectHttpError(missing, 'resource pull', 404, 'resource_not_found');
    expect(readTree(dst)).toEqual({ 'keep.txt': 'keep' });
    expect(readdirSync(tmp).filter((n) => n.startsWith('.untouched'))).toEqual([]);
  });

  it('pull refuses to replace a symlinked target', async () => {
    const real = path.join(tmp, 'sym-real');
    mkdirSync(real);
    const link = path.join(tmp, 'sym-link');
    symlinkSync(real, link);
    const result = await run(['resource', 'pull', 'plugin', 'rt-plugin', link, '--ref', 'published', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/symbolic link/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(real)).toEqual([]);
  });

  it('pull verifies every blob: a corrupted blob on the hub aborts before the swap', async () => {
    const src = path.join(tmp, 'corrupt-src');
    writeTree(src, { 'a.txt': 'alpha', 'b.txt': 'bravo' });
    expectOk(await run(['resource', 'push', 'skill', 'corrupt-skill', src, '--ref', 'published', '--json']));
    // Tamper with the stored bytes of one blob behind the hub's back.
    const blobPath = hub.blobs.pathFor(sha('bravo'));
    chmodSync(blobPath, 0o600);
    writeFileSync(blobPath, 'BRAVO');
    const dst = path.join(tmp, 'corrupt-dst');
    writeTree(dst, { 'old.txt': 'old' });
    const result = await run(['resource', 'pull', 'skill', 'corrupt-skill', dst, '--ref', 'published', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/failed verification/);
    expect(readTree(dst)).toEqual({ 'old.txt': 'old' });
    expect(readdirSync(tmp).filter((n) => n.startsWith('.corrupt-dst'))).toEqual([]);
    writeFileSync(blobPath, 'bravo');
  });

  it('push validates argv locally (exit 2) and rejects unknown kinds / non-published refs', async () => {
    const usage = await run(['resource', 'push', 'plugin', 'only-two', '--ref', 'published', '--json']);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toMatch(/^Error: resource push: usage/);
    const kind = await run(['resource', 'push', 'widget', 'x', tmp, '--ref', 'published', '--json']);
    expect(kind.exitCode).toBe(2);
    expect(kind.stderr).toMatch(/unsupported resource kind/);
    expectHttpError(await run(['resource', 'push', 'plugin', 'x', tmp, '--ref', 'draft', '--json']), 'resource push', 404, 'ref_not_found');
    const meta = await run(['resource', 'push', 'plugin', 'x', tmp, '--ref', 'published', '--json', '--metadata-json', '{nope']);
    expect(meta.exitCode).toBe(2);
    expect(meta.stderr).toBe('Error: resource push: --metadata-json is not valid JSON\n');
    const noDir = await run(['resource', 'push', 'plugin', 'x', path.join(tmp, 'does-not-exist'), '--ref', 'published', '--json']);
    expect(noDir.exitCode).toBe(1);
    expect(noDir.stderr).toMatch(/^Error: resource push: /);
    expect(noDir.stderr).not.toMatch(/\n.+\n/);
  });
});

describe('resource push / pull large tree', () => {
  it('pushes and pulls a tree of 1600 distinct small files (blobs/missing chunking + body limits)', async () => {
    const src = path.join(tmp, 'large-src');
    const files: Record<string, string> = {};
    for (let i = 0; i < 1600; i += 1) files[`dir${i % 40}/file-${String(i).padStart(4, '0')}.txt`] = `content ${i}\n`;
    writeTree(src, files);
    const pushed = await run(['resource', 'push', 'skill', 'large-skill', src, '--ref', 'published', '--json']);
    const version = expectOk(pushed);
    expect(parseVersion(pushed.stdout)).toEqual({ version: 1, versionId: version.versionId });
    const stored = await store.getResourceVersion(TEAM_WORKSPACE, 'large-skill', 1);
    expect(stored!.entryCount).toBe(1600);
    expect(new Set(stored!.manifest.map((e) => e.sha256)).size).toBe(1600);
    const dst = path.join(tmp, 'large-dst');
    const pulled = await run(['resource', 'pull', 'skill', 'large-skill', dst, '--ref', 'published', '--json'], OTHER_KEY);
    expect(parseVersion(pulled.stdout)).toEqual({ version: 1, versionId: version.versionId });
    expect(readTree(dst)).toEqual(files);
    // A second push of the same tree uploads nothing and publishes an identical digest as version 2.
    const again = expectOk(await run(['resource', 'push', 'skill', 'large-skill', src, '--ref', 'published', '--json']));
    expect(again).toMatchObject({ version: 2 });
    expect((again.versionId as string).slice(2)).toBe((version.versionId as string).slice(2));
  }, 60_000);
});

describe('resource push CAS (two writers)', () => {
  it('a push whose head observation went stale answers 409 resource_version_conflict', async () => {
    const dirA = path.join(tmp, 'cas-a');
    const dirB = path.join(tmp, 'cas-b');
    writeTree(dirA, { 'f.txt': 'A' });
    writeTree(dirB, { 'f.txt': 'B' });
    expectOk(await run(['resource', 'push', 'skill', 'cas-skill', dirA, '--ref', 'published', '--json']));
    // Writer B observes head=1 by going through the same client, but before it
    // commits, writer A publishes version 2. Simulate by intercepting fetch.
    let interposed = false;
    const fetchWithRace: typeof fetch = async (input, init) => {
      const url = String(input);
      if (!interposed && url.includes('/api/v1/blobs/missing')) {
        interposed = true;
        // Writer A lands between B's head and B's version POST.
        expectOk(await run(['resource', 'push', 'skill', 'cas-skill', dirA, '--ref', 'published', '--json']));
      }
      return fetch(input, init);
    };
    const result = await runCli(['resource', 'push', 'skill', 'cas-skill', dirB, '--ref', 'published', '--json'], envFor(), { fetch: fetchWithRace as never });
    expectHttpError(result, 'resource push', 409, 'resource_version_conflict');
    expect(interposed).toBe(true);
    // Head still reflects writer A and B's bytes were not published.
    const head = expectOk(await run(['resource', 'head', 'cas-skill', '--ref', 'published', '--json']));
    expect(head.version).toBe(2);
    const v2 = await store.getResourceVersion(TEAM_WORKSPACE, 'cas-skill', 2);
    expect(v2!.manifest[0]!.sha256).toBe(sha('A'));
    expect(await store.getResourceVersion(TEAM_WORKSPACE, 'cas-skill', 3)).toBeNull();
    // A fresh push (re-reading head) succeeds as version 3.
    expect(expectOk(await run(['resource', 'push', 'skill', 'cas-skill', dirB, '--ref', 'published', '--json']))).toMatchObject({ version: 3 });
  });
});

describe('resource remove / shared / list', () => {
  it('remove -> {ok:true}; second remove -> {ok:true} (idempotent); tombstone gates head/pull/push with resource_not_found', async () => {
    const src = path.join(tmp, 'rm-src');
    writeTree(src, { 'a': 'a' });
    expectOk(await run(['resource', 'push', 'design_system', 'ds-rm', src, '--ref', 'published', '--json']));
    expect(expectOk(await run(['resource', 'remove', 'ds-rm', '--json']))).toEqual({ ok: true });
    expect(expectOk(await run(['resource', 'remove', 'ds-rm', '--json']))).toEqual({ ok: true });
    // An id that never existed is still a hard 404 (the daemon reads resource_not_found as "retracted", which is fine here).
    const never = await run(['resource', 'remove', 'ds-never', '--json']);
    expectHttpError(never, 'resource remove', 404, 'resource_not_found');
    expect(isRetractedHubResourceError(never.stderr)).toBe(true);
    // PLAN §3.4 tombstone gate: head answers resource_not_found for a removed id, which the daemon reads as retracted.
    const head = await run(['resource', 'head', 'ds-rm', '--ref', 'published', '--json']);
    expectHttpError(head, 'resource head', 404, 'resource_not_found');
    expect(isRetractedHubResourceError(head.stderr)).toBe(true);
    expect(isMissingResourceError(head.stderr)).toBe(true);
    const pull = await run(['resource', 'pull', 'design_system', 'ds-rm', path.join(tmp, 'rm-dst'), '--ref', 'published', '--json']);
    expectHttpError(pull, 'resource pull', 404, 'resource_not_found');
    expect(isRetractedHubResourceError(pull.stderr)).toBe(true);
    expectHttpError(await run(['resource', 'push', 'design_system', 'ds-rm', src, '--ref', 'published', '--json']), 'resource push', 404, 'resource_not_found');
  });

  it('a member cannot remove another member\'s resource', async () => {
    const src = path.join(tmp, 'rm-bob');
    writeTree(src, { 'a': 'bob' });
    expectOk(await run(['resource', 'push', 'plugin', 'pl-owned-by-bob', src, '--ref', 'published', '--json'], OTHER_KEY));
    expectHttpError(await run(['resource', 'push', 'plugin', 'pl-owned-by-bob', src, '--ref', 'published', '--json'], 'odc_test_key_carol'), 'resource push', 401, 'invalid_api_key');
    // Alice is workspace owner -> allowed.
    expect(expectOk(await run(['resource', 'remove', 'pl-owned-by-bob', '--json']))).toEqual({ ok: true });
  });

  it('shared lists live resources in the SharedResourceWire shape; list mirrors it', async () => {
    const projectSrc = path.join(tmp, 'shared-project-src');
    writeTree(projectSrc, { 'index.html': 'shared' });
    expectOk(await run(['resource', 'push', 'project', 'project-shared-1', projectSrc, '--ref', 'published', '--json']));
    const shared = expectOk(await run(['resource', 'shared', '--json'], OTHER_KEY));
    const rows = shared.resources as Array<Record<string, unknown>>;
    const rt = rows.find((r) => r.id === 'rt-plugin')!;
    expect(rt).toEqual({
      id: 'rt-plugin', teamId: TEAM_WORKSPACE, kind: 'plugin', ownerMemberId: ALICE,
      metadata: { localId: 'rt', title: 'Round trip' }, createdAt: expect.any(String), deletedAt: null,
      publishedVersion: { id: expect.stringMatching(/^v1-/), version: 1 },
    });
    expect(rows.some((r) => r.id === 'ds-rm')).toBe(false);
    // Only project-kind rows pass the daemon's fallback catalog filter; plugin rows do not.
    expect(isSharedProjectResource(rt)).toBe(false);
    const projects = rows.filter((r) => r.kind === 'project');
    expect(projects.some((r) => r.id === 'project-shared-1')).toBe(true);
    for (const row of projects) expect(isSharedProjectResource(row)).toBe(true);
    expect(expectOk(await run(['resource', 'list', '--json']))).toEqual(shared);
  });

  it('snapshot / snapshot-redact / unknown verbs stay typed 501', async () => {
    expectHttpError(await run(['resource', 'snapshot', 'rt-plugin', '--ref', 'published', '--name', 'n', '--json']), 'resource snapshot', 501, 'not_supported');
    expectHttpError(await run(['resource', 'snapshot-redact', 'rt-plugin', 'slug', '--json']), 'resource snapshot-redact', 501, 'not_supported');
    expectHttpError(await run(['resource', 'frob', '--json']), 'resource frob', 501, 'not_supported');
  });
});

describe('resource pull-batch --requests-file -', () => {
  it('materializes each request independently, exit 0, per-item ok/error/errorCode', async () => {
    const src = path.join(tmp, 'batch-src');
    writeTree(src, { 'SKILL.md': '# skill' });
    expectOk(await run(['resource', 'push', 'skill', 'batch-skill', src, '--ref', 'published', '--json']));
    const d1 = path.join(tmp, 'batch-d1');
    const d2 = path.join(tmp, 'batch-d2');
    const d3 = path.join(tmp, 'batch-d3');
    writeTree(d1, { 'stale': 'x' });
    const stdin = JSON.stringify({ requests: [
      { key: 'od-pull-1', kind: 'skill', resourceId: 'batch-skill', dir: d1, ref: 'published' },
      { key: 'od-pull-2', kind: 'skill', resourceId: 'batch-missing', dir: d2 },
      { key: 'od-pull-3', kind: 'skill', resourceId: 'batch-skill', dir: d3, ref: 'latest' },
    ] });
    const result = await run(['resource', 'pull-batch', '--requests-file', '-', '--json'], OTHER_KEY, stdin);
    const body = expectOk(result) as { results: Array<Record<string, unknown>>; succeeded: number; failed: number };
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(2);
    expect(body.results).toEqual([
      { key: 'od-pull-1', kind: 'skill', resourceId: 'batch-skill', dir: d1, ref: 'published', ok: true, version: 1, versionId: expect.stringMatching(/^v1-/) },
      { key: 'od-pull-2', kind: 'skill', resourceId: 'batch-missing', dir: d2, ref: 'published', ok: false, error: 'resource_not_found', errorCode: 'resource_not_found' },
      { key: 'od-pull-3', kind: 'skill', resourceId: 'batch-skill', dir: d3, ref: 'latest', ok: false, error: 'ref_not_found', errorCode: 'ref_not_found' },
    ]);
    expect(readTree(d1)).toEqual({ 'SKILL.md': '# skill' });
    expect(existsSync(d2)).toBe(false);
    expect(existsSync(d3)).toBe(false);
    // What each daemon caller would have observed (vela-cli-resource-pull-batcher.ts flush).
    const verdicts = settlePullBatch(result.stdout, ['od-pull-1', 'od-pull-2', 'od-pull-3']);
    expect(verdicts.get('od-pull-1')).toEqual({ ok: true });
    expect(verdicts.get('od-pull-2')).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'resource_not_found (resource_not_found)' }) });
    expect(verdicts.get('od-pull-3')).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'ref_not_found (ref_not_found)' }) });
    expect(isRetractedHubResourceError((verdicts.get('od-pull-2') as { error: Error }).error)).toBe(true);
    expect(isRetractedHubResourceError((verdicts.get('od-pull-3') as { error: Error }).error)).toBe(false);
  });

  it('rejects malformed batches as a whole (local error, exit 2)', async () => {
    const bad = await run(['resource', 'pull-batch', '--requests-file', '-', '--json'], CONTROL_KEY, 'not json');
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toBe('Error: resource pull-batch: stdin is not valid JSON\n');
    const empty = await run(['resource', 'pull-batch', '--requests-file', '-', '--json'], CONTROL_KEY, '{"requests":[]}');
    expect(empty.exitCode).toBe(2);
    const dup = await run(['resource', 'pull-batch', '--requests-file', '-', '--json'], CONTROL_KEY, JSON.stringify({ requests: [
      { key: 'k', kind: 'skill', resourceId: 'a', dir: '/tmp/a' }, { key: 'k', kind: 'skill', resourceId: 'b', dir: '/tmp/b' },
    ] }));
    expect(dup.stderr).toMatch(/duplicate request key/);
    const tooMany = await run(['resource', 'pull-batch', '--requests-file', '-', '--json'], CONTROL_KEY, JSON.stringify({ requests: Array.from({ length: 129 }, (_, i) => ({ key: `k${i}`, kind: 'skill', resourceId: 'a', dir: '/tmp/a' })) }));
    expect(tooMany.stderr).toMatch(/at most 128/);
    const file = await run(['resource', 'pull-batch', '--requests-file', '/tmp/x.json', '--json']);
    expect(file.exitCode).toBe(2);
  });
});

describe('team-projects', () => {
  const projectSrc = () => {
    const src = path.join(tmp, uniq('tp-src'));
    writeTree(src, { 'index.html': '<h1>tp</h1>', 'assets/style.css': 'h1{}' });
    return src;
  };

  it('--help is stdout-only exit 0; unknown verb is typed 501', async () => {
    const help = await run(['team-projects', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stderr).toBe('');
    expect(help.stdout).toContain('Usage:');
    expectHttpError(await run(['team-projects', 'frob', 'x']), 'team-projects frob', 501, 'not_supported');
  });

  it('get on an unknown project -> 404 team_project_not_found (isAuthoritativeTeamProjectNotFound)', async () => {
    const result = await run(['team-projects', 'get', 'nope', '--json']);
    expectHttpError(result, 'team-projects get', 404, 'team_project_not_found');
    expect(isAuthoritativeTeamProjectNotFound(result.stderr)).toBe(true);
  });

  it('upsert/list/get/remove in the TeamProjectWire shape (vela-cli-team-projects.ts:407-462)', async () => {
    const src = projectSrc();
    const pushed = expectOk(await run(['resource', 'push', 'project', 'project-tp1', src, '--ref', 'published', '--json', '--metadata-json', JSON.stringify({ projectId: 'tp1', name: 'TP1' })]));
    const upserted = expectOk(await run([
      'team-projects', 'upsert', 'tp1', '--resource-id', 'project-tp1', '--display-name', 'TP One', '--sync-state', 'synced',
      '--last-synced-version-id', pushed.versionId as string, '--metadata-json', JSON.stringify({ name: 'TP One', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 2 }),
    ]));
    expect(upserted).toEqual({
      id: expect.any(String), workspaceId: TEAM_WORKSPACE, projectId: 'tp1', resourceId: 'project-tp1', ownerMemberId: ALICE,
      displayName: 'TP One', syncState: 'synced', lastSyncedVersionId: pushed.versionId, publishedVersionId: pushed.versionId,
      metadata: { name: 'TP One', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 2 },
      createdAt: expect.any(String), updatedAt: expect.any(String),
      access: { canView: true, canComment: true, canEdit: true, frozen: false },
    });
    expect(expectDaemonReadableTeamProject(upserted)).toMatchObject({ syncState: 'synced', originProjectUpdatedAt: 2, publishedVersionId: pushed.versionId });
    // An omitted --sync-state defaults to 'synced' (e2e/lib/collab-hub-core/commands.ts), never 'pending_upload'.
    const pushed2 = expectOk(await run(['resource', 'push', 'project', 'project-tp1b', projectSrc(), '--ref', 'published', '--json']));
    const defaulted = expectOk(await run(['team-projects', 'upsert', 'tp1b', '--resource-id', 'project-tp1b']));
    expect(defaulted).toMatchObject({ syncState: 'synced', publishedVersionId: pushed2.versionId });
    expect(expectDaemonReadableTeamProject(defaulted).syncState).toBe('synced');
    // No --json on list/upsert in the daemon argv; both still return JSON.
    const list = expectOk(await run(['team-projects', 'list'], OTHER_KEY)) as { workspaceId: string; projects: Array<Record<string, unknown>> };
    expect(list.workspaceId).toBe(TEAM_WORKSPACE);
    const row = list.projects.find((p) => p.projectId === 'tp1')!;
    expect(row).toMatchObject({ ownerMemberId: ALICE, access: { canEdit: false } });
    for (const p of list.projects) expectDaemonReadableTeamProject(p);
    const got = expectOk(await run(['team-projects', 'get', 'tp1', '--json'], OTHER_KEY));
    expect(got).toMatchObject({ projectId: 'tp1', publishedVersionId: pushed.versionId });
    expect(expectDaemonReadableTeamProject(got).access.canEdit).toBe(false);
    // Missing --resource-id -> local error, never `unknown flag`.
    const noRes = await run(['team-projects', 'upsert', 'tp1']);
    expect(noRes.exitCode).toBe(2);
    expect(noRes.stderr).toBe('Error: team-projects upsert: required flag --resource-id is missing\n');
    // Bob cannot re-catalog Alice's project; owner stays Alice after an admin upsert.
    expectHttpError(await run(['team-projects', 'upsert', 'tp1', '--resource-id', 'project-tp1'], OTHER_KEY), 'team-projects upsert', 403, 'team_project_forbidden');
    expect(expectOk(await run(['team-projects', 'remove', 'tp1']))).toEqual({ ok: true });
    // Idempotent: the daemon's unshare retry (vela-cli-team-projects.ts remove -> runtime.ts) expects {ok:true}, never a 404.
    expect(expectOk(await run(['team-projects', 'remove', 'tp1']))).toEqual({ ok: true });
    expect(expectOk(await run(['team-projects', 'remove', 'never-catalogued']))).toEqual({ ok: true });
    expectHttpError(await run(['team-projects', 'get', 'tp1', '--json']), 'team-projects get', 404, 'team_project_not_found');
  });

  describe('pull', () => {
    let versionId: string;
    let digest: string;
    // The daemon keys a shared project by the principal-scoped id
    // (vela-team-projects.ts:52-62) and validateReceipt recomputes exactly that.
    const PULL_RESOURCE_ID = projectResourceIdFor('pull', { teamId: TEAM_WORKSPACE, memberId: ALICE });
    const SCOPE = { workspaceId: TEAM_WORKSPACE, resourceTeamId: TEAM_WORKSPACE, viewerMemberId: BOB, ownerMemberId: ALICE };
    beforeAll(async () => {
      const src = projectSrc();
      const pushed = expectOk(await run(['resource', 'push', 'project', PULL_RESOURCE_ID, src, '--ref', 'published', '--json', '--metadata-json', '{"projectId":"pull"}']));
      versionId = pushed.versionId as string;
      digest = (await store.getResourceVersion(TEAM_WORKSPACE, PULL_RESOURCE_ID, 1))!.manifestDigest;
      expectOk(await run(['team-projects', 'upsert', 'pull', '--resource-id', PULL_RESOURCE_ID, '--sync-state', 'synced', '--last-synced-version-id', versionId]));
    });

    const expectReceipt = (receipt: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      expect(receipt).toEqual({
        schemaVersion: 1, workspaceId: TEAM_WORKSPACE, resourceTeamId: TEAM_WORKSPACE, viewerMemberId: BOB, ownerMemberId: ALICE,
        projectId: 'pull', resourceId: PULL_RESOURCE_ID, ref: 'published', version: 1, versionId, manifestDigest: digest,
        manifestEntryCount: 2, lifecycleState: 'active', authorizedAt: expect.any(String), expiresAt: expect.any(String), ...extra,
      });
      expect(receipt.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const authorizedAt = Date.parse(receipt.authorizedAt as string);
      const expiresAt = Date.parse(receipt.expiresAt as string);
      expect(expiresAt - authorizedAt).toBe(2000);
      expect(Date.now()).toBeLessThan(expiresAt);
      // The daemon's own parse + bind check (authorized-team-project-pull.ts:102-184) must accept the stdout untouched.
      const parsed = parseReceipt(JSON.stringify(receipt));
      expect(() => validateReceipt(parsed, { projectId: 'pull', scope: SCOPE, expectedVersion: 1, nowMs: authorizedAt })).not.toThrow();
      expect(() => validateReceipt(parsed, { projectId: 'pull', scope: SCOPE, expectedVersion: 2, nowMs: authorizedAt })).toThrow(/binding does not match/);
      expect(() => validateReceipt(parsed, { projectId: 'pull', scope: SCOPE, expectedVersion: 1, nowMs: expiresAt })).toThrow(/is stale/);
    };

    it('--authorize-only returns the receipt with manifestEntryCount and without materializing anything', async () => {
      const result = await run(['team-projects', 'pull', 'pull', '--authorize-only', '--ref', 'published', '--expected-version', '1', '--json'], OTHER_KEY);
      const receipt = expectOk(result);
      expectReceipt(receipt);
      expect(receipt).not.toHaveProperty('nonce');
    });

    it('owner pulling own project, wrong version, wrong ref, bad args', async () => {
      expectHttpError(await run(['team-projects', 'pull', 'pull', '--authorize-only', '--ref', 'published', '--expected-version', '1', '--json'], CONTROL_KEY), 'team-projects pull', 409, 'authorized_team_project_pull_rejected');
      expectHttpError(await run(['team-projects', 'pull', 'pull', '--authorize-only', '--ref', 'published', '--expected-version', '999', '--json'], OTHER_KEY), 'team-projects pull', 409, 'authorized_team_project_pull_rejected');
      expectHttpError(await run(['team-projects', 'pull', 'pull', '--authorize-only', '--ref', 'latest', '--expected-version', '1', '--json'], OTHER_KEY), 'team-projects pull', 404, 'ref_not_found');
      expectHttpError(await run(['team-projects', 'pull', 'ghost', '--authorize-only', '--ref', 'published', '--expected-version', '1', '--json'], OTHER_KEY), 'team-projects pull', 404, 'team_project_not_found');
      const noVersion = await run(['team-projects', 'pull', 'pull', '--authorize-only', '--ref', 'published', '--json'], OTHER_KEY);
      expect(noVersion.exitCode).toBe(2);
      expect(noVersion.stderr).toBe('Error: team-projects pull: --expected-version must be a non-negative integer\n');
      const noStage = await run(['team-projects', 'pull', 'pull', '--ref', 'published', '--expected-version', '1', '--json'], OTHER_KEY);
      expect(noStage.exitCode).toBe(2);
      expect(noStage.stderr).toMatch(/stage directory is required/);
    });

    it('materializing pull: flags before the stage dir are skipped, tree lands in the stage inode, receipt printed after download', async () => {
      const live = path.join(tmp, 'live-pull');
      writeTree(live, { 'index.html': '<h1>tp</h1>', 'assets/style.css': 'OLD' });
      const stage = mkdtempSync(path.join(tmp, '.live-pull.od-pull-stage-'));
      const before = statSync(stage);
      // Daemon argv order (authorized-team-project-pull.ts:391-409) puts the stage
      // dir right after the project id; also try flags first to prove the scan skips values.
      const result = await run([
        'team-projects', 'pull', 'pull', '--ref', 'published', '--live-dir', live, stage, '--expected-version', '1', '--json',
      ], OTHER_KEY);
      const receipt = expectOk(result);
      expectReceipt(receipt);
      expect(readTree(stage)).toEqual({ 'index.html': '<h1>tp</h1>', 'assets/style.css': 'h1{}' });
      const after = lstatSync(stage);
      expect(after.isDirectory()).toBe(true);
      expect(after.isSymbolicLink()).toBe(false);
      expect(after.ino).not.toBe(before.ino);
      // The live dir was reused by hard link where the sha matched and left alone otherwise.
      expect(statSync(path.join(live, 'index.html')).ino).toBe(statSync(path.join(stage, 'index.html')).ino);
      expect(readFileSync(path.join(live, 'assets/style.css'), 'utf8')).toBe('OLD');
      expect(readdirSync(tmp).filter((n) => n.startsWith('.live-pull') && n !== path.basename(stage))).toEqual([]);
    });

    it('stage dir must be an empty real directory', async () => {
      const full = path.join(tmp, 'stage-full');
      writeTree(full, { 'x': 'x' });
      const notEmpty = await run(['team-projects', 'pull', 'pull', full, '--ref', 'published', '--expected-version', '1', '--json'], OTHER_KEY);
      expect(notEmpty.exitCode).toBe(2);
      expect(notEmpty.stderr).toMatch(/must be empty/);
      const link = path.join(tmp, 'stage-link');
      const target = path.join(tmp, 'stage-link-target');
      mkdirSync(target);
      symlinkSync(target, link);
      const sym = await run(['team-projects', 'pull', 'pull', link, '--ref', 'published', '--expected-version', '1', '--json'], OTHER_KEY);
      expect(sym.exitCode).toBe(2);
      expect(sym.stderr).toMatch(/real directory/);
      expect(readdirSync(target)).toEqual([]);
      const missing = await run(['team-projects', 'pull', 'pull', path.join(tmp, 'no-such-stage'), '--ref', 'published', '--expected-version', '1', '--json'], OTHER_KEY);
      expect(missing.exitCode).toBe(2);
    });

    it('materializing pull with a stale expected version fails before any download and leaves the stage empty', async () => {
      const stage = mkdtempSync(path.join(tmp, '.stale.od-pull-stage-'));
      expectHttpError(await run(['team-projects', 'pull', 'pull', stage, '--ref', 'published', '--expected-version', '7', '--json'], OTHER_KEY), 'team-projects pull', 409, 'authorized_team_project_pull_rejected');
      expect(readdirSync(stage)).toEqual([]);
      expect(readdirSync(tmp).filter((n) => n.startsWith('.stale') && n !== path.basename(stage))).toEqual([]);
    });
  });
});

describe('spawned bin/od-vela (dist) — real process stdout/stderr/exit/stdin', () => {
  const bin = fileURLToPath(new URL('../bin/od-vela.mjs', import.meta.url));
  const dist = fileURLToPath(new URL('../dist/od-vela.mjs', import.meta.url));
  const spawn = (args: string[], env: Record<string, string | undefined>, stdin?: string) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
        const status = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? null : 0;
        resolve({ status, stdout, stderr });
      });
      if (stdin !== undefined) child.stdin!.end(stdin);
      else child.stdin!.end();
    });

  it.skipIf(!existsSync(dist))('push -> head -> pull -> pull-batch (stdin) -> remove through the built binary', async () => {
    const src = path.join(tmp, 'spawn-src');
    writeTree(src, { 'README.md': '# spawned', 'node_modules/x': 'no' });
    const pushed = await spawn(['resource', 'push', 'plugin', 'spawn-plugin', src, '--ref', 'published', '--json', '--exclude', 'node_modules'], envFor());
    expect(pushed.stderr).toBe('');
    expect(pushed.status).toBe(0);
    const version = parseVersion(pushed.stdout)!;
    expect(version.version).toBe(1);
    const head = await spawn(['resource', 'head', 'spawn-plugin', '--ref', 'published', '--json'], envFor(OTHER_KEY));
    expect(parseVersion(head.stdout)).toEqual(version);
    const dst = path.join(tmp, 'spawn-dst');
    const pulled = await spawn(['resource', 'pull', 'plugin', 'spawn-plugin', dst, '--ref', 'published', '--json'], envFor(OTHER_KEY));
    expect(pulled.status).toBe(0);
    expect(readTree(dst)).toEqual({ 'README.md': '# spawned' });
    const batch = await spawn(['resource', 'pull-batch', '--requests-file', '-', '--json'], envFor(OTHER_KEY), JSON.stringify({ requests: [
      { key: 'k1', kind: 'plugin', resourceId: 'spawn-plugin', dir: path.join(tmp, 'spawn-b1'), ref: 'published' },
      { key: 'k2', kind: 'plugin', resourceId: 'spawn-missing', dir: path.join(tmp, 'spawn-b2'), ref: 'published' },
    ] }));
    expect(batch.stderr).toBe('');
    expect(batch.status).toBe(0);
    const results = (JSON.parse(batch.stdout) as { results: Array<Record<string, unknown>> }).results;
    expect(results.map((r) => [r.key, r.ok, r.errorCode ?? null])).toEqual([['k1', true, null], ['k2', false, 'resource_not_found']]);
    const missing = await spawn(['resource', 'pull', 'plugin', 'spawn-missing', path.join(tmp, 'spawn-m'), '--ref', 'published', '--json'], envFor(OTHER_KEY));
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Error: resource pull: API request failed with status 404: resource_not_found\n');
    const removed = await spawn(['resource', 'remove', 'spawn-plugin', '--json'], envFor());
    expect(JSON.parse(removed.stdout)).toEqual({ ok: true });
    const again = await spawn(['resource', 'remove', 'spawn-plugin', '--json'], envFor());
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({ ok: true });
    const results2 = settlePullBatch(batch.stdout, ['k1', 'k2']);
    expect(results2.get('k1')).toEqual({ ok: true });
    expect(results2.get('k2')).toMatchObject({ ok: false });
  });

  it.skipIf(!existsSync(dist))('team-projects catalog + receipt through the built binary', async () => {
    const src = path.join(tmp, 'spawn-tp');
    writeTree(src, { 'index.html': 'x' });
    const pushed = await spawn(['resource', 'push', 'project', 'project-spawn', src, '--ref', 'published', '--json', '--metadata-json', '{"projectId":"spawn"}'], envFor());
    const version = parseVersion(pushed.stdout)!;
    const upsert = await spawn(['team-projects', 'upsert', 'spawn', '--resource-id', 'project-spawn', '--sync-state', 'synced', '--last-synced-version-id', version.versionId!], envFor());
    expect(upsert.stderr).toBe('');
    expect(JSON.parse(upsert.stdout)).toMatchObject({ projectId: 'spawn', ownerMemberId: ALICE, publishedVersionId: version.versionId });
    expect(toVelaTeamProjectRecord(JSON.parse(upsert.stdout))).not.toBeNull();
    const list = await spawn(['team-projects', 'list'], envFor(OTHER_KEY));
    expect((JSON.parse(list.stdout) as { projects: Array<{ projectId: string }> }).projects.some((p) => p.projectId === 'spawn')).toBe(true);
    const missing = await spawn(['team-projects', 'get', 'spawn-missing', '--json'], envFor());
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe('Error: team-projects get: API request failed with status 404: team_project_not_found\n');
    expect(isExactTeamProjectLookupUnavailable(missing.stderr)).toBe(false);
    const stage = mkdtempSync(path.join(tmp, '.spawn-live.od-pull-stage-'));
    const pull = await spawn(['team-projects', 'pull', 'spawn', stage, '--live-dir', path.join(tmp, 'spawn-live'), '--ref', 'published', '--expected-version', '1', '--json'], envFor(OTHER_KEY));
    expect(pull.stderr).toBe('');
    expect(pull.status).toBe(0);
    const receipt = JSON.parse(pull.stdout) as Record<string, unknown>;
    expect(receipt).toMatchObject({ schemaVersion: 1, viewerMemberId: BOB, ownerMemberId: ALICE, version: 1, versionId: version.versionId, lifecycleState: 'active' });
    expect(parseReceipt(pull.stdout).version).toBe(1);
    expect(readTree(stage)).toEqual({ 'index.html': 'x' });
    const help = await spawn(['team-projects', '--help'], envFor());
    expect(help.status).toBe(0);
    expect(help.stderr).toBe('');
    const removed = await spawn(['team-projects', 'remove', 'spawn'], envFor());
    expect(JSON.parse(removed.stdout)).toEqual({ ok: true });
  });
});
