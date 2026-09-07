import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { seedDevIdentity } from '../src/server/dev-seed.js';
import { deriveMemberId, hashApiKey } from '../src/server/ids.js';
import { MemoryHubStore } from '../src/server/memory-store.js';
import { applyMigrations, resolveMigrationsDir, SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore } from '../src/server/store.js';
import { createHubServer } from '../src/server/http.js';

const implementations: Array<[string, () => HubStore]> = [
  ['MemoryHubStore', () => new MemoryHubStore()],
  ['SqliteHubStore(:memory:)', () => new SqliteHubStore(':memory:')],
];

describe.each(implementations)('%s', (_name, make) => {
  it('issues and authenticates control keys, honouring revoke and expiry', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    const { apiKey, secret } = await store.issueApiKey({ userId: 'u1', kind: 'control', profile: 'selfhost' });
    expect(secret.startsWith('odc_')).toBe(true);
    expect(apiKey.keyHash).not.toContain(secret);

    const principal = await store.authenticate(secret);
    expect(principal?.user.id).toBe('u1');
    expect(principal?.apiKey.lastSeenAt).toBeTruthy();
    expect(await store.authenticate('odc_wrong')).toBeNull();
    expect(await store.authenticate('')).toBeNull();

    await store.revokeApiKey(secret);
    expect(await store.authenticate(secret)).toBeNull();

    const expiring = await store.issueApiKey({ userId: 'u1', kind: 'runtime', expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(expiring.secret.startsWith('odr_')).toBe(true);
    expect(await store.authenticate(expiring.secret, new Date('2025-12-31T00:00:00Z'))).not.toBeNull();
    expect(await store.authenticate(expiring.secret, new Date('2026-01-02T00:00:00Z'))).toBeNull();
    await store.close();
  });

  it('issueApiKey is idempotent on the plaintext secret (looked up by key_hash)', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    const first = await store.issueApiKey({ userId: 'u1', kind: 'control', secret: 'odc_fixed_dev_key' });
    const second = await store.issueApiKey({ userId: 'u1', kind: 'control', secret: 'odc_fixed_dev_key' });
    expect(second.apiKey.id).toBe(first.apiKey.id);
    expect(second.apiKey.keyHash).toBe(first.apiKey.keyHash);
    expect((await store.authenticate('odc_fixed_dev_key'))?.user.id).toBe('u1');
    await store.close();
  });

  it('derives a stable memberId, upserts members, and surfaces removed rows in the directory', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    await store.createWorkspace({ id: 'u1', name: 'Mine', kind: 'personal' });
    await store.createWorkspace({ id: 'g1', name: 'Team', kind: 'team', iconKey: 'https://x/icon.png' });
    await store.createWorkspace({ id: 'g2', name: 'Other', kind: 'team' });
    await store.upsertMember({ workspaceId: 'u1', userId: 'u1', role: 'owner' });
    const first = await store.upsertMember({ workspaceId: 'g1', userId: 'u1', role: 'member', displayName: 'A' });
    expect(first.memberId).toBe(deriveMemberId('u1', 'g1'));
    const promoted = await store.upsertMember({ workspaceId: 'g1', userId: 'u1', role: 'admin' });
    expect(promoted.memberId).toBe(first.memberId);
    expect(promoted.role).toBe('admin');
    expect(promoted.displayName).toBe('A');
    await store.upsertMember({ workspaceId: 'g2', userId: 'u1', role: 'owner', memberStatus: 'removed' });

    const directory = await store.listDirectory('u1');
    // personal first, then teams by name; removed memberships stay visible as memberStatus=removed
    expect(directory.map((e) => [e.workspaceId, e.memberStatus])).toEqual([
      ['u1', 'active'], ['g2', 'removed'], ['g1', 'active'],
    ]);
    expect(directory.find((e) => e.workspaceId === 'g1')?.workspaceIconKey).toBe('https://x/icon.png');
    expect(directory.find((e) => e.workspaceId === 'g2')?.workspaceIconKey).toBeUndefined();
    expect((await store.listMembers('g2'))[0]!.removedAt).toBeTruthy();
    expect((await store.getMembership('u1', 'g1'))?.role).toBe('admin');
    expect(await store.getMembership('u1', 'nope')).toBeNull();
    await store.close();
  });

  it('serves constant billing and a stable, bumpable sync digest', async () => {
    const store = make();
    const billing = await store.getWorkspaceBilling('g1');
    expect(billing).toEqual({
      workspaceId: 'g1',
      billingState: 'active',
      planId: 'team_plus',
      balanceUsd: '999999',
      revisionBilling: '1',
      revisionWallet: '1',
    });
    const digest = await store.getSyncDigest('g1');
    expect(await store.getSyncDigest('g1')).toEqual(digest);
    const bumped = await store.bumpSyncDigest('g1', 'catalogToken');
    expect(bumped.catalogToken).not.toBe(digest.catalogToken);
    expect(bumped.membersToken).toBe(digest.membersToken);
    expect(bumped.billingToken).toBe('');
    expect(await store.getSyncDigest('g1')).toEqual(bumped);
    await store.close();
  });

  it('sliding expiry moves expiresAt on authenticate only when a TTL is asked for and the key had one', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    const t0 = new Date('2026-09-08T00:00:00.000Z');
    const { secret } = await store.issueApiKey({ userId: 'u1', kind: 'control', expiresAt: new Date(t0.getTime() + 1000).toISOString() });
    const slid = await store.authenticate(secret, t0, { slidingTtlMs: 60_000 });
    expect(slid?.apiKey.expiresAt).toBe(new Date(t0.getTime() + 60_000).toISOString());
    expect(await store.authenticate(secret, new Date(t0.getTime() + 30_000))).not.toBeNull();
    expect(await store.authenticate(secret, new Date(t0.getTime() + 61_000), { slidingTtlMs: 60_000 })).toBeNull();
    // Seeded keys without expiry never gain one.
    const forever = await store.issueApiKey({ userId: 'u1', kind: 'control', secret: 'odc_forever_key' });
    expect((await store.authenticate(forever.secret, t0, { slidingTtlMs: 60_000 }))?.apiKey.expiresAt).toBeNull();
    // revokeAllUserKeys hits every live key once.
    expect(await store.revokeAllUserKeys('u1')).toBe(2);
    expect(await store.revokeAllUserKeys('u1')).toBe(0);
    expect(await store.authenticate(forever.secret, t0)).toBeNull();
    await store.close();
  });

  it('upsertUser refreshes identity fields and keeps createdAt / gitlabId', async () => {
    const store = make();
    const created = await store.upsertUser({ id: '7', gitlabId: 7, email: 'x@y.z', name: 'X', avatarUrl: 'https://a/x.png' });
    const updated = await store.upsertUser({ id: '7', gitlabId: 7, email: 'new@y.z', name: 'X2' });
    expect(updated).toMatchObject({ id: '7', gitlabId: 7, email: 'new@y.z', name: 'X2', avatarUrl: 'https://a/x.png', createdAt: created.createdAt });
    const cleared = await store.upsertUser({ id: '7', email: 'new@y.z', name: 'X2', avatarUrl: null });
    expect(cleared.avatarUrl).toBeNull();
    expect(cleared.gitlabId).toBe(7);
    await store.close();
  });

  it('device auths and encrypted grants round-trip', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    // Keyed by sha256(hub device code); GitLab's code is an opaque cipher blob plus its key id.
    const hash = hashApiKey('hub-code');
    const row = {
      deviceCodeHash: hash, userCode: 'ABCD-0001', gitlabDeviceCodeEnc: Buffer.from([9, 8, 7, 6]), keyId: 'k_dev',
      verificationUri: 'https://gl/-/oauth/device',
      verificationUriComplete: 'https://gl/-/oauth/device?user_code=ABCD-0001', intervalS: 5, status: 'pending' as const,
      userId: null, profile: 'selfhost', createdAt: '2026-09-08T00:00:00.000Z', expiresAt: '2026-09-08T00:10:00.000Z', lastPolledAt: null,
    };
    expect(await store.createDeviceAuth(row)).toEqual(row);
    expect(Buffer.isBuffer((await store.getDeviceAuth(hash))!.gitlabDeviceCodeEnc)).toBe(true);
    expect(await store.getDeviceAuth('hub-code')).toBeNull();
    expect(await store.getDeviceAuth('nope')).toBeNull();
    const patched = await store.updateDeviceAuth(hash, { status: 'complete', userId: 'u1', intervalS: 10, lastPolledAt: '2026-09-08T00:00:05.000Z' });
    expect(patched).toEqual({ ...row, status: 'complete', userId: 'u1', intervalS: 10, lastPolledAt: '2026-09-08T00:00:05.000Z' });
    expect(await store.updateDeviceAuth('nope', { status: 'denied' })).toBeNull();

    const grant = {
      userId: 'u1', accessTokenEnc: Buffer.from([1, 2, 3]), refreshTokenEnc: Buffer.from([4, 5]), keyId: 'k_1',
      accessExpiresAt: '2026-09-08T02:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
    };
    await store.putOAuthGrant(grant);
    const read = await store.getOAuthGrant('u1');
    expect(read).toEqual(grant);
    expect(Buffer.isBuffer(read!.accessTokenEnc)).toBe(true);
    await store.putOAuthGrant({ ...grant, refreshTokenEnc: null, keyId: 'k_2' });
    expect(await store.getOAuthGrant('u1')).toMatchObject({ refreshTokenEnc: null, keyId: 'k_2' });
    await store.deleteOAuthGrant('u1');
    expect(await store.getOAuthGrant('u1')).toBeNull();
    await store.close();
  });

  it('applyBatch commits mutation + outbox + digest bumps together; outbox drains in id order once', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    const before = await store.getSyncDigest('g1');
    const { outbox } = await store.applyBatch({
      workspaces: [{ create: { id: 'g1', name: 'Team', kind: 'team', gitlabId: 1 } }],
      members: [{ workspaceId: 'g1', userId: 'u1', role: 'member' }],
      outbox: [
        { workspaceId: 'g1', userId: 'u1', topic: 'directory', eventName: 'workspace-directory-changed', payload: { type: 'workspace-directory-changed', workspaceId: 'g1', change: 'created' } },
        { workspaceId: 'g1', userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'workspace-members-changed', workspaceId: 'g1', memberChange: 'added' } },
      ],
      digestBumps: [{ workspaceId: 'g1', face: 'membersToken' }],
      audit: [{ actorUserId: 'u1', workspaceId: 'g1', action: 'membership_added' }],
    });
    expect(outbox.map((r) => [r.id, r.topic, r.publishedAt])).toEqual([[1, 'directory', null], [2, 'workspace', null]]);
    expect((await store.getWorkspace('g1'))?.name).toBe('Team');
    expect((await store.getMembership('u1', 'g1'))?.memberStatus).toBe('active');
    expect((await store.getSyncDigest('g1')).membersToken).not.toBe(before.membersToken);
    const pending = await store.listUnpublishedOutbox();
    expect(pending.map((r) => r.id)).toEqual([1, 2]);
    expect(pending[1]!.payload).toEqual({ type: 'workspace-members-changed', workspaceId: 'g1', memberChange: 'added' });
    await store.markOutboxPublished([1]);
    expect((await store.listUnpublishedOutbox()).map((r) => r.id)).toEqual([2]);
    await store.markOutboxPublished([2]);
    expect(await store.listUnpublishedOutbox()).toEqual([]);

    // update op + removed retention keeps the first removedAt
    await store.applyBatch({ workspaces: [{ update: { id: 'g1', name: 'Renamed', lifecycleState: 'locked' } }] });
    expect(await store.getWorkspace('g1')).toMatchObject({ name: 'Renamed', lifecycleState: 'locked', gitlabId: 1 });
    expect(await store.updateWorkspace('missing', { name: 'x' })).toBeNull();
    const removed = await store.upsertMember({ workspaceId: 'g1', userId: 'u1', role: 'member', memberStatus: 'removed' });
    const removedAgain = await store.upsertMember({ workspaceId: 'g1', userId: 'u1', role: 'member', memberStatus: 'removed' });
    expect(removedAgain.removedAt).toBe(removed.removedAt);
    expect((await store.listMemberships('u1')).map((m) => [m.workspaceId, m.memberStatus])).toEqual([['g1', 'removed']]);

    // memberDeletes purges the row outright (retention expiry) and is a no-op for unknown pairs.
    await store.applyBatch({ memberDeletes: [{ workspaceId: 'g1', userId: 'u1' }, { workspaceId: 'g1', userId: 'ghost' }] });
    expect(await store.listMemberships('u1')).toEqual([]);
    expect(await store.getMembership('u1', 'g1')).toBeNull();
    expect(await store.listMembers('g1')).toEqual([]);
    await store.close();
  });

  it('SQLite rolls the whole batch back when one statement fails', async () => {
    const store = make();
    await store.createUser({ id: 'u1', email: 'a@b.c', name: 'A' });
    await store.createWorkspace({ id: 'g1', name: 'Team', kind: 'team' });
    await expect(store.applyBatch({
      outbox: [{ workspaceId: 'g1', userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'x' } }],
      // duplicate primary key -> throws
      workspaces: [{ create: { id: 'g1', name: 'Dup', kind: 'team' } }],
    })).rejects.toThrow();
    if (store instanceof SqliteHubStore) {
      expect(await store.listUnpublishedOutbox()).toEqual([]);
    }
    await store.close();
  });

  it('seedDevIdentity is idempotent and the seeded key authenticates through the server', async () => {
    const store = make();
    const first = await seedDevIdentity(store, { controlKey: 'odc_dev_seed_key' });
    expect(first.issuedNewKey).toBe(true);
    const second = await seedDevIdentity(store, { controlKey: 'odc_dev_seed_key' });
    expect(second.issuedNewKey).toBe(false);
    expect(second.controlKey).toBe('odc_dev_seed_key');
    await expect(seedDevIdentity(store, { controlKey: 'dev-control-key' })).rejects.toThrow(/odc_/);

    const hub = createHubServer({ store });
    const { url } = await hub.listen(0);
    try {
      const res = await fetch(`${url}/api/v1/workspaces`, { headers: { authorization: 'Bearer odc_dev_seed_key' } });
      expect(res.status).toBe(200);
      const body = await res.json() as { items: Array<{ workspaceId: string; workspaceType: string }> };
      expect(body.items.map((i) => [i.workspaceId, i.workspaceType])).toEqual([['u1', 'personal'], ['g1', 'team']]);
    } finally {
      await hub.close();
      await store.close();
    }
  });
});

