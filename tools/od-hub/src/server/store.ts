/**
 * Storage model for od-hub. Mirrors PLAN §3.2 (Postgres schema) as TypeScript
 * rows so that an in-memory store and a SQL store expose the same shape.
 * Column names are camelCased; `migrations/0001_init.sql` (tool root) is the SQL twin.
 */

export type ApiKeyKind = 'control' | 'runtime';
export type WorkspaceKind = 'personal' | 'team';
export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type WorkspaceMemberStatus = 'active' | 'removed';
export type WorkspaceLifecycleState = 'active' | 'locked' | 'deleting' | 'deleted';

export interface UserRow {
  id: string;
  gitlabId: number | null;
  email: string;
  name: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiKeyRow {
  id: string;
  /** sha256 hex of the presented bearer token. */
  keyHash: string;
  userId: string;
  kind: ApiKeyKind;
  profile: string | null;
  deviceLabel: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface WorkspaceRow {
  id: string;
  gitlabKind: WorkspaceKind;
  gitlabId: number | null;
  name: string;
  iconKey: string | null;
  lifecycleState: WorkspaceLifecycleState;
  updatedAt: string;
}

export interface WorkspaceMemberRow {
  workspaceId: string;
  userId: string;
  /** Stable (user x workspace) id; the same value must appear in the directory and in billing snapshots. */
  memberId: string;
  role: WorkspaceRole;
  memberStatus: WorkspaceMemberStatus;
  displayName: string | null;
  avatarUrl: string | null;
  seenAt: string | null;
  removedAt: string | null;
  updatedAt: string;
}

export interface WorkspaceBillingRow {
  workspaceId: string;
  billingState: string;
  planId: string;
  balanceUsd: string;
  revisionBilling: string;
  revisionWallet: string;
}

export interface SyncDigestRow {
  workspaceId: string;
  catalogToken: string;
  membersToken: string;
  contextToken: string;
  billingToken: string;
}

/** Directory row as returned by GET /api/v1/workspaces (contracts WorkspaceDirectoryItem). */
export interface WorkspaceDirectoryItem {
  workspaceId: string;
  workspaceName: string;
  workspaceIconKey?: string;
  workspaceType: WorkspaceKind;
  workspaceMemberId: string;
  role: WorkspaceRole;
  memberStatus: WorkspaceMemberStatus;
  lifecycleState: WorkspaceLifecycleState;
}

export interface AuthenticatedPrincipal {
  user: UserRow;
  apiKey: ApiKeyRow;
}

export interface CreateUserInput {
  id: string;
  email: string;
  name: string;
  gitlabId?: number | null;
  avatarUrl?: string | null;
}

export interface IssueApiKeyInput {
  userId: string;
  kind: ApiKeyKind;
  /** Plaintext secret to hash. When omitted a fresh `odc_`/`odr_` secret is minted. */
  secret?: string;
  profile?: string | null;
  deviceLabel?: string | null;
  expiresAt?: string | null;
}

export interface CreateWorkspaceInput {
  id: string;
  name: string;
  kind: WorkspaceKind;
  gitlabId?: number | null;
  iconKey?: string | null;
  lifecycleState?: WorkspaceLifecycleState;
}

export interface UpsertMemberInput {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  memberStatus?: WorkspaceMemberStatus;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export type SyncDigestFace = Exclude<keyof SyncDigestRow, 'workspaceId'>;

/**
 * Persistence boundary shared by the HTTP server, the dev seed, and the CLI
 * facing endpoints. Every implementation (memory, SQLite) must satisfy the
 * parity suite in `tests/store.test.ts`. Everything else in PLAN §3.2
 * (resources, comments, invites, outbox) is declared in `migrations/` but not
 * yet surfaced here.
 */
export interface HubStore {
  // ---- reads used by the server ----
  authenticate(bearerToken: string, now?: Date): Promise<AuthenticatedPrincipal | null>;
  listDirectory(userId: string): Promise<WorkspaceDirectoryItem[]>;
  getMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | null>;
  getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBillingRow>;
  getSyncDigest(workspaceId: string): Promise<SyncDigestRow>;

  // ---- writes used by seeding and later milestones ----
  createUser(input: CreateUserInput): Promise<UserRow>;
  getUser(id: string): Promise<UserRow | null>;
  /**
   * Idempotent on the secret: issuing the same plaintext twice returns the
   * existing row (looked up by `keyHash`) instead of failing on the UNIQUE
   * constraint, so `--seed-dev` survives a restart against a persistent store.
   */
  issueApiKey(input: IssueApiKeyInput): Promise<{ apiKey: ApiKeyRow; secret: string }>;
  revokeApiKey(secret: string, now?: Date): Promise<void>;
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRow>;
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  upsertMember(input: UpsertMemberInput): Promise<WorkspaceMemberRow>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]>;
  bumpSyncDigest(workspaceId: string, face: SyncDigestFace): Promise<SyncDigestRow>;
  close(): Promise<void>;
}
