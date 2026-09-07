import { createHash, randomBytes } from 'node:crypto';

import { digestFacesForEvent } from './digest.js';
import type { DirectoryService } from './directory-service.js';
import type { GitLabClient } from './gitlab.js';
import { hashApiKey } from './ids.js';
import type { Mailer } from './mailer.js';
import type {
  HubStore,
  InviteContinuationRow,
  InviteRole,
  InviteRow,
  OutboxEventInput,
  SideEffects,
  UserRow,
  WorkspaceMemberRow,
  WorkspaceRow,
} from './store.js';
import { toWorkspaceContextWire, type WorkspaceContextWire } from './workspace-context.js';

/**
 * Workspace invites and the desktop hand-off continuation (PLAN §3.2 invites /
 * invite_continuations). Wire shapes and error codes follow
 * packages/contracts/src/api/workspace-invites.ts and the two daemon
 * consumers (collab/invite-create.ts, collab/invite-continue.ts) — see the
 * file:line citations on each method.
 */

/** Typed failure the HTTP layer maps to `{status, error}` (JSON) or error.html (browser). */
export class InviteServiceError extends Error {
  constructor(readonly status: number, readonly code: string, detail?: string) {
    super(detail ?? code);
  }
}

/** contracts workspace-invites.ts:77-81 — fixed scheme + authority/path of the continuation deeplink. */
export const INVITE_DEEPLINK_SCHEME = 'opendesign';
export const INVITE_DEEPLINK_PATH = 'workspace/invite/continue';

/** 32 random bytes as base64url (256-bit): landing tokens, continuation nonces, PKCE verifiers. */
const SECRET_BYTES = 32;
export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function mintSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/** GitLab access levels an invite role maps to (PLAN §5.2 inverse of roleForAccessLevel). */
export const GITLAB_ACCESS_LEVEL: Record<InviteRole, number> = { admin: 40, member: 30 };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(email) && email.length <= 320 ? email : null;
}

/** `j***@company.com` (contracts workspace-invites.ts:93-95): the raw address never crosses the wire. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

export function isInviteRole(value: unknown): value is InviteRole {
  return value === 'admin' || value === 'member';
}

/**
 * contracts workspace-invites.ts:352-361 (buildInviteDeeplink) — same field
 * order so a round trip through `parseInviteDeeplink` is byte-identical.
 */
export function buildInviteDeeplink(payload: { workspaceId: string; memberId: string; inviteId: string; nonce: string }): string {
  const params = new URLSearchParams({
    workspace_id: payload.workspaceId,
    member_id: payload.memberId,
    invite_id: payload.inviteId,
    nonce: payload.nonce,
  });
  return `${INVITE_DEEPLINK_SCHEME}://${INVITE_DEEPLINK_PATH}?${params.toString()}`;
}

/** contracts workspace-invites.ts:20 status as seen from outside (a pending invite past expiry reads expired). */
export function inviteStatusAt(row: InviteRow, now: Date): InviteRow['status'] {
  if (row.status === 'pending' && Date.parse(row.expiresAt) <= now.getTime()) return 'expired';
  return row.status;
}

/** contracts workspace-invites.ts:97-107 */
export interface InvitePreviewWire {
  inviteId: string;
  workspaceId: string;
  workspaceName: string;
  invitedEmailMasked: string;
  role: InviteRole;
  status: InviteRow['status'];
  expiresAt: number;
  clientHints: { preferredDesktopScheme: typeof INVITE_DEEPLINK_SCHEME; downloadUrl: string };
}

/** contracts workspace-invites.ts:126-153 */
export interface InviteAcceptWire {
  workspaceId: string;
  workspaceMemberId: string;
  memberId: string;
  inviteId: string;
  role: WorkspaceMemberRow['role'];
  lifecycleState: WorkspaceRow['lifecycleState'];
  continuation: { nonce: string; deeplinkUrl: string; expiresAt: number; fallbackDownloadUrl: string };
  currentWorkspaceContext: WorkspaceContextWire;
}

