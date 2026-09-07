import { describe, expect, it } from 'vitest';

import { deriveMemberId, hashApiKey } from '../src/server/ids.js';
import { MemoryHubStore } from '../src/server/memory-store.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore, InviteRow } from '../src/server/store.js';

/**
 * Memory <-> SQLite parity for the F8 rows: invites, continuations, public
 * snapshots, and the audit export query. Every scenario runs against both
 * implementations with the same injected clock.
 */
const implementations: Array<[string, (now: () => Date) => HubStore]> = [
  ['MemoryHubStore', (now) => new MemoryHubStore({}, { now })],
  ['SqliteHubStore(:memory:)', (now) => new SqliteHubStore(':memory:', { now })],
];

async function seed(store: HubStore): Promise<void> {
  await store.createUser({ id: 'u1', email: 'alice@example.test', name: 'Alice' });
  await store.createUser({ id: 'u2', email: 'bob@example.test', name: 'Bob' });
  await store.createUser({ id: 'u3', email: 'carol@example.test', name: 'Carol' });
  await store.createWorkspace({ id: 'g1', name: 'Team', kind: 'team', gitlabId: 1000 });
  await store.createWorkspace({ id: 'g2', name: 'Other', kind: 'team', gitlabId: 2000 });
  await store.upsertMember({ workspaceId: 'g1', userId: 'u1', role: 'owner' });
  await store.upsertMember({ workspaceId: 'g2', userId: 'u2', role: 'owner' });
}

