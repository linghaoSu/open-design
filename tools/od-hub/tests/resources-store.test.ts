import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { BlobDigestMismatchError, BlobStore, BlobTooLargeError } from '../src/server/blob-store.js';
import { parseHubConfig, resolveBlobDirFlag } from '../src/server/config.js';
import { MemoryHubStore } from '../src/server/memory-store.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore, PullReceiptRow, SideEffects } from '../src/server/store.js';
import { manifestDigest, versionIdFor, type ManifestEntry } from '../src/shared/manifest.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const entry = (p: string, content: string, mode = 0o644): ManifestEntry => ({ path: p, sha256: sha(content), size: Buffer.byteLength(content), mode });
const noEffects = (): SideEffects => ({});

const implementations: Array<[string, () => HubStore]> = [
  ['MemoryHubStore', () => new MemoryHubStore()],
  ['SqliteHubStore(:memory:)', () => new SqliteHubStore(':memory:')],
];

describe.each(implementations)('%s resources', (_name, make) => {
  const publish = (store: HubStore, resourceId: string, manifest: ManifestEntry[], expectedVersion: number | null, actor = 'm_owner', canManageAll = false, effects: (r: { version: { version: number } }) => SideEffects = noEffects) =>
    store.publishVersion(
      { workspaceId: 'g1', resourceId, kind: 'plugin', manifest, manifestDigest: manifestDigest(manifest), expectedVersion, actorMemberId: actor },
      { actorCanManageAll: canManageAll },
      effects,
    );

  it('publishes immutable versions with CAS on published_version', async () => {
    const store = make();
    expect(await store.getResource('g1', 'r1')).toBeNull();
    const m1 = [entry('a.txt', 'one')];
    const first = await publish(store, 'r1', m1, 0);
    expect(first.kind).toBe('published');
    if (first.kind !== 'published') return;
    expect(first.created).toBe(true);
    expect(first.version.version).toBe(1);
    expect(first.version.versionId).toBe(versionIdFor(1, manifestDigest(m1)));
    expect(first.resource.publishedVersion).toBe(1);
    expect(first.resource.ownerMemberId).toBe('m_owner');
    expect(first.resource.manifestEntryCount).toBe(1);

    // Stale expectedVersion -> conflict, nothing written.
    const stale = await publish(store, 'r1', [entry('b.txt', 'two')], 0);
    expect(stale).toEqual({ kind: 'conflict', publishedVersion: 1 });
    expect((await store.getResource('g1', 'r1'))!.publishedVersion).toBe(1);
    expect(await store.getResourceVersion('g1', 'r1', 2)).toBeNull();

    // Correct expectedVersion -> version 2, version 1 stays readable.
    const m2 = [entry('b.txt', 'two')];
    const second = await publish(store, 'r1', m2, 1);
    expect(second.kind).toBe('published');
    if (second.kind !== 'published') return;
    expect(second.created).toBe(false);
    expect(second.version.version).toBe(2);
    expect((await store.getResourceVersion('g1', 'r1', 1))!.manifest).toEqual(m1);
    expect((await store.getResourceVersionById('g1', 'r1', second.version.versionId))!.version).toBe(2);
    // null expectedVersion = no CAS.
    const third = await publish(store, 'r1', m1, null);
    expect(third.kind).toBe('published');
    expect((await store.getResource('g1', 'r1'))!.publishedVersion).toBe(3);
    await store.close();
  });

  it('keeps kind and owner fixed; workspace admins may publish over others', async () => {
    const store = make();
    await publish(store, 'r1', [entry('a', 'a')], 0, 'm_owner');
    const otherKind = await store.publishVersion(
      { workspaceId: 'g1', resourceId: 'r1', kind: 'skill', manifest: [], manifestDigest: manifestDigest([]), expectedVersion: null, actorMemberId: 'm_owner' },
      { actorCanManageAll: false }, noEffects,
    );
    expect(otherKind).toEqual({ kind: 'kind_conflict', storedKind: 'plugin' });
    expect(await publish(store, 'r1', [entry('a', 'b')], null, 'm_other')).toEqual({ kind: 'forbidden', ownerMemberId: 'm_owner' });
    const admin = await publish(store, 'r1', [entry('a', 'b')], null, 'm_admin', true);
    expect(admin.kind).toBe('published');
    if (admin.kind === 'published') expect(admin.resource.ownerMemberId).toBe('m_owner');
    await store.close();
  });

  it('metadata: undefined keeps, object replaces, null clears', async () => {
    const store = make();
    const base = { workspaceId: 'g1', resourceId: 'r1', kind: 'plugin' as const, manifest: [], manifestDigest: manifestDigest([]), expectedVersion: null, actorMemberId: 'm' };
    await store.publishVersion({ ...base, metadata: { localId: 'x', title: 'T' } }, { actorCanManageAll: false }, noEffects);
    expect((await store.getResource('g1', 'r1'))!.metadata).toEqual({ localId: 'x', title: 'T' });
    await store.publishVersion(base, { actorCanManageAll: false }, noEffects);
    expect((await store.getResource('g1', 'r1'))!.metadata).toEqual({ localId: 'x', title: 'T' });
    await store.publishVersion({ ...base, metadata: null }, { actorCanManageAll: false }, noEffects);
    expect((await store.getResource('g1', 'r1'))!.metadata).toBeNull();
    await store.close();
  });

  it('tombstone gate: remove is idempotent, later reads and publishes answer not_found', async () => {
    const store = make();
    await publish(store, 'r1', [entry('a', 'a')], 0);
    expect(await store.tombstoneResource('g1', 'nope', { memberId: 'm_owner', canManageAll: false }, noEffects)).toEqual({ kind: 'not_found' });
    expect(await store.tombstoneResource('g1', 'r1', { memberId: 'm_other', canManageAll: false }, noEffects)).toEqual({ kind: 'forbidden', ownerMemberId: 'm_owner' });
    const removed = await store.tombstoneResource('g1', 'r1', { memberId: 'm_owner', canManageAll: false }, noEffects);
    expect(removed.kind).toBe('removed');
    if (removed.kind === 'removed') expect(removed.resource.deletedAt).toBeTruthy();
    expect(await store.tombstoneResource('g1', 'r1', { memberId: 'm_owner', canManageAll: false }, noEffects)).toEqual({ kind: 'already_removed' });
    expect(await store.getResource('g1', 'r1')).toBeNull();
    expect(await store.listResources('g1')).toEqual([]);
    // The id is retired: no resurrection through a new publish.
    expect(await publish(store, 'r1', [entry('a', 'a')], null)).toEqual({ kind: 'not_found' });
    // Version rows stay for audit but are only reachable through the store API.
    expect((await store.getResourceVersion('g1', 'r1', 1))!.version).toBe(1);
    await store.close();
  });

  it('side effects commit with the mutation and are visible in the outbox', async () => {
    const store = make();
    const result = await publish(store, 'r1', [entry('a', 'a')], 0, 'm', false, ({ version }) => ({
      outbox: [{ workspaceId: 'g1', userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'team-resources-changed', version: version.version } }],
      digestBumps: [{ workspaceId: 'g1', face: 'catalogToken' }],
      audit: [{ actorUserId: 'u1', workspaceId: 'g1', action: 'resource_publish', target: 'r1' }],
    }));
    expect(result.kind).toBe('published');
    const outbox = await store.listUnpublishedOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toEqual({ type: 'team-resources-changed', version: 1 });
    // A rejected publish runs no effects.
    const before = await store.getSyncDigest('g1');
    await publish(store, 'r1', [entry('a', 'b')], 0, 'm', false, () => ({ digestBumps: [{ workspaceId: 'g1', face: 'catalogToken' }] }));
    expect((await store.getSyncDigest('g1')).catalogToken).toBe(before.catalogToken);
    expect(await store.listUnpublishedOutbox()).toHaveLength(1);
    await store.close();
  });

  it('listResources is workspace-scoped and excludes tombstones', async () => {
    const store = make();
    await publish(store, 'r1', [], 0);
    await publish(store, 'r2', [], 0);
    await store.publishVersion({ workspaceId: 'g2', resourceId: 'r3', kind: 'skill', manifest: [], manifestDigest: manifestDigest([]), expectedVersion: 0, actorMemberId: 'm' }, { actorCanManageAll: false }, noEffects);
    await store.tombstoneResource('g1', 'r2', { memberId: 'm_owner', canManageAll: false }, noEffects);
    expect((await store.listResources('g1')).map((r) => r.resourceId)).toEqual(['r1']);
    expect((await store.listResources('g2')).map((r) => r.resourceId)).toEqual(['r3']);
    await store.close();
  });
});

