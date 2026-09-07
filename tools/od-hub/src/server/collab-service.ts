import { commentToWire } from './comments.js';
import { digestFacesForEvent } from './digest.js';
import type { HeartbeatInput, PresenceService, PresenceViewerWire } from './presence-service.js';
import type { Actor } from './resource-service.js';
import type { HubStore, OutboxEventInput, SideEffects, WorkspaceMemberRow, WorkspaceRole } from './store.js';

/** Typed failure the HTTP layer maps to `{status, error}`. */
export class CollabServiceError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string) {
    super(detail ?? code);
  }
}

/** `collab member list|register` row (vela-cli-collab-client.ts:183-191 toDirectoryEntry). */
export interface MemberWire {
  memberId: string;
  displayName: string;
  role: WorkspaceRole;
  avatarUrl?: string;
}

export function toMemberWire(row: WorkspaceMemberRow): MemberWire {
  return {
    memberId: row.memberId,
    displayName: row.displayName?.trim() || row.memberId,
    role: row.role,
    ...(row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}),
  };
}

interface WorkspaceEvent {
  type: string;
  [key: string]: unknown;
}

/** Sort members deterministically: owner, admin, member, then by memberId. */
const ROLE_ORDER: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2 };
const WORKSPACE_ROLES = new Set<string>(Object.keys(ROLE_ORDER));

/** Audit action for a stored comment write: create / update / delete (target = id; details never carry the body). */
export type CommentAuditAction = 'comment_create' | 'comment_update' | 'comment_delete';
export function commentAuditAction(created: boolean, deleted: boolean): CommentAuditAction {
  if (deleted) return 'comment_delete';
  return created ? 'comment_create' : 'comment_update';
}

/**
 * Member directory, comment stream, and presence use cases behind
 * `/api/v1/collab/*` (PLAN §4.3 collab rows). Members and comments persist
 * through the store in one transaction with their outbox rows; presence is
 * process-local (see presence-service.ts) and its events are appended through
 * `applyBatch` after the roster changed.
 */
export class CollabService {
  constructor(
    private readonly deps: {
      store: HubStore;
      presence: PresenceService;
      now: () => Date;
      onOutbox: () => void;
    },
  ) {}

  private events(workspaceId: string, events: WorkspaceEvent[], audit: SideEffects['audit'] = []): SideEffects {
    const at = this.deps.now().toISOString();
    const outbox: OutboxEventInput[] = events.map((event) => ({
      workspaceId,
      userId: null,
      topic: 'workspace',
      eventName: 'workspace-event',
      payload: { ...event, workspaceId, at },
    }));
    const digestBumps: SideEffects['digestBumps'] = [];
    for (const event of events) {
      for (const face of digestFacesForEvent(event.type)) digestBumps.push({ workspaceId, face });
    }
    return { outbox, digestBumps, audit };
  }

  // ---- members ----------------------------------------------------------------------

