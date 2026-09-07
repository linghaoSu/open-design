import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { seedDevIdentity } from '../src/server/dev-seed.js';
import { deriveMemberId } from '../src/server/ids.js';
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

  it('resolves migrations/ from src/ and declares sync_digests', () => {
    const dir = resolveMigrationsDir();
    expect(dir.endsWith(`${path.sep}migrations`)).toBe(true);
    const db = new Database(':memory:');
    expect(applyMigrations(db, dir)).toEqual([1]);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['schema_migrations', 'users', 'api_keys', 'workspaces', 'workspace_members', 'sync_digests']));
    // Second pass is a no-op.
    expect(applyMigrations(db, dir)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 1 });
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