describe.each(implementations)('%s team projects + receipts', (_name, make) => {
  it('upsert fixes the owner on first write, merges partial updates, and remove is exact', async () => {
    const store = make();
    const created = await store.upsertTeamProject(
      { workspaceId: 'g1', projectId: 'p1', resourceId: 'r1', displayName: 'P', syncState: 'synced', lastSyncedVersionId: 'v1-x', metadata: { name: 'P' }, actorMemberId: 'm_owner' },
      { actorCanManageAll: false }, noEffects,
    );
    expect(created.kind).toBe('upserted');
    if (created.kind !== 'upserted') return;
    expect(created.created).toBe(true);
    expect(created.row.ownerMemberId).toBe('m_owner');
    expect(created.row.syncState).toBe('synced');

    const updated = await store.upsertTeamProject(
      { workspaceId: 'g1', projectId: 'p1', resourceId: 'r1', syncState: 'failed', actorMemberId: 'm_owner' },
      { actorCanManageAll: false }, noEffects,
    );
    expect(updated.kind).toBe('upserted');
    if (updated.kind !== 'upserted') return;
    expect(updated.created).toBe(false);
    expect(updated.row.id).toBe(created.row.id);
    expect(updated.row.displayName).toBe('P');
    expect(updated.row.lastSyncedVersionId).toBe('v1-x');
    expect(updated.row.metadata).toEqual({ name: 'P' });
    expect(updated.row.syncState).toBe('failed');
    expect(updated.row.createdAt).toBe(created.row.createdAt);

    expect(await store.upsertTeamProject({ workspaceId: 'g1', projectId: 'p1', resourceId: 'r1', actorMemberId: 'm_other' }, { actorCanManageAll: false }, noEffects))
      .toEqual({ kind: 'forbidden', ownerMemberId: 'm_owner' });
    const byAdmin = await store.upsertTeamProject({ workspaceId: 'g1', projectId: 'p1', resourceId: 'r1', displayName: 'Q', actorMemberId: 'm_admin' }, { actorCanManageAll: true }, noEffects);
    expect(byAdmin.kind === 'upserted' && byAdmin.row.ownerMemberId).toBe('m_owner');

    expect((await store.listTeamProjects('g1')).map((p) => p.projectId)).toEqual(['p1']);
    expect(await store.listTeamProjects('g2')).toEqual([]);
    expect((await store.listTeamProjectsByResource('g1', 'r1')).map((p) => p.projectId)).toEqual(['p1']);
    expect(await store.listTeamProjectsByResource('g1', 'r9')).toEqual([]);
    expect(await store.getTeamProject('g1', 'p1')).not.toBeNull();
    expect(await store.getTeamProject('g2', 'p1')).toBeNull();

    expect(await store.removeTeamProject('g1', 'p1', { memberId: 'm_other', canManageAll: false }, noEffects)).toEqual({ kind: 'forbidden', ownerMemberId: 'm_owner' });
    expect((await store.removeTeamProject('g1', 'p1', { memberId: 'm_owner', canManageAll: false }, noEffects)).kind).toBe('removed');
    expect(await store.removeTeamProject('g1', 'p1', { memberId: 'm_owner', canManageAll: false }, noEffects)).toEqual({ kind: 'not_found' });
    expect(await store.getTeamProject('g1', 'p1')).toBeNull();
    await store.close();
  });

  it('pull receipts are single-use', async () => {
    const store = make();
    const row: PullReceiptRow = {
      nonce: 'n1', workspaceId: 'g1', projectId: 'p1', resourceId: 'r1', viewerMemberId: 'm_v', ownerMemberId: 'm_o',
      version: 1, versionId: 'v1-abc', manifestDigest: `sha256:${'a'.repeat(64)}`,
      authorizedAt: '2026-09-08T00:00:00.000Z', expiresAt: '2026-09-08T00:00:02.000Z', consumedAt: null,
    };
    await store.createPullReceipt(row, { audit: [{ actorUserId: 'u', action: 'team_project_pull_authorize', target: 'p1' }] });
    expect(await store.getPullReceipt('n1')).toEqual(row);
    await expect(store.createPullReceipt(row)).rejects.toThrow();
    expect(await store.consumePullReceipt('n1', new Date('2026-09-08T00:00:01.000Z'))).toBe(true);
    expect(await store.consumePullReceipt('n1')).toBe(false);
    expect(await store.consumePullReceipt('missing')).toBe(false);
    expect((await store.getPullReceipt('n1'))!.consumedAt).toBe('2026-09-08T00:00:01.000Z');
    await store.close();
  });
});

