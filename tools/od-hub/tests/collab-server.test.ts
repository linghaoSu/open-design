import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHubServer, type HubServer } from '../src/server/http.js';
import { deriveMemberId, MemoryHubStore } from '../src/server/memory-store.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore } from '../src/server/store.js';
import { toDirectoryEntry, toPresenceMember } from './daemon-collab-parsers.js';
import { parseHubWorkspaceEvent } from './daemon-parsers.js';
import { authHeaders, CONTROL_KEY, OTHER_KEY, PERSONAL_WORKSPACE, SEED, TEAM_WORKSPACE } from './helpers.js';

/**
 * `/api/v1/collab/{members,projects/:p/comments,projects/:p/presence}` over
 * HTTP on both stores: membership gates, event emission (comment-changed,
 * presence-changed, workspace-members-changed), digest movement, audit rows.
 */
const implementations: Array<[string, (now: () => Date) => HubStore]> = [
  ['MemoryHubStore', (now) => new MemoryHubStore({}, { now })],
  ['SqliteHubStore(:memory:)', (now) => new SqliteHubStore(':memory:', { now })],
];

/** u3 (Carol): a REMOVED member holding a live key — 403 everywhere, absent from the member list. */
const REMOVED_KEY = 'odc_test_key_carol';

async function seedStore(store: HubStore): Promise<void> {
  for (const user of SEED.users ?? []) {
    await store.createUser({ id: user.id, email: user.email, name: user.name });
    await store.issueApiKey({ userId: user.id, kind: 'control', secret: user.controlKey });
  }
  for (const workspace of SEED.workspaces ?? []) {
    await store.createWorkspace({ id: workspace.id, name: workspace.name, kind: workspace.kind, iconKey: workspace.iconKey ?? null });
    for (const member of workspace.members) {
      await store.upsertMember({ workspaceId: workspace.id, userId: member.userId, role: member.role, displayName: SEED.users!.find((u) => u.id === member.userId)!.name });
    }
  }
  await store.createUser({ id: 'u3', email: 'carol@example.test', name: 'Carol' });
  await store.issueApiKey({ userId: 'u3', kind: 'control', secret: REMOVED_KEY });
  await store.upsertMember({ workspaceId: TEAM_WORKSPACE, userId: 'u3', role: 'member', memberStatus: 'removed', displayName: 'Carol' });
}