const T0 = new Date('2026-09-08T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

async function createInvite(store: HubStore, token: string, overrides: Partial<Parameters<HubStore['createInvite']>[0]> = {}): Promise<InviteRow> {
  return store.createInvite({
    id: `inv_${token}`,
    workspaceId: 'g1',
    invitedEmail: 'bob@example.test',
    role: 'member',
    tokenHash: hashApiKey(token),
    expiresAt: new Date(T0.getTime() + 168 * HOUR).toISOString(),
    createdByUserId: 'u1',
    createdByMemberId: deriveMemberId('u1', 'g1'),
    ...overrides,
  }, { audit: [{ actorUserId: 'u1', workspaceId: 'g1', action: 'invite_create', target: `inv_${token}` }] });
}

describe.each(implementations)('%s invites', (_name, make) => {
  it('creates a pending invite, finds it by token hash, lists pending by (workspace, email)', async () => {
    const clock = { now: T0 };
    const store = make(() => clock.now);
    await seed(store);
    const row = await createInvite(store, 'tok1');
    expect(row.status).toBe('pending');
    expect(row.createdAt).toBe(T0.toISOString());
    expect(await store.getInviteByTokenHash(hashApiKey('tok1'))).toEqual(row);
    expect(await store.getInviteByTokenHash(hashApiKey('nope'))).toBeNull();
    expect(await store.getInvite(row.id)).toEqual(row);
    expect((await store.listPendingInvites('g1', 'bob@example.test')).map((r) => r.id)).toEqual([row.id]);
    expect(await store.listPendingInvites('g1', 'other@example.test')).toEqual([]);
    expect(await store.listPendingInvites('g2', 'bob@example.test')).toEqual([]);
    expect((await store.listAudit('g1')).map((a) => a.action)).toEqual(['invite_create']);
    await store.close();
  });

  it('setInviteStatus marks expired/revoked and drops the row from the pending list', async () => {
    const store = make(() => T0);
    await seed(store);
    const row = await createInvite(store, 'tok2');
    expect((await store.setInviteStatus(row.id, 'revoked'))?.status).toBe('revoked');
    expect(await store.listPendingInvites('g1', 'bob@example.test')).toEqual([]);
    expect(await store.setInviteStatus('missing', 'expired')).toBeNull();
    await store.close();
  });

  it('acceptInvite: membership at the invite role, invite accepted, continuation minted, effects committed', async () => {
    const clock = { now: T0 };
    const store = make(() => clock.now);
    await seed(store);
    const row = await createInvite(store, 'tok3');
    clock.now = new Date(T0.getTime() + HOUR);
    const result = await store.acceptInvite(
      { tokenHash: row.tokenHash, userId: 'u2', displayName: 'Bob', avatarUrl: null, continuation: { nonceHash: hashApiKey('nonce3'), expiresAt: new Date(clock.now.getTime() + 600_000).toISOString() } },
      ({ invite, membership }) => ({
        outbox: [{ workspaceId: 'g1', userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'workspace-members-changed', memberId: membership.memberId } }],
        digestBumps: [{ workspaceId: 'g1', face: 'membersToken' }],
        audit: [{ actorUserId: 'u2', workspaceId: 'g1', action: 'invite_accept', target: invite.id }],
      }),
    );
    expect(result.kind).toBe('accepted');
    if (result.kind !== 'accepted') return;
    expect(result.invite.status).toBe('accepted');
    expect(result.invite.acceptedByUserId).toBe('u2');
    expect(result.invite.acceptedAt).toBe(clock.now.toISOString());
    expect(result.membership).toMatchObject({ workspaceId: 'g1', userId: 'u2', role: 'member', memberStatus: 'active', displayName: 'Bob', memberId: deriveMemberId('u2', 'g1') });
    expect(result.continuation).toMatchObject({ nonceHash: hashApiKey('nonce3'), inviteId: row.id, workspaceId: 'g1', userId: 'u2', memberId: deriveMemberId('u2', 'g1'), consumedAt: null });
    expect(await store.getMembership('u2', 'g1')).toMatchObject({ role: 'member', memberStatus: 'active' });
    expect(await store.getInviteContinuation(hashApiKey('nonce3'))).toEqual(result.continuation);
    expect((await store.listUnpublishedOutbox()).map((e) => e.payload.type)).toEqual(['workspace-members-changed']);
    expect((await store.listAudit('g1')).map((a) => a.action)).toEqual(['invite_create', 'invite_accept']);
    // Second accept of the same token: consumed, nothing else changes.
    const again = await store.acceptInvite(
      { tokenHash: row.tokenHash, userId: 'u3', displayName: 'Carol', avatarUrl: null, continuation: { nonceHash: hashApiKey('nonceX'), expiresAt: clock.now.toISOString() } },
      () => ({ audit: [{ actorUserId: 'u3', action: 'never' }] }),
    );
    expect(again.kind).toBe('consumed');
    expect(await store.getMembership('u3', 'g1')).toBeNull();
    expect(await store.getInviteContinuation(hashApiKey('nonceX'))).toBeNull();
    expect((await store.listAudit('g1')).map((a) => a.action)).not.toContain('never');
    await store.close();
  });

  it('acceptInvite: expired pending invite flips to expired and writes nothing; revoked stays revoked; unknown token is not_found', async () => {
    const clock = { now: T0 };
    const store = make(() => clock.now);
    await seed(store);
    const row = await createInvite(store, 'tok4', { expiresAt: new Date(T0.getTime() + HOUR).toISOString() });
    clock.now = new Date(T0.getTime() + HOUR);
    const input = { tokenHash: row.tokenHash, userId: 'u2', displayName: null, avatarUrl: null, continuation: { nonceHash: hashApiKey('n4'), expiresAt: clock.now.toISOString() } };
    expect((await store.acceptInvite(input, () => ({}))).kind).toBe('expired');
    expect((await store.getInvite(row.id))?.status).toBe('expired');
    expect(await store.getMembership('u2', 'g1')).toBeNull();
    const revoked = await createInvite(store, 'tok5');
    await store.setInviteStatus(revoked.id, 'revoked');
    expect((await store.acceptInvite({ ...input, tokenHash: revoked.tokenHash }, () => ({}))).kind).toBe('revoked');
    expect((await store.acceptInvite({ ...input, tokenHash: hashApiKey('ghost') }, () => ({}))).kind).toBe('not_found');
    await store.close();
  });

  it('acceptInvite never demotes an active member and reactivates a removed one', async () => {
    const store = make(() => T0);
    await seed(store);
    // u1 is owner of g1; a member invite must leave them owner.
    const ownerInvite = await createInvite(store, 'tok6', { invitedEmail: 'alice@example.test' });
    const kept = await store.acceptInvite({ tokenHash: ownerInvite.tokenHash, userId: 'u1', displayName: null, avatarUrl: null, continuation: { nonceHash: hashApiKey('n6'), expiresAt: T0.toISOString() } }, () => ({}));
    expect(kept.kind === 'accepted' && kept.membership.role).toBe('owner');
    // u2 removed from g1, then invited as admin: back to active at admin.
    await store.upsertMember({ workspaceId: 'g1', userId: 'u2', role: 'member', memberStatus: 'removed' });
    const adminInvite = await createInvite(store, 'tok7', { role: 'admin' });
    const back = await store.acceptInvite({ tokenHash: adminInvite.tokenHash, userId: 'u2', displayName: null, avatarUrl: null, continuation: { nonceHash: hashApiKey('n7'), expiresAt: T0.toISOString() } }, () => ({}));
    expect(back.kind === 'accepted' && back.membership).toMatchObject({ role: 'admin', memberStatus: 'active', removedAt: null });
    await store.close();
  });

  it('consumeInviteContinuation: owner check first, then single-use, then expiry; effects only on success', async () => {
    const clock = { now: T0 };
    const store = make(() => clock.now);
    await seed(store);
    const row = await createInvite(store, 'tok8');
    const expiresAt = new Date(T0.getTime() + 600_000).toISOString();
    await store.acceptInvite({ tokenHash: row.tokenHash, userId: 'u2', displayName: null, avatarUrl: null, continuation: { nonceHash: hashApiKey('n8'), expiresAt } }, () => ({}));
    const effects = (r: { inviteId: string }) => ({ audit: [{ actorUserId: 'u2', workspaceId: 'g1', action: 'continuation_consume', target: r.inviteId }] });

    expect((await store.consumeInviteContinuation(hashApiKey('unknown'), 'u2', clock.now, effects)).kind).toBe('not_found');
    expect((await store.consumeInviteContinuation(hashApiKey('n8'), 'u3', clock.now, effects)).kind).toBe('owner_mismatch');
    expect((await store.getInviteContinuation(hashApiKey('n8')))?.consumedAt).toBeNull();

    const consumed = await store.consumeInviteContinuation(hashApiKey('n8'), 'u2', clock.now, effects);
    expect(consumed.kind).toBe('consumed');
    expect(consumed.kind === 'consumed' && consumed.row.consumedAt).toBe(T0.toISOString());
    expect((await store.consumeInviteContinuation(hashApiKey('n8'), 'u2', clock.now, effects)).kind).toBe('already_consumed');
    // Owner mismatch still wins over already_consumed so a foreign caller learns nothing.
    expect((await store.consumeInviteContinuation(hashApiKey('n8'), 'u3', clock.now, effects)).kind).toBe('owner_mismatch');
    expect((await store.listAudit('g1')).filter((a) => a.action === 'continuation_consume')).toHaveLength(1);

    const later = await createInvite(store, 'tok9', { invitedEmail: 'carol@example.test' });
    await store.acceptInvite({ tokenHash: later.tokenHash, userId: 'u3', displayName: null, avatarUrl: null, continuation: { nonceHash: hashApiKey('n9'), expiresAt } }, () => ({}));
    clock.now = new Date(T0.getTime() + 600_000);
    expect((await store.consumeInviteContinuation(hashApiKey('n9'), 'u3', clock.now, effects)).kind).toBe('expired');
    await store.close();
  });
});