describe('SqliteHubStore resource persistence', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('versions, catalog rows, and tombstones survive reopen', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-hub-res-'));
    dirs.push(dir);
    const file = path.join(dir, 'hub.sqlite');
    const m = [entry('a', 'a')];
    let store = new SqliteHubStore(file);
    await store.publishVersion({ workspaceId: 'g1', resourceId: 'r1', kind: 'project', manifest: m, manifestDigest: manifestDigest(m), expectedVersion: 0, actorMemberId: 'm', metadata: { projectId: 'p1' } }, { actorCanManageAll: false }, noEffects);
    await store.publishVersion({ workspaceId: 'g1', resourceId: 'r2', kind: 'skill', manifest: [], manifestDigest: manifestDigest([]), expectedVersion: 0, actorMemberId: 'm' }, { actorCanManageAll: false }, noEffects);
    await store.tombstoneResource('g1', 'r2', { memberId: 'm', canManageAll: false }, noEffects);
    await store.upsertTeamProject({ workspaceId: 'g1', projectId: 'p1', resourceId: 'r1', actorMemberId: 'm' }, { actorCanManageAll: false }, noEffects);
    await store.close();

    store = new SqliteHubStore(file);
    const r1 = await store.getResource('g1', 'r1');
    expect(r1?.publishedVersion).toBe(1);
    expect(r1?.metadata).toEqual({ projectId: 'p1' });
    expect((await store.getResourceVersion('g1', 'r1', 1))!.manifest).toEqual(m);
    expect(await store.getResource('g1', 'r2')).toBeNull();
    expect(await store.publishVersion({ workspaceId: 'g1', resourceId: 'r2', kind: 'skill', manifest: [], manifestDigest: manifestDigest([]), expectedVersion: null, actorMemberId: 'm' }, { actorCanManageAll: false }, noEffects)).toEqual({ kind: 'not_found' });
    expect((await store.getTeamProject('g1', 'p1'))?.resourceId).toBe('r1');
    await store.close();
  });
});