  /** Active members only; removed members never appear (fake-collab-hub filters `removedMembers`). */
  async listMembers(workspaceId: string): Promise<MemberWire[]> {
    const rows = await this.deps.store.listMembers(workspaceId);
    return rows
      .filter((row) => row.memberStatus === 'active')
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0))
      .map(toMemberWire);
  }

  /**
   * Idempotent upsert of the caller's display name (contracts collab.ts:769).
   * `role` in the body is validated (400 invalid_role outside owner/admin/member)
   * but otherwise ignored: roles come from the directory mirror, never from the
   * client. A changed name emits `workspace-members-changed{updated}` and moves
   * `membersToken`; an unchanged one is a silent no-op.
   */
  async registerMember(actor: Actor, body: Record<string, unknown>): Promise<MemberWire> {
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 256) : '';
    if (!displayName) throw new CollabServiceError(400, 'display_name_required');
    if (body.role !== undefined && (typeof body.role !== 'string' || !WORKSPACE_ROLES.has(body.role))) {
      throw new CollabServiceError(400, 'invalid_role');
    }
    if (displayName === (actor.membership.displayName ?? '').trim()) return toMemberWire(actor.membership);
    const next = await this.deps.store.setMemberDisplayName(actor.workspaceId, actor.userId, displayName, (previous) =>
      this.events(
        actor.workspaceId,
        [{ type: 'workspace-members-changed', memberId: previous.memberId, memberChange: 'updated' }],
        [{ actorUserId: actor.userId, workspaceId: actor.workspaceId, action: 'member_register', target: previous.memberId, details: { displayName } }],
      ));
    if (!next) throw new CollabServiceError(403, 'workspace_not_authorized');
    this.deps.onOutbox();
    return toMemberWire(next);
  }

  // ---- comments -----------------------------------------------------------------------

  /**
   * `POST .../projects/:projectId/comments {comment}`. Unknown projects are
   * accepted (the reference hub keeps comment streams independent of the
   * catalog; the daemon's own outbox already gates on a remote catalog row).
   * The author is the payload's `memberId` when present, else the caller: an
   * edit relayed by a non-author (status change on someone else's comment) is
   * legitimate and must not be rejected, because the daemon's durable outbox
   * would retry a 4xx forever (collab-cloud-service.ts deferOutboxRecord).
   */
  async pushComment(actor: Actor, projectId: string, body: Record<string, unknown>): Promise<{ seq: number }> {
    const comment = body.comment;
    if (!comment || typeof comment !== 'object' || Array.isArray(comment)) throw new CollabServiceError(400, 'comment_required');
    const record = comment as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) throw new CollabServiceError(400, 'comment_id_required');
    const authorMemberId = typeof record.memberId === 'string' && record.memberId.trim() ? record.memberId.trim() : actor.membership.memberId;
    const result = await this.deps.store.pushComment(
      { workspaceId: actor.workspaceId, projectId, comment: { ...record, id }, authorMemberId },
      ({ row, created }) => this.events(
        actor.workspaceId,
        [{ type: 'comment-changed', projectId, seq: row.seq }],
        [{
          actorUserId: actor.userId, workspaceId: actor.workspaceId, action: commentAuditAction(created, row.deleted), target: id,
          details: { projectId, seq: row.seq, authorMemberId: row.authorMemberId, pushedByMemberId: actor.membership.memberId },
        }],
      ),
    );
    if (result.kind === 'stored') this.deps.onOutbox();
    // A tombstoned id answers with the tombstone's seq: the daemon only confirms
    // pin_seq once and the stream already carries the delete.
    return { seq: result.row.seq };
  }

  async pullComments(workspaceId: string, projectId: string, sinceSeq: number): Promise<{ comments: Record<string, unknown>[]; latestSeq: number }> {
    const rows = await this.deps.store.listCommentsSince(workspaceId, projectId, sinceSeq);
    const latestSeq = await this.deps.store.latestCommentSeq(workspaceId, projectId);
    return { comments: rows.map(commentToWire), latestSeq };
  }

  // ---- presence ------------------------------------------------------------------------

  private async presenceChanged(workspaceId: string, projectId: string): Promise<void> {
    await this.deps.store.applyBatch(this.events(workspaceId, [{ type: 'presence-changed', projectId }]));
    this.deps.onOutbox();
  }

  async heartbeat(actor: Actor, projectId: string, body: Record<string, unknown>): Promise<{ viewers: PresenceViewerWire[] }> {
    const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : actor.membership.memberId;
    const input: HeartbeatInput = {
      clientId,
      member: actor.membership,
      displayName: typeof body.displayName === 'string' ? body.displayName : null,
      filePath: typeof body.filePath === 'string' ? body.filePath : null,
      ...('activity' in body ? { activity: body.activity } : {}),
    };
    const result = this.deps.presence.heartbeat(actor.workspaceId, projectId, input);
    if (result.changed) await this.presenceChanged(actor.workspaceId, projectId);
    return { viewers: result.viewers };
  }

  async listPresence(workspaceId: string, projectId: string): Promise<{ viewers: PresenceViewerWire[] }> {
    const result = this.deps.presence.list(workspaceId, projectId);
    if (result.changed) await this.presenceChanged(workspaceId, projectId);
    return { viewers: result.viewers };
  }

  /** Membership removed: drop the member's leases everywhere and announce every touched project. */
  async evictMemberPresence(workspaceId: string, memberId: string): Promise<void> {
    for (const projectId of this.deps.presence.evictMember(workspaceId, memberId)) {
      await this.presenceChanged(workspaceId, projectId);
    }
  }

  async leavePresence(actor: Actor, projectId: string, body: Record<string, unknown>): Promise<{ viewers: PresenceViewerWire[] }> {
    const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : null;
    const result = this.deps.presence.leave(actor.workspaceId, projectId, actor.membership.memberId, clientId);
    if (result.changed) await this.presenceChanged(actor.workspaceId, projectId);
    return { viewers: result.viewers };
  }
}