/** invite-continue.ts:67-75 + tests/invite-continue.test.ts:31-37 */
export interface ContinuationConsumeWire {
  workspaceId: string;
  workspaceMemberId: string;
  memberId: string;
  inviteId: string;
  currentWorkspaceContext: WorkspaceContextWire;
}

export interface InviteServiceDeps {
  store: HubStore;
  directory: DirectoryService;
  gitlab: GitLabClient | null;
  /** Group Access Token; null = mirror-only membership (warned). */
  gitlabGroupToken: string | null;
  mailer: Mailer | null;
  mailFrom: string | null;
  inviteTtlMs: number;
  continuationTtlMs: number;
  downloadUrl: string;
  now: () => Date;
  onOutbox: () => void;
  log: (line: string) => void;
}

export interface InviteActor {
  user: UserRow;
  membership: WorkspaceMemberRow;
  ip?: string | null;
  userAgent?: string | null;
}

export class InviteService {
  constructor(private readonly deps: InviteServiceDeps) {}

  // ---- create (invite-create.ts:75-104; extract-3 §2) ---------------------------------

  /**
   * `POST /api/v1/workspaces/:workspaceId/invites {invitedEmail, role}` -> `{inviteId}`.
   * Error codes are the create allowlist (contracts workspace-invites.ts:34-40):
   * `already_member` and `active_pending_invite` (both 409). Seat codes are
   * never emitted — od-hub has no seats.
   */
  async create(actor: InviteActor, workspace: WorkspaceRow, body: Record<string, unknown>, consoleOrigin: string): Promise<{ invite: InviteRow; token: string; landingUrl: string }> {
    if (workspace.gitlabKind !== 'team') throw new InviteServiceError(403, 'workspace_forbidden', 'invites are team-workspace only');
    if (workspace.lifecycleState !== 'active') throw new InviteServiceError(409, 'workspace_subscription_locked');
    if (actor.membership.role !== 'owner' && actor.membership.role !== 'admin') throw new InviteServiceError(403, 'workspace_forbidden');
    const invitedEmail = normalizeEmail(body.invitedEmail);
    if (!invitedEmail) throw new InviteServiceError(400, 'invalid_email');
    if (!isInviteRole(body.role)) throw new InviteServiceError(400, 'invalid_role');
    const role = body.role;
    const now = this.deps.now();

    // already_member: match on the emails the hub holds. GitLab may hide an
    // address (then users.email is `<username>@<host>`), so accept re-checks by id.
    for (const member of await this.deps.store.listMembers(workspace.id)) {
      if (member.memberStatus !== 'active') continue;
      const user = await this.deps.store.getUser(member.userId);
      if (user && user.email.trim().toLowerCase() === invitedEmail) throw new InviteServiceError(409, 'already_member');
    }
    for (const pending of await this.deps.store.listPendingInvites(workspace.id, invitedEmail)) {
      if (Date.parse(pending.expiresAt) > now.getTime()) throw new InviteServiceError(409, 'active_pending_invite');
      await this.deps.store.setInviteStatus(pending.id, 'expired');
    }

    const token = mintSecret();
    const inviteId = `inv_${randomBytes(12).toString('base64url')}`;
    const expiresAt = new Date(now.getTime() + this.deps.inviteTtlMs).toISOString();
    const invite = await this.deps.store.createInvite(
      {
        id: inviteId,
        workspaceId: workspace.id,
        invitedEmail,
        role,
        tokenHash: hashApiKey(token),
        expiresAt,
        createdByUserId: actor.user.id,
        createdByMemberId: actor.membership.memberId,
      },
      {
        audit: [{
          actorUserId: actor.user.id, actorMemberId: actor.membership.memberId, workspaceId: workspace.id, action: 'invite_create',
          target: inviteId, ip: actor.ip ?? null, userAgent: actor.userAgent ?? null,
          details: { role, invitedEmailMasked: maskEmail(invitedEmail), expiresAt },
        }],
      },
    );
    const landingUrl = landingUrlFor(consoleOrigin, token);
    await this.deliver(invite, workspace, actor.user, landingUrl);
    return { invite, token, landingUrl };
  }

