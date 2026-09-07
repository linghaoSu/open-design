import type { AuthService } from './auth-service.js';
import type { HubConfig } from './config.js';
import { digestFacesForEvent } from './digest.js';
import { GitLabHttpError, type GitLabClient, type GitLabGroup } from './gitlab.js';
import { deriveMemberId } from './ids.js';
import { ACCESS_REVOKED_MEMBERSHIP_REMOVED, type HubDirectoryChange, type HubMemberChange } from '../shared/wire.js';
import type {
  HubStore,
  OutboxEventInput,
  StoreBatch,
  UpsertMemberInput,
  UserRow,
  WorkspaceDirectoryItem,
  WorkspaceLifecycleState,
  WorkspaceMemberRow,
  WorkspaceRole,
  WorkspaceRow,
} from './store.js';

/** PLAN §5.2 role mapping. Returns null for access levels below the configured floor (no directory row). */
export function roleForAccessLevel(accessLevel: number, minAccessLevel: number): WorkspaceRole | null {
  if (accessLevel >= 50) return 'owner';
  if (accessLevel >= 40) return 'admin';
  if (accessLevel >= minAccessLevel) return 'member';
  return null;
}

/** PLAN §3.1 lifecycle mapping; vela-workspace-context.ts:60-66 accepts active|billing_past_due|locked|deleting|deleted. */
export function lifecycleForGroup(group: Pick<GitLabGroup, 'marked_for_deletion_on' | 'archived'>): WorkspaceLifecycleState {
  if (group.marked_for_deletion_on) return 'deleting';
  if (group.archived) return 'locked';
  return 'active';
}

export const personalWorkspaceId = (user: UserRow): string => `u${user.gitlabId ?? user.id}`;
export const groupWorkspaceId = (groupId: number): string => `g${groupId}`;

interface DesiredWorkspace {
  workspace: { id: string; name: string; kind: 'personal' | 'team'; gitlabId: number | null; iconKey: string | null; lifecycleState: WorkspaceLifecycleState };
  role: WorkspaceRole;
}

export interface DirectoryServiceOptions {
  store: HubStore;
  gitlab: GitLabClient | null;
  /** Owns the per-user refresh lock consulted when GitLab rejects a token the hub still believed valid. */
  auth?: AuthService | null;
  config: HubConfig;
  now?: () => Date;
  /** Called after a batch with outbox rows was committed; the server drains the relay here. */
  onOutbox?: () => Promise<void> | void;
  /** Called once per membership that flipped to `removed` in a committed batch (presence eviction hook). */
  onMembershipRemoved?: (workspaceId: string, memberId: string) => Promise<void> | void;
  log?: (line: string) => void;
}

/**
 * Mirrors the caller's GitLab groups into `workspaces` / `workspace_members`
 * and turns each diff into outbox rows (PLAN §3.1, §4.2). All GitLab reads are
 * per-user and cached for `config.directoryCacheMs`; every write goes through
 * one `applyBatch` so directory rows and their events commit together.
 */
export class DirectoryService {
  private readonly store: HubStore;
  private readonly gitlab: GitLabClient | null;
  private readonly auth: AuthService | null;
  private readonly config: HubConfig;
  private readonly now: () => Date;
  private readonly onOutbox: () => Promise<void> | void;
  private readonly onMembershipRemoved: (workspaceId: string, memberId: string) => Promise<void> | void;
  private readonly log: (line: string) => void;
  private readonly refreshedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(options: DirectoryServiceOptions) {
    this.store = options.store;
    this.gitlab = options.gitlab;
    this.auth = options.auth ?? null;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.onOutbox = options.onOutbox ?? (() => {});
    this.onMembershipRemoved = options.onMembershipRemoved ?? (() => {});
    this.log = options.log ?? (() => {});
  }

  /** Force the next `ensureFresh` for the user to hit GitLab (tests, webhooks). */
  invalidate(userId: string): void {
    this.refreshedAt.delete(userId);
  }

  /**
   * Refresh the mirror from GitLab if the cache is stale. `accessToken` null
   * means the account has no GitLab grant (dev seed): the stored rows are the
   * truth and nothing is fetched.
   */
  async ensureFresh(user: UserRow, accessToken: string | null): Promise<void> {
    if (!accessToken || !this.gitlab) return;
    const last = this.refreshedAt.get(user.id);
    if (last !== undefined && this.now().getTime() - last < this.config.directoryCacheMs) return;
    const running = this.inFlight.get(user.id);
    if (running) return running;
    const task = this.refresh(user, accessToken, this.gitlab).finally(() => {
      this.inFlight.delete(user.id);
    });
    this.inFlight.set(user.id, task);
    return task;
  }

