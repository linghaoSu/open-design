import { afterEach, describe, expect, it } from 'vitest';

import { digestFacesForEvent } from '../src/server/digest.js';
import { lifecycleForGroup, roleForAccessLevel } from '../src/server/directory-service.js';
import { deriveMemberId } from '../src/server/ids.js';
import { HUB_CAPABILITIES } from '../src/shared/wire.js';
import {
  mapVelaWorkspaceDirectoryItem,
  parseHubListenerStatus,
  parseHubWorkspaceDirectoryEvent,
  parseHubWorkspaceEvent,
  parseSyncDigest,
} from './daemon-parsers.js';
import { ALICE, BOB, loginViaHttp, startGitLabHub, type GitLabHubFixture } from './helpers/gitlab-hub.js';

const fixtures: GitLabHubFixture[] = [];
async function fx(options: Parameters<typeof startGitLabHub>[0] = {}): Promise<GitLabHubFixture> {
  const created = await startGitLabHub(options);
  fixtures.push(created);
  return created;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const bearer = (key: string, workspaceId?: string): Record<string, string> => ({
  authorization: `Bearer ${key}`,
  ...(workspaceId ? { 'x-vela-workspace-id': workspaceId } : {}),
});

interface Frame { event: string; data: Record<string, unknown> }

/** Open an SSE stream and expose frames as they arrive. */
async function openSse(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (!response.ok || !response.body) throw new Error(`sse status ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = '';
  let closed = false;
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { closed = true; return; }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = /^event: (.*)$/m.exec(frame)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(frame)?.[1] ?? '';
        frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
        boundary = buffer.indexOf('\n\n');
      }
    }
  })().catch(() => { closed = true; });
  const waitFor = async (predicate: (frames: Frame[]) => boolean, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(frames)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for frames; have ${JSON.stringify(frames.map((f) => f.event))}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const waitClosed = async (timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!closed) {
      if (Date.now() > deadline) throw new Error('stream did not close');
      await new Promise((r) => setTimeout(r, 10));
    }
    await pump;
  };
  return { frames, waitFor, waitClosed, isClosed: () => closed, abort: () => controller.abort() };
}

describe('role / lifecycle mapping (PLAN §5.2, §3.1)', () => {
  it('maps access levels to roles with the configurable floor', () => {
    expect(roleForAccessLevel(50, 20)).toBe('owner');
    expect(roleForAccessLevel(40, 20)).toBe('admin');
    expect(roleForAccessLevel(30, 20)).toBe('member');
    expect(roleForAccessLevel(20, 20)).toBe('member');
    expect(roleForAccessLevel(15, 20)).toBeNull();
    expect(roleForAccessLevel(10, 20)).toBeNull();
    expect(roleForAccessLevel(10, 10)).toBe('member');
  });

  it('maps group state to lifecycleState the daemon accepts (vela-workspace-context.ts:60-66)', () => {
    expect(lifecycleForGroup({})).toBe('active');
    expect(lifecycleForGroup({ archived: true })).toBe('locked');
    expect(lifecycleForGroup({ marked_for_deletion_on: '2026-09-01', archived: true })).toBe('deleting');
  });

  it('event -> digest face mapping mirrors e2e/lib/collab-hub-core/store.ts:303-327', () => {
    expect(digestFacesForEvent('team-projects-changed')).toEqual(['catalogToken']);
    expect(digestFacesForEvent('project-metadata-changed')).toEqual(['catalogToken']);
    expect(digestFacesForEvent('project-content-changed')).toEqual(['catalogToken']);
    expect(digestFacesForEvent('team-resources-changed')).toEqual(['catalogToken']);
    expect(digestFacesForEvent('workspace-members-changed')).toEqual(['membersToken']);
    expect(digestFacesForEvent('workspace-context-changed')).toEqual(['membersToken', 'contextToken']);
    expect(digestFacesForEvent('billing-changed')).toEqual(['billingToken']);
    expect(digestFacesForEvent('billing-subscription-changed')).toEqual(['billingToken']);
    expect(digestFacesForEvent('wallet-balance-changed')).toEqual(['billingToken']);
    expect(digestFacesForEvent('comment-changed')).toEqual([]);
    expect(digestFacesForEvent('presence-changed')).toEqual([]);
  });
});

describe.each(['memory', 'sqlite'] as const)('GET /api/v1/workspaces from GitLab (%s store)', (storeKind) => {
  it('returns personal + group rows in the daemon directory shape with role, icon, member id, lifecycle', async () => {
    const f = await fx({ store: storeKind });
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    const res = await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) });
    expect(res.status).toBe(200);
    const { items } = await res.json() as { items: Array<Record<string, unknown>> };
    expect(items).toEqual([
      {
        workspaceId: 'u101',
        workspaceName: "Alice Liddell's workspace",
        workspaceType: 'personal',
        workspaceMemberId: deriveMemberId('101', 'u101'),
        role: 'owner',
        memberStatus: 'active',
        lifecycleState: 'active',
      },
      {
        workspaceId: 'g1000',
        workspaceName: 'Design Team',
        workspaceIconKey: 'https://gitlab.example.test/design.png',
        workspaceType: 'team',
        workspaceMemberId: deriveMemberId('101', 'g1000'),
        role: 'owner',
        memberStatus: 'active',
        lifecycleState: 'active',
      },
      {
        workspaceId: 'g2000',
        workspaceName: 'Platform',
        workspaceType: 'team',
        workspaceMemberId: deriveMemberId('101', 'g2000'),
        role: 'admin',
        memberStatus: 'active',
        lifecycleState: 'active',
      },
    ]);
    // Guest-only group (access 10 < 20) and the subgroup (top-level mode) produce no row.
    expect(items.map((i) => i.workspaceId)).not.toContain('g3000');
    expect(items.map((i) => i.workspaceId)).not.toContain('g1001');
    // member id grammar: m_<sha256(userId:workspaceId)[:24]>
    for (const item of items) {
      expect(item.workspaceMemberId).toMatch(/^m_[0-9a-f]{24}$/);
      expect(item.workspaceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/); // routes/vela.ts:75
      // apps/daemon/src/collab/vela-workspace-context.ts:196-219 accepts every row
      expect(mapVelaWorkspaceDirectoryItem(item)).toEqual(item);
    }
    // Rows are mirrored into the store.
    expect((await f.store.getWorkspace('g1000'))).toMatchObject({ gitlabKind: 'team', gitlabId: 1000, name: 'Design Team' });
    expect((await f.store.getMembership('101', 'g2000'))?.role).toBe('admin');
  });

  it('include-subgroups mode adds subgroup rows; Bob (developer) is a member of g1000 only', async () => {
    const f = await fx({ store: storeKind, env: { GITLAB_WORKSPACE_GROUP_MODE: 'include-subgroups' } });
    const alice = await loginViaHttp(f, ALICE.id);
    const { items } = await (await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(alice.controlKey) })).json() as { items: Array<Record<string, unknown>> };
    expect(items.map((i) => [i.workspaceId, i.role])).toEqual([
      ['u101', 'owner'], ['g1000', 'owner'], ['g1001', 'member'], ['g2000', 'admin'],
    ]);
    const bob = await loginViaHttp(f, BOB.id);
    const bobItems = await (await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(bob.controlKey) })).json() as { items: Array<Record<string, unknown>> };
    expect(bobItems.items.map((i) => [i.workspaceId, i.role, i.workspaceMemberId])).toEqual([
      ['u202', 'owner', deriveMemberId('202', 'u202')],
      ['g1000', 'member', deriveMemberId('202', 'g1000')],
    ]);
    // Same workspace, two users -> two distinct member ids (billing snapshot must agree).
    expect(bobItems.items[1]!.workspaceMemberId).not.toBe(items[1]!.workspaceMemberId);
    const snap = await (await fetch(`${f.hubUrl}/api/v1/billing/workspace-snapshot`, { headers: bearer(bob.controlKey, 'g1000') })).json() as { workspaceMemberId: string };
    expect(snap.workspaceMemberId).toBe(bobItems.items[1]!.workspaceMemberId);
  });

  it('caches the GitLab listing for 60s per user, then refreshes and diffs', async () => {
    const f = await fx({ store: storeKind });
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    const groupsCalls = () => f.gitlab.requests.filter((r) => r.path.startsWith('/api/v4/groups?')).length;
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) });
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) });
    expect(groupsCalls()).toBe(1);
    f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) });
    expect(groupsCalls()).toBe(2);
  });

  it('a membership that disappears from GitLab is returned as memberStatus=removed for 7 days, then dropped; lifecycle follows the group', async () => {
    const f = await fx({ store: storeKind });
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) });

    delete f.gitlab.groups.get(2000)!.members[ALICE.id];
    f.gitlab.groups.get(1000)!.archived = true;
    f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    let { items } = await (await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) })).json() as { items: Array<Record<string, unknown>> };
    expect(items.find((i) => i.workspaceId === 'g2000')).toMatchObject({ memberStatus: 'removed', role: 'admin' });
    expect(items.find((i) => i.workspaceId === 'g1000')).toMatchObject({ lifecycleState: 'locked' });
    // Removed members are locked out of workspace-scoped routes.
    const gate = await fetch(`${f.hubUrl}/api/v1/collab/sync-digest`, { headers: bearer(controlKey, 'g2000') });
    expect(gate.status).toBe(403);
    expect(await gate.json()).toEqual({ error: 'workspace_not_authorized' });

    f.gitlab.groups.get(1000)!.marked_for_deletion_on = '2026-09-20';
    f.clock.now = new Date(f.clock.now.getTime() + 6 * 86_400_000);
    ({ items } = await (await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) })).json() as { items: Array<Record<string, unknown>> });
    expect(items.find((i) => i.workspaceId === 'g2000')?.memberStatus).toBe('removed');
    expect(items.find((i) => i.workspaceId === 'g1000')?.lifecycleState).toBe('deleting');

    f.clock.now = new Date(f.clock.now.getTime() + 1.1 * 86_400_000);
    ({ items } = await (await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) })).json() as { items: Array<Record<string, unknown>> });
    expect(items.map((i) => i.workspaceId)).toEqual(['u101', 'g1000']);
    // Past retention the sync hard-deletes the row (not just hides it), so workspace_members stays bounded.
    expect(await f.store.getMembership('101', 'g2000')).toBeNull();
    expect((await f.store.listMemberships('101')).map((m) => m.workspaceId).sort()).toEqual(['g1000', 'u101']);

    // Re-added: active again with the same member id.
    f.gitlab.groups.get(2000)!.members[ALICE.id] = 30;
    f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    ({ items } = await (await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) })).json() as { items: Array<Record<string, unknown>> });
    expect(items.find((i) => i.workspaceId === 'g2000')).toMatchObject({ memberStatus: 'active', role: 'member', workspaceMemberId: deriveMemberId('101', 'g2000') });
  });

  it('serves the mirrored directory when GitLab is unreachable instead of failing', async () => {
    const f = await fx({ store: storeKind });
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) });
    await f.gitlab.stop();
    f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    const res = await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(controlKey) });
    expect(res.status).toBe(200);
    const { items } = await res.json() as { items: Array<{ workspaceId: string }> };
    expect(items.map((i) => i.workspaceId)).toEqual(['u101', 'g1000', 'g2000']);
  });
});

describe('SSE + outbox (hub-events-subscriber.ts contract)', () => {
  it('ready carries the 5 capabilities and listener status, then heartbeats keep the same epoch', async () => {
    const f = await fx();
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    const sse = await openSse(`${f.hubUrl}/api/v1/collab/events`, bearer(controlKey, 'g1000'));
    await sse.waitFor((frames) => frames.length >= 3);
    expect(sse.frames[0]!.event).toBe('ready');
    const ready = sse.frames[0]!.data;
    expect(ready.workspaceId).toBe('g1000');
    expect(ready.capabilities).toEqual([...HUB_CAPABILITIES]);
    // hub-events-subscriber.ts:222-244
    expect(parseHubListenerStatus(ready)).toEqual({ listenerEpoch: ready.listenerEpoch, listenerHealth: 'healthy', sourceGap: false });
    expect(sse.frames[1]!.event).toBe('heartbeat');
    expect(sse.frames[2]!.event).toBe('heartbeat');
    expect(parseHubListenerStatus(sse.frames[1]!.data)).toEqual(parseHubListenerStatus(ready));
    sse.abort();
  });

  it('directory diffs fan out as workspace-directory-changed frames to the user only; workspace-event frames go to workspace members', async () => {
    const f = await fx();
    const alice = await loginViaHttp(f, ALICE.id);
    const bob = await loginViaHttp(f, BOB.id);
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(alice.controlKey) });
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(bob.controlKey) });
    const aliceSse = await openSse(`${f.hubUrl}/api/v1/collab/events`, bearer(alice.controlKey, 'g1000'));
    const bobSse = await openSse(`${f.hubUrl}/api/v1/collab/events`, bearer(bob.controlKey, 'g1000'));
    await aliceSse.waitFor((fr) => fr.length >= 2);
    await bobSse.waitFor((fr) => fr.length >= 2);

    // Alice is promoted in g1001? no - add a brand new group for Alice and demote her in g2000.
    f.gitlab.addGroup({ id: 4000, name: 'new', full_name: 'Brand New', full_path: 'new', path: 'new', parent_id: null, members: { [ALICE.id]: 30 } });
    f.gitlab.groups.get(2000)!.members[ALICE.id] = 30;
    f.gitlab.groups.get(1000)!.members[ALICE.id] = 40; // owner -> admin in the workspace Bob also watches
    f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(alice.controlKey) });

    await aliceSse.waitFor((fr) => fr.filter((x) => x.event === 'workspace-directory-changed').length >= 3);
    const directory = aliceSse.frames.filter((x) => x.event === 'workspace-directory-changed').map((x) => x.data);
    expect(directory).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'workspace-directory-changed', workspaceId: 'g4000', change: 'created' }),
      expect.objectContaining({ type: 'workspace-directory-changed', workspaceId: 'g2000', change: 'membership-updated' }),
      expect.objectContaining({ type: 'workspace-directory-changed', workspaceId: 'g1000', change: 'membership-updated' }),
    ]));
    for (const d of directory) {
      // hub-events-subscriber.ts:173-196 parseHubWorkspaceDirectoryEvent must accept every frame
      expect(parseHubWorkspaceDirectoryEvent(JSON.stringify(d))).toEqual({ type: 'workspace-directory-changed', workspaceId: d.workspaceId, change: d.change, at: d.at });
    }

    // Bob (same workspace, different account) sees the g1000 member change but no directory frames.
    await bobSse.waitFor((fr) => fr.filter((x) => x.event === 'workspace-event').length >= 2);
    const bobEvents = bobSse.frames.filter((x) => x.event === 'workspace-event').map((x) => x.data);
    expect(bobEvents).toEqual([
      expect.objectContaining({ type: 'workspace-context-changed', workspaceId: 'g1000' }),
      expect.objectContaining({ type: 'workspace-members-changed', workspaceId: 'g1000', memberId: deriveMemberId('101', 'g1000'), memberChange: 'updated' }),
    ]);
    for (const e of bobEvents) expect(parseHubWorkspaceEvent(JSON.stringify(e))).toMatchObject({ type: e.type, workspaceId: 'g1000' });
    expect(bobSse.frames.some((x) => x.event === 'workspace-directory-changed')).toBe(false);
    // Events for g2000/g4000 never reach a g1000 stream.
    expect(aliceSse.frames.filter((x) => x.event === 'workspace-event').every((x) => x.data.workspaceId === 'g1000')).toBe(true);

    // Outbox rows are marked published.
    expect(await f.store.listUnpublishedOutbox()).toEqual([]);
    aliceSse.abort();
    bobSse.abort();
  });

  it('membership removal: members-changed{removed} to the workspace, then access-revoked{reason} to the removed user and the stream closes', async () => {
    const f = await fx();
    const alice = await loginViaHttp(f, ALICE.id);
    const bob = await loginViaHttp(f, BOB.id);
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(alice.controlKey) });
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(bob.controlKey) });
    const bobSse = await openSse(`${f.hubUrl}/api/v1/collab/events`, bearer(bob.controlKey, 'g1000'));
    const aliceSse = await openSse(`${f.hubUrl}/api/v1/collab/events`, bearer(alice.controlKey, 'g1000'));
    await bobSse.waitFor((fr) => fr.length >= 2);
    await aliceSse.waitFor((fr) => fr.length >= 2);
    const digestBefore = await (await fetch(`${f.hubUrl}/api/v1/collab/sync-digest`, { headers: bearer(alice.controlKey, 'g1000') })).json() as Record<string, string>;

    // GitLab drops Bob; the hub learns it on Bob's next directory refresh.
    delete f.gitlab.groups.get(1000)!.members[BOB.id];
    f.clock.now = new Date(f.clock.now.getTime() + 61_000);
    const dir = await (await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(bob.controlKey) })).json() as { items: Array<Record<string, unknown>> };
    expect(dir.items.find((i) => i.workspaceId === 'g1000')?.memberStatus).toBe('removed');

    await bobSse.waitClosed();
    const bobNames = bobSse.frames.map((x) => x.event);
    // order: ready, heartbeat(s)..., directory, workspace-event x2, access-revoked
    const idx = (name: string) => bobNames.indexOf(name);
    expect(idx('workspace-directory-changed')).toBeGreaterThan(0);
    expect(idx('access-revoked')).toBe(bobNames.length - 1);
    expect(idx('workspace-event')).toBeLessThan(idx('access-revoked'));
    expect(bobSse.frames.find((x) => x.event === 'workspace-directory-changed')!.data).toMatchObject({ workspaceId: 'g1000', change: 'membership-removed' });
    const removedEvent = bobSse.frames.filter((x) => x.event === 'workspace-event').map((x) => x.data);
    expect(removedEvent).toEqual([
      expect.objectContaining({ type: 'workspace-context-changed', workspaceId: 'g1000' }),
      expect.objectContaining({ type: 'workspace-members-changed', workspaceId: 'g1000', memberId: deriveMemberId('202', 'g1000'), memberChange: 'removed' }),
    ]);
    // hub-events-subscriber.ts:598-631 reads `reason`; e2e fake uses this string (hub.ts:315)
    expect(bobSse.frames.at(-1)!.data).toEqual({ reason: 'workspace_membership_removed' });

    // Alice keeps her stream and sees the member change, never access-revoked.
    await aliceSse.waitFor((fr) => fr.some((x) => x.event === 'workspace-event' && x.data.memberChange === 'removed'));
    expect(aliceSse.isClosed()).toBe(false);
    expect(aliceSse.frames.some((x) => x.event === 'access-revoked')).toBe(false);

    // Bob can no longer subscribe to g1000 (403) and the digest members/context faces moved for Alice.
    const denied = await fetch(`${f.hubUrl}/api/v1/collab/events`, { headers: bearer(bob.controlKey, 'g1000') });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'workspace_not_authorized' });
    const digestAfter = await (await fetch(`${f.hubUrl}/api/v1/collab/sync-digest`, { headers: bearer(alice.controlKey, 'g1000') })).json() as Record<string, string>;
    expect(parseSyncDigest(digestAfter)).toEqual(digestAfter);
    expect(digestAfter.membersToken).not.toBe(digestBefore.membersToken);
    expect(digestAfter.contextToken).not.toBe(digestBefore.contextToken);
    expect(digestAfter.catalogToken).toBe(digestBefore.catalogToken);
    expect(digestAfter.billingToken).toBe(digestBefore.billingToken);
    // Bob's key is still valid: membership loss is not an auth failure (PLAN §5.3).
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: bearer(bob.controlKey) })).status).toBe(200);
    aliceSse.abort();
  });

  it('the store-level removeMembership hook produces the same sequence (admin/test path) and SQLite writes outbox atomically', async () => {
    const f = await fx({ store: 'sqlite' });
    const bob = await loginViaHttp(f, BOB.id);
    await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(bob.controlKey) });
    const sse = await openSse(`${f.hubUrl}/api/v1/collab/events`, bearer(bob.controlKey, 'g1000'));
    await sse.waitFor((fr) => fr.length >= 2);
    await f.hub.directory.removeMembership('202', 'g1000');
    await sse.waitClosed();
    expect(sse.frames.map((x) => x.event).filter((e) => e !== 'heartbeat')).toEqual([
      'ready', 'workspace-directory-changed', 'workspace-event', 'workspace-event', 'access-revoked',
    ]);
    expect((await f.store.getMembership('202', 'g1000'))?.memberStatus).toBe('removed');
    expect(await f.store.listUnpublishedOutbox()).toEqual([]);
  });

  it('sync-digest faces move by the shared event mapping on both stores', async () => {
    for (const storeKind of ['memory', 'sqlite'] as const) {
      const f = await fx({ store: storeKind });
      const alice = await loginViaHttp(f, ALICE.id);
      // First directory read mirrors the groups (moves members/context faces); snapshot after that.
      await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: bearer(alice.controlKey) });
      const before = await f.store.getSyncDigest('g1000');
      await f.store.applyBatch({
        outbox: [{ workspaceId: 'g1000', userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'team-projects-changed', workspaceId: 'g1000', projectId: 'p1' } }],
        digestBumps: digestFacesForEvent('team-projects-changed').map((face) => ({ workspaceId: 'g1000', face })),
      });
      const after = await (await fetch(`${f.hubUrl}/api/v1/collab/sync-digest`, { headers: bearer(alice.controlKey, 'g1000') })).json() as Record<string, string>;
      expect(after.catalogToken).not.toBe(before.catalogToken);
      expect(after.membersToken).toBe(before.membersToken);
      expect(after.contextToken).toBe(before.contextToken);
      expect(after.billingToken).toBe('');
    }
  });
});
