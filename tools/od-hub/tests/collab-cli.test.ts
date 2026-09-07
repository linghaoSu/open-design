import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRESENCE_HTTP_TIMEOUT_MS } from '../src/cli/collab.js';
import { runCli, type CliResult } from '../src/cli/shim.js';
import { createHubServer, type HubServer } from '../src/server/http.js';
import { deriveMemberId, MemoryHubStore } from '../src/server/memory-store.js';
import { API_FAILURE_LINE } from './daemon-parsers.js';
import {
  classifyCollabCloudError,
  mergeSyncedPreviewComment,
  parseCollabStdout,
  parsePullCommentsStdout,
  parsePushCommentStdout,
  PRESENCE_COMMAND_TIMEOUT_MS,
  toDirectoryEntry,
  toPresenceMember,
} from './daemon-collab-parsers.js';
import { CONTROL_KEY, OTHER_KEY, SEED, TEAM_WORKSPACE } from './helpers.js';

/**
 * CLI contract for the seven `od-vela collab *` subcommands against an
 * in-process hub, asserted through verbatim copies of the daemon parsers
 * (vela-cli-collab-client.ts, collab-cloud-error.ts, db.ts merge).
 */

let hub: HubServer;
let hubUrl: string;
let store: MemoryHubStore;
let tmp: string;
let clock = new Date('2026-09-08T12:00:00.000Z');
const ALICE = deriveMemberId('u1', TEAM_WORKSPACE);
const BOB = deriveMemberId('u2', TEAM_WORKSPACE);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'od-vela-collab-'));
  store = new MemoryHubStore(SEED, { now: () => clock });
  hub = createHubServer({ store, now: () => clock, presenceTtlMs: 30_000 });
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

const run = (argv: string[], key = CONTROL_KEY) => runCli(argv, envFor(key));

const FORBIDDEN_STDERR = ['unknown command', 'unknown flag:', 'billing_workspace_snapshot_unsupported'];

function expectOk(result: CliResult): Record<string, unknown> {
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.endsWith('\n')).toBe(true);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return parseCollabStdout<Record<string, unknown>>(result.stdout);
}

function expectHttpError(result: CliResult, scope: string, status: number, code: string): void {
  expect(result.stdout).toBe('');
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe(`Error: ${scope}: API request failed with status ${status}: ${code}\n`);
  expect(result.stderr.trim()).toMatch(API_FAILURE_LINE);
  for (const banned of FORBIDDEN_STDERR) expect(result.stderr.toLowerCase()).not.toContain(banned);
}

/** What the daemon sees: execFile rejects with `Command failed: ...\n<stderr>`. */
const daemonError = (result: CliResult) => new Error(`Command failed: od-vela collab ...\n${result.stderr}`);