  /**
   * Directory rows for the caller with the 7-day removed retention applied.
   * The read-side filter stays so a mirror served while GitLab is unreachable
   * (no sync ran) still hides rows past retention; `refresh` deletes them.
   */
  async directoryFor(user: UserRow): Promise<WorkspaceDirectoryItem[]> {
    const items = await this.store.listDirectory(user.id);
    const memberships = await this.store.listMemberships(user.id);
    const expired = new Set(memberships.filter((m) => this.pastRetention(m)).map((m) => m.workspaceId));
    return items.filter((item) => !expired.has(item.workspaceId));
  }

  /** A removed membership whose 7-day visibility window (PLAN §3.1) has elapsed. */
  private pastRetention(member: WorkspaceMemberRow): boolean {
    if (member.memberStatus !== 'removed') return false;
    const removedAt = member.removedAt ? Date.parse(member.removedAt) : Number.NaN;
    return Number.isNaN(removedAt) || removedAt < this.now().getTime() - this.config.removedRetentionMs;
  }

  /**
   * Fetch the desired state, retrying exactly once with a refreshed token when
   * GitLab answers 401 to a token the hub still considered valid. A rejected
   * refresh surfaces as GitLabSessionRevokedError from the auth service.
   */
  private async desiredWithRetry(user: UserRow, accessToken: string, gitlab: GitLabClient): Promise<Map<string, DesiredWorkspace>> {
    try {
      return await this.desiredFromGitLab(user, accessToken, gitlab);
    } catch (error) {
      if (!(error instanceof GitLabHttpError) || error.status !== 401 || !this.auth) throw error;
      this.log(`[od-hub] GitLab rejected the access token of ${user.id}; refreshing once`);
      const refreshed = await this.auth.handleRejectedToken(user, accessToken);
      return this.desiredFromGitLab(user, refreshed, gitlab);
    }
  }

  private async desiredFromGitLab(user: UserRow, accessToken: string, gitlab: GitLabClient): Promise<Map<string, DesiredWorkspace>> {
    const desired = new Map<string, DesiredWorkspace>();
    desired.set(personalWorkspaceId(user), {
      workspace: {
        id: personalWorkspaceId(user),
        name: `${user.name}'s workspace`,
        kind: 'personal',
        gitlabId: null,
        iconKey: null,
        lifecycleState: 'active',
      },
      role: 'owner',
    });
    const groups = await gitlab.listGroups(accessToken, {
      minAccessLevel: this.config.gitlabMinAccessLevel,
      topLevelOnly: this.config.workspaceGroupMode === 'top-level',
    });
    for (const group of groups) {
      if (this.config.workspaceGroupMode === 'top-level' && group.parent_id !== null && group.parent_id !== undefined) continue;
      // The list endpoint does not carry the caller's access level; ask per group.
      let accessLevel = this.config.gitlabMinAccessLevel;
      if (user.gitlabId !== null) {
        const member = await gitlab.getGroupMember(accessToken, group.id, user.gitlabId);
        if (member) accessLevel = member.access_level;
      }
      const role = roleForAccessLevel(accessLevel, this.config.gitlabMinAccessLevel);
      if (!role) continue;
      const id = groupWorkspaceId(group.id);
      desired.set(id, {
        workspace: {
          id,
          name: group.full_name,
          kind: 'team',
          gitlabId: group.id,
          iconKey: group.avatar_url?.trim() || null,
          lifecycleState: lifecycleForGroup(group),
        },
        role,
      });
    }
    return desired;
  }

