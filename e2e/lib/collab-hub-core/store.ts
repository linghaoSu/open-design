// In-memory hub state.
//
// `HubStore` is the persistence seam a real self-hosted hub can implement on
// top of Postgres/Redis; `InMemoryHubStore` is the reference implementation the
// fake hub and the conformance suite run against. Command and HTTP handlers only
// talk to the interface, never to the maps below.

import type {
  AccountBilling,
  AddedWorkspace,
  ClientIdentity,
  CommentRecord,
  HubEvent,
  HubMemberRole,
  PresenceEntry,
  ResourceRecord,
  SyncDigest,
  TeamProjectRecord,
  WorkspaceBalance,
  WorkspaceBilling,
} from './types.ts';

export const DEFAULT_PRESENCE_TTL_MS = 30_000;

export type HubStore = {
  // --- identity / membership ------------------------------------------------
  identityForControlKey(controlKey: string): ClientIdentity | null;
  /** All accounts known to this hub (the roster of `options.clients`). */
  members(): readonly ClientIdentity[];
  hasMember(memberId: string): boolean;
  roleOf(memberId: string): HubMemberRole;
  setRole(memberId: string, role: HubMemberRole): void;
  isRemoved(memberId: string): boolean;
  markRemoved(memberId: string): void;

  // --- account-level workspace directory -----------------------------------
  addedWorkspaces(memberId: string): readonly AddedWorkspace[];
  addWorkspace(memberId: string, workspace: AddedWorkspace): void;

  // --- team projects ---------------------------------------------------------
  getProject(projectId: string): TeamProjectRecord | undefined;
  listProjects(workspaceId: string): TeamProjectRecord[];
  putProject(record: TeamProjectRecord): void;
  deleteProject(projectId: string): boolean;

  // --- resources -------------------------------------------------------------
  getResource(workspaceId: string, resourceId: string): ResourceRecord | undefined;
  listResources(workspaceId: string): ResourceRecord[];
  putResource(record: ResourceRecord): void;
  deleteResource(workspaceId: string, resourceId: string): ResourceRecord | undefined;

  // --- comments --------------------------------------------------------------
  comments(projectId: string): CommentRecord[];
  /** Upsert by `id`, assigning `seq = latest + 1`. Returns the assigned seq. */
  pushComment(projectId: string, comment: Record<string, unknown>): number;

  // --- presence --------------------------------------------------------------
  /** Live roster for a project after sweeping expired leases. */
  presence(projectId: string, now?: number): Map<string, PresenceEntry>;
  /**
   * Whether the most recent `presence(projectId, now)` sweep evicted at least
   * one lease. Consumed once: the flag resets on the next sweep.
   */
  sweptPresence(projectId: string, now?: number): boolean;
  setPresence(projectId: string, clientId: string, entry: PresenceEntry): void;
  deletePresence(projectId: string, clientId: string): boolean;
  /** Remove every lease held by `memberId` across all projects. */
  evictMemberPresence(memberId: string): string[];

  // --- billing ---------------------------------------------------------------
  accountBilling(memberId: string): AccountBilling;
  setAccountBilling(memberId: string, next: AccountBilling): void;
  workspaceBilling(workspaceId: string): WorkspaceBilling;
  setWorkspaceBilling(workspaceId: string, next: WorkspaceBilling): void;
  workspaceBalance(workspaceId: string, memberId: string): WorkspaceBalance;
  setWorkspaceBalance(workspaceId: string, memberId: string, next: WorkspaceBalance): void;

  // --- sync digest -----------------------------------------------------------
  /**
   * Advance the digest tokens implied by an emitted workspace event. The hub
   * calls this from its single emit path so control-plane mutations
   * (`setWorkspaceBalance`, `removeMember`, ...) and command-side mutations move
   * tokens through one rule instead of each mutation bumping its own counter.
   */
  noteEvent(event: HubEvent): void;
  syncDigest(workspaceId: string): SyncDigest;
};

type DigestCounters = { catalog: number; members: number; context: number; billing: number };

export type InMemoryHubStoreOptions = {
  workspaceId: string;
  clients: readonly ClientIdentity[];
  presenceTtlMs?: number;
  now?: () => number;
};