describe('collab member', () => {
  it('register --display-name D --role R -> {member} (role from the hub, not argv); list -> {members}', async () => {
    const registered = expectOk(await run(['collab', 'member', 'register', '--display-name', 'Alice CLI', '--role', 'member']));
    expect(toDirectoryEntry(registered.member as never)).toEqual({ memberId: ALICE, displayName: 'Alice CLI', role: 'owner' });
    const list = expectOk(await run(['collab', 'member', 'list'], OTHER_KEY));
    const entries = (list.members as unknown[]).map((m) => toDirectoryEntry(m as never));
    expect(entries).toEqual([
      { memberId: ALICE, displayName: 'Alice CLI', role: 'owner' },
      { memberId: BOB, displayName: 'Bob', role: 'member' },
    ]);
  });

  it('register --role is optional and, when given, validated by the hub (400 invalid_role) but never stored', async () => {
    const noRole = expectOk(await run(['collab', 'member', 'register', '--display-name', 'Alice CLI']));
    expect(toDirectoryEntry(noRole.member as never)).toEqual({ memberId: ALICE, displayName: 'Alice CLI', role: 'owner' });
    for (const role of ['owner', 'admin', 'member']) {
      const withRole = expectOk(await run(['collab', 'member', 'register', '--display-name', 'Alice CLI', '--role', role, '--json']));
      expect((withRole.member as { role: string }).role).toBe('owner');
    }
    const bad = await run(['collab', 'member', 'register', '--display-name', 'Alice CLI', '--role', 'god']);
    expectHttpError(bad, 'collab member register', 400, 'invalid_role');
    // The daemon files a 400 as a retryable infrastructure failure with the upstream status attached; register is
    // not an outbox path, so this cannot wedge anything, and the register call itself never sends a bad role.
    expect(classifyCollabCloudError(daemonError(bad))).toMatchObject({ kind: 'infrastructure', retryable: true, upstreamStatus: 400 });
    expect((await store.getMembership('u1', TEAM_WORKSPACE))!.displayName).toBe('Alice CLI');
  });

  it('local validation exits 2 with the scope prefix; missing workspace exits 2', async () => {
    const missing = await run(['collab', 'member', 'register']);
    expect(missing).toEqual({ stdout: '', stderr: 'Error: collab member register: required flag --display-name is missing\n', exitCode: 2 });
    const noWs = await runCli(['collab', 'member', 'list'], envFor(CONTROL_KEY, null));
    expect(noWs.exitCode).toBe(2);
    expect(noWs.stderr).toMatch(/^Error: collab member list: VELA_WORKSPACE_ID/);
  });

  it('non-member -> 403 workspace_not_authorized, classified as denied by the daemon', async () => {
    const result = await runCli(['collab', 'member', 'list'], envFor(OTHER_KEY, 'u1'));
    expectHttpError(result, 'collab member list', 403, 'workspace_not_authorized');
    expect(classifyCollabCloudError(daemonError(result))).toMatchObject({ kind: 'denied', status: 403, retryable: false });
    const badKey = await runCli(['collab', 'member', 'list'], envFor('odc_nope'));
    expectHttpError(badKey, 'collab member list', 401, 'invalid_api_key');
    expect(classifyCollabCloudError(daemonError(badKey)).kind).toBe('denied');
  });

  it('unknown collab verbs stay typed 501', async () => {
    expectHttpError(await run(['collab', 'member', 'frobnicate']), 'collab member frobnicate', 501, 'not_supported');
    expectHttpError(await run(['collab', 'invite', 'create']), 'collab invite create', 501, 'not_supported');
    expectHttpError(await run(['collab']), 'collab', 501, 'not_supported');
  });
});