describe('SqliteHubStore migrations', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves migrations/ from src/ and applies 0001 + 0002 + 0003 in order', () => {
    const dir = resolveMigrationsDir();
    expect(dir.endsWith(`${path.sep}migrations`)).toBe(true);
    const db = new Database(':memory:');
    expect(applyMigrations(db, dir)).toEqual([1, 2, 3]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['schema_migrations', 'users', 'api_keys', 'workspaces', 'workspace_members', 'sync_digests', 'device_auths', 'oauth_grants', 'events_outbox', 'audit_log']));
    const outboxColumns = (db.prepare('PRAGMA table_info(events_outbox)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(outboxColumns).toContain('user_id');
    const deviceColumns = (db.prepare('PRAGMA table_info(device_auths)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(deviceColumns).toEqual(expect.arrayContaining(['device_code_hash', 'gitlab_device_code_enc', 'key_id']));
    expect(deviceColumns).not.toContain('device_code');
    // Second pass is a no-op.
    expect(applyMigrations(db, dir)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 3 });
    db.close();
  });

  it('persists across reopen so --seed-dev survives a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-hub-sqlite-'));
    dirs.push(dir);
    const file = path.join(dir, 'hub.sqlite');

    const first = new SqliteHubStore(file);
    await seedDevIdentity(first, { controlKey: 'odc_persisted_key' });
    await first.close();

    const second = new SqliteHubStore(file);
    const seeded = await seedDevIdentity(second, { controlKey: 'odc_persisted_key' });
    expect(seeded.issuedNewKey).toBe(false);
    expect((await second.authenticate('odc_persisted_key'))?.user.id).toBe('u1');
    expect((await second.listDirectory('u1')).map((i) => i.workspaceId)).toEqual(['u1', 'g1']);
    await second.close();
  });
});