  private async deliver(invite: InviteRow, workspace: WorkspaceRow, inviter: UserRow, landingUrl: string): Promise<void> {
    if (!this.deps.mailer) {
      this.deps.log(`[od-hub] invite ${invite.id} for ${maskEmail(invite.invitedEmail)} to ${workspace.id}: no SMTP_URL, share this link manually: ${landingUrl}`);
      return;
    }
    const from = this.deps.mailFrom ?? `od-hub@${safeHost(landingUrl)}`;
    try {
      await this.deps.mailer.send({
        from,
        to: invite.invitedEmail,
        subject: `${inviter.name} invited you to ${workspace.name} on OpenDesign`,
        text: [
          `${inviter.name} invited you to join the workspace "${workspace.name}" as ${invite.role}.`,
          '',
          'Open this link to accept:',
          landingUrl,
          '',
          `The invite expires at ${invite.expiresAt}.`,
        ].join('\n'),
      });
      this.deps.log(`[od-hub] invite ${invite.id} mailed to ${maskEmail(invite.invitedEmail)}`);
    } catch (error) {
      // The invite exists; a mail failure must not roll it back or leak the token into a 5xx.
      this.deps.log(`[od-hub] invite ${invite.id} mail failed (${error instanceof Error ? error.message : String(error)}); share this link manually: ${landingUrl}`);
    }
  }

  // ---- preview (contracts :97-107) ------------------------------------------------------

  async lookup(token: string): Promise<InviteRow> {
    if (!SECRET_PATTERN.test(token)) throw new InviteServiceError(404, 'invite_not_found');
    const row = await this.deps.store.getInviteByTokenHash(hashApiKey(token));
    if (!row) throw new InviteServiceError(404, 'invite_not_found');
    return row;
  }

  async preview(token: string): Promise<{ invite: InviteRow; workspace: WorkspaceRow; inviter: UserRow | null; wire: InvitePreviewWire }> {
    const invite = await this.lookup(token);
    const workspace = await this.deps.store.getWorkspace(invite.workspaceId);
    if (!workspace) throw new InviteServiceError(404, 'workspace_not_found');
    const inviter = invite.createdByUserId ? await this.deps.store.getUser(invite.createdByUserId) : null;
    const status = inviteStatusAt(invite, this.deps.now());
    if (status === 'expired' && invite.status === 'pending') await this.deps.store.setInviteStatus(invite.id, 'expired');
    return {
      invite: { ...invite, status },
      workspace,
      inviter,
      wire: {
        inviteId: invite.id,
        workspaceId: invite.workspaceId,
        workspaceName: workspace.name,
        invitedEmailMasked: maskEmail(invite.invitedEmail),
        role: invite.role,
        status,
        expiresAt: Date.parse(invite.expiresAt),
        clientHints: { preferredDesktopScheme: INVITE_DEEPLINK_SCHEME, downloadUrl: this.deps.downloadUrl },
      },
    };
  }

  // ---- accept (contracts :116-153) -------------------------------------------------------