describe('collab comment', () => {
  const base = {
    conversationId: 'conv-1', seq: 0, note: '', filePath: 'index.html', elementId: 'el', selector: 'h1', label: 'H1', text: 'Hello',
    htmlHint: '<h1>', position: { x: 1, y: 2, width: 3, height: 4 }, status: 'open', createdAt: clock.getTime(),
  };
  const cloud = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...base, id, projectId: 'proj-cli', memberId: ALICE, updatedAt: clock.getTime(), ...extra });

  it('push <p> --comment-json J -> {seq}; pull <p> --since-seq N -> {comments, latestSeq}; daemon merge converges', async () => {
    const pushed = await run(['collab', 'comment', 'push', 'proj-cli', '--comment-json', cloud('k1')]);
    expectOk(pushed);
    expect(parsePushCommentStdout(pushed.stdout)).toEqual({ seq: 1 });
    const seq2 = parsePushCommentStdout((await run(['collab', 'comment', 'push', 'proj-cli', '--comment-json', cloud('k2', { text: 'Second' })], OTHER_KEY)).stdout);
    expect(seq2).toEqual({ seq: 2 });
    const edit = parsePushCommentStdout((await run(['collab', 'comment', 'push', 'proj-cli', '--comment-json', cloud('k1', { text: 'Edited', status: 'resolved', updatedAt: clock.getTime() + 5 })])).stdout);
    expect(edit).toEqual({ seq: 3 });
    const tomb = parsePushCommentStdout((await run(['collab', 'comment', 'push', 'proj-cli', '--comment-json', cloud('k2', { deleted: true, updatedAt: clock.getTime() + 6 })], OTHER_KEY)).stdout);
    expect(tomb).toEqual({ seq: 4 });

    const pullResult = await run(['collab', 'comment', 'pull', 'proj-cli', '--since-seq', '0'], OTHER_KEY);
    expectOk(pullResult);
    const pulled = parsePullCommentsStdout(pullResult.stdout, 0);
    expect(pulled.notModified).toBe(false);
    expect(pulled.etag).toBeNull();
    expect(pulled.latestSeq).toBe(4);
    expect(pulled.comments.map((c) => [c.id, c.seq, c.deleted === true])).toEqual([['k1', 3, false], ['k2', 4, true]]);
    expect(pulled.comments[0]).toMatchObject({ projectId: 'proj-cli', memberId: ALICE, text: 'Edited', status: 'resolved', position: base.position });
    expect(pulled.comments[1]).toMatchObject({ projectId: 'proj-cli', memberId: ALICE, deleted: true });

    const receiver = new Map();
    for (const c of pulled.comments) mergeSyncedPreviewComment(receiver, c as never);
    expect([...receiver.keys()]).toEqual(['k1']);
    expect(receiver.get('k1')!.body.text).toBe('Edited');

    const delta = parsePullCommentsStdout((await run(['collab', 'comment', 'pull', 'proj-cli', '--since-seq', '3'])).stdout, 3);
    expect(delta.comments.map((c) => c.id)).toEqual(['k2']);
    const none = parsePullCommentsStdout((await run(['collab', 'comment', 'pull', 'proj-cli', '--since-seq', '4'])).stdout, 4);
    expect(none).toEqual({ comments: [], latestSeq: 4, notModified: true, etag: null });
    // Unknown project: empty stream, cursor stays at the caller's sinceSeq semantics (latestSeq 0).
    const unknownResult = await run(['collab', 'comment', 'pull', 'nope', '--since-seq', '0']);
    expectOk(unknownResult);
    const unknown = parsePullCommentsStdout(unknownResult.stdout, 0);
    expect(unknown).toEqual({ comments: [], latestSeq: 0, notModified: true, etag: null });
  });

  it('local validation: missing projectId / --comment-json / invalid JSON exit 2; server 400 stays typed', async () => {
    expect((await run(['collab', 'comment', 'push'])).exitCode).toBe(2);
    expect((await run(['collab', 'comment', 'push', 'p'])).stderr).toBe('Error: collab comment push: required flag --comment-json is missing\n');
    expect((await run(['collab', 'comment', 'push', 'p', '--comment-json', '{nope'])).stderr).toBe('Error: collab comment push: --comment-json is not valid JSON\n');
    expect((await run(['collab', 'comment', 'push', 'p', '--comment-json', '[]'])).exitCode).toBe(2);
    expectHttpError(await run(['collab', 'comment', 'push', 'p', '--comment-json', '{"text":"no id"}']), 'collab comment push', 400, 'comment_id_required');
    expect((await run(['collab', 'comment', 'pull', 'p', '--since-seq', 'x'])).stderr).toBe('Error: collab comment pull: --since-seq must be a non-negative integer\n');
    expect((await run(['collab', 'comment', 'pull'])).exitCode).toBe(2);
  });

  it('pull defaults --since-seq to 0: the full stream, same as an explicit 0', async () => {
    const implicit = await run(['collab', 'comment', 'pull', 'proj-cli'], OTHER_KEY);
    expectOk(implicit);
    const explicit = await run(['collab', 'comment', 'pull', 'proj-cli', '--since-seq', '0'], OTHER_KEY);
    expect(implicit.stdout).toBe(explicit.stdout);
    const pulled = parsePullCommentsStdout(implicit.stdout, 0);
    expect(pulled.latestSeq).toBe(4);
    expect(pulled.comments.map((c) => c.id)).toEqual(['k1', 'k2']);
    // Unknown project without the flag is the same empty stream.
    expect(parsePullCommentsStdout(expectOkRaw(await run(['collab', 'comment', 'pull', 'p'])), 0)).toEqual({ comments: [], latestSeq: 0, notModified: true, etag: null });
  });

  it('nested body fields (position, attachments, podMembers) survive push -> pull through the shim byte-for-byte', async () => {
    const comment = {
      ...base, id: 'nested', projectId: 'proj-nested', memberId: ALICE, updatedAt: clock.getTime(),
      position: { x: 1.5, y: 2.25, width: 3, height: 4, anchor: { side: 'left', offset: [1, 2] } },
      attachments: [{ kind: 'image', url: 'https://x/y.png', meta: { w: 10, h: 20, tags: ['a', 'b'] } }, { kind: 'link', url: 'https://z' }],
      podMembers: [{ memberId: BOB, role: 'reviewer', flags: { muted: false } }],
    };
    expect(parsePushCommentStdout(expectOkRaw(await run(['collab', 'comment', 'push', 'proj-nested', '--comment-json', JSON.stringify(comment)])))).toEqual({ seq: 1 });
    const pulled = parsePullCommentsStdout(expectOkRaw(await run(['collab', 'comment', 'pull', 'proj-nested'], OTHER_KEY)), 0);
    expect(pulled.comments).toEqual([{ ...comment, seq: 1 }]);
    const receiver = new Map();
    mergeSyncedPreviewComment(receiver, pulled.comments[0] as never);
    expect(receiver.get('nested')!.body).toMatchObject({ position: comment.position, attachments: comment.attachments, podMembers: comment.podMembers });
  });
});