describe.each(implementations)('%s public snapshots', (_name, make) => {
  it('create -> get -> redact (once) -> get shows redactedAt; second redact is a no-op', async () => {
    const clock = { now: T0 };
    const store = make(() => clock.now);
    await seed(store);
    const row = { slug: 's'.repeat(43), workspaceId: 'g1', resourceId: 'r1', versionId: 'v1-abc', name: 'index.html', kind: 'project' as const, createdAt: T0.toISOString(), redactedAt: null };
    await store.createPublicSnapshot(row, { audit: [{ actorUserId: 'u1', workspaceId: 'g1', action: 'snapshot_create', target: row.slug }] });
    expect(await store.getPublicSnapshot(row.slug)).toEqual(row);
    expect(await store.getPublicSnapshot('missing')).toBeNull();
    await expect(store.createPublicSnapshot(row)).rejects.toThrow();
    clock.now = new Date(T0.getTime() + HOUR);
    const redacted = await store.redactPublicSnapshot(row.slug, (s) => ({ audit: [{ actorUserId: 'u1', workspaceId: 'g1', action: 'snapshot_redact', target: s.slug }] }));
    expect(redacted?.redactedAt).toBe(clock.now.toISOString());
    expect((await store.getPublicSnapshot(row.slug))?.redactedAt).toBe(clock.now.toISOString());
    expect(await store.redactPublicSnapshot(row.slug, () => ({ audit: [{ actorUserId: 'u1', action: 'never' }] }))).toBeNull();
    expect(await store.redactPublicSnapshot('missing', () => ({}))).toBeNull();
    expect((await store.listAudit('g1')).map((a) => a.action)).toEqual(['snapshot_create', 'snapshot_redact']);
    await store.close();
  });
});

