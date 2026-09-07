import { apiKeyIdFromHash, deriveMemberId, hashApiKey, mintApiKeySecret, newDigestToken } from './ids.js';
import type {
  ApiKeyRow,
  AuthenticatedPrincipal,
  CreateUserInput,
  CreateWorkspaceInput,
  HubStore,
  IssueApiKeyInput,
  SyncDigestFace,
  SyncDigestRow,
  UpsertMemberInput,
  UserRow,
  WorkspaceBillingRow,
  WorkspaceDirectoryItem,
  WorkspaceKind,
  WorkspaceMemberRow,
  WorkspaceRole,
  WorkspaceRow,
} from './store.js';

export { deriveMemberId, hashApiKey } from './ids.js';

export const DEFAULT_BILLING: Omit<WorkspaceBillingRow, 'workspaceId'> = {
  billingState: 'active',
  planId: 'team_plus',
  balanceUsd: '999999',
  revisionBilling: '1',
  revisionWallet: '1',
};

/** Initial digest for a workspace nobody has written to yet. */
export function freshSyncDigest(workspaceId: string): SyncDigestRow {
  return {
    workspaceId,
    catalogToken: newDigestToken(),
    membersToken: newDigestToken(),
    contextToken: newDigestToken(),
    // Empty is allowed by the daemon (no subscription row).
    billingToken: '',
  };
}

/** Sort: personal first, then by name — deterministic for tests and UI. */
export function sortDirectory(items: WorkspaceDirectoryItem[]): WorkspaceDirectoryItem[] {
  return items.sort((a, b) =>
    a.workspaceType === b.workspaceType
      ? a.workspaceName.localeCompare(b.workspaceName)
      : a.workspaceType === 'personal' ? -1 : 1,
  );
}

export function toDirectoryItem(workspace: WorkspaceRow, member: WorkspaceMemberRow): WorkspaceDirectoryItem {
  const item: WorkspaceDirectoryItem = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceType: workspace.gitlabKind,
    workspaceMemberId: member.memberId,
    role: member.role,
    memberStatus: member.memberStatus,
    lifecycleState: workspace.lifecycleState,
  };
  if (workspace.iconKey) item.workspaceIconKey = workspace.iconKey;
  return item;
}

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  /** Plain-text control key; only its hash is stored. */
  controlKey: string;
  avatarUrl?: string;
  profile?: string;
}

export interface SeedWorkspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  iconKey?: string;
  members: Array<{ userId: string; role: WorkspaceRole; displayName?: string }>;
}

export interface MemoryHubStoreSeed {
  users?: SeedUser[];
  workspaces?: SeedWorkspace[];
}

/**
 * In-memory HubStore. State lives for the process lifetime; suitable for tests
 * and for pointing a dev daemon at a hub with a handful of seeded accounts.
 */
export class MemoryHubStore implements HubStore {
  private readonly users = new Map<string, UserRow>();
  private readonly apiKeys = new Map<string, ApiKeyRow>(); // keyHash -> row
  private readonly workspaces = new Map<string, WorkspaceRow>();
  private readonly members = new Map<string, WorkspaceMemberRow>(); // `${ws}:${user}`
  private readonly billing = new Map<string, WorkspaceBillingRow>();
  private readonly digests = new Map<string, SyncDigestRow>();
  private readonly now: () => Date;

  constructor(seed: MemoryHubStoreSeed = {}, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    for (const user of seed.users ?? []) this.addUser(user);
    for (const workspace of seed.workspaces ?? []) this.addWorkspace(workspace);
  }

  // ---- synchronous seed helpers ------------------------------------------------

  addUser(seed: SeedUser): UserRow {
    const user = this.putUser({ id: seed.id, email: seed.email, name: seed.name, avatarUrl: seed.avatarUrl ?? null });
    this.putApiKey({ userId: user.id, kind: 'control', secret: seed.controlKey, profile: seed.profile ?? null });
    return user;
  }

  addWorkspace(seed: SeedWorkspace): WorkspaceRow {
    const workspace = this.putWorkspace({ id: seed.id, name: seed.name, kind: seed.kind, iconKey: seed.iconKey ?? null });
    for (const member of seed.members) {
      this.putMember({
        workspaceId: workspace.id,
        userId: member.userId,
        role: member.role,
        displayName: member.displayName ?? this.users.get(member.userId)?.name ?? null,
      });
    }
    return workspace;
  }

  revokeKey(controlKey: string): void {
    const row = this.apiKeys.get(hashApiKey(controlKey));
    if (row) row.revokedAt = this.now().toISOString();
  }

  removeMember(userId: string, workspaceId: string): void {
    const row = this.members.get(`${workspaceId}:${userId}`);
    if (!row) return;
    this.putMember({ workspaceId, userId, role: row.role, memberStatus: 'removed' });
  }

