import { apiKeyIdFromHash, deriveMemberId, hashApiKey, mintApiKeySecret, newDigestToken } from './ids.js';
import type {
  ApiKeyRow,
  AuditInput,
  AuthenticateOptions,
  AuthenticatedPrincipal,
  CreateUserInput,
  CreateWorkspaceInput,
  DeviceAuthRow,
  HubStore,
  IssueApiKeyInput,
  OAuthGrantRow,
  OutboxEventInput,
  OutboxRow,
  StoreBatch,
  SyncDigestFace,
  SyncDigestRow,
  UpdateWorkspaceInput,
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

/** Shared sliding-expiry rule so memory and SQLite agree byte-for-byte. */
export function slideExpiry(now: Date, options: AuthenticateOptions | undefined): string | undefined {
  if (!options?.slidingTtlMs) return undefined;
  return new Date(now.getTime() + options.slidingTtlMs).toISOString();
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
  private readonly deviceAuths = new Map<string, DeviceAuthRow>();
  private readonly grants = new Map<string, OAuthGrantRow>();
  private readonly outbox: OutboxRow[] = [];
  readonly audit: Array<AuditInput & { at: string }> = [];
  private outboxSeq = 0;
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
    const previous = this.users.get(input.id);
    const user: UserRow = {
      id: input.id,
      gitlabId: input.gitlabId ?? previous?.gitlabId ?? null,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl === undefined ? (previous?.avatarUrl ?? null) : input.avatarUrl,
      createdAt: previous?.createdAt ?? at,
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

  private patchWorkspace(id: string, patch: UpdateWorkspaceInput): WorkspaceRow | null {
    const row = this.workspaces.get(id);
    if (!row) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.iconKey !== undefined) row.iconKey = patch.iconKey;
    if (patch.lifecycleState !== undefined) row.lifecycleState = patch.lifecycleState;
    row.updatedAt = this.now().toISOString();
    return row;
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
      // Keep the first removal timestamp so retention counts from when GitLab dropped the member.
      removedAt: status === 'removed' ? (previous?.memberStatus === 'removed' ? previous.removedAt : at) : null,
      updatedAt: at,
    };
    this.members.set(key, row);
    return row;
  }

  private pushOutbox(input: OutboxEventInput): OutboxRow {
    this.outboxSeq += 1;
    const row: OutboxRow = { ...input, id: this.outboxSeq, createdAt: this.now().toISOString(), publishedAt: null };
    this.outbox.push(row);
    return row;
  }

  private bumpDigestSync(workspaceId: string, face: SyncDigestFace): SyncDigestRow {
    const digest = { ...this.digestSync(workspaceId), [face]: newDigestToken() };
    this.digests.set(workspaceId, digest);
    return { ...digest };
  }

  private digestSync(workspaceId: string): SyncDigestRow {
    let digest = this.digests.get(workspaceId);
    if (!digest) {
      digest = freshSyncDigest(workspaceId);
      this.digests.set(workspaceId, digest);
    }
    return digest;
  }

  // ---- HubStore reads -----------------------------------------------------------

  async authenticate(
    bearerToken: string,
    now: Date = this.now(),
    options?: AuthenticateOptions,
  ): Promise<AuthenticatedPrincipal | null> {
    const token = bearerToken.trim();
    if (!token) return null;
    const apiKey = this.apiKeys.get(hashApiKey(token));
    if (!apiKey || apiKey.revokedAt) return null;
    if (apiKey.expiresAt && Date.parse(apiKey.expiresAt) <= now.getTime()) return null;
    const user = this.users.get(apiKey.userId);
    if (!user) return null;
    apiKey.lastSeenAt = now.toISOString();
    const slid = slideExpiry(now, options);
    if (slid && apiKey.expiresAt) apiKey.expiresAt = slid;
    return { user, apiKey: { ...apiKey } };
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

  async listMemberships(userId: string): Promise<WorkspaceMemberRow[]> {
    return [...this.members.values()].filter((m) => m.userId === userId).map((m) => ({ ...m }));
  }

  async getMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | null> {
    const row = this.members.get(`${workspaceId}:${userId}`);
    return row ? { ...row } : null;
  }

  async getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBillingRow> {
    return this.billing.get(workspaceId) ?? { workspaceId, ...DEFAULT_BILLING };
  }

  async getSyncDigest(workspaceId: string): Promise<SyncDigestRow> {
    return { ...this.digestSync(workspaceId) };
  }

  // ---- identity -------------------------------------------------------------------

  async createUser(input: CreateUserInput): Promise<UserRow> {
    if (this.users.has(input.id)) throw new Error(`user ${input.id} already exists`);
    return { ...this.putUser(input) };
  }

  async upsertUser(input: CreateUserInput): Promise<UserRow> {
    return { ...this.putUser(input) };
  }

  async getUser(id: string): Promise<UserRow | null> {
    const row = this.users.get(id);
    return row ? { ...row } : null;
  }

  async issueApiKey(input: IssueApiKeyInput): Promise<{ apiKey: ApiKeyRow; secret: string }> {
    const { apiKey, secret } = this.putApiKey(input);
    return { apiKey: { ...apiKey }, secret };
  }

  async revokeApiKey(secret: string, now: Date = this.now()): Promise<void> {
    const row = this.apiKeys.get(hashApiKey(secret));
    if (row && !row.revokedAt) row.revokedAt = now.toISOString();
  }

  async revokeAllUserKeys(userId: string, now: Date = this.now()): Promise<number> {
    let count = 0;
    for (const row of this.apiKeys.values()) {
      if (row.userId === userId && !row.revokedAt) {
        row.revokedAt = now.toISOString();
        count += 1;
      }
    }
    return count;
  }

  // ---- device flow + grants ------------------------------------------------------

  async createDeviceAuth(row: DeviceAuthRow): Promise<DeviceAuthRow> {
    this.deviceAuths.set(row.deviceCodeHash, { ...row });
    return { ...row };
  }

  async getDeviceAuth(deviceCodeHash: string): Promise<DeviceAuthRow | null> {
    const row = this.deviceAuths.get(deviceCodeHash);
    return row ? { ...row } : null;
  }

  async updateDeviceAuth(
    deviceCodeHash: string,
    patch: Partial<Pick<DeviceAuthRow, 'status' | 'userId' | 'intervalS' | 'lastPolledAt'>>,
  ): Promise<DeviceAuthRow | null> {
    const row = this.deviceAuths.get(deviceCodeHash);
    if (!row) return null;
    Object.assign(row, patch);
    return { ...row };
  }

  async putOAuthGrant(row: OAuthGrantRow): Promise<void> {
    this.grants.set(row.userId, { ...row });
  }

  async getOAuthGrant(userId: string): Promise<OAuthGrantRow | null> {
    const row = this.grants.get(userId);
    return row ? { ...row } : null;
  }

  async deleteOAuthGrant(userId: string): Promise<void> {
    this.grants.delete(userId);
  }

  // ---- workspaces -----------------------------------------------------------------

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    if (this.workspaces.has(input.id)) throw new Error(`workspace ${input.id} already exists`);
    return { ...this.putWorkspace(input) };
  }

  async updateWorkspace(id: string, patch: UpdateWorkspaceInput): Promise<WorkspaceRow | null> {
    const row = this.patchWorkspace(id, patch);
    return row ? { ...row } : null;
  }

  async getWorkspace(id: string): Promise<WorkspaceRow | null> {
    const row = this.workspaces.get(id);
    return row ? { ...row } : null;
  }

  async upsertMember(input: UpsertMemberInput): Promise<WorkspaceMemberRow> {
    return { ...this.putMember(input) };
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
    return [...this.members.values()].filter((m) => m.workspaceId === workspaceId).map((m) => ({ ...m }));
  }

  async bumpSyncDigest(workspaceId: string, face: SyncDigestFace): Promise<SyncDigestRow> {
    return this.bumpDigestSync(workspaceId, face);
  }

  // ---- outbox / audit -------------------------------------------------------------

  async applyBatch(batch: StoreBatch): Promise<{ outbox: OutboxRow[] }> {
    // Validate first so a failing batch leaves no partial state (the SQLite twin uses a transaction).
    for (const op of batch.workspaces ?? []) {
      if ('create' in op && this.workspaces.has(op.create.id)) throw new Error(`workspace ${op.create.id} already exists`);
    }
    for (const op of batch.workspaces ?? []) {
      if ('create' in op) this.putWorkspace(op.create);
      else this.patchWorkspace(op.update.id, op.update);
    }
    for (const member of batch.members ?? []) this.putMember(member);
    for (const { workspaceId, userId } of batch.memberDeletes ?? []) this.members.delete(`${workspaceId}:${userId}`);
    for (const bump of batch.digestBumps ?? []) this.bumpDigestSync(bump.workspaceId, bump.face);
    for (const entry of batch.audit ?? []) this.audit.push({ ...entry, at: this.now().toISOString() });
    const outbox = (batch.outbox ?? []).map((event) => ({ ...this.pushOutbox(event) }));
    return { outbox };
  }

  async listUnpublishedOutbox(limit = 500): Promise<OutboxRow[]> {
    return this.outbox.filter((row) => !row.publishedAt).slice(0, limit).map((row) => ({ ...row }));
  }

  async markOutboxPublished(ids: number[], now: Date = this.now()): Promise<void> {
    const set = new Set(ids);
    for (const row of this.outbox) if (set.has(row.id) && !row.publishedAt) row.publishedAt = now.toISOString();
  }

  async appendAudit(entry: AuditInput): Promise<void> {
    this.audit.push({ ...entry, at: this.now().toISOString() });
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