describe.each(implementations)('%s audit export query', (_name, make) => {
  async function seedAudit(store: HubStore, clock: { now: Date }): Promise<void> {
    await seed(store);
    const at = (h: number) => { clock.now = new Date(T0.getTime() + h * HOUR); };
    at(0); await store.appendAudit({ actorUserId: 'u1', workspaceId: 'g1', action: 'a' });        // 1 visible to u1 (own + ws)
    at(1); await store.appendAudit({ actorUserId: 'u2', workspaceId: 'g1', action: 'b' });        // 2 visible to u1 (ws)
    at(2); await store.appendAudit({ actorUserId: 'u2', workspaceId: 'g2', action: 'a' });        // 3 hidden from u1
    at(3); await store.appendAudit({ actorUserId: 'u1', workspaceId: null, action: 'login' });    // 4 visible to u1 (own)
    at(4); await store.appendAudit({ actorUserId: 'u3', workspaceId: null, action: 'login' });    // 5 hidden from u1
    at(5); await store.appendAudit({ actorUserId: 'u2', workspaceId: 'g1', action: 'a' });        // 6 visible to u1 (ws)
  }

  it('rows carry monotonic ids; visibility = administered workspaces OR own actions; filters and cursor compose', async () => {
    const clock = { now: T0 };
    const store = make(() => clock.now);
    await seedAudit(store, clock);
    const all = await store.listAudit();
    expect(all.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6]);

    const base = { workspaceIds: ['g1'], ownActorUserId: 'u1', limit: 100 };
    expect((await store.queryAudit(base)).map((r) => r.id)).toEqual([1, 2, 4, 6]);
    expect((await store.queryAudit({ ...base, action: 'a' })).map((r) => r.id)).toEqual([1, 6]);
    expect((await store.queryAudit({ ...base, actorUserId: 'u2' })).map((r) => r.id)).toEqual([2, 6]);
    expect((await store.queryAudit({ ...base, since: new Date(T0.getTime() + 3 * HOUR).toISOString() })).map((r) => r.id)).toEqual([4, 6]);
    expect((await store.queryAudit({ ...base, afterId: 2 })).map((r) => r.id)).toEqual([4, 6]);
    expect((await store.queryAudit({ ...base, limit: 2 })).map((r) => r.id)).toEqual([1, 2]);
    expect((await store.queryAudit({ ...base, afterId: 2, limit: 1 })).map((r) => r.id)).toEqual([4]);
    // No administered workspace: only own actions.
    expect((await store.queryAudit({ workspaceIds: [], ownActorUserId: 'u3', limit: 100 })).map((r) => r.id)).toEqual([5]);
    // `since` with a non-canonical ISO form is normalised before comparing.
    expect((await store.queryAudit({ ...base, since: '2026-09-08T03:00:00+00:00' })).map((r) => r.id)).toEqual([4, 6]);
    await store.close();
  });
});