describe('BlobStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fresh = (options?: { maxBytes?: number }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-hub-blobs-'));
    dirs.push(dir);
    return new BlobStore(path.join(dir, 'blobs'), options);
  };

  it('stores by digest under <aa>/<sha256>, dedupes, and never leaves temp files', async () => {
    const blobs = fresh();
    const body = Buffer.from('hello blob');
    const digest = sha('hello blob');
    expect(await blobs.has(digest)).toBe(false);
    expect(await blobs.missing([digest, digest])).toEqual([digest]);
    const first = await blobs.put(digest, Readable.from([body]));
    expect(first).toEqual({ size: body.length, created: true });
    expect(blobs.pathFor(digest)).toBe(path.join(blobs.root, digest.slice(0, 2), digest));
    expect(statSync(blobs.pathFor(digest)).size).toBe(body.length);
    const second = await blobs.put(digest, Readable.from([body]));
    expect(second).toEqual({ size: body.length, created: false });
    expect(await blobs.missing([digest])).toEqual([]);
    expect(await blobs.size(digest)).toBe(body.length);
    expect(readdirSync(path.join(blobs.root, 'tmp'))).toEqual([]);
    const chunks: Buffer[] = [];
    for await (const c of blobs.open(digest)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
  });

  it('rejects a body whose digest does not match and writes nothing', async () => {
    const blobs = fresh();
    const digest = sha('expected');
    await expect(blobs.put(digest, Readable.from([Buffer.from('actual')]))).rejects.toBeInstanceOf(BlobDigestMismatchError);
    expect(await blobs.has(digest)).toBe(false);
    expect(readdirSync(path.join(blobs.root, 'tmp'))).toEqual([]);
  });

  it('enforces the size limit and streams large bodies chunk by chunk', async () => {
    const small = fresh({ maxBytes: 10 });
    await expect(small.put(sha('x'.repeat(11)), Readable.from([Buffer.from('x'.repeat(11))]))).rejects.toBeInstanceOf(BlobTooLargeError);
    const blobs = fresh();
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const parts = 9; // 9 MiB > 8 MiB
    const hash = createHash('sha256');
    for (let i = 0; i < parts; i += 1) hash.update(chunk);
    const digest = hash.digest('hex');
    const result = await blobs.put(digest, Readable.from(Array.from({ length: parts }, () => chunk)));
    expect(result.size).toBe(parts * chunk.length);
    expect(await blobs.size(digest)).toBe(parts * chunk.length);
  });

  it('short-circuits a put of an already stored digest: body drained, no temp file written', async () => {
    const blobs = fresh();
    const body = Buffer.from('already here');
    const digest = sha('already here');
    await blobs.put(digest, Readable.from([body]));
    const before = statSync(blobs.pathFor(digest));
    // A body that does NOT hash to the digest is still accepted: nothing is
    // verified or written because the bytes under that digest are already final.
    const source = Readable.from([Buffer.from('completely different bytes')]);
    const result = await blobs.put(digest, source);
    expect(result).toEqual({ size: body.length, created: false });
    expect(source.readableEnded).toBe(true);
    expect(statSync(blobs.pathFor(digest)).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(path.join(blobs.root, 'tmp'))).toEqual([]);
    const chunks: Buffer[] = [];
    for await (const c of blobs.open(digest)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
  });

  it('rejects malformed digests', async () => {
    const blobs = fresh();
    expect(() => blobs.pathFor('../etc/passwd')).toThrow();
    expect(await blobs.has('nope')).toBe(false);
  });
});