  /**
   * Accept for `user`. Order: gate on the invite row (404/410/409), re-check
   * `already_member` by user id (the create-time email check may have missed a
   * hidden GitLab address), enrol in the GitLab group when a Group Access
   * Token is configured (a failure there is 503 and nothing is written — a
   * mirror row GitLab does not know about would be removed on the next
   * directory sync), then the transactional store accept + continuation.
   */
  async accept(token: string, user: UserRow, options: { continueWithCurrentAccount: boolean; ip?: string | null; userAgent?: string | null }): Promise<InviteAcceptWire> {
    const invite = await this.lookup(token);
    const now = this.deps.now();
    const status = inviteStatusAt(invite, now);
    if (status === 'accepted') throw new InviteServiceError(409, 'invite_consumed');
    if (status !== 'pending') throw new InviteServiceError(410, 'invite_expired');
    const workspace = await this.deps.store.getWorkspace(invite.workspaceId);
    if (!workspace) throw new InviteServiceError(404, 'workspace_not_found');
    if (workspace.lifecycleState !== 'active') throw new InviteServiceError(409, 'workspace_subscription_locked');
    if (user.email.trim().toLowerCase() !== invite.invitedEmail && !options.continueWithCurrentAccount) {
      // contracts :118-123: consume only once the account choice is explicit.
      throw new InviteServiceError(403, 'invite_email_mismatch');
    }
    const existing = await this.deps.store.getMembership(user.id, workspace.id);
    if (existing?.memberStatus === 'active') throw new InviteServiceError(409, 'already_member');

    await this.enrolInGitLab(workspace, user, invite.role);

    const nonce = mintSecret();
    const expiresAt = new Date(now.getTime() + this.deps.continuationTtlMs).toISOString();
    const result = await this.deps.store.acceptInvite(
      {
        tokenHash: invite.tokenHash,
        userId: user.id,
        displayName: user.name,
        avatarUrl: user.avatarUrl,
        continuation: { nonceHash: hashApiKey(nonce), expiresAt },
      },
      ({ invite: accepted, membership }) => this.membershipEffects(workspace.id, user, membership, existing, {
        actorUserId: user.id, actorMemberId: membership.memberId, workspaceId: workspace.id, action: 'invite_accept', target: accepted.id,
        ip: options.ip ?? null, userAgent: options.userAgent ?? null,
        details: { role: membership.role, invitedRole: accepted.role, reactivated: existing?.memberStatus === 'removed' },
      }),
    );
    switch (result.kind) {
      case 'accepted':
        break;
      case 'not_found':
        throw new InviteServiceError(404, 'invite_not_found');
      case 'consumed':
        throw new InviteServiceError(409, 'invite_consumed');
      case 'expired':
      case 'revoked':
        throw new InviteServiceError(410, 'invite_expired');
      default:
        throw new InviteServiceError(500, 'internal_error');
    }
    this.deps.directory.invalidate(user.id);
    this.deps.onOutbox();
    const context = await this.contextFor(workspace, result.membership);
    return {
      workspaceId: workspace.id,
      workspaceMemberId: result.membership.memberId,
      memberId: result.membership.memberId,
      inviteId: result.invite.id,
      role: result.membership.role,
      lifecycleState: workspace.lifecycleState,
      continuation: {
        nonce,
        deeplinkUrl: buildInviteDeeplink({ workspaceId: workspace.id, memberId: result.membership.memberId, inviteId: result.invite.id, nonce }),
        expiresAt: Date.parse(result.continuation.expiresAt),
        fallbackDownloadUrl: this.deps.downloadUrl,
      },
      currentWorkspaceContext: context,
    };
  }

  private async enrolInGitLab(workspace: WorkspaceRow, user: UserRow, role: InviteRole): Promise<void> {
    const { gitlab, gitlabGroupToken } = this.deps;
    if (!gitlab || !gitlabGroupToken) {
      this.deps.log(`[od-hub] invite accept for ${user.id} in ${workspace.id}: GITLAB_GROUP_TOKEN not set, membership recorded in the hub mirror only`);
      return;
    }
    if (workspace.gitlabId === null || user.gitlabId === null) {
      this.deps.log(`[od-hub] invite accept for ${user.id} in ${workspace.id}: no GitLab ids on record, membership recorded in the hub mirror only`);
      return;
    }
    try {
      await gitlab.addGroupMember(gitlabGroupToken, workspace.gitlabId, user.gitlabId, GITLAB_ACCESS_LEVEL[role]);
    } catch (error) {
      this.deps.log(`[od-hub] GitLab group add failed for ${user.id} in ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`);
      throw new InviteServiceError(503, 'gitlab_unavailable');
    }
  }