describe.each(implementations)('%s collab over HTTP', (_name, makeStore) => {
  let hub: HubServer;
  let url: string;
  let store: HubStore;
  let clock = new Date('2026-09-08T10:00:00.000Z');
  const PRESENCE_TTL = 30_000;
  const ALICE = deriveMemberId('u1', TEAM_WORKSPACE);
  const BOB = deriveMemberId('u2', TEAM_WORKSPACE);

  beforeAll(async () => {
    store = makeStore(() => clock);
    await seedStore(store);
    hub = createHubServer({ store, heartbeatIntervalMs: 50, now: () => clock, presenceTtlMs: PRESENCE_TTL });
    url = (await hub.listen(0)).url;
  });

  afterAll(async () => {
    await hub.close();
    await store.close();
  });

  async function call(method: string, pathname: string, options: { key?: string; workspace?: string | null; body?: unknown } = {}) {
    const headers: Record<string, string> = authHeaders(options.key ?? CONTROL_KEY, options.workspace === null ? undefined : (options.workspace ?? TEAM_WORKSPACE));
    let body: string | undefined;
    if (options.body !== undefined && method !== 'GET') {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(`${url}${pathname}`, { method, headers, body });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  const digest = async () => (await call('GET', '/api/v1/collab/sync-digest')).body as Record<string, string>;

  /** Subscribe and resolve once `count` workspace-event frames arrived (heartbeats are ignored). */
  async function subscribe(count: number, key = OTHER_KEY): Promise<{ events: () => Promise<Array<Record<string, unknown> | null>> }> {
    const controller = new AbortController();
    const response = await fetch(`${url}/api/v1/collab/events`, { headers: authHeaders(key, TEAM_WORKSPACE), signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const collected: Array<Record<string, unknown> | null> = [];
    let buffer = '';
    const done = (async () => {
      while (collected.length < count) {
        const { value, done: closed } = await reader.read();
        if (closed) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
          const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
          if (event === 'workspace-event') collected.push(parseHubWorkspaceEvent(data));
          boundary = buffer.indexOf('\n\n');
        }
      }
      controller.abort();
      return collected;
    })();
    // Wait for the ready frame so the subscription is registered before the caller mutates.
    await new Promise((r) => setTimeout(r, 30));
    return { events: () => Promise.race([done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out; have ${JSON.stringify(collected)}`)), 3_000))]) };
  }

  describe('gates', () => {
    // Bodies are valid so the gate, not body validation, is what answers.
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/api/v1/collab/members', undefined],
      ['POST', '/api/v1/collab/members/register', { displayName: 'X' }],
      ['POST', '/api/v1/collab/projects/p/comments', { comment: { id: 'gate' } }],
      ['GET', '/api/v1/collab/projects/p/comments?sinceSeq=0', undefined],
      ['POST', '/api/v1/collab/projects/p/presence/heartbeat', { clientId: 'gate' }],
      ['GET', '/api/v1/collab/projects/p/presence', undefined],
      ['POST', '/api/v1/collab/projects/p/presence/leave', { clientId: 'gate' }],
    ];
    for (const [method, pathname, body] of routes) {
      it(`${method} ${pathname}: 401 bad key, 400 no workspace header, 403 non-member, 403 removed member`, async () => {
        const badKey = await call(method, pathname, { key: 'odc_nope', body });
        expect(badKey.status).toBe(401);
        expect(badKey.body).toEqual({ error: 'invalid_api_key' });
        const noWorkspace = await call(method, pathname, { workspace: null, body });
        expect(noWorkspace.status).toBe(400);
        expect(noWorkspace.body).toEqual({ error: 'workspace_id_required' });
        // Bob is not a member of Alice's personal workspace.
        const denied = await call(method, pathname, { key: OTHER_KEY, workspace: PERSONAL_WORKSPACE, body });
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: 'workspace_not_authorized' });
        // Unknown workspace id.
        expect((await call(method, pathname, { workspace: 'g999', body })).status).toBe(403);
        // Carol's key is valid but her membership is REMOVED: same 403 as a stranger.
        const removed = await call(method, pathname, { key: REMOVED_KEY, body });
        expect(removed.status).toBe(403);
        expect(removed.body).toEqual({ error: 'workspace_not_authorized' });
        // Nothing leaked into the roster / stream / audit while gated.
        expect((await call('GET', '/api/v1/collab/projects/p/presence')).body).toEqual({ viewers: [] });
        expect((await call('GET', '/api/v1/collab/projects/p/comments')).body).toEqual({ comments: [], latestSeq: 0 });
      });
    }
  });

  describe('members', () => {
    it('lists active members sorted owner->admin->member with the daemon-parsable shape', async () => {
      const result = await call('GET', '/api/v1/collab/members', { key: OTHER_KEY });
      expect(result.status).toBe(200);
      const members = (result.body as { members: Array<Record<string, unknown>> }).members;
      expect(members.map((m) => [m.memberId, m.role, m.displayName])).toEqual([[ALICE, 'owner', 'Alice'], [BOB, 'member', 'Bob']]);
      expect(members.map(toDirectoryEntry)).toEqual([
        { memberId: ALICE, displayName: 'Alice', role: 'owner' },
        { memberId: BOB, displayName: 'Bob', role: 'member' },
      ]);
    });

    it('register upserts the display name, ignores the client role, emits members-changed once, moves membersToken', async () => {
      const before = await digest();
      const sse = await subscribe(1);
      const first = await call('POST', '/api/v1/collab/members/register', { body: { displayName: 'Alice Renamed', role: 'member' } });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ member: { memberId: ALICE, displayName: 'Alice Renamed', role: 'owner' } });
      // Idempotent: same name -> same answer, no second event.
      const again = await call('POST', '/api/v1/collab/members/register', { body: { displayName: 'Alice Renamed', role: 'admin' } });
      expect(again.body).toEqual(first.body);
      await new Promise((r) => setTimeout(r, 50));
      const events = await sse.events();
      expect(events).toEqual([{ type: 'workspace-members-changed', workspaceId: TEAM_WORKSPACE, memberId: ALICE, memberChange: 'updated', at: clock.toISOString() }]);
      const after = await digest();
      expect(after.membersToken).not.toBe(before.membersToken);
      expect(after.catalogToken).toBe(before.catalogToken);
      expect(after.contextToken).toBe(before.contextToken);
      expect((await store.listAudit(TEAM_WORKSPACE)).filter((a) => a.action === 'member_register')).toHaveLength(1);
      // Directory row reflects the new name; list too.
      expect((await store.getMembership('u1', TEAM_WORKSPACE))!.displayName).toBe('Alice Renamed');
      const list = (await call('GET', '/api/v1/collab/members')).body as { members: Array<{ displayName: string }> };
      expect(list.members[0]!.displayName).toBe('Alice Renamed');
      // Validation.
      expect((await call('POST', '/api/v1/collab/members/register', { body: {} })).body).toEqual({ error: 'display_name_required' });
      expect((await call('POST', '/api/v1/collab/members/register', { body: { displayName: '   ' } })).status).toBe(400);
    });

    it('register with an unchanged displayName is a pure read: membersToken untouched, no event, no audit', async () => {
      const current = (await store.getMembership('u1', TEAM_WORKSPACE))!.displayName!;
      const before = await digest();
      const outboxBefore = (await store.listUnpublishedOutbox()).length;
      const auditBefore = (await store.listAudit(TEAM_WORKSPACE)).length;
      const same = await call('POST', '/api/v1/collab/members/register', { body: { displayName: `  ${current}  ` } });
      expect(same.status).toBe(200);
      expect((same.body as { member: { displayName: string } }).member.displayName).toBe(current);
      expect((await digest()).membersToken).toBe(before.membersToken);
      expect(await digest()).toEqual(before);
      expect((await store.listUnpublishedOutbox()).length).toBe(outboxBefore);
      expect((await store.listAudit(TEAM_WORKSPACE)).length).toBe(auditBefore);
    });

    it('register validates role: 400 invalid_role outside owner/admin/member, accepted values are still ignored', async () => {
      const before = await digest();
      for (const role of ['god', '', 'OWNER', 42, null, {}]) {
        const bad = await call('POST', '/api/v1/collab/members/register', { body: { displayName: 'Whoever', role } });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ error: 'invalid_role' });
      }
      // Rejected before any write: name unchanged, digest unchanged.
      expect((await store.getMembership('u1', TEAM_WORKSPACE))!.displayName).not.toBe('Whoever');
      expect(await digest()).toEqual(before);
      // Valid role values pass validation and are ignored for storage (Alice stays owner).
      const current = (await store.getMembership('u1', TEAM_WORKSPACE))!.displayName!;
      for (const role of ['owner', 'admin', 'member']) {
        const ok = await call('POST', '/api/v1/collab/members/register', { body: { displayName: current, role } });
        expect(ok.status).toBe(200);
        expect((ok.body as { member: { role: string } }).member.role).toBe('owner');
      }
      // Absent role is fine too.
      expect((await call('POST', '/api/v1/collab/members/register', { body: { displayName: current } })).status).toBe(200);
    });

    it('removed members disappear from the list', async () => {
      await hub.directory.removeMembership('u2', TEAM_WORKSPACE);
      const list = (await call('GET', '/api/v1/collab/members')).body as { members: Array<{ memberId: string }> };
      expect(list.members.map((m) => m.memberId)).toEqual([ALICE]);
      expect((await call('GET', '/api/v1/collab/members', { key: OTHER_KEY })).status).toBe(403);
      // Restore Bob for the remaining cases.
      await store.upsertMember({ workspaceId: TEAM_WORKSPACE, userId: 'u2', role: 'member', memberStatus: 'active' });
    });
  });

  describe('comments', () => {
    it('push assigns seq, emits comment-changed, does NOT move the digest; pull pages by sinceSeq with tombstones', async () => {
      const before = await digest();
      const sse = await subscribe(3);
      const base = { conversationId: 'conv', seq: 0, note: '', filePath: 'index.html', elementId: 'e', selector: 'h1', label: 'h1', text: 'x', htmlHint: '', position: { x: 0, y: 0, width: 1, height: 1 }, status: 'open', createdAt: clock.getTime() };
      const c1 = await call('POST', `/api/v1/collab/projects/proj-1/comments`, { body: { comment: { ...base, id: 'c1', projectId: 'proj-1', memberId: ALICE, updatedAt: clock.getTime() } } });
      expect(c1).toEqual({ status: 200, body: { seq: 1 } });
      // Bob pushes with an empty memberId: author defaults to the caller (Bob).
      const c2 = await call('POST', `/api/v1/collab/projects/proj-1/comments`, { key: OTHER_KEY, body: { comment: { ...base, id: 'c2', projectId: 'proj-1', memberId: '', updatedAt: clock.getTime() + 60_000 } } });
      expect(c2.body).toEqual({ seq: 2 });
      // Delete relayed by a non-author (Alice deletes Bob's comment): accepted.
      const del = await call('POST', `/api/v1/collab/projects/proj-1/comments`, { body: { comment: { ...base, id: 'c2', projectId: 'proj-1', memberId: BOB, deleted: true, updatedAt: clock.getTime() + 1 } } });
      expect(del.body).toEqual({ seq: 3 });
      // The daemon parser (hub-events-subscriber.ts:152-165) keeps projectId and seq: the frame names what moved.
      const events = await sse.events();
      expect(events).toEqual([1, 2, 3].map((seq) => ({ type: 'comment-changed', workspaceId: TEAM_WORKSPACE, projectId: 'proj-1', seq, at: clock.toISOString() })));

      const pull = (await call('GET', `/api/v1/collab/projects/proj-1/comments?sinceSeq=0`, { key: OTHER_KEY })).body as { comments: Array<Record<string, unknown>>; latestSeq: number };
      expect(pull.latestSeq).toBe(3);
      expect(pull.comments.map((c) => [c.id, c.seq, c.deleted ?? false, c.memberId])).toEqual([['c1', 1, false, ALICE], ['c2', 3, true, BOB]]);
      // updatedAt clamp: Bob's +60s became now+5s, then the tombstone (now+1) replaced the row.
      expect(pull.comments[1]!.updatedAt).toBe(clock.getTime() + 1);
      const delta = (await call('GET', `/api/v1/collab/projects/proj-1/comments?sinceSeq=2`)).body as { comments: unknown[]; latestSeq: number };
      expect(delta.comments).toHaveLength(1);
      expect(delta.latestSeq).toBe(3);
      const empty = (await call('GET', `/api/v1/collab/projects/proj-1/comments?sinceSeq=3`)).body;
      expect(empty).toEqual({ comments: [], latestSeq: 3 });
      expect((await call('GET', `/api/v1/collab/projects/never/comments`)).body).toEqual({ comments: [], latestSeq: 0 });
      expect((await call('GET', `/api/v1/collab/projects/proj-1/comments?sinceSeq=-1`)).body).toEqual({ error: 'invalid_since_seq' });
      expect((await call('GET', `/api/v1/collab/projects/proj-1/comments?sinceSeq=abc`)).status).toBe(400);

      // Resurrecting the tombstone is refused silently: same seq, no event, no audit.
      const auditBefore = (await store.listAudit(TEAM_WORKSPACE)).length;
      const late = await call('POST', `/api/v1/collab/projects/proj-1/comments`, { key: OTHER_KEY, body: { comment: { ...base, id: 'c2', projectId: 'proj-1', memberId: BOB, updatedAt: clock.getTime() + 2 } } });
      expect(late.body).toEqual({ seq: 3 });
      expect((await store.listAudit(TEAM_WORKSPACE)).length).toBe(auditBefore);
      expect(await store.listUnpublishedOutbox()).toEqual([]);

      const after = await digest();
      expect(after).toEqual(before);
      // Audit: one action per outcome, id only, never the body.
      const audit = (await store.listAudit(TEAM_WORKSPACE)).filter((a) => a.action.startsWith('comment_'));
      expect(audit.map((a) => [a.action, a.target])).toEqual([['comment_create', 'c1'], ['comment_create', 'c2'], ['comment_delete', 'c2']]);
      expect(audit[0]).toMatchObject({ actorUserId: 'u1', details: { projectId: 'proj-1', seq: 1, authorMemberId: ALICE, pushedByMemberId: ALICE } });
      expect(audit[2]).toMatchObject({ actorUserId: 'u1', details: { projectId: 'proj-1', seq: 3, authorMemberId: BOB, pushedByMemberId: ALICE } });
      expect(JSON.stringify(audit)).not.toContain('"text"');
      expect(JSON.stringify(audit)).not.toContain('comment_push');
      // An edit of a live row is comment_update.
      await call('POST', `/api/v1/collab/projects/proj-1/comments`, { body: { comment: { ...base, id: 'c1', projectId: 'proj-1', memberId: ALICE, text: 'edited', updatedAt: clock.getTime() + 1 } } });
      const updated = (await store.listAudit(TEAM_WORKSPACE)).filter((a) => a.action === 'comment_update');
      expect(updated.map((a) => [a.target, (a.details as { seq: number }).seq])).toEqual([['c1', 4]]);
      expect(JSON.stringify(updated)).not.toContain('edited');
    });

    it('tombstone precedence over HTTP: the zombie push is a 200 echoing the tombstone seq with NO SSE event', async () => {
      const seedBody = (extra: Record<string, unknown>) => ({ comment: { id: 'z', projectId: 'proj-t', memberId: ALICE, text: 'body', updatedAt: clock.getTime(), ...extra } });
      const sse = await subscribe(2);
      expect((await call('POST', `/api/v1/collab/projects/proj-t/comments`, { body: seedBody({}) })).body).toEqual({ seq: 1 });
      expect((await call('POST', `/api/v1/collab/projects/proj-t/comments`, { body: seedBody({ deleted: true }) })).body).toEqual({ seq: 2 });
      const framesBefore = await sse.events();
      expect(framesBefore.map((e) => [e!.type, e!.seq])).toEqual([['comment-changed', 1], ['comment-changed', 2]]);
      const outboxBefore = await store.listUnpublishedOutbox();
      const auditBefore = (await store.listAudit(TEAM_WORKSPACE)).length;
      // Subscribe again; the zombie push must produce no workspace-event frame at all.
      const silent = await subscribe(1);
      const zombie = await call('POST', `/api/v1/collab/projects/proj-t/comments`, { body: seedBody({ text: 'back from the dead', updatedAt: clock.getTime() + 10 }) });
      expect(zombie.status).toBe(200);
      expect(zombie.body).toEqual({ seq: 2 });
      await expect(silent.events()).rejects.toThrow(/timed out; have \[\]/);
      expect(await store.listUnpublishedOutbox()).toEqual(outboxBefore);
      expect((await store.listAudit(TEAM_WORKSPACE)).length).toBe(auditBefore);
      const pull = (await call('GET', `/api/v1/collab/projects/proj-t/comments?sinceSeq=0`)).body as { comments: Array<Record<string, unknown>>; latestSeq: number };
      expect(pull.latestSeq).toBe(2);
      expect(pull.comments.map((c) => [c.id, c.seq, c.deleted])).toEqual([['z', 2, true]]);
      expect(JSON.stringify(pull)).not.toContain('back from the dead');
    });

    it('clamps a far-future updatedAt to now + 5s over HTTP', async () => {
      const far = clock.getTime() + 999_999_999;
      expect((await call('POST', `/api/v1/collab/projects/proj-f/comments`, { body: { comment: { id: 'ff', projectId: 'proj-f', memberId: ALICE, updatedAt: far } } })).body).toEqual({ seq: 1 });
      const [row] = ((await call('GET', `/api/v1/collab/projects/proj-f/comments?sinceSeq=0`)).body as { comments: Array<Record<string, unknown>> }).comments;
      expect(row!.updatedAt).toBe(clock.getTime() + 5_000);
      // A past updatedAt is kept verbatim.
      expect((await call('POST', `/api/v1/collab/projects/proj-f/comments`, { body: { comment: { id: 'past', projectId: 'proj-f', memberId: ALICE, updatedAt: clock.getTime() - 60_000 } } })).body).toEqual({ seq: 2 });
      const rows = ((await call('GET', `/api/v1/collab/projects/proj-f/comments?sinceSeq=1`)).body as { comments: Array<Record<string, unknown>> }).comments;
      expect(rows[0]!.updatedAt).toBe(clock.getTime() - 60_000);
    });

    it('nested body fields (position, attachments, podMembers) round-trip push -> pull untouched', async () => {
      const comment = {
        id: 'nested', projectId: 'proj-n', memberId: ALICE, conversationId: 'conv', note: 'n', filePath: 'a/b.html', elementId: 'e', selector: 'div > h1', label: 'H1', text: 'T', htmlHint: '<h1>',
        position: { x: 1.5, y: 2.25, width: 3, height: 4, anchor: { side: 'left', offset: [1, 2] } },
        attachments: [{ kind: 'image', url: 'https://x/y.png', meta: { w: 10, h: 20, tags: ['a', 'b'] } }, { kind: 'link', url: 'https://z' }],
        podMembers: [{ memberId: BOB, role: 'reviewer', flags: { muted: false } }],
        status: 'open', createdAt: clock.getTime(), updatedAt: clock.getTime(), seq: 999,
      };
      expect((await call('POST', `/api/v1/collab/projects/proj-n/comments`, { body: { comment } })).body).toEqual({ seq: 1 });
      const [row] = ((await call('GET', `/api/v1/collab/projects/proj-n/comments?sinceSeq=0`, { key: OTHER_KEY })).body as { comments: Array<Record<string, unknown>> }).comments;
      // Authoritative fields rewritten (seq), everything else byte-for-byte; `deleted` stays absent for a live row.
      expect(row).toEqual({ ...comment, seq: 1 });
      expect('deleted' in row!).toBe(false);
      expect(row!.position).toEqual(comment.position);
      expect(row!.attachments).toEqual(comment.attachments);
      expect(row!.podMembers).toEqual(comment.podMembers);
    });

    it('validates the body', async () => {
      expect((await call('POST', `/api/v1/collab/projects/p/comments`, { body: {} })).body).toEqual({ error: 'comment_required' });
      expect((await call('POST', `/api/v1/collab/projects/p/comments`, { body: { comment: [] } })).status).toBe(400);
      expect((await call('POST', `/api/v1/collab/projects/p/comments`, { body: { comment: { text: 'no id' } } })).body).toEqual({ error: 'comment_id_required' });
      expect((await call('POST', `/api/v1/collab/projects/p/comments`, { body: { comment: { id: '  ' } } })).body).toEqual({ error: 'comment_id_required' });
    });
  });

  describe('presence', () => {
    it('heartbeat/list/leave with events on join, eviction, and leave; clientId defaults to memberId', async () => {
      const before = await digest();
      const sse = await subscribe(4);
      const activity = { kind: 'editing', nested: { n: 1 } };
      const beat = await call('POST', `/api/v1/collab/projects/pp/presence/heartbeat`, { body: { clientId: 'tab-1', displayName: 'Alice', filePath: 'index.html', activity } });
      expect(beat.status).toBe(200);
      const viewers = (beat.body as { viewers: Array<Record<string, unknown>> }).viewers;
      expect(viewers).toEqual([{ memberId: ALICE, displayName: 'Alice', role: 'owner', avatarUrl: null, filePath: 'index.html', heartbeatAt: clock.toISOString(), activity }]);
      expect(toPresenceMember(viewers[0]!)).toEqual({ memberId: ALICE, name: 'Alice', role: 'owner', avatarUrl: null, filePath: 'index.html', activity, heartbeatAt: clock.toISOString() });
      // Repeat beat: no event.
      await call('POST', `/api/v1/collab/projects/pp/presence/heartbeat`, { body: { clientId: 'tab-1' } });
      // Bob without clientId -> lease keyed by his memberId; another member sees both.
      const bob = await call('POST', `/api/v1/collab/projects/pp/presence/heartbeat`, { key: OTHER_KEY, body: {} });
      expect((bob.body as { viewers: unknown[] }).viewers).toHaveLength(2);
      const listed = (await call('GET', `/api/v1/collab/projects/pp/presence`, { key: OTHER_KEY })).body as { viewers: Array<{ memberId: string; displayName: string }> };
      expect(listed.viewers.map((v) => v.memberId).sort()).toEqual([ALICE, BOB].sort());
      expect(listed.viewers.find((v) => v.memberId === BOB)!.displayName).toBe('Bob');
      // Advance past the TTL for Alice only, then a list sweeps her out (event).
      clock = new Date(clock.getTime() + PRESENCE_TTL - 1);
      await call('POST', `/api/v1/collab/projects/pp/presence/heartbeat`, { key: OTHER_KEY, body: {} });
      clock = new Date(clock.getTime() + 2);
      const swept = (await call('GET', `/api/v1/collab/projects/pp/presence`)).body as { viewers: Array<{ memberId: string }> };
      expect(swept.viewers.map((v) => v.memberId)).toEqual([BOB]);
      // Leave removes Bob's lease (keyed by memberId since he sent no clientId).
      const left = (await call('POST', `/api/v1/collab/projects/pp/presence/leave`, { key: OTHER_KEY, body: { clientId: BOB } })).body;
      expect(left).toEqual({ viewers: [] });
      // Leaving an unknown lease: no event.
      await call('POST', `/api/v1/collab/projects/pp/presence/leave`, { key: OTHER_KEY, body: { clientId: 'ghost' } });
      await new Promise((r) => setTimeout(r, 50));
      const events = await sse.events();
      // Frames carry projectId for the daemon's markPresenceStale(projectId) (hub-events-subscriber.ts:155).
      expect(events).toEqual(Array(4).fill(null).map(() => ({ type: 'presence-changed', workspaceId: TEAM_WORKSPACE, projectId: 'pp', at: expect.any(String) })));
      // Presence never moves the digest and writes no audit.
      expect(await digest()).toEqual(before);
      expect((await store.listAudit(TEAM_WORKSPACE)).some((a) => a.action.startsWith('presence'))).toBe(false);
      expect(await store.listUnpublishedOutbox()).toEqual([]);
    });

    it('viewer snapshots are isolated: mutating a response never changes the roster', async () => {
      const activity = { kind: 'editing', nested: { n: 1, list: [1, 2] } };
      await call('POST', `/api/v1/collab/projects/iso/presence/heartbeat`, { body: { clientId: 'iso-1', activity } });
      const first = ((await call('GET', `/api/v1/collab/projects/iso/presence`)).body as { viewers: Array<{ activity: { nested: { n: number; list: number[] } } }> }).viewers[0]!;
      first.activity.nested.n = 99;
      first.activity.nested.list.push(3);
      const second = ((await call('GET', `/api/v1/collab/projects/iso/presence`)).body as { viewers: Array<{ activity: unknown }> }).viewers[0]!;
      expect(second.activity).toEqual(activity);
      await call('POST', `/api/v1/collab/projects/iso/presence/leave`, { body: { clientId: 'iso-1' } });
    });

    it('membership removal evicts the member from every roster and announces it', async () => {
      const sse = await subscribe(6, CONTROL_KEY);
      await call('POST', `/api/v1/collab/projects/ev-1/presence/heartbeat`, { key: OTHER_KEY, body: { clientId: 'b1' } });
      await call('POST', `/api/v1/collab/projects/ev-2/presence/heartbeat`, { key: OTHER_KEY, body: { clientId: 'b2' } });
      await hub.directory.removeMembership('u2', TEAM_WORKSPACE);
      const events = await sse.events();
      // Two joins, then the directory diff commits (context + members), then one eviction announcement per touched project.
      expect(events.map((e) => e!.type)).toEqual(['presence-changed', 'presence-changed', 'workspace-context-changed', 'workspace-members-changed', 'presence-changed', 'presence-changed']);
      expect(events.filter((e) => e!.type === 'presence-changed').map((e) => e!.projectId)).toEqual(['ev-1', 'ev-2', 'ev-1', 'ev-2']);
      expect((await call('GET', `/api/v1/collab/projects/ev-1/presence`)).body).toEqual({ viewers: [] });
      expect((await call('GET', `/api/v1/collab/projects/ev-2/presence`)).body).toEqual({ viewers: [] });
      expect((await call('POST', `/api/v1/collab/projects/ev-1/presence/heartbeat`, { key: OTHER_KEY, body: {} })).status).toBe(403);
      await store.upsertMember({ workspaceId: TEAM_WORKSPACE, userId: 'u2', role: 'member', memberStatus: 'active' });
    });
  });
});
