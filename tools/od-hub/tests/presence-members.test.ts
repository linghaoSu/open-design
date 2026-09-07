import { describe, expect, it } from 'vitest';

import { MemoryHubStore } from '../src/server/memory-store.js';
import { DEFAULT_PRESENCE_TTL_MS, PresenceService } from '../src/server/presence-service.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore, WorkspaceMemberRow } from '../src/server/store.js';
import { toPresenceMember } from './daemon-collab-parsers.js';

/**
 * Presence lease semantics under a fake clock (PLAN §3.2 presence, extract-1
 * §2.5-2.7): TTL 30s aligned with the daemon's presence-tracker.ts:31, lazy
 * sweep, `changed` only on first appearance / leave / eviction, clientId as
 * lease key, activity passthrough. Plus `setMemberDisplayName` parity.
 */

const T0 = new Date('2026-09-08T10:00:00.000Z');

function member(memberId: string, role: WorkspaceMemberRow['role'] = 'member', displayName: string | null = null, avatarUrl: string | null = null): WorkspaceMemberRow {
  return { workspaceId: 'g1', userId: `u-${memberId}`, memberId, role, memberStatus: 'active', displayName, avatarUrl, seenAt: null, removedAt: null, updatedAt: T0.toISOString() };
}

describe('PresenceService (fake clock)', () => {
  function service(ttlMs = DEFAULT_PRESENCE_TTL_MS) {
    let nowMs = T0.getTime();
    const svc = new PresenceService({ ttlMs, now: () => new Date(nowMs) });
    return { svc, advance: (ms: number) => { nowMs += ms; }, at: () => nowMs };
  }

  it('defaults to a 30s TTL and rejects a non-positive or non-finite one', () => {
    expect(DEFAULT_PRESENCE_TTL_MS).toBe(30_000);
    expect(new PresenceService().ttl).toBe(30_000);
    expect(new PresenceService({ ttlMs: 1 }).ttl).toBe(1);
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PresenceService({ ttlMs })).toThrow(/positive/);
    }
  });

  it('viewers are snapshots: activity is cloned on the way in and on the way out', () => {
    const { svc } = service();
    const activity = { kind: 'editing', nested: { n: 1, list: [1] } };
    const first = svc.heartbeat('g1', 'p1', { clientId: 'c', member: member('m_a'), activity });
    // Mutating the caller's object after the heartbeat does not reach the roster.
    activity.nested.n = 2;
    activity.nested.list.push(2);
    expect(svc.list('g1', 'p1').viewers[0]!.activity).toEqual({ kind: 'editing', nested: { n: 1, list: [1] } });
    // Mutating a returned viewer does not reach the roster or later responses.
    (first.viewers[0]!.activity as { nested: { n: number } }).nested.n = 99;
    const again = svc.list('g1', 'p1').viewers[0]!;
    expect((again.activity as { nested: { n: number } }).nested.n).toBe(1);
    expect(again.activity).not.toBe(first.viewers[0]!.activity);
    // Absent activity stays absent (no `activity: undefined` key).
    const bare = svc.heartbeat('g1', 'p1', { clientId: 'd', member: member('m_b') });
    expect('activity' in bare.viewers.find((v) => v.memberId === 'm_b')!).toBe(false);
  });

  it('drops an emptied roster so unknown-project lookups do not accumulate Maps', () => {
    const { svc, advance } = service(1_000);
    expect(svc.rosterCount).toBe(0);
    // GETs for projects nobody is in allocate nothing that survives the call.
    for (let i = 0; i < 50; i += 1) expect(svc.list('g1', `ghost-${i}`).viewers).toEqual([]);
    expect(svc.rosterCount).toBe(0);
    // Leave on an unknown roster does not leave a Map behind either.
    expect(svc.leave('g1', 'nobody', 'm_a', 'c').changed).toBe(false);
    expect(svc.rosterCount).toBe(0);
    // A live roster is held; leaving the last lease releases it.
    svc.heartbeat('g1', 'p1', { clientId: 'a', member: member('m_a') });
    svc.heartbeat('g1', 'p2', { clientId: 'b', member: member('m_b') });
    expect(svc.rosterCount).toBe(2);
    expect(svc.leave('g1', 'p1', 'm_a', 'a').viewers).toEqual([]);
    expect(svc.rosterCount).toBe(1);
    // A sweep that empties the roster releases it too.
    advance(1_001);
    expect(svc.list('g1', 'p2')).toEqual({ viewers: [], changed: true });
    expect(svc.rosterCount).toBe(0);
    // evictMember releases rosters it emptied.
    svc.heartbeat('g1', 'p3', { clientId: 'a', member: member('m_a') });
    svc.heartbeat('g1', 'p4', { clientId: 'a', member: member('m_a') });
    svc.heartbeat('g1', 'p4', { clientId: 'b', member: member('m_b') });
    expect(svc.evictMember('g1', 'm_a').sort()).toEqual(['p3', 'p4']);
    expect(svc.rosterCount).toBe(1);
    expect(svc.list('g1', 'p4').viewers.map((v) => v.memberId)).toEqual(['m_b']);
  });

  it('first heartbeat of a clientId is `changed`; a repeat is not; roster carries the wire fields', () => {
    const { svc } = service();
    const alice = member('m_alice', 'owner', 'Alice', 'https://a/avatar.png');
    const first = svc.heartbeat('g1', 'p1', { clientId: 'tab-1', member: alice, displayName: 'Alice Tab', filePath: 'index.html', activity: { kind: 'editing', n: 1 } });
    expect(first.changed).toBe(true);
    expect(first.viewers).toEqual([{
      memberId: 'm_alice', displayName: 'Alice Tab', role: 'owner', avatarUrl: 'https://a/avatar.png', filePath: 'index.html',
      heartbeatAt: T0.toISOString(), activity: { kind: 'editing', n: 1 },
    }]);
    const again = svc.heartbeat('g1', 'p1', { clientId: 'tab-1', member: alice, filePath: 'other.html' });
    expect(again.changed).toBe(false);
    expect(again.viewers).toHaveLength(1);
    expect(again.viewers[0]!.filePath).toBe('other.html');
    // activity omitted -> key absent (daemon toPresenceMember only sets activity when !== undefined).
    expect('activity' in again.viewers[0]!).toBe(false);
    // Daemon mapping: displayName falls back to the member row, then memberId (which the daemon then drops).
    const bare = svc.heartbeat('g1', 'p1', { clientId: 'tab-2', member: member('m_bob') });
    const mapped = toPresenceMember(bare.viewers.find((v) => v.memberId === 'm_bob')!);
    expect(mapped.name).toBeUndefined();
    expect(mapped.role).toBe('member');
    expect(mapped.avatarUrl).toBeNull();
    expect(mapped.heartbeatAt).toBe(T0.toISOString());
  });

  it('two tabs of one member are two leases; leaving one keeps the other', () => {
    const { svc } = service();
    const alice = member('m_alice');
    svc.heartbeat('g1', 'p1', { clientId: 'tab-1', member: alice });
    const second = svc.heartbeat('g1', 'p1', { clientId: 'tab-2', member: alice });
    expect(second.changed).toBe(true);
    expect(second.viewers).toHaveLength(2);
    const left = svc.leave('g1', 'p1', 'm_alice', 'tab-1');
    expect(left.changed).toBe(true);
    expect(left.viewers.map((v) => v.memberId)).toEqual(['m_alice']);
    // Unknown clientId: nothing changes.
    expect(svc.leave('g1', 'p1', 'm_alice', 'nope').changed).toBe(false);
    // Legacy leave without clientId evicts every lease of the member.
    svc.heartbeat('g1', 'p1', { clientId: 'tab-3', member: alice });
    const all = svc.leave('g1', 'p1', 'm_alice', null);
    expect(all.changed).toBe(true);
    expect(all.viewers).toEqual([]);
  });

  it('sweeps expired leases lazily and reports the eviction exactly once', () => {
    const { svc, advance } = service(30_000);
    svc.heartbeat('g1', 'p1', { clientId: 'a', member: member('m_a') });
    advance(10_000);
    svc.heartbeat('g1', 'p1', { clientId: 'b', member: member('m_b') });
    advance(19_999); // a is 29.999s old
    expect(svc.list('g1', 'p1')).toEqual(expect.objectContaining({ changed: false }));
    expect(svc.list('g1', 'p1').viewers.map((v) => v.memberId)).toEqual(['m_a', 'm_b']);
    advance(2); // a: 30.001s (expired), b: 20.001s (alive)
    const swept = svc.list('g1', 'p1');
    expect(swept.changed).toBe(true);
    expect(swept.viewers.map((v) => v.memberId)).toEqual(['m_b']);
    expect(svc.list('g1', 'p1').changed).toBe(false);
    // A heartbeat refreshes the lease clock.
    advance(9_000);
    svc.heartbeat('g1', 'p1', { clientId: 'b', member: member('m_b') });
    advance(29_000);
    expect(svc.list('g1', 'p1').viewers).toHaveLength(1);
    advance(2_000);
    expect(svc.list('g1', 'p1').viewers).toHaveLength(0);
  });

  it('a heartbeat that also sweeps someone else reports changed even for a known clientId', () => {
    const { svc, advance } = service(1_000);
    svc.heartbeat('g1', 'p1', { clientId: 'a', member: member('m_a') });
    svc.heartbeat('g1', 'p1', { clientId: 'b', member: member('m_b') });
    advance(600);
    expect(svc.heartbeat('g1', 'p1', { clientId: 'b', member: member('m_b') }).changed).toBe(false);
    advance(600); // a expired (1.2s), b fresh (0.6s)
    const beat = svc.heartbeat('g1', 'p1', { clientId: 'b', member: member('m_b') });
    expect(beat.changed).toBe(true);
    expect(beat.viewers.map((v) => v.memberId)).toEqual(['m_b']);
  });

  it('rosters are scoped per (workspace, project); evictMember clears a member everywhere in one workspace', () => {
    const { svc } = service();
    svc.heartbeat('g1', 'p1', { clientId: 'a1', member: member('m_a') });
    svc.heartbeat('g1', 'p2', { clientId: 'a2', member: member('m_a') });
    svc.heartbeat('g1', 'p2', { clientId: 'b', member: member('m_b') });
    svc.heartbeat('g2', 'p1', { clientId: 'a3', member: member('m_a') });
    expect(svc.list('g2', 'p1').viewers).toHaveLength(1);
    expect(svc.evictMember('g1', 'm_a').sort()).toEqual(['p1', 'p2']);
    expect(svc.list('g1', 'p1').viewers).toEqual([]);
    expect(svc.list('g1', 'p2').viewers.map((v) => v.memberId)).toEqual(['m_b']);
    expect(svc.list('g2', 'p1').viewers).toHaveLength(1);
    expect(svc.evictMember('g1', 'm_a')).toEqual([]);
  });
});

