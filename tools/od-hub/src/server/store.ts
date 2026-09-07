/**
 * Storage model for od-hub. Mirrors PLAN §3.2 (Postgres schema) as TypeScript
 * rows so that an in-memory store and a SQL store expose the same shape.
 * Column names are camelCased; `migrations/0001_init.sql` (tool root) is the SQL twin.
 */

import type { ManifestEntry, ResourceKind } from '../shared/manifest.js';

export type { ManifestEntry, ResourceKind };

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
  /** memberId of the actor inside `workspaceId` when the action is workspace-scoped. */
  actorMemberId?: string | null;
  workspaceId?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  details?: Record<string, unknown> | null;
}

export interface AuditRow extends AuditInput {
  /** Monotonic insertion id; the export cursor is `id`-based so paging is stable under concurrent appends. */
  id: number;
  at: string;
}

/** Filter for the admin audit export (`GET /api/v1/admin/audit`). */
export interface AuditQuery {
  /** ISO timestamp; rows with `at >= since` only. */
  since?: string | null;
  actorUserId?: string | null;
  action?: string | null;
  /** Visibility: rows in any of these workspaces OR authored by `ownActorUserId`. */
  workspaceIds: string[];
  ownActorUserId: string;
  /** Rows with `id > afterId` only (cursor). */
  afterId?: number | null;
  limit: number;
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

// ---- resources / versions / catalog / receipts (PLAN §3.2, §3.4) ----------------

export interface ResourceRow {
  workspaceId: string;
  resourceId: string;
  kind: ResourceKind;
  /** memberId of the first publisher; fixed for the resource lifetime. */
  ownerMemberId: string;
  metadata: Record<string, unknown> | null;
  /** 0 until the first publish. */
  publishedVersion: number;
  publishedVersionId: string | null;
  manifestDigest: string | null;
  manifestEntryCount: number | null;
  createdAt: string;
  updatedAt: string;
  /** Tombstone: once set, every resource-scoped call answers 404 resource_not_found. */
  deletedAt: string | null;
}

export interface ResourceVersionRow {
  workspaceId: string;
  resourceId: string;
  version: number;
  versionId: string;
  manifest: ManifestEntry[];
  manifestDigest: string;
  entryCount: number;
  createdByMemberId: string;
  createdAt: string;
}

export type TeamProjectSyncState = 'pending_upload' | 'syncing' | 'synced' | 'failed';

export interface TeamProjectRow {
  id: string;
  workspaceId: string;
  projectId: string;
  resourceId: string;
  /** memberId of the first upserter; later upserts never change it. */
  ownerMemberId: string;
  displayName: string | null;
  syncState: TeamProjectSyncState;
  lastSyncedVersionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullReceiptRow {
  nonce: string;
  workspaceId: string;
  projectId: string;
  resourceId: string;
  viewerMemberId: string;
  ownerMemberId: string;
  version: number;
  versionId: string;
  manifestDigest: string;
  authorizedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

/** Outbox rows, digest bumps, and audit entries committed together with a resource mutation. */
export type SideEffects = Pick<StoreBatch, 'outbox' | 'digestBumps' | 'audit'>;

export interface PublishVersionInput {
  workspaceId: string;
  resourceId: string;
  kind: ResourceKind;
  /** Already normalized (sorted, validated) — see shared/manifest.ts. */
  manifest: ManifestEntry[];
  manifestDigest: string;
  /** CAS guard: when a number, the publish is rejected unless it equals the current published version. */
  expectedVersion: number | null;
  /** Replaces the resource metadata when provided; `undefined` keeps the stored value. */
  metadata?: Record<string, unknown> | null;
  actorMemberId: string;
}

export type PublishVersionResult =
  | { kind: 'published'; resource: ResourceRow; version: ResourceVersionRow; created: boolean; teamProjects: TeamProjectRow[] }
  | { kind: 'conflict'; publishedVersion: number }
  | { kind: 'not_found' }
  | { kind: 'kind_conflict'; storedKind: ResourceKind }
  | { kind: 'forbidden'; ownerMemberId: string };

export interface PublishVersionOptions {
  /** True when the actor may publish over a resource somebody else owns (workspace owner/admin). */
  actorCanManageAll: boolean;
}

export type TombstoneResult =
  | { kind: 'removed'; resource: ResourceRow }
  | { kind: 'already_removed' | 'not_found' }
  | { kind: 'forbidden'; ownerMemberId: string };

export interface UpsertTeamProjectInput {
  workspaceId: string;
  projectId: string;
  resourceId: string;
  displayName?: string | null;
  syncState?: TeamProjectSyncState;
  lastSyncedVersionId?: string | null;
  metadata?: Record<string, unknown> | null;
  actorMemberId: string;
}

export type UpsertTeamProjectResult =
  | { kind: 'upserted'; row: TeamProjectRow; created: boolean }
  | { kind: 'forbidden'; ownerMemberId: string };

export type RemoveTeamProjectResult =
  | { kind: 'removed'; row: TeamProjectRow }
  | { kind: 'not_found' }
  | { kind: 'forbidden'; ownerMemberId: string };

// ---- comments (PLAN §3.2 comments / comment_seq) ---------------------------------

export interface CommentRow {
  workspaceId: string;
  projectId: string;
  id: string;
  /** Monotonic within (workspace, project); reassigned on every accepted write of the id. */
  seq: number;
  /** Stored payload with projectId/seq/memberId/updatedAt/deleted rewritten to the authoritative values. */
  body: Record<string, unknown>;
  deleted: boolean;
  authorMemberId: string;
  /** Epoch ms, already clamped to `server now + 5000`. */
  updatedAt: number;
  serverReceivedAt: string;
}

export interface PushCommentInput {
  workspaceId: string;
  projectId: string;
  comment: Record<string, unknown>;
  authorMemberId: string;
}

export type PushCommentResult =
  | { kind: 'stored'; row: CommentRow; created: boolean }
  /** A tombstone already holds the id; nothing was written and no seq consumed. */
  | { kind: 'tombstoned'; row: CommentRow };

// ---- invites / continuations (PLAN §3.2 invites, invite_continuations) ------------

/** contracts workspace-invites.ts:20 minus `declined` (the hub has no decline surface). */
export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
/** contracts workspace-invites.ts:26 — an invite never creates an owner. */
export type InviteRole = Extract<WorkspaceRole, 'admin' | 'member'>;

export interface InviteRow {
  id: string;
  workspaceId: string;
  /** Lower-cased, trimmed. */
  invitedEmail: string;
  role: InviteRole;
  /** sha256 hex of the landing token; the token itself is only ever in the URL. */
  tokenHash: string;
  status: InviteStatus;
  expiresAt: string;
  createdByUserId: string | null;
  createdByMemberId: string | null;
  createdAt: string;
  acceptedAt: string | null;
  acceptedByUserId: string | null;
  updatedAt: string;
}

export interface CreateInviteInput {
  id: string;
  workspaceId: string;
  invitedEmail: string;
  role: InviteRole;
  tokenHash: string;
  expiresAt: string;
  createdByUserId: string;
  createdByMemberId: string;
}

/**
 * Desktop hand-off continuation minted on accept. `nonceHash` is the sha256 of
 * the nonce inside the deeplink; single-use and bound to the accepting user.
 */
export interface InviteContinuationRow {
  nonceHash: string;
  inviteId: string;
  workspaceId: string;
  userId: string;
  memberId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export type AcceptInviteResult =
  | { kind: 'accepted'; invite: InviteRow; membership: WorkspaceMemberRow; continuation: InviteContinuationRow }
  | { kind: 'not_found' }
  | { kind: 'expired' | 'consumed' | 'revoked' };

export interface AcceptInviteInput {
  tokenHash: string;
  userId: string;
  /** Display fields written onto the new membership row. */
  displayName: string | null;
  avatarUrl: string | null;
  continuation: { nonceHash: string; expiresAt: string };
}

export type ConsumeContinuationResult =
  | { kind: 'consumed'; row: InviteContinuationRow }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'already_consumed' }
  | { kind: 'owner_mismatch' };

// ---- public snapshots (PLAN §3.2 public_snapshots) ---------------------------------

export interface PublicSnapshotRow {
  slug: string;
  workspaceId: string;
  resourceId: string;
  versionId: string;
  name: string;
  kind: ResourceKind;
  createdAt: string;
  redactedAt: string | null;
}

/**
 * Persistence boundary shared by the HTTP server, the dev seed, and the CLI
 * facing endpoints. Every implementation (memory, SQLite) must satisfy the
 * parity suite in `tests/store.test.ts`. Presence is process-local by design
 * (see presence-service.ts).
 *
 * Mutations that take a `SideEffects` argument commit it in the same
 * transaction as the mutation: an SSE event or digest bump is never visible
 * without the row change that caused it (or vice versa).
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
  /**
   * `collab member register`: set the caller's display_name only (role and
   * status stay whatever the directory mirror says). Commits `effects` in the
   * same transaction. Returns null when the membership row does not exist.
   */
  setMemberDisplayName(workspaceId: string, userId: string, displayName: string, effects: (previous: WorkspaceMemberRow, next: WorkspaceMemberRow) => SideEffects): Promise<WorkspaceMemberRow | null>;
  bumpSyncDigest(workspaceId: string, face: SyncDigestFace): Promise<SyncDigestRow>;

  // ---- outbox / audit ----
  /** Atomic mutation + outbox append. Returns the appended outbox rows (unpublished). */
  applyBatch(batch: StoreBatch): Promise<{ outbox: OutboxRow[] }>;
  listUnpublishedOutbox(limit?: number): Promise<OutboxRow[]>;
  markOutboxPublished(ids: number[], now?: Date): Promise<void>;
  appendAudit(entry: AuditInput): Promise<void>;
  /** Audit trail, oldest first (optionally filtered by workspace). Read-only diagnostics surface shared by tests. */
  listAudit(workspaceId?: string): Promise<AuditRow[]>;
  /** Admin export: visibility-filtered, `id`-ascending, at most `limit` rows after `afterId`. */
  queryAudit(query: AuditQuery): Promise<AuditRow[]>;

  // ---- resources (PLAN §3.4) ----
  /**
   * Live (non-tombstoned) resource, or null. `includeDeleted` also returns a
   * tombstoned row (with `deletedAt` set) so callers can tell "never existed"
   * from "removed" (PLAN §3.4 tombstone gate).
   */
  getResource(workspaceId: string, resourceId: string, options?: { includeDeleted?: boolean }): Promise<ResourceRow | null>;
  /** Live resources of a workspace, oldest first. */
  listResources(workspaceId: string): Promise<ResourceRow[]>;
  getResourceVersion(workspaceId: string, resourceId: string, version: number): Promise<ResourceVersionRow | null>;
  getResourceVersionById(workspaceId: string, resourceId: string, versionId: string): Promise<ResourceVersionRow | null>;
  /**
   * Transactional publish: CAS on `published_version`, insert the immutable
   * version row, move the `published` ref, and commit `effects` — all or
   * nothing. `not_found` means the id is tombstoned. Blob existence is checked
   * by the caller BEFORE this call (the blob store is outside the transaction),
   * so a version row never references bytes the hub does not hold.
   */
  publishVersion(input: PublishVersionInput, options: PublishVersionOptions, effects: (result: { resource: ResourceRow; version: ResourceVersionRow; created: boolean; teamProjects: TeamProjectRow[] }) => SideEffects): Promise<PublishVersionResult>;
  /** Set `deleted_at`. Idempotent: a second call reports `already_removed`. */
  tombstoneResource(workspaceId: string, resourceId: string, actor: { memberId: string; canManageAll: boolean }, effects: (resource: ResourceRow) => SideEffects): Promise<TombstoneResult>;

  // ---- team project catalog ----
  getTeamProject(workspaceId: string, projectId: string): Promise<TeamProjectRow | null>;
  listTeamProjects(workspaceId: string): Promise<TeamProjectRow[]>;
  /** Catalog rows pointing at one resource (used to route project-content-changed). */
  listTeamProjectsByResource(workspaceId: string, resourceId: string): Promise<TeamProjectRow[]>;
  upsertTeamProject(input: UpsertTeamProjectInput, options: { actorCanManageAll: boolean }, effects: (row: TeamProjectRow, created: boolean) => SideEffects): Promise<UpsertTeamProjectResult>;
  removeTeamProject(workspaceId: string, projectId: string, actor: { memberId: string; canManageAll: boolean }, effects: (row: TeamProjectRow) => SideEffects): Promise<RemoveTeamProjectResult>;

  // ---- pull receipts ----
  createPullReceipt(row: PullReceiptRow, effects?: SideEffects): Promise<void>;
  getPullReceipt(nonce: string): Promise<PullReceiptRow | null>;
  /** Single use: returns false when unknown or already consumed. */
  consumePullReceipt(nonce: string, now?: Date): Promise<boolean>;

  // ---- comments (PLAN §3.2) ----
  /**
   * Transactional push (see comments.ts for the rules): read latest seq +
   * the stored row for the id under one write lock, decide, write the row and
   * advance `comment_seq`, commit `effects`. `tombstoned` writes nothing.
   */
  pushComment(input: PushCommentInput, effects: (result: { row: CommentRow; created: boolean }) => SideEffects): Promise<PushCommentResult>;
  /** Rows with `seq > sinceSeq`, ascending by seq, tombstones included. */
  listCommentsSince(workspaceId: string, projectId: string, sinceSeq: number): Promise<CommentRow[]>;
  /** Highest seq assigned in the project (0 before the first push). */
  latestCommentSeq(workspaceId: string, projectId: string): Promise<number>;
  getComment(workspaceId: string, projectId: string, id: string): Promise<CommentRow | null>;

  // ---- invites (PLAN §3.2) ----
  /** Insert a pending invite together with its audit row. */
  createInvite(input: CreateInviteInput, effects?: SideEffects): Promise<InviteRow>;
  getInvite(id: string): Promise<InviteRow | null>;
  getInviteByTokenHash(tokenHash: string): Promise<InviteRow | null>;
  /** Pending invites of a workspace addressed to `invitedEmail` (already lower-cased); expiry is the caller's call. */
  listPendingInvites(workspaceId: string, invitedEmail: string): Promise<InviteRow[]>;
  /** Mark expired/revoked (idempotent for the same status). */
  setInviteStatus(id: string, status: Exclude<InviteStatus, 'accepted'>): Promise<InviteRow | null>;
  /**
   * Transactional accept: re-read the invite under the write lock, check
   * status + expiry, upsert the membership at the invite role (an existing
   * active row keeps its stronger role; a removed row is reactivated), mark the
   * invite accepted, insert the continuation, commit `effects`.
   */
  acceptInvite(input: AcceptInviteInput, effects: (result: { invite: InviteRow; membership: WorkspaceMemberRow }) => SideEffects): Promise<AcceptInviteResult>;
  getInviteContinuation(nonceHash: string): Promise<InviteContinuationRow | null>;
  /** Single-use, owner-bound consume; the store decides atomically which failure applies. */
  consumeInviteContinuation(nonceHash: string, userId: string, now: Date, effects: (row: InviteContinuationRow) => SideEffects): Promise<ConsumeContinuationResult>;

  // ---- public snapshots (PLAN §3.2) ----
  createPublicSnapshot(row: PublicSnapshotRow, effects?: SideEffects): Promise<void>;
  /** Live or redacted row; callers check `redactedAt`. */
  getPublicSnapshot(slug: string): Promise<PublicSnapshotRow | null>;
  /** Set `redacted_at`; returns the row when it was live, null when unknown or already redacted. */
  redactPublicSnapshot(slug: string, effects: (row: PublicSnapshotRow) => SideEffects): Promise<PublicSnapshotRow | null>;

  close(): Promise<void>;
}
