/**
 * Comment stream reconciliation rules (PLAN §3.2 `comments` / `comment_seq`,
 * §4.3 collab rows). These are the semantics the daemon relies on when it
 * merges a pulled stream (apps/daemon/src/db.ts:3806-3837
 * `mergeSyncedPreviewComment`) and when it pushes edits and tombstones
 * (apps/daemon/src/collab/collab-cloud-service.ts:289-321):
 *
 *   - one monotonic `seq` per (workspace, project); every accepted write takes
 *     `latest + 1`, including an upsert of an existing id (the daemon's pull
 *     cursor is `seq`, so a re-sequenced edit is the only way it is seen);
 *   - upsert by `id`: an id appears at most once in the stream;
 *   - a tombstone (`deleted:true`) is never overwritten by a non-tombstone
 *     (receivers delete by id regardless of `updatedAt`, so resurrecting the
 *     row would diverge from every receiver that already deleted it);
 *   - `updatedAt` is clamped to `now + 5000ms`: receivers apply
 *     last-writer-wins on `updatedAt`, so a client with a runaway clock must
 *     not be able to freeze a comment against every later edit.
 *
 * Everything here is pure so the memory and SQLite stores decide identically;
 * the store only supplies `previous`, `latestSeq`, and the transaction.
 */

import type { CommentRow } from './store.js';

/** Maximum tolerated client clock skew for `updatedAt` (PLAN §4.3, §9 "服务端夹逼 now+5s"). */
export const COMMENT_UPDATED_AT_SKEW_MS = 5_000;

/**
 * `updatedAt` as stored: a finite number no later than `now + skew`; anything
 * else (missing, ISO string, NaN) becomes `now`, which is also what the daemon
 * substitutes on merge (db.ts:3829).
 */
export function clampCommentUpdatedAt(value: unknown, nowMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return nowMs;
  return Math.min(Math.round(value), nowMs + COMMENT_UPDATED_AT_SKEW_MS);
}

export interface CommentWriteInput {
  workspaceId: string;
  projectId: string;
  /** The comment as sent; must carry a non-empty string `id`. */
  comment: Record<string, unknown>;
  /** Author the hub resolved (the payload's `memberId` or, when missing, the caller). */
  authorMemberId: string;
}

export type CommentWriteDecision =
  | { kind: 'write'; row: CommentRow; created: boolean }
  /** The stored row is a tombstone and the write is not: keep the tombstone, assign nothing. */
  | { kind: 'keep_tombstone'; row: CommentRow };

/**
 * Decide the row a push produces given the stored row for the same id (or
 * null) and the current latest seq of the project. The stored `body` is the
 * payload with `projectId`, `seq`, `memberId`, `updatedAt`, and `deleted`
 * rewritten to the authoritative values so a pull returns exactly what the
 * daemon will merge.
 */
export function decideCommentWrite(
  input: CommentWriteInput,
  previous: CommentRow | null,
  latestSeq: number,
  now: Date,
): CommentWriteDecision {
  const deleted = input.comment.deleted === true;
  if (previous?.deleted && !deleted) return { kind: 'keep_tombstone', row: previous };
  const nowMs = now.getTime();
  const updatedAt = clampCommentUpdatedAt(input.comment.updatedAt, nowMs);
  const seq = latestSeq + 1;
  const body: Record<string, unknown> = {
    ...input.comment,
    projectId: input.projectId,
    seq,
    memberId: input.authorMemberId,
    updatedAt,
  };
  if (deleted) body.deleted = true;
  else delete body.deleted;
  const row: CommentRow = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    id: String(input.comment.id),
    seq,
    body,
    deleted,
    authorMemberId: input.authorMemberId,
    updatedAt,
    serverReceivedAt: now.toISOString(),
  };
  return { kind: 'write', row, created: !previous };
}

/** Wire form of a stored comment (`CollabCloudComment`): the body already carries the authoritative fields. */
export function commentToWire(row: CommentRow): Record<string, unknown> {
  return { ...row.body, projectId: row.projectId, seq: row.seq, ...(row.deleted ? { deleted: true } : {}) };
}
