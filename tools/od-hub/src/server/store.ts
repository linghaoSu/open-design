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

export type DeviceAuthStatus = 'pending' | 'complete' | 'denied' | 'expired';

/**
 * One hub-side device authorization (PLAN §5.1). The CLI holds a hub-minted
 * device code; only its sha256 is stored (a database read-out cannot complete
 * a login in flight). GitLab's own device_code is sealed with the TokenCipher
 * under `keyId` and never leaves the server.
 */
export interface DeviceAuthRow {
  /** sha256 hex of the hub device code presented by the CLI. */
  deviceCodeHash: string;
  userCode: string;
  gitlabDeviceCodeEnc: Buffer;
  keyId: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalS: number;
  status: DeviceAuthStatus;
  userId: string | null;
  profile: string | null;
  createdAt: string;
  expiresAt: string;
  lastPolledAt: string | null;
}

/** Encrypted GitLab tokens for one user. Blobs are opaque to the store (see token-cipher.ts). */
export interface OAuthGrantRow {
  userId: string;
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer | null;
  keyId: string;
  accessExpiresAt: string | null;
  updatedAt: string;
}

export type OutboxTopic = 'workspace' | 'directory' | 'access';

export interface OutboxEventInput {
  /** Workspace the event is scoped to; null for account-only signals. */
  workspaceId: string | null;
  /** Target user for `directory` / `access` topics; null fans out to every stream of the workspace. */
  userId: string | null;
  topic: OutboxTopic;
  eventName: string;
  payload: Record<string, unknown>;
}

export interface OutboxRow extends OutboxEventInput {
  id: number;
  createdAt: string;
  publishedAt: string | null;
}

export interface AuditInput {
  actorUserId: string | null;
  workspaceId?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

export interface UpdateWorkspaceInput {
  name?: string;
  iconKey?: string | null;
  lifecycleState?: WorkspaceLifecycleState;
}

/**
 * One atomic unit of work: directory mirror writes plus the outbox rows and
 * digest bumps they imply. SQLite applies it inside a single transaction so
 * an event is never visible without its mutation (or vice versa).
 */
export interface StoreBatch {
  workspaces?: Array<{ create: CreateWorkspaceInput } | { update: { id: string } & UpdateWorkspaceInput }>;
  members?: UpsertMemberInput[];
  /** Removed membership rows past the retention window: hard-delete so the mirror does not grow unbounded. */
  memberDeletes?: Array<{ workspaceId: string; userId: string }>;
  outbox?: OutboxEventInput[];
  digestBumps?: Array<{ workspaceId: string; face: SyncDigestFace }>;
  audit?: AuditInput[];
}

export interface AuthenticateOptions {
  /**
   * Sliding expiry (PLAN §5.3): on success move `expiresAt` to `now + ttl`.
   * Omitted = fixed expiry semantics (seeded keys without TTL never expire).
   */
  slidingTtlMs?: number;
}

/**
 * Persistence boundary shared by the HTTP server, the dev seed, and the CLI
 * facing endpoints. Every implementation (memory, SQLite) must satisfy the
 * parity suite in `tests/store.test.ts`. Resources, comments, and invites
 * (PLAN §3.2) are declared in `migrations/` but not yet surfaced here.
 */
export interface HubStore {
  // ---- reads used by the server ----
  authenticate(bearerToken: string, now?: Date, options?: AuthenticateOptions): Promise<AuthenticatedPrincipal | null>;
  /** Every membership row of the user, including removed ones; callers apply retention. */
  listDirectory(userId: string): Promise<WorkspaceDirectoryItem[]>;
  listMemberships(userId: string): Promise<WorkspaceMemberRow[]>;
  getMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | null>;
  getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBillingRow>;
  getSyncDigest(workspaceId: string): Promise<SyncDigestRow>;

  // ---- identity ----
  createUser(input: CreateUserInput): Promise<UserRow>;
  /** Insert or refresh email/name/avatar/gitlabId for an existing id. */
  upsertUser(input: CreateUserInput): Promise<UserRow>;
  getUser(id: string): Promise<UserRow | null>;
  /**
   * Idempotent on the secret: issuing the same plaintext twice returns the
   * existing row (looked up by `keyHash`) instead of failing on the UNIQUE
   * constraint, so `--seed-dev` survives a restart against a persistent store.
   */
  issueApiKey(input: IssueApiKeyInput): Promise<{ apiKey: ApiKeyRow; secret: string }>;
  revokeApiKey(secret: string, now?: Date): Promise<void>;
  /** Revoke every live key of a user (GitLab refresh failure, admin action). Returns the count revoked. */
  revokeAllUserKeys(userId: string, now?: Date): Promise<number>;

  // ---- device flow + GitLab grants ----
  createDeviceAuth(row: DeviceAuthRow): Promise<DeviceAuthRow>;
  /** Lookup by the sha256 hex of the CLI's device code. */
  getDeviceAuth(deviceCodeHash: string): Promise<DeviceAuthRow | null>;
  updateDeviceAuth(
    deviceCodeHash: string,
    patch: Partial<Pick<DeviceAuthRow, 'status' | 'userId' | 'intervalS' | 'lastPolledAt'>>,
  ): Promise<DeviceAuthRow | null>;
  putOAuthGrant(row: OAuthGrantRow): Promise<void>;
  getOAuthGrant(userId: string): Promise<OAuthGrantRow | null>;
  deleteOAuthGrant(userId: string): Promise<void>;

  // ---- workspaces ----
  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRow>;
  updateWorkspace(id: string, patch: UpdateWorkspaceInput): Promise<WorkspaceRow | null>;
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  upsertMember(input: UpsertMemberInput): Promise<WorkspaceMemberRow>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]>;
  bumpSyncDigest(workspaceId: string, face: SyncDigestFace): Promise<SyncDigestRow>;

  // ---- outbox / audit ----
  /** Atomic mutation + outbox append. Returns the appended outbox rows (unpublished). */
  applyBatch(batch: StoreBatch): Promise<{ outbox: OutboxRow[] }>;
  listUnpublishedOutbox(limit?: number): Promise<OutboxRow[]>;
  markOutboxPublished(ids: number[], now?: Date): Promise<void>;
  appendAudit(entry: AuditInput): Promise<void>;
  close(): Promise<void>;
}