  private async refresh(user: UserRow, accessToken: string, gitlab: GitLabClient): Promise<void> {
    const desired = await this.desiredWithRetry(user, accessToken, gitlab);
    const existing = new Map((await this.store.listMemberships(user.id)).map((m) => [m.workspaceId, m]));
    const at = this.now().toISOString();
    const batch: StoreBatch = { workspaces: [], members: [], memberDeletes: [], outbox: [], digestBumps: [], audit: [] };
    const removed: Array<{ workspaceId: string; memberId: string }> = [];
    const directoryEvent = (workspaceId: string, change: HubDirectoryChange): OutboxEventInput => ({
      workspaceId,
      userId: user.id,
      topic: 'directory',
      eventName: 'workspace-directory-changed',
      payload: { type: 'workspace-directory-changed', workspaceId, change, at },
    });
    const membersEvent = (workspaceId: string, memberId: string, memberChange: HubMemberChange): OutboxEventInput[] => {
      const events: OutboxEventInput[] = [
        {
          workspaceId, userId: null, topic: 'workspace', eventName: 'workspace-event',
          payload: { type: 'workspace-context-changed', workspaceId, at },
        },
        {
          workspaceId, userId: null, topic: 'workspace', eventName: 'workspace-event',
          payload: { type: 'workspace-members-changed', workspaceId, memberId, memberChange, at },
        },
      ];
      for (const event of events) {
        for (const face of digestFacesForEvent(event.payload.type as string)) batch.digestBumps!.push({ workspaceId, face });
      }
      return events;
    };

    for (const [workspaceId, want] of desired) {
      const current = await this.store.getWorkspace(workspaceId);
      if (!current) {
        batch.workspaces!.push({ create: want.workspace });
        batch.outbox!.push(directoryEvent(workspaceId, 'created'));
      } else if (workspaceChanged(current, want.workspace)) {
        batch.workspaces!.push({ update: { id: workspaceId, name: want.workspace.name, iconKey: want.workspace.iconKey, lifecycleState: want.workspace.lifecycleState } });
        batch.outbox!.push(directoryEvent(workspaceId, 'updated'));
      }
      const member: UpsertMemberInput = {
        workspaceId, userId: user.id, role: want.role, memberStatus: 'active', displayName: user.name, avatarUrl: user.avatarUrl,
      };
      const previous = existing.get(workspaceId);
      const memberId = deriveMemberId(user.id, workspaceId);
      if (!previous || previous.memberStatus === 'removed') {
        batch.members!.push(member);
        if (current) batch.outbox!.push(directoryEvent(workspaceId, 'membership-added'));
        batch.outbox!.push(...membersEvent(workspaceId, memberId, 'added'));
      } else if (previous.role !== want.role) {
        batch.members!.push(member);
        batch.outbox!.push(directoryEvent(workspaceId, 'membership-updated'));
        batch.outbox!.push(...membersEvent(workspaceId, memberId, 'updated'));
      } else {
        // Unchanged: refresh seen_at / display fields only.
        batch.members!.push(member);
      }
    }

    for (const [workspaceId, previous] of existing) {
      if (desired.has(workspaceId)) continue;
      if (previous.memberStatus === 'removed') {
        // Past the 7-day window the row has no reader left: purge it so the mirror stays bounded.
        if (this.pastRetention(previous)) batch.memberDeletes!.push({ workspaceId, userId: user.id });
        continue;
      }
      batch.members!.push({ workspaceId, userId: user.id, role: previous.role, memberStatus: 'removed' });
      batch.outbox!.push(directoryEvent(workspaceId, 'membership-removed'));
      batch.outbox!.push(...membersEvent(workspaceId, previous.memberId, 'removed'));
      batch.outbox!.push({
        workspaceId, userId: user.id, topic: 'access', eventName: 'access-revoked',
        payload: { reason: ACCESS_REVOKED_MEMBERSHIP_REMOVED },
      });
      batch.audit!.push({ actorUserId: user.id, workspaceId, action: 'membership_removed', target: previous.memberId });
      removed.push({ workspaceId, memberId: previous.memberId });
    }

    const { outbox } = await this.store.applyBatch(batch);
    this.refreshedAt.set(user.id, this.now().getTime());
    for (const entry of removed) await this.onMembershipRemoved(entry.workspaceId, entry.memberId);
    if (outbox.length > 0) {
      this.log(`[od-hub] directory refresh for ${user.id}: ${outbox.length} event(s)`);
      await this.onOutbox();
    }
  }

  /** Test/admin hook: mark one membership removed with the same event fan-out a GitLab diff produces. */
  async removeMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | null> {
    const previous = await this.store.getMembership(userId, workspaceId);
    if (!previous || previous.memberStatus === 'removed') return previous;
    const at = this.now().toISOString();
    const batch: StoreBatch = {
      members: [{ workspaceId, userId, role: previous.role, memberStatus: 'removed' }],
      outbox: [
        { workspaceId, userId, topic: 'directory', eventName: 'workspace-directory-changed', payload: { type: 'workspace-directory-changed', workspaceId, change: 'membership-removed', at } },
        { workspaceId, userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'workspace-context-changed', workspaceId, at } },
        { workspaceId, userId: null, topic: 'workspace', eventName: 'workspace-event', payload: { type: 'workspace-members-changed', workspaceId, memberId: previous.memberId, memberChange: 'removed', at } },
        { workspaceId, userId, topic: 'access', eventName: 'access-revoked', payload: { reason: ACCESS_REVOKED_MEMBERSHIP_REMOVED } },
      ],
      digestBumps: [
        { workspaceId, face: 'membersToken' },
        { workspaceId, face: 'contextToken' },
      ],
    };
    await this.store.applyBatch(batch);
    await this.onMembershipRemoved(workspaceId, previous.memberId);
    await this.onOutbox();
    return this.store.getMembership(userId, workspaceId);
  }
}

function workspaceChanged(current: WorkspaceRow, want: DesiredWorkspace['workspace']): boolean {
  return current.name !== want.name || (current.iconKey ?? null) !== (want.iconKey ?? null) || current.lifecycleState !== want.lifecycleState;
}