const implementations: Array<[string, () => HubStore]> = [
  ['MemoryHubStore', () => new MemoryHubStore({}, { now: () => T0 })],
  ['SqliteHubStore(:memory:)', () => new SqliteHubStore(':memory:', { now: () => T0 })],
];

describe.each(implementations)('%s members', (_name, make) => {
  it('setMemberDisplayName changes only the name and commits effects with it', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@x', name: 'Alice' });
    await store.createWorkspace({ id: 'g1', name: 'Team', kind: 'team' });
    await store.upsertMember({ workspaceId: 'g1', userId: 'u1', role: 'admin', displayName: 'Alice', avatarUrl: 'https://a' });
    const before = (await store.getMembership('u1', 'g1'))!;
    const next = await store.setMemberDisplayName('g1', 'u1', 'Alice R.', (previous, updated) => ({
      outbox: [{ workspaceId: 'g1', userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'workspace-members-changed', memberId: previous.memberId, memberChange: 'updated', from: previous.displayName, to: updated.displayName } }],
      digestBumps: [{ workspaceId: 'g1', face: 'membersToken' }],
      audit: [{ actorUserId: 'u1', workspaceId: 'g1', action: 'member_register', target: previous.memberId }],
    }));
    expect(next).toMatchObject({ memberId: before.memberId, role: 'admin', memberStatus: 'active', displayName: 'Alice R.', avatarUrl: 'https://a' });
    expect((await store.getMembership('u1', 'g1'))!.displayName).toBe('Alice R.');
    const outbox = await store.listUnpublishedOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toMatchObject({ type: 'workspace-members-changed', memberChange: 'updated', from: 'Alice', to: 'Alice R.' });
    expect((await store.listAudit('g1')).map((a) => a.action)).toEqual(['member_register']);
    // Unknown membership: null, no effects.
    expect(await store.setMemberDisplayName('g1', 'nobody', 'X', () => ({ audit: [{ actorUserId: null, action: 'never' }] }))).toBeNull();
    expect((await store.listAudit()).map((a) => a.action)).toEqual(['member_register']);
    // The directory mirror still owns role/status: a later upsert keeps the new name (COALESCE) but may change the role.
    await store.upsertMember({ workspaceId: 'g1', userId: 'u1', role: 'member' });
    expect(await store.getMembership('u1', 'g1')).toMatchObject({ role: 'member', displayName: 'Alice R.' });
    await store.close();
  });
});