export class InMemoryHubStore implements HubStore {
  private readonly identities: Map<string, ClientIdentity>;
  private readonly clients: readonly ClientIdentity[];
  private readonly memberRoles: Map<string, HubMemberRole>;
  private readonly removedMembers = new Set<string>();
  private readonly added = new Map<string, Map<string, AddedWorkspace>>();
  private readonly projects = new Map<string, TeamProjectRecord>();
  private readonly resources = new Map<string, ResourceRecord>();
  private readonly commentsByProject = new Map<string, CommentRecord[]>();
  private readonly presenceByProject = new Map<string, Map<string, PresenceEntry>>();
  private readonly presenceSwept = new Set<string>();
  private readonly accountBillingByMember: Map<string, AccountBilling>;
  private readonly workspaceBillingById: Map<string, WorkspaceBilling>;
  private readonly balances: Map<string, WorkspaceBalance>;
  private readonly presenceTtlMs: number;
  private readonly now: () => number;
  // Digest counters, advanced by `noteEvent`. Tokens are opaque
  // `${eventCount}:${structuralCount}` strings; the daemon only compares them
  // for equality.
  private readonly digestCounters = new Map<string, DigestCounters>();

  constructor(options: InMemoryHubStoreOptions) {
    this.clients = options.clients;
    this.identities = new Map(options.clients.map((client) => [client.controlKey, client]));
    this.memberRoles = new Map(options.clients.map((client) => [client.memberId, client.role]));
    this.accountBillingByMember = new Map(options.clients.map((client) => [
      client.memberId,
      { membershipTier: 'team_plus', balanceUsd: '0.00', revision: 1 },
    ]));
    this.workspaceBillingById = new Map([[options.workspaceId, {
      billingState: 'active',
      planId: 'team_plus' as string | null,
      revision: 1,
    }]]);
    this.balances = new Map(options.clients.map((client) => [
      balanceKey(options.workspaceId, client.memberId),
      { balanceUsd: '0.00', revision: 1 },
    ]));
    this.presenceTtlMs = options.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  identityForControlKey(controlKey: string): ClientIdentity | null {
    const identity = this.identities.get(controlKey);
    if (!identity) return null;
    return { ...identity, role: this.roleOf(identity.memberId) };
  }

  members(): readonly ClientIdentity[] {
    return this.clients;
  }

  hasMember(memberId: string): boolean {
    return this.memberRoles.has(memberId);
  }

  roleOf(memberId: string): HubMemberRole {
    return this.memberRoles.get(memberId)
      ?? this.clients.find((client) => client.memberId === memberId)?.role
      ?? 'member';
  }

  setRole(memberId: string, role: HubMemberRole): void {
    this.memberRoles.set(memberId, role);
  }

  isRemoved(memberId: string): boolean {
    return this.removedMembers.has(memberId);
  }

  markRemoved(memberId: string): void {
    this.removedMembers.add(memberId);
  }

  addedWorkspaces(memberId: string): readonly AddedWorkspace[] {
    return [...(this.added.get(memberId)?.values() ?? [])];
  }

  addWorkspace(memberId: string, workspace: AddedWorkspace): void {
    const memberships = this.added.get(memberId) ?? new Map<string, AddedWorkspace>();
    memberships.set(workspace.workspaceId, workspace);
    this.added.set(memberId, memberships);
  }

  getProject(projectId: string): TeamProjectRecord | undefined {
    return this.projects.get(projectId);
  }

  listProjects(workspaceId: string): TeamProjectRecord[] {
    return [...this.projects.values()].filter((project) => project.workspaceId === workspaceId);
  }

  putProject(record: TeamProjectRecord): void {
    this.projects.set(record.projectId, record);
  }

  deleteProject(projectId: string): boolean {
    return this.projects.delete(projectId);
  }

  getResource(workspaceId: string, resourceId: string): ResourceRecord | undefined {
    return this.resources.get(resourceKey(workspaceId, resourceId));
  }

  listResources(workspaceId: string): ResourceRecord[] {
    return [...this.resources.values()].filter((resource) => resource.workspaceId === workspaceId);
  }

  putResource(record: ResourceRecord): void {
    this.resources.set(resourceKey(record.workspaceId, record.resourceId), record);
  }

  deleteResource(workspaceId: string, resourceId: string): ResourceRecord | undefined {
    const key = resourceKey(workspaceId, resourceId);
    const previous = this.resources.get(key);
    this.resources.delete(key);
    return previous;
  }

  comments(projectId: string): CommentRecord[] {
    return this.commentsByProject.get(projectId) ?? [];
  }

  pushComment(projectId: string, comment: Record<string, unknown>): number {
    const list = this.commentsByProject.get(projectId) ?? [];
    const seq = latestSeq(list) + 1;
    const next: CommentRecord = { ...comment, projectId, seq };
    const existingIndex = list.findIndex((entry) => entry.id === next.id);
    if (existingIndex >= 0) list[existingIndex] = next;
    else list.push(next);
    this.commentsByProject.set(projectId, list);
    return seq;
  }

  presence(projectId: string, now = this.now()): Map<string, PresenceEntry> {
    const roster = this.presenceByProject.get(projectId) ?? new Map<string, PresenceEntry>();
    this.presenceByProject.set(projectId, roster);
    if (this.presenceTtlMs > 0) {
      const cutoff = now - this.presenceTtlMs;
      let swept = false;
      for (const [clientId, entry] of roster) {
        const at = Date.parse(entry.heartbeatAt);
        if (Number.isFinite(at) && at < cutoff) {
          roster.delete(clientId);
          swept = true;
        }
      }
      if (swept) this.presenceSwept.add(projectId);
    }
    return roster;
  }

  sweptPresence(projectId: string, now = this.now()): boolean {
    this.presence(projectId, now);
    return this.presenceSwept.delete(projectId);
  }

  setPresence(projectId: string, clientId: string, entry: PresenceEntry): void {
    this.presence(projectId).set(clientId, entry);
  }

  deletePresence(projectId: string, clientId: string): boolean {
    return this.presence(projectId).delete(clientId);
  }

  evictMemberPresence(memberId: string): string[] {
    const touched: string[] = [];
    for (const [projectId, roster] of this.presenceByProject) {
      for (const [clientId, entry] of roster) {
        if (entry.memberId === memberId) {
          roster.delete(clientId);
          if (!touched.includes(projectId)) touched.push(projectId);
        }
      }
    }
    return touched;
  }

  accountBilling(memberId: string): AccountBilling {
    return this.accountBillingByMember.get(memberId)
      ?? { membershipTier: 'team_plus', balanceUsd: '0.00', revision: 0 };
  }

  setAccountBilling(memberId: string, next: AccountBilling): void {
    this.accountBillingByMember.set(memberId, next);
  }

  workspaceBilling(workspaceId: string): WorkspaceBilling {
    return this.workspaceBillingById.get(workspaceId)
      ?? { billingState: 'free', planId: null, revision: 0 };
  }

  setWorkspaceBilling(workspaceId: string, next: WorkspaceBilling): void {
    this.workspaceBillingById.set(workspaceId, next);
  }

  workspaceBalance(workspaceId: string, memberId: string): WorkspaceBalance {
    return this.balances.get(balanceKey(workspaceId, memberId))
      ?? { balanceUsd: '0.00', revision: 0 };
  }

  setWorkspaceBalance(workspaceId: string, memberId: string, next: WorkspaceBalance): void {
    this.balances.set(balanceKey(workspaceId, memberId), next);
  }

  noteEvent(event: HubEvent): void {
    const counters = this.countersFor(event.workspaceId);
    switch (event.type) {
      case 'team-projects-changed':
      case 'project-metadata-changed':
      case 'project-content-changed':
      case 'team-resources-changed':
        counters.catalog += 1;
        break;
      case 'workspace-members-changed':
        counters.members += 1;
        break;
      case 'workspace-context-changed':
        counters.members += 1;
        counters.context += 1;
        break;
      case 'billing-changed':
      case 'billing-subscription-changed':
      case 'wallet-balance-changed':
        counters.billing += 1;
        break;
      default:
        break;
    }
  }

  syncDigest(workspaceId: string): SyncDigest {
    const counters = this.countersFor(workspaceId);
    // Structural counts ride along so a mutation that produced no event (for
    // example `resource remove` of a project-kind resource) still moves the
    // token the daemon compares.
    const projects = this.listProjects(workspaceId).length;
    const resources = this.listResources(workspaceId).length;
    const activeMembers = this.clients.filter((c) => !this.removedMembers.has(c.memberId)).length;
    const billing = this.workspaceBillingById.get(workspaceId);
    return {
      catalogToken: `${counters.catalog}:${projects + resources}`,
      membersToken: `${counters.members}:${activeMembers}`,
      contextToken: `${counters.context}`,
      billingToken: `${counters.billing}:${billing?.revision ?? 0}`,
    };
  }

  private countersFor(workspaceId: string): DigestCounters {
    const existing = this.digestCounters.get(workspaceId);
    if (existing) return existing;
    const created: DigestCounters = { catalog: 0, members: 0, context: 0, billing: 0 };
    this.digestCounters.set(workspaceId, created);
    return created;
  }
}

export function latestSeq(comments: readonly CommentRecord[]): number {
  return comments.reduce(
    (latest, comment) => (typeof comment.seq === 'number' ? Math.max(latest, comment.seq) : latest),
    0,
  );
}

function balanceKey(workspaceId: string, memberId: string): string {
  return `${workspaceId}\0${memberId}`;
}

function resourceKey(workspaceId: string, resourceId: string): string {
  return `${workspaceId}\0${resourceId}`;
}
