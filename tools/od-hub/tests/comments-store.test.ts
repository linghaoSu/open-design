import { describe, expect, it } from 'vitest';

import { clampCommentUpdatedAt, COMMENT_UPDATED_AT_SKEW_MS, commentToWire, decideCommentWrite } from '../src/server/comments.js';
import { MemoryHubStore } from '../src/server/memory-store.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore, SideEffects } from '../src/server/store.js';
import { mergeSyncedPreviewComment } from './daemon-collab-parsers.js';

/**
 * Comment stream parity (PLAN §3.2 comments / comment_seq) — the semantics the
 * daemon reconciles against (db.ts:3806-3837, collab-cloud-service.ts:289-321):
 * per-project monotonic seq, upsert by id, tombstone precedence, updatedAt
 * clamp, and `sinceSeq` paging. Every case runs on both stores.
 */

const T0 = new Date('2026-09-08T10:00:00.000Z');
let clock = T0;
const now = () => clock;

const implementations: Array<[string, () => HubStore]> = [
  ['MemoryHubStore', () => new MemoryHubStore({}, { now })],
  ['SqliteHubStore(:memory:)', () => new SqliteHubStore(':memory:', { now })],
];

const noEffects = (): SideEffects => ({});

describe.each(implementations)('%s comments', (_name, make) => {
  const push = (store: HubStore, projectId: string, comment: Record<string, unknown>, author = 'm_a', effects: (r: { row: { seq: number }; created: boolean }) => SideEffects = noEffects) =>
    store.pushComment({ workspaceId: 'g1', projectId, comment, authorMemberId: author }, effects);

  it('assigns a monotonic seq per project and keeps projects independent', async () => {
    clock = T0;
    const store = make();
    expect(await store.latestCommentSeq('g1', 'p1')).toBe(0);
    const a = await push(store, 'p1', { id: 'c1', text: 'one', updatedAt: T0.getTime() });
    const b = await push(store, 'p1', { id: 'c2', text: 'two', updatedAt: T0.getTime() });
    const other = await push(store, 'p2', { id: 'c1', text: 'other project', updatedAt: T0.getTime() });
    expect(a.kind).toBe('stored');
    expect(a.row.seq).toBe(1);
    expect(b.row.seq).toBe(2);
    expect(other.row.seq).toBe(1);
    expect(await store.latestCommentSeq('g1', 'p1')).toBe(2);
    expect(await store.latestCommentSeq('g1', 'p2')).toBe(1);
    // Another workspace with the same project id is a different stream.
    const ws2 = await store.pushComment({ workspaceId: 'g2', projectId: 'p1', comment: { id: 'x' }, authorMemberId: 'm_a' }, noEffects);
    expect(ws2.row.seq).toBe(1);
    expect(await store.latestCommentSeq('g1', 'p1')).toBe(2);
    await store.close();
  });

  it('upserts by id: the edit takes a fresh seq and the id appears once', async () => {
    clock = T0;
    const store = make();
    await push(store, 'p1', { id: 'c1', text: 'v1', status: 'open', updatedAt: T0.getTime() });
    await push(store, 'p1', { id: 'c2', text: 'x', updatedAt: T0.getTime() });
    const edit = await push(store, 'p1', { id: 'c1', text: 'v2', status: 'resolved', updatedAt: T0.getTime() + 10 });
    expect(edit.kind).toBe('stored');
    if (edit.kind !== 'stored') return;
    expect(edit.created).toBe(false);
    expect(edit.row.seq).toBe(3);
    const all = await store.listCommentsSince('g1', 'p1', 0);
    expect(all.map((c) => [c.id, c.seq])).toEqual([['c2', 2], ['c1', 3]]);
    expect(all[1]!.body.text).toBe('v2');
    expect(all[1]!.body.status).toBe('resolved');
    // seq 1 no longer exists in the stream: a cursor at 1 sees c2 and the edited c1 only.
    expect((await store.listCommentsSince('g1', 'p1', 1)).map((c) => c.id)).toEqual(['c2', 'c1']);
    expect((await store.listCommentsSince('g1', 'p1', 2)).map((c) => c.id)).toEqual(['c1']);
    expect(await store.listCommentsSince('g1', 'p1', 3)).toEqual([]);
    await store.close();
  });

  it('a tombstone is never overwritten by a non-tombstone (delete wins, no seq consumed)', async () => {
    clock = T0;
    const store = make();
    await push(store, 'p1', { id: 'c1', text: 'v1', updatedAt: T0.getTime() });
    const del = await push(store, 'p1', { id: 'c1', text: 'v1', deleted: true, updatedAt: T0.getTime() + 1_000 });
    expect(del.kind).toBe('stored');
    expect(del.row.deleted).toBe(true);
    expect(del.row.seq).toBe(2);
    let effectsCalled = 0;
    const late = await push(store, 'p1', { id: 'c1', text: 'resurrected', updatedAt: T0.getTime() + 60_000 }, 'm_a', () => { effectsCalled += 1; return {}; });
    expect(late.kind).toBe('tombstoned');
    expect(late.row.seq).toBe(2);
    expect(late.row.deleted).toBe(true);
    expect(effectsCalled).toBe(0);
    expect(await store.latestCommentSeq('g1', 'p1')).toBe(2);
    const stored = await store.getComment('g1', 'p1', 'c1');
    expect(stored!.deleted).toBe(true);
    expect(stored!.body.text).toBe('v1');
    // Re-deleting a tombstone is an accepted write (idempotent delete retry) and re-sequences it.
    const again = await push(store, 'p1', { id: 'c1', deleted: true, updatedAt: T0.getTime() + 2_000 });
    expect(again.kind).toBe('stored');
    expect(again.row.seq).toBe(3);
    // The tombstone is part of the stream a receiver pulls.
    const pulled = (await store.listCommentsSince('g1', 'p1', 0)).map(commentToWire);
    expect(pulled).toHaveLength(1);
    expect(pulled[0]).toMatchObject({ id: 'c1', deleted: true, seq: 3, projectId: 'p1' });
    await store.close();
  });

  it('clamps updatedAt to now + 5000ms and normalizes invalid values to now', async () => {
    clock = T0;
    const store = make();
    const farFuture = T0.getTime() + 60 * 60 * 1_000;
    const clamped = await push(store, 'p1', { id: 'c1', updatedAt: farFuture });
    expect(clamped.row.updatedAt).toBe(T0.getTime() + COMMENT_UPDATED_AT_SKEW_MS);
    expect(clamped.row.body.updatedAt).toBe(T0.getTime() + COMMENT_UPDATED_AT_SKEW_MS);
    const withinSkew = await push(store, 'p1', { id: 'c2', updatedAt: T0.getTime() + 4_999 });
    expect(withinSkew.row.updatedAt).toBe(T0.getTime() + 4_999);
    const past = await push(store, 'p1', { id: 'c3', updatedAt: T0.getTime() - 86_400_000 });
    expect(past.row.updatedAt).toBe(T0.getTime() - 86_400_000);
    const iso = await push(store, 'p1', { id: 'c4', updatedAt: T0.toISOString() });
    expect(iso.row.updatedAt).toBe(T0.getTime());
    const missing = await push(store, 'p1', { id: 'c5' });
    expect(missing.row.updatedAt).toBe(T0.getTime());
    await store.close();
  });

  it('rewrites projectId, seq, and memberId to the authoritative values on the stored body', async () => {
    clock = T0;
    const store = make();
    const result = await push(store, 'p1', { id: 'c1', projectId: 'spoofed', seq: 999, memberId: '', updatedAt: T0.getTime() }, 'm_author');
    expect(result.row.body).toMatchObject({ id: 'c1', projectId: 'p1', seq: 1, memberId: 'm_author' });
    expect(result.row.authorMemberId).toBe('m_author');
    expect(result.row.serverReceivedAt).toBe(T0.toISOString());
    const wire = commentToWire((await store.listCommentsSince('g1', 'p1', 0))[0]!);
    expect(wire).toEqual({ id: 'c1', projectId: 'p1', seq: 1, memberId: 'm_author', updatedAt: T0.getTime() });
    await store.close();
  });

  it('commits effects in the same operation as the row (outbox/audit visible with the row)', async () => {
    clock = T0;
    const store = make();
    await push(store, 'p1', { id: 'c1', updatedAt: T0.getTime() }, 'm_a', ({ row, created }) => ({
      outbox: [{ workspaceId: 'g1', userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'comment-changed', projectId: 'p1', seq: row.seq } }],
      audit: [{ actorUserId: 'u1', workspaceId: 'g1', action: created ? 'comment_create' : 'comment_update', target: 'c1', details: { created } }],
    }));
    const outbox = await store.listUnpublishedOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.payload).toEqual({ type: 'comment-changed', projectId: 'p1', seq: 1 });
    const audit = await store.listAudit('g1');
    expect(audit.map((a) => a.action)).toEqual(['comment_create']);
    expect(audit[0]!.details).toEqual({ created: true });
    await store.close();
  });

  it('a receiver replaying the stream from any cursor converges (daemon mergeSyncedPreviewComment)', async () => {
    clock = T0;
    const store = make();
    const t = (ms: number) => T0.getTime() + ms;
    await push(store, 'p1', { id: 'a', text: 'a1', updatedAt: t(0) });
    await push(store, 'p1', { id: 'b', text: 'b1', updatedAt: t(1) });
    await push(store, 'p1', { id: 'a', text: 'a2', updatedAt: t(2) });
    await push(store, 'p1', { id: 'b', deleted: true, updatedAt: t(3) });
    await push(store, 'p1', { id: 'b', text: 'b-late', updatedAt: t(9_000) }); // rejected: tombstone wins
    await push(store, 'p1', { id: 'c', text: 'c1', updatedAt: t(4) });

    // Full replay.
    const full = new Map();
    for (const row of await store.listCommentsSince('g1', 'p1', 0)) mergeSyncedPreviewComment(full, commentToWire(row) as never, t(10));
    expect([...full.keys()].sort()).toEqual(['a', 'c']);
    expect(full.get('a')!.body.text).toBe('a2');

    // Receiver that already had a1/b1 and pulls from cursor 2.
    const partial = new Map([['a', { updatedAt: t(0), body: { id: 'a', text: 'a1' } }], ['b', { updatedAt: t(1), body: { id: 'b', text: 'b1' } }]]);
    for (const row of await store.listCommentsSince('g1', 'p1', 2)) mergeSyncedPreviewComment(partial, commentToWire(row) as never, t(10));
    expect([...partial.keys()].sort()).toEqual(['a', 'c']);
    expect(partial.get('a')!.body.text).toBe('a2');
    await store.close();
  });
});

describe('decideCommentWrite (pure)', () => {
  it('clamp helper', () => {
    expect(clampCommentUpdatedAt(undefined, 1_000)).toBe(1_000);
    expect(clampCommentUpdatedAt(Number.NaN, 1_000)).toBe(1_000);
    expect(clampCommentUpdatedAt(10_000, 1_000)).toBe(6_000);
    expect(clampCommentUpdatedAt(5_999.6, 1_000)).toBe(6_000);
    expect(clampCommentUpdatedAt(500, 1_000)).toBe(500);
  });

  it('strips a false `deleted` and stores `true` only', () => {
    const write = decideCommentWrite({ workspaceId: 'g', projectId: 'p', comment: { id: 'c', deleted: false }, authorMemberId: 'm' }, null, 0, T0);
    expect(write.kind).toBe('write');
    if (write.kind !== 'write') return;
    expect('deleted' in write.row.body).toBe(false);
    expect(write.row.deleted).toBe(false);
  });
});