describe('blob root resolution (od-hub start --blob-dir)', () => {
  it('BLOB_DIR env wins, then --blob-dir, then <dir of --sqlite>/blobs, else the config default', () => {
    expect(resolveBlobDirFlag('/flag/blobs', '/data/hub.sqlite', { BLOB_DIR: '/env/blobs' })).toBeUndefined();
    expect(parseHubConfig({ BLOB_DIR: '/env/blobs' }).blobDir).toBe('/env/blobs');
    expect(resolveBlobDirFlag('/flag/blobs', '/data/hub.sqlite', {})).toBe('/flag/blobs');
    expect(resolveBlobDirFlag(undefined, '/data/hub.sqlite', {})).toBe(path.join('/data', 'blobs'));
    expect(resolveBlobDirFlag(undefined, 'relative/hub.sqlite', {})).toBe(path.join(path.resolve('relative'), 'blobs'));
    expect(resolveBlobDirFlag(undefined, ':memory:', {})).toBeUndefined();
    expect(resolveBlobDirFlag(undefined, undefined, {})).toBeUndefined();
    expect(parseHubConfig({}).blobDir).toBe(path.join('.tmp', 'od-hub', 'blobs'));
    expect(parseHubConfig({ OD_HUB_DATA_DIR: '/var/od-hub' }).blobDir).toBe(path.join('/var/od-hub', 'blobs'));
  });
});