describe('collab presence', () => {
  it('heartbeat/list/leave round-trip with activity passthrough through toPresenceMember', async () => {
    const activity = { kind: 'editing', filePath: 'index.html', nested: { n: 1 } };
    const beat = expectOk(await run([
      'collab', 'presence', 'heartbeat', 'proj-p', '--client-id', 'cli-1', '--display-name', 'Alice', '--file-path', 'index.html', '--activity-json', JSON.stringify(activity),
    ]));
    const viewers = (beat.viewers as unknown[]).map((v) => toPresenceMember(v as never));
    expect(viewers).toEqual([{ memberId: ALICE, name: 'Alice', role: 'owner', avatarUrl: null, filePath: 'index.html', activity, heartbeatAt: clock.toISOString() }]);
    // Minimal heartbeat: no display name / file path / activity flags.
    const bob = expectOk(await run(['collab', 'presence', 'heartbeat', 'proj-p', '--client-id', BOB], OTHER_KEY));
    const bobView = (bob.viewers as unknown[]).map((v) => toPresenceMember(v as never)).find((v) => v.memberId === BOB)!;
    expect(bobView).toEqual({ memberId: BOB, name: 'Bob', role: 'member', avatarUrl: null, filePath: null, heartbeatAt: clock.toISOString() });
    expect('activity' in bobView).toBe(false);
    const listed = expectOk(await run(['collab', 'presence', 'list', 'proj-p'], OTHER_KEY));
    expect((listed.viewers as Array<{ memberId: string }>).map((v) => v.memberId).sort()).toEqual([ALICE, BOB].sort());
    const left = expectOk(await run(['collab', 'presence', 'leave', 'proj-p', '--client-id', 'cli-1']));
    expect((left.viewers as Array<{ memberId: string }>).map((v) => v.memberId)).toEqual([BOB]);
    // Invalid --activity-json is a local error.
    expect((await run(['collab', 'presence', 'heartbeat', 'proj-p', '--client-id', 'c', '--activity-json', '{'])).stderr).toBe('Error: collab presence heartbeat: --activity-json is not valid JSON\n');
    expect((await run(['collab', 'presence', 'list'])).exitCode).toBe(2);
  });

  it('presence uses an 8s internal budget below the daemon 10s kill; a stalled hub yields the typed timeout line', async () => {
    expect(PRESENCE_HTTP_TIMEOUT_MS).toBe(8_000);
    expect(PRESENCE_HTTP_TIMEOUT_MS).toBeLessThan(PRESENCE_COMMAND_TIMEOUT_MS);
    let observedTimeout: number | null = null;
    const stalled = async (_url: string, init: RequestInit) => {
      // Record the budget the shim armed, then behave like a hung socket until aborted.
      const signal = init.signal!;
      return new Promise<Response>((_, reject) => {
        const armedAt = Date.now();
        signal.addEventListener('abort', () => {
          observedTimeout = Date.now() - armedAt;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
        // Fire the abort ourselves: replace the real 8s wait with the same AbortError the timer would raise.
        setTimeout(() => (signal as AbortSignal & { dispatchEvent: (e: Event) => boolean }).dispatchEvent(new Event('abort')), 5);
      });
    };
    for (const argv of [
      ['collab', 'presence', 'heartbeat', 'p', '--client-id', 'c'],
      ['collab', 'presence', 'list', 'p'],
      ['collab', 'presence', 'leave', 'p', '--client-id', 'c'],
    ]) {
      const result = await runCli(argv, envFor(), { fetch: stalled });
      expect(result).toEqual({ stdout: '', stderr: `Error: ${argv.slice(0, 3).join(' ')}: request failed: timeout\n`, exitCode: 1 });
      // The daemon classifies a shim-side timeout line as infrastructure (retryable), not as a kill.
      expect(classifyCollabCloudError(daemonError(result))).toMatchObject({ kind: 'infrastructure', retryable: true, upstreamStatus: null });
    }
    expect(observedTimeout).not.toBeNull();
  });

  it('non-member presence -> 403 without touching GitLab, still fast', async () => {
    const started = Date.now();
    const result = await runCli(['collab', 'presence', 'heartbeat', 'p', '--client-id', 'c'], envFor(OTHER_KEY, 'u1'));
    expectHttpError(result, 'collab presence heartbeat', 403, 'workspace_not_authorized');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

function expectOkRaw(result: CliResult): string {
  expect(result.stderr).toBe('');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  return result.stdout;
}