  /** Same fan-out a directory diff produces for a new/updated membership (directory-service.ts:198-240). */
  private membershipEffects(workspaceId: string, user: UserRow, membership: WorkspaceMemberRow, previous: WorkspaceMemberRow | null, audit: NonNullable<SideEffects['audit']>[number]): SideEffects {
    const at = this.deps.now().toISOString();
    const memberChange = previous && previous.memberStatus === 'active' ? 'updated' : 'added';
    const outbox: OutboxEventInput[] = [
      {
        workspaceId, userId: user.id, topic: 'directory', eventName: 'workspace-directory-changed',
        payload: { type: 'workspace-directory-changed', workspaceId, change: memberChange === 'added' ? 'membership-added' : 'membership-updated', at },
      },
      { workspaceId, userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'workspace-context-changed', workspaceId, at } },
      {
        workspaceId, userId: null, topic: 'workspace', eventName: 'workspace-event',
        payload: { type: 'workspace-members-changed', workspaceId, memberId: membership.memberId, memberChange, at },
      },
    ];
    const digestBumps: SideEffects['digestBumps'] = [];
    for (const type of ['workspace-context-changed', 'workspace-members-changed']) {
      for (const face of digestFacesForEvent(type)) digestBumps.push({ workspaceId, face });
    }
    return { outbox, digestBumps, audit: [audit] };
  }

  async contextFor(workspace: WorkspaceRow, membership: WorkspaceMemberRow): Promise<WorkspaceContextWire> {
    const billing = await this.deps.store.getWorkspaceBilling(workspace.id);
    return toWorkspaceContextWire({ workspace, membership, billing });
  }

  // ---- continuation consume (invite-continue.ts:59-75; extract-3 §3) -------------------------

  /**
   * `POST /api/v1/workspace-invites/continuations/:nonce/consume` (Bearer, no
   * body). 404 `invalid_nonce`, 403 `nonce_owner_mismatch`, 409
   * `nonce_consumed`, 410 `expired`; the daemon maps any of them to
   * `continuation_<status>` (invite-continue.ts:65). A consumed nonce whose
   * membership has since been removed (directory sync between accept and
   * desktop hand-off) is 403 `workspace_forbidden`: the hand-off must never
   * mint a workspace context for a non-member.
   */
  async consume(nonce: string, user: UserRow, request: { ip?: string | null; userAgent?: string | null } = {}): Promise<ContinuationConsumeWire> {
    if (!SECRET_PATTERN.test(nonce)) throw new InviteServiceError(404, 'invalid_nonce');
    const now = this.deps.now();
    const result = await this.deps.store.consumeInviteContinuation(hashApiKey(nonce), user.id, now, (row) => ({
      audit: [{
        actorUserId: user.id, actorMemberId: row.memberId, workspaceId: row.workspaceId, action: 'continuation_consume', target: row.inviteId,
        ip: request.ip ?? null, userAgent: request.userAgent ?? null, details: { memberId: row.memberId },
      }],
    }));
    switch (result.kind) {
      case 'consumed':
        return this.consumed(result.row, user);
      case 'not_found':
        throw new InviteServiceError(404, 'invalid_nonce');
      case 'owner_mismatch':
        throw new InviteServiceError(403, 'nonce_owner_mismatch');
      case 'already_consumed':
        throw new InviteServiceError(409, 'nonce_consumed');
      case 'expired':
        throw new InviteServiceError(410, 'expired');
      default:
        throw new InviteServiceError(500, 'internal_error');
    }
  }

  private async consumed(row: InviteContinuationRow, user: UserRow): Promise<ContinuationConsumeWire> {
    const workspace = await this.deps.store.getWorkspace(row.workspaceId);
    const membership = await this.deps.store.getMembership(user.id, row.workspaceId);
    if (!workspace || !membership) throw new InviteServiceError(404, 'workspace_not_found');
    if (membership.memberStatus !== 'active') throw new InviteServiceError(403, 'workspace_forbidden');
    this.deps.directory.invalidate(user.id);
    return {
      workspaceId: workspace.id,
      workspaceMemberId: membership.memberId,
      memberId: membership.memberId,
      inviteId: row.inviteId,
      currentWorkspaceContext: await this.contextFor(workspace, membership),
    };
  }
}

/** Browser landing page for a token; the same URL answers JSON to `Accept: application/json`. */
export function landingUrlFor(consoleOrigin: string, token: string): string {
  return `${consoleOrigin.replace(/\/+$/, '')}/console/invites/${encodeURIComponent(token)}`;
}

export function acceptUrlFor(consoleOrigin: string, token: string): string {
  return `${landingUrlFor(consoleOrigin, token)}/accept`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname || 'od-hub.local';
  } catch {
    return 'od-hub.local';
  }
}

/** S256 PKCE challenge (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