  private putUser(input: CreateUserInput): UserRow {
    const at = this.now().toISOString();
    const user: UserRow = {
      id: input.id,
      gitlabId: input.gitlabId ?? null,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl ?? null,
      createdAt: at,
      updatedAt: at,
    };
    this.users.set(user.id, user);
    return user;
  }

  private putApiKey(input: IssueApiKeyInput): { apiKey: ApiKeyRow; secret: string } {
    const secret = input.secret ?? mintApiKeySecret(input.kind);
    const keyHash = hashApiKey(secret);
    const existing = this.apiKeys.get(keyHash);
    if (existing) return { apiKey: existing, secret };
    const apiKey: ApiKeyRow = {
      id: apiKeyIdFromHash(keyHash),
      keyHash,
      userId: input.userId,
      kind: input.kind,
      profile: input.profile ?? null,
      deviceLabel: input.deviceLabel ?? null,
      createdAt: this.now().toISOString(),
      lastSeenAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
    };
    this.apiKeys.set(keyHash, apiKey);
    return { apiKey, secret };
  }

  private putWorkspace(input: CreateWorkspaceInput): WorkspaceRow {
    const workspace: WorkspaceRow = {
      id: input.id,
      gitlabKind: input.kind,
      gitlabId: input.gitlabId ?? null,
      name: input.name,
      iconKey: input.iconKey ?? null,
      lifecycleState: input.lifecycleState ?? 'active',
      updatedAt: this.now().toISOString(),
    };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  private putMember(input: UpsertMemberInput): WorkspaceMemberRow {
    const at = this.now().toISOString();
    const key = `${input.workspaceId}:${input.userId}`;
    const previous = this.members.get(key);
    const status = input.memberStatus ?? 'active';
    const row: WorkspaceMemberRow = {
      workspaceId: input.workspaceId,
      userId: input.userId,
      memberId: deriveMemberId(input.userId, input.workspaceId),
      role: input.role,
      memberStatus: status,
      displayName: input.displayName ?? previous?.displayName ?? null,
      avatarUrl: input.avatarUrl ?? previous?.avatarUrl ?? null,
      seenAt: at,
      removedAt: status === 'removed' ? at : null,
      updatedAt: at,
    };
    this.members.set(key, row);
    return row;
  }

  // ---- HubStore reads -----------------------------------------------------------

  async authenticate(bearerToken: string, now: Date = this.now()): Promise<AuthenticatedPrincipal | null> {
    const token = bearerToken.trim();
    if (!token) return null;
    const apiKey = this.apiKeys.get(hashApiKey(token));
    if (!apiKey || apiKey.revokedAt) return null;
    if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= now.getTime()) return null;
    const user = this.users.get(apiKey.userId);
    if (!user) return null;
    apiKey.lastSeenAt = now.toISOString();
    return { user, apiKey };
  }

  async listDirectory(userId: string): Promise<WorkspaceDirectoryItem[]> {
    const items: WorkspaceDirectoryItem[] = [];
    for (const member of this.members.values()) {
      if (member.userId !== userId) continue;
      const workspace = this.workspaces.get(member.workspaceId);
      if (!workspace) continue;
      items.push(toDirectoryItem(workspace, member));
    }
    return sortDirectory(items);
  }

  async getMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | null> {
    return this.members.get(`${workspaceId}:${userId}`) ?? null;
  }

  async getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBillingRow> {
    return this.billing.get(workspaceId) ?? { workspaceId, ...DEFAULT_BILLING };
  }

  async getSyncDigest(workspaceId: string): Promise<SyncDigestRow> {
    let digest = this.digests.get(workspaceId);
    if (!digest) {
      digest = freshSyncDigest(workspaceId);
      this.digests.set(workspaceId, digest);
    }
    return { ...digest };
  }

  // ---- HubStore writes ----------------------------------------------------------

  async createUser(input: CreateUserInput): Promise<UserRow> {
    return this.putUser(input);
  }

  async getUser(id: string): Promise<UserRow | null> {
    return this.users.get(id) ?? null;
  }

  async issueApiKey(input: IssueApiKeyInput): Promise<{ apiKey: ApiKeyRow; secret: string }> {
    return this.putApiKey(input);
  }

  async revokeApiKey(secret: string, now: Date = this.now()): Promise<void> {
    const row = this.apiKeys.get(hashApiKey(secret));
    if (row && !row.revokedAt) row.revokedAt = now.toISOString();
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    return this.putWorkspace(input);
  }

  async getWorkspace(id: string): Promise<WorkspaceRow | null> {
    return this.workspaces.get(id) ?? null;
  }

  async upsertMember(input: UpsertMemberInput): Promise<WorkspaceMemberRow> {
    return this.putMember(input);
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
    return [...this.members.values()].filter((m) => m.workspaceId === workspaceId);
  }

  async bumpSyncDigest(workspaceId: string, face: SyncDigestFace): Promise<SyncDigestRow> {
    const digest = { ...(await this.getSyncDigest(workspaceId)), [face]: newDigestToken() };
    this.digests.set(workspaceId, digest);
    return { ...digest };
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
