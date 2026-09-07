/**
 * Verbatim copies of the daemon-side functions that consume `od-vela collab *`
 * stdout and reconcile pulled comments. tools/* must not import
 * apps/daemon/src (root AGENTS.md boundary), so each block reproduces the
 * exact logic and cites the source location. If one of these drifts from the
 * daemon, the contract test goes red for the wrong reason: update the copy
 * together with the daemon.
 *
 * Only type aliases are inlined; function bodies are byte-for-byte the daemon's.
 */

export type CollabMemberRole = 'owner' | 'admin' | 'member';

export interface CollabCloudMemberDirectoryEntry {
  memberId: string;
  displayName: string;
  role: CollabMemberRole;
}

/** packages/contracts/src/api/collab.ts:44-52 */
export interface CollabPresenceMember {
  memberId: string;
  name?: string;
  role?: CollabMemberRole;
  avatarUrl?: string | null;
  filePath?: string | null;
  activity?: string | { label?: string } | Record<string, unknown> | null;
  heartbeatAt?: string;
}

type MemberWire = {
  memberId?: unknown;
  displayName?: unknown;
  role?: unknown;
  avatarUrl?: unknown;
};

type PresenceWire = MemberWire & {
  filePath?: unknown;
  activity?: unknown;
  heartbeatAt?: unknown;
};

type PresenceActivity = Exclude<CollabPresenceMember['activity'], undefined>;

// ---- apps/daemon/src/collab/vela-cli-collab-client.ts:56-65 (runJson stdout handling)
export function parseCollabStdout<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) return {} as T;
  return JSON.parse(trimmed) as T;
}

// ---- apps/daemon/src/collab/vela-cli-collab-client.ts:183-191 (toDirectoryEntry)
export function toDirectoryEntry(input: MemberWire | undefined): CollabCloudMemberDirectoryEntry {
  const memberId = typeof input?.memberId === 'string' ? input.memberId : '';
  const displayName =
    typeof input?.displayName === 'string' && input.displayName.trim()
      ? input.displayName
      : memberId;
  const role = isRole(input?.role) ? input.role : 'member';
  return { memberId, displayName, role };
}

// ---- apps/daemon/src/collab/vela-cli-collab-client.ts:193-218 (toPresenceMember)
export function toPresenceMember(input: PresenceWire): CollabPresenceMember {
  const memberId = typeof input.memberId === 'string' ? input.memberId : '';
  const member: CollabPresenceMember = {
    memberId,
  };
  const displayName = typeof input.displayName === 'string'
    ? input.displayName.trim()
    : '';
  if (displayName && displayName !== memberId) {
    member.name = displayName;
  }
  if (isRole(input.role)) member.role = input.role;
  if (typeof input.avatarUrl === 'string' || input.avatarUrl === null) {
    member.avatarUrl = input.avatarUrl;
  }
  if (typeof input.filePath === 'string' || input.filePath === null) {
    member.filePath = input.filePath;
  }
  if (input.activity !== undefined) {
    member.activity = input.activity as PresenceActivity;
  }
  if (typeof input.heartbeatAt === 'string') {
    member.heartbeatAt = input.heartbeatAt;
  }
  return member;
}

// ---- apps/daemon/src/collab/vela-cli-collab-client.ts:220-222 (isRole)
export function isRole(value: unknown): value is CollabMemberRole {
  return value === 'owner' || value === 'admin' || value === 'member';
}

// ---- apps/daemon/src/collab/vela-cli-collab-client.ts:95-103 (pushComment result), :109-133 (pullComments result)
export function parsePushCommentStdout(stdout: string): { seq: number } {
  const payload = parseCollabStdout<{ seq?: unknown }>(stdout);
  return { seq: typeof payload.seq === 'number' ? payload.seq : 0 };
}

export function parsePullCommentsStdout(stdout: string, sinceSeq: number): {
  comments: Array<Record<string, unknown>>;
  latestSeq: number;
  notModified: boolean;
  etag: string | null;
} {
  const payload = parseCollabStdout<{ comments?: unknown; latestSeq?: unknown }>(stdout);
  const comments = Array.isArray(payload.comments)
    ? (payload.comments as Array<Record<string, unknown>>)
    : [];
  return {
    comments,
    latestSeq: typeof payload.latestSeq === 'number' ? payload.latestSeq : sinceSeq,
    notModified: comments.length === 0,
    etag: null,
  };
}

// ---- apps/daemon/src/collab/vela-cli-collab-client.ts:233 (PRESENCE_COMMAND_TIMEOUT_MS)
export const PRESENCE_COMMAND_TIMEOUT_MS = 10_000;

// ---- apps/daemon/src/collab/collab-cloud-error.ts:30-46 (parseVelaApiStatus), :48-73 (classifyCollabCloudError)
const VELA_API_STATUS_PATTERN = /API request failed with status (\d{3})\b/;

export function parseVelaApiStatus(error: unknown): number | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const match = VELA_API_STATUS_PATTERN.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return error.name === 'TimeoutError' || code === 'ETIMEDOUT';
}

export function classifyCollabCloudError(error: unknown): {
  kind: 'denied' | 'not_found' | 'timeout' | 'infrastructure';
  status: 403 | 404 | 502 | 503;
  retryable: boolean;
  upstreamStatus: number | null;
} {
  const upstreamStatus = parseVelaApiStatus(error);
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return { kind: 'denied', status: 403, retryable: false, upstreamStatus };
  }
  if (upstreamStatus === 404) {
    return { kind: 'not_found', status: 404, retryable: false, upstreamStatus };
  }
  if (isTimeoutError(error)) {
    return { kind: 'timeout', status: 503, retryable: true, upstreamStatus };
  }
  return {
    kind: 'infrastructure',
    status: 502,
    retryable: true,
    upstreamStatus,
  };
}

// ---- apps/daemon/src/db.ts:3800-3837 (mergeSyncedPreviewComment decision core)
// The daemon writes to SQLite `preview_comments`; this copy keeps only the
// decision (delete-wins by id, strictly-newer updatedAt LWW) over a Map so a
// test can replay a pulled stream and assert what each receiver converges to.
export interface ReceiverRow { updatedAt: number; body: Record<string, unknown> }

export function mergeSyncedPreviewComment(
  local: Map<string, ReceiverRow>,
  comment: Record<string, unknown> & { id: string; deleted?: boolean; updatedAt?: unknown },
  now: number = Date.now(),
): boolean {
  if (comment.deleted) {
    // db.ts:3769-3778 deleteSyncedPreviewComment
    return local.delete(comment.id);
  }
  const updatedAt = Number.isFinite(comment.updatedAt) ? (comment.updatedAt as number) : now;
  const existing = local.get(comment.id);
  if (existing) {
    // Last-writer-wins: only apply a strictly-newer edit.
    if (updatedAt <= Number(existing.updatedAt ?? 0)) return false;
    local.set(comment.id, { updatedAt, body: comment });
    return false;
  }
  local.set(comment.id, { updatedAt, body: comment });
  return true;
}
