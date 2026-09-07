import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { versionIdFor, type ManifestEntry, type ResourceKind } from '../shared/manifest.js';
import { apiKeyIdFromHash, deriveMemberId, hashApiKey, isoNow, mintApiKeySecret, newDigestToken } from './ids.js';
import { DEFAULT_BILLING, freshSyncDigest, slideExpiry, sortDirectory, teamProjectRowId, toDirectoryItem } from './memory-store.js';
import type {
  ApiKeyRow,
  AuditInput,
  AuditRow,
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
  PublishVersionInput,
  PublishVersionOptions,
  PublishVersionResult,
  PullReceiptRow,
  RemoveTeamProjectResult,
  ResourceRow,
  ResourceVersionRow,
  SideEffects,
  StoreBatch,
  SyncDigestFace,
  SyncDigestRow,
  TeamProjectRow,
  TeamProjectSyncState,
  TombstoneResult,
  UpdateWorkspaceInput,
  UpsertMemberInput,
  UpsertTeamProjectInput,
  UpsertTeamProjectResult,
  UserRow,
  WorkspaceBillingRow,
  WorkspaceDirectoryItem,
  WorkspaceMemberRow,
  WorkspaceRow,
} from './store.js';

/**
 * Locate `migrations/` relative to the running module. Source runs from
 * `src/server/`, the esbuild bundle from `dist/`; both sit under the tool root,
 * so walk upwards until the first migration file is found.
 */
export function resolveMigrationsDir(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, '0001_init.sql'))) return candidate;
    dir = resolve(dir, '..');
  }
  throw new Error('migrations directory not found');
}

/**
 * Apply every `NNNN_*.sql` file under `migrationsDir` that is not yet recorded
 * in `schema_migrations`. Each file runs in one transaction. Returns the
 * versions applied by this call (empty on a fully migrated database).
 */
export function applyMigrations(db: Database.Database, migrationsDir: string = resolveMigrationsDir()): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );
  const files = readdirSync(migrationsDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const ran: number[] = [];
  for (const file of files) {
    const version = Number.parseInt(file.slice(0, 4), 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, isoNow());
    })();
    ran.push(version);
  }
  return ran;
}

interface UserSqlRow {
  id: string; gitlab_id: number | null; email: string; name: string; avatar_url: string | null;
  created_at: string; updated_at: string;
}
interface ApiKeySqlRow {
  id: string; key_hash: string; user_id: string; kind: ApiKeyRow['kind']; profile: string | null;
  device_label: string | null; created_at: string; last_seen_at: string | null; expires_at: string | null;
  revoked_at: string | null;
}
interface WorkspaceSqlRow {
  id: string; gitlab_kind: WorkspaceRow['gitlabKind']; gitlab_id: number | null; name: string;
  icon_key: string | null; lifecycle_state: WorkspaceRow['lifecycleState']; updated_at: string;
}
interface MemberSqlRow {
  workspace_id: string; user_id: string; member_id: string; role: WorkspaceMemberRow['role'];
  member_status: WorkspaceMemberRow['memberStatus']; display_name: string | null; avatar_url: string | null;
  seen_at: string | null; removed_at: string | null; updated_at: string;
}
interface BillingSqlRow {
  workspace_id: string; billing_state: string; plan_id: string; balance_usd: string;
  revision_billing: string; revision_wallet: string;
}
interface DigestSqlRow {
  workspace_id: string; catalog_token: string; members_token: string; context_token: string; billing_token: string;
}
interface DeviceAuthSqlRow {
  device_code_hash: string; user_code: string; gitlab_device_code_enc: Buffer | null; key_id: string | null; verification_uri: string | null;
  verification_uri_complete: string | null; interval_s: number; status: DeviceAuthRow['status'];
  user_id: string | null; profile: string | null; created_at: string; expires_at: string; last_polled_at: string | null;
}
interface GrantSqlRow {
  user_id: string; access_token_enc: Buffer | null; refresh_token_enc: Buffer | null; key_id: string | null;
  access_expires_at: string | null; updated_at: string;
}
interface OutboxSqlRow {
  id: number; workspace_id: string | null; user_id: string | null; topic: OutboxRow['topic']; event_name: string;
  payload: string; created_at: string; published_at: string | null;
}
interface ResourceSqlRow {
  workspace_id: string; resource_id: string; kind: ResourceKind; owner_member_id: string | null; metadata: string | null;
  published_version: number; published_version_id: string | null; manifest_digest: string | null;
  manifest_entry_count: number | null; created_at: string; updated_at: string | null; deleted_at: string | null;
}
interface ResourceVersionSqlRow {
  workspace_id: string; resource_id: string; version: number; version_id: string; manifest: string;
  manifest_digest: string; entry_count: number; created_by_member_id: string | null; created_at: string;
}
interface TeamProjectSqlRow {
  id: string; workspace_id: string; project_id: string; resource_id: string; owner_member_id: string | null;
  display_name: string | null; sync_state: string | null; last_synced_version_id: string | null;
  published_version_id: string | null; metadata: string | null; created_at: string; updated_at: string;
}
interface PullReceiptSqlRow {
  nonce: string; workspace_id: string; project_id: string; resource_id: string | null; viewer_member_id: string;
  owner_member_id: string | null; version: number; version_id: string | null; manifest_digest: string | null;
  authorized_at: string | null; expires_at: string; consumed_at: string | null;
}

const parseJsonObject = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
};
const resourceFromRow = (r: ResourceSqlRow): ResourceRow => ({
  workspaceId: r.workspace_id, resourceId: r.resource_id, kind: r.kind, ownerMemberId: r.owner_member_id ?? '',
  metadata: parseJsonObject(r.metadata), publishedVersion: r.published_version, publishedVersionId: r.published_version_id,
  manifestDigest: r.manifest_digest, manifestEntryCount: r.manifest_entry_count, createdAt: r.created_at,
  updatedAt: r.updated_at ?? r.created_at, deletedAt: r.deleted_at,
});
const versionFromRow = (r: ResourceVersionSqlRow): ResourceVersionRow => ({
  workspaceId: r.workspace_id, resourceId: r.resource_id, version: r.version, versionId: r.version_id,
  manifest: JSON.parse(r.manifest) as ManifestEntry[], manifestDigest: r.manifest_digest, entryCount: r.entry_count,
  createdByMemberId: r.created_by_member_id ?? '', createdAt: r.created_at,
});
const SYNC_STATES: ReadonlySet<string> = new Set(['pending_upload', 'syncing', 'synced', 'failed']);
const teamProjectFromRow = (r: TeamProjectSqlRow): TeamProjectRow => ({
  id: r.id, workspaceId: r.workspace_id, projectId: r.project_id, resourceId: r.resource_id,
  ownerMemberId: r.owner_member_id ?? '', displayName: r.display_name,
  syncState: (r.sync_state && SYNC_STATES.has(r.sync_state) ? r.sync_state : 'pending_upload') as TeamProjectSyncState,
  lastSyncedVersionId: r.last_synced_version_id, metadata: parseJsonObject(r.metadata),
  createdAt: r.created_at, updatedAt: r.updated_at,
});

const userFromRow = (r: UserSqlRow): UserRow => ({
  id: r.id, gitlabId: r.gitlab_id, email: r.email, name: r.name, avatarUrl: r.avatar_url,
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const apiKeyFromRow = (r: ApiKeySqlRow): ApiKeyRow => ({
  id: r.id, keyHash: r.key_hash, userId: r.user_id, kind: r.kind, profile: r.profile, deviceLabel: r.device_label,
  createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, revokedAt: r.revoked_at,
});
const workspaceFromRow = (r: WorkspaceSqlRow): WorkspaceRow => ({
  id: r.id, gitlabKind: r.gitlab_kind, gitlabId: r.gitlab_id, name: r.name, iconKey: r.icon_key,
  lifecycleState: r.lifecycle_state, updatedAt: r.updated_at,
});
const memberFromRow = (r: MemberSqlRow): WorkspaceMemberRow => ({
  workspaceId: r.workspace_id, userId: r.user_id, memberId: r.member_id, role: r.role, memberStatus: r.member_status,
  displayName: r.display_name, avatarUrl: r.avatar_url, seenAt: r.seen_at, removedAt: r.removed_at,
  updatedAt: r.updated_at,
});
const digestFromRow = (r: DigestSqlRow): SyncDigestRow => ({
  workspaceId: r.workspace_id, catalogToken: r.catalog_token, membersToken: r.members_token,
  contextToken: r.context_token, billingToken: r.billing_token,
});
const deviceAuthFromRow = (r: DeviceAuthSqlRow): DeviceAuthRow => ({
  deviceCodeHash: r.device_code_hash, userCode: r.user_code,
  gitlabDeviceCodeEnc: r.gitlab_device_code_enc ? Buffer.from(r.gitlab_device_code_enc) : Buffer.alloc(0), keyId: r.key_id ?? '',
  verificationUri: r.verification_uri ?? '', verificationUriComplete: r.verification_uri_complete,
  intervalS: r.interval_s, status: r.status, userId: r.user_id, profile: r.profile, createdAt: r.created_at,
  expiresAt: r.expires_at, lastPolledAt: r.last_polled_at,
});
const outboxFromRow = (r: OutboxSqlRow): OutboxRow => ({
  id: r.id, workspaceId: r.workspace_id, userId: r.user_id, topic: r.topic, eventName: r.event_name,
  payload: JSON.parse(r.payload) as Record<string, unknown>, createdAt: r.created_at, publishedAt: r.published_at,
});

/**
 * SQLite-backed HubStore (better-sqlite3, synchronous under the hood). Pass
 * `':memory:'` for an ephemeral database; any other path is created on demand
 * and migrated on open.
 */
export class SqliteHubStore implements HubStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(filename: string, options: { migrationsDir?: string; now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.db = new Database(filename);
    if (filename !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    applyMigrations(this.db, options.migrationsDir);
  }

  // ---- HubStore reads -----------------------------------------------------------

  async authenticate(
    bearerToken: string,
    now: Date = this.now(),
    options?: AuthenticateOptions,
  ): Promise<AuthenticatedPrincipal | null> {
    const token = bearerToken.trim();
    if (!token) return null;
    const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashApiKey(token)) as
      | ApiKeySqlRow
      | undefined;
    if (!row || row.revoked_at) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return null;
    const user = await this.getUser(row.user_id);
    if (!user) return null;
    const seen = isoNow(now);
    const slid = slideExpiry(now, options);
    const expiresAt = slid && row.expires_at ? slid : row.expires_at;
    this.db.prepare('UPDATE api_keys SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(seen, expiresAt, row.id);
    return { user, apiKey: apiKeyFromRow({ ...row, last_seen_at: seen, expires_at: expiresAt }) };
  }

  async listDirectory(userId: string): Promise<WorkspaceDirectoryItem[]> {
    const rows = this.db.prepare('SELECT * FROM workspace_members WHERE user_id = ?').all(userId) as MemberSqlRow[];
    const items: WorkspaceDirectoryItem[] = [];
    for (const row of rows) {
      const workspace = await this.getWorkspace(row.workspace_id);
      if (!workspace) continue;
      items.push(toDirectoryItem(workspace, memberFromRow(row)));
    }
    return sortDirectory(items);
  }

  async listMemberships(userId: string): Promise<WorkspaceMemberRow[]> {
    const rows = this.db.prepare('SELECT * FROM workspace_members WHERE user_id = ?').all(userId) as MemberSqlRow[];
    return rows.map(memberFromRow);
  }

  async getMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | null> {
    const row = this.db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId) as MemberSqlRow | undefined;
    return row ? memberFromRow(row) : null;
  }

  async getWorkspaceBilling(workspaceId: string): Promise<WorkspaceBillingRow> {
    const row = this.db.prepare('SELECT * FROM workspace_billing WHERE workspace_id = ?').get(workspaceId) as
      | BillingSqlRow
      | undefined;
    if (!row) return { workspaceId, ...DEFAULT_BILLING };
    return {
      workspaceId: row.workspace_id, billingState: row.billing_state, planId: row.plan_id,
      balanceUsd: row.balance_usd, revisionBilling: row.revision_billing, revisionWallet: row.revision_wallet,
    };
  }

  async getSyncDigest(workspaceId: string): Promise<SyncDigestRow> {
    return this.digestSync(workspaceId);
  }

  private digestSync(workspaceId: string): SyncDigestRow {
    const row = this.db.prepare('SELECT * FROM sync_digests WHERE workspace_id = ?').get(workspaceId) as
      | DigestSqlRow
      | undefined;
    if (row) return digestFromRow(row);
    const digest = freshSyncDigest(workspaceId);
    this.writeDigest(digest);
    return digest;
  }

  // ---- identity -------------------------------------------------------------------

  async createUser(input: CreateUserInput): Promise<UserRow> {
    const now = isoNow(this.now());
    this.db.prepare(
      'INSERT INTO users (id, gitlab_id, email, name, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(input.id, input.gitlabId ?? null, input.email, input.name, input.avatarUrl ?? null, now, now);
    return (await this.getUser(input.id))!;
  }

  async upsertUser(input: CreateUserInput): Promise<UserRow> {
    const now = isoNow(this.now());
    this.db.prepare(
      `INSERT INTO users (id, gitlab_id, email, name, avatar_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         gitlab_id = COALESCE(excluded.gitlab_id, users.gitlab_id),
         email = excluded.email,
         name = excluded.name,
         avatar_url = CASE WHEN ? THEN excluded.avatar_url ELSE users.avatar_url END,
         updated_at = excluded.updated_at`,
    ).run(input.id, input.gitlabId ?? null, input.email, input.name, input.avatarUrl ?? null, now, now,
      input.avatarUrl === undefined ? 0 : 1);
    return (await this.getUser(input.id))!;
  }

  async getUser(id: string): Promise<UserRow | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserSqlRow | undefined;
    return row ? userFromRow(row) : null;
  }

  async issueApiKey(input: IssueApiKeyInput): Promise<{ apiKey: ApiKeyRow; secret: string }> {
    const secret = input.secret ?? mintApiKeySecret(input.kind);
    const keyHash = hashApiKey(secret);
    const select = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?');
    const existing = select.get(keyHash) as ApiKeySqlRow | undefined;
    if (existing) return { apiKey: apiKeyFromRow(existing), secret };
    this.db.prepare(
      `INSERT INTO api_keys (id, key_hash, user_id, kind, profile, device_label, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(apiKeyIdFromHash(keyHash), keyHash, input.userId, input.kind, input.profile ?? null,
      input.deviceLabel ?? null, isoNow(this.now()), input.expiresAt ?? null);
    return { apiKey: apiKeyFromRow(select.get(keyHash) as ApiKeySqlRow), secret };
  }

  async revokeApiKey(secret: string, now: Date = this.now()): Promise<void> {
    this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL')
      .run(isoNow(now), hashApiKey(secret));
  }

  async revokeAllUserKeys(userId: string, now: Date = this.now()): Promise<number> {
    const result = this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(isoNow(now), userId);
    return result.changes;
  }

  // ---- device flow + grants ------------------------------------------------------

  async createDeviceAuth(row: DeviceAuthRow): Promise<DeviceAuthRow> {
    this.db.prepare(
      `INSERT INTO device_auths (device_code_hash, user_code, gitlab_device_code_enc, key_id, verification_uri,
         verification_uri_complete, interval_s, status, user_id, profile, created_at, expires_at, last_polled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.deviceCodeHash, row.userCode, row.gitlabDeviceCodeEnc, row.keyId, row.verificationUri, row.verificationUriComplete,
      row.intervalS, row.status, row.userId, row.profile, row.createdAt, row.expiresAt, row.lastPolledAt);
    return (await this.getDeviceAuth(row.deviceCodeHash))!;
  }

  async getDeviceAuth(deviceCodeHash: string): Promise<DeviceAuthRow | null> {
    const row = this.db.prepare('SELECT * FROM device_auths WHERE device_code_hash = ?').get(deviceCodeHash) as
      | DeviceAuthSqlRow
      | undefined;
    return row ? deviceAuthFromRow(row) : null;
  }

  async updateDeviceAuth(
    deviceCodeHash: string,
    patch: Partial<Pick<DeviceAuthRow, 'status' | 'userId' | 'intervalS' | 'lastPolledAt'>>,
  ): Promise<DeviceAuthRow | null> {
    const existing = await this.getDeviceAuth(deviceCodeHash);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    this.db.prepare('UPDATE device_auths SET status = ?, user_id = ?, interval_s = ?, last_polled_at = ? WHERE device_code_hash = ?')
      .run(next.status, next.userId, next.intervalS, next.lastPolledAt, deviceCodeHash);
    return next;
  }

  async putOAuthGrant(row: OAuthGrantRow): Promise<void> {
    this.db.prepare(
      `INSERT INTO oauth_grants (user_id, access_token_enc, refresh_token_enc, key_id, access_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
         key_id = excluded.key_id, access_expires_at = excluded.access_expires_at, updated_at = excluded.updated_at`,
    ).run(row.userId, row.accessTokenEnc, row.refreshTokenEnc, row.keyId, row.accessExpiresAt, row.updatedAt);
  }

  async getOAuthGrant(userId: string): Promise<OAuthGrantRow | null> {
    const row = this.db.prepare('SELECT * FROM oauth_grants WHERE user_id = ?').get(userId) as GrantSqlRow | undefined;
    if (!row || !row.access_token_enc || !row.key_id) return null;
    return {
      userId: row.user_id, accessTokenEnc: Buffer.from(row.access_token_enc),
      refreshTokenEnc: row.refresh_token_enc ? Buffer.from(row.refresh_token_enc) : null,
      keyId: row.key_id, accessExpiresAt: row.access_expires_at, updatedAt: row.updated_at,
    };
  }

  async deleteOAuthGrant(userId: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_grants WHERE user_id = ?').run(userId);
  }

  // ---- workspaces -----------------------------------------------------------------

  private insertWorkspace(input: CreateWorkspaceInput): void {
    this.db.prepare(
      `INSERT INTO workspaces (id, gitlab_kind, gitlab_id, name, icon_key, lifecycle_state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.kind, input.gitlabId ?? null, input.name, input.iconKey ?? null,
      input.lifecycleState ?? 'active', isoNow(this.now()));
  }

  private patchWorkspace(id: string, patch: UpdateWorkspaceInput): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); values.push(patch.name); }
    if (patch.iconKey !== undefined) { sets.push('icon_key = ?'); values.push(patch.iconKey); }
    if (patch.lifecycleState !== undefined) { sets.push('lifecycle_state = ?'); values.push(patch.lifecycleState); }
    sets.push('updated_at = ?');
    values.push(isoNow(this.now()), id);
    this.db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceRow> {
    this.insertWorkspace(input);
    return (await this.getWorkspace(input.id))!;
  }

  async updateWorkspace(id: string, patch: UpdateWorkspaceInput): Promise<WorkspaceRow | null> {
    if (!(await this.getWorkspace(id))) return null;
    this.patchWorkspace(id, patch);
    return this.getWorkspace(id);
  }

  async getWorkspace(id: string): Promise<WorkspaceRow | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceSqlRow | undefined;
    return row ? workspaceFromRow(row) : null;
  }

  private writeMember(input: UpsertMemberInput): void {
    const now = isoNow(this.now());
    const status = input.memberStatus ?? 'active';
    this.db.prepare(
      `INSERT INTO workspace_members
         (workspace_id, user_id, member_id, role, member_status, display_name, avatar_url, seen_at, removed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         role = excluded.role,
         member_status = excluded.member_status,
         display_name = COALESCE(excluded.display_name, workspace_members.display_name),
         avatar_url = COALESCE(excluded.avatar_url, workspace_members.avatar_url),
         seen_at = excluded.seen_at,
         removed_at = CASE
           WHEN excluded.member_status = 'removed' AND workspace_members.member_status = 'removed'
             THEN workspace_members.removed_at
           ELSE excluded.removed_at END,
         updated_at = excluded.updated_at`,
    ).run(input.workspaceId, input.userId, deriveMemberId(input.userId, input.workspaceId), input.role, status,
      input.displayName ?? null, input.avatarUrl ?? null, now, status === 'removed' ? now : null, now);
  }

  async upsertMember(input: UpsertMemberInput): Promise<WorkspaceMemberRow> {
    this.writeMember(input);
    return (await this.getMembership(input.userId, input.workspaceId))!;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
    const rows = this.db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ?').all(workspaceId) as MemberSqlRow[];
    return rows.map(memberFromRow);
  }

  private bumpDigestSync(workspaceId: string, face: SyncDigestFace): SyncDigestRow {
    const digest = { ...this.digestSync(workspaceId), [face]: newDigestToken() };
    this.writeDigest(digest);
    return digest;
  }

  async bumpSyncDigest(workspaceId: string, face: SyncDigestFace): Promise<SyncDigestRow> {
    return this.bumpDigestSync(workspaceId, face);
  }

  private writeDigest(d: SyncDigestRow): void {
    this.db.prepare(
      `INSERT INTO sync_digests (workspace_id, catalog_token, members_token, context_token, billing_token)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         catalog_token = excluded.catalog_token, members_token = excluded.members_token,
         context_token = excluded.context_token, billing_token = excluded.billing_token`,
    ).run(d.workspaceId, d.catalogToken, d.membersToken, d.contextToken, d.billingToken);
  }

  // ---- outbox / audit -------------------------------------------------------------

  private insertOutbox(event: OutboxEventInput): OutboxRow {
    const createdAt = isoNow(this.now());
    const result = this.db.prepare(
      `INSERT INTO events_outbox (workspace_id, user_id, topic, event_name, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(event.workspaceId, event.userId, event.topic, event.eventName, JSON.stringify(event.payload), createdAt);
    return { ...event, id: Number(result.lastInsertRowid), createdAt, publishedAt: null };
  }

  private insertAudit(entry: AuditInput): void {
    this.db.prepare(
      `INSERT INTO audit_log (at, actor_user_id, workspace_id, action, target, ip, user_agent, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(isoNow(this.now()), entry.actorUserId, entry.workspaceId ?? null, entry.action, entry.target ?? null,
      entry.ip ?? null, entry.userAgent ?? null, entry.details ? JSON.stringify(entry.details) : null);
  }

  async applyBatch(batch: StoreBatch): Promise<{ outbox: OutboxRow[] }> {
    // One transaction: the mutation and its outbox rows commit or roll back together.
    const run = this.db.transaction((): OutboxRow[] => {
      for (const op of batch.workspaces ?? []) {
        if ('create' in op) this.insertWorkspace(op.create);
        else this.patchWorkspace(op.update.id, op.update);
      }
      for (const member of batch.members ?? []) this.writeMember(member);
      for (const { workspaceId, userId } of batch.memberDeletes ?? []) {
        this.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
      }
      for (const bump of batch.digestBumps ?? []) this.bumpDigestSync(bump.workspaceId, bump.face);
      for (const entry of batch.audit ?? []) this.insertAudit(entry);
      return (batch.outbox ?? []).map((event) => this.insertOutbox(event));
    });
    return { outbox: run() };
  }

  async listUnpublishedOutbox(limit = 500): Promise<OutboxRow[]> {
    const rows = this.db.prepare('SELECT * FROM events_outbox WHERE published_at IS NULL ORDER BY id LIMIT ?')
      .all(limit) as OutboxSqlRow[];
    return rows.map(outboxFromRow);
  }

  async markOutboxPublished(ids: number[], now: Date = this.now()): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.db.prepare('UPDATE events_outbox SET published_at = ? WHERE id = ? AND published_at IS NULL');
    const at = isoNow(now);
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, id);
    })();
  }

  async listAudit(workspaceId?: string): Promise<AuditRow[]> {
    const rows = (workspaceId === undefined
      ? this.db.prepare('SELECT * FROM audit_log ORDER BY id').all()
      : this.db.prepare('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY id').all(workspaceId)) as Array<{
        at: string; actor_user_id: string | null; workspace_id: string | null; action: string; target: string | null;
        ip: string | null; user_agent: string | null; details: string | null;
      }>;
    return rows.map((r) => ({
      at: r.at, actorUserId: r.actor_user_id, workspaceId: r.workspace_id, action: r.action, target: r.target,
      ip: r.ip, userAgent: r.user_agent, details: parseJsonObject(r.details),
    }));
  }

  async appendAudit(entry: AuditInput): Promise<void> {
    this.insertAudit(entry);
  }

  // ---- resources ------------------------------------------------------------------

  private applyEffects(effects: SideEffects): void {
    for (const bump of effects.digestBumps ?? []) this.bumpDigestSync(bump.workspaceId, bump.face);
    for (const entry of effects.audit ?? []) this.insertAudit(entry);
    for (const event of effects.outbox ?? []) this.insertOutbox(event);
  }

  private resourceRowSync(workspaceId: string, resourceId: string, includeDeleted: boolean): ResourceRow | null {
    const row = this.db.prepare('SELECT * FROM resources WHERE workspace_id = ? AND resource_id = ?')
      .get(workspaceId, resourceId) as ResourceSqlRow | undefined;
    if (!row) return null;
    if (row.deleted_at && !includeDeleted) return null;
    return resourceFromRow(row);
  }

  async getResource(workspaceId: string, resourceId: string, options?: { includeDeleted?: boolean }): Promise<ResourceRow | null> {
    return this.resourceRowSync(workspaceId, resourceId, options?.includeDeleted === true);
  }

  async listResources(workspaceId: string): Promise<ResourceRow[]> {
    const rows = this.db.prepare(
      'SELECT * FROM resources WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at, resource_id',
    ).all(workspaceId) as ResourceSqlRow[];
    return rows.map(resourceFromRow);
  }

  async getResourceVersion(workspaceId: string, resourceId: string, version: number): Promise<ResourceVersionRow | null> {
    const row = this.db.prepare('SELECT * FROM resource_versions WHERE workspace_id = ? AND resource_id = ? AND version = ?')
      .get(workspaceId, resourceId, version) as ResourceVersionSqlRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  async getResourceVersionById(workspaceId: string, resourceId: string, versionId: string): Promise<ResourceVersionRow | null> {
    const row = this.db.prepare('SELECT * FROM resource_versions WHERE workspace_id = ? AND resource_id = ? AND version_id = ?')
      .get(workspaceId, resourceId, versionId) as ResourceVersionSqlRow | undefined;
    return row ? versionFromRow(row) : null;
  }

  async publishVersion(
    input: PublishVersionInput,
    options: PublishVersionOptions,
    effects: (result: { resource: ResourceRow; version: ResourceVersionRow; created: boolean; teamProjects: TeamProjectRow[] }) => SideEffects,
  ): Promise<PublishVersionResult> {
    // IMMEDIATE transaction: the read of published_version and the write of
    // version+1 happen under one write lock, so two concurrent publishers
    // cannot both pass the CAS check (PLAN §3.4 `SELECT ... FOR UPDATE`).
    const run = this.db.transaction((): PublishVersionResult => {
      const previous = this.resourceRowSync(input.workspaceId, input.resourceId, true);
      if (previous?.deletedAt) return { kind: 'not_found' };
      if (previous && previous.kind !== input.kind) return { kind: 'kind_conflict', storedKind: previous.kind };
      if (previous && !options.actorCanManageAll && previous.ownerMemberId !== input.actorMemberId) {
        return { kind: 'forbidden', ownerMemberId: previous.ownerMemberId };
      }
      const current = previous?.publishedVersion ?? 0;
      if (input.expectedVersion !== null && input.expectedVersion !== current) {
        return { kind: 'conflict', publishedVersion: current };
      }
      const at = isoNow(this.now());
      const version = current + 1;
      const versionId = versionIdFor(version, input.manifestDigest);
      const metadata = input.metadata === undefined ? (previous?.metadata ?? null) : input.metadata;
      this.db.prepare(
        `INSERT INTO resource_versions
           (workspace_id, resource_id, version, version_id, manifest, manifest_digest, entry_count, created_by_member_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.workspaceId, input.resourceId, version, versionId, JSON.stringify(input.manifest), input.manifestDigest,
        input.manifest.length, input.actorMemberId, at);
      if (previous) {
        const updated = this.db.prepare(
          `UPDATE resources SET metadata = ?, published_version = ?, published_version_id = ?, manifest_digest = ?,
             manifest_entry_count = ?, updated_at = ?
           WHERE workspace_id = ? AND resource_id = ? AND published_version = ? AND deleted_at IS NULL`,
        ).run(metadata ? JSON.stringify(metadata) : null, version, versionId, input.manifestDigest, input.manifest.length, at,
          input.workspaceId, input.resourceId, current);
        // Cannot happen under the IMMEDIATE lock, but a silent no-op here would
        // leave a version row pointing past the published ref: abort loudly.
        if (updated.changes !== 1) throw new Error(`publish lost the CAS race on ${input.resourceId}`);
      } else {
        this.db.prepare(
          `INSERT INTO resources
             (workspace_id, resource_id, kind, owner_member_id, metadata, published_version, published_version_id,
              manifest_digest, manifest_entry_count, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(input.workspaceId, input.resourceId, input.kind, input.actorMemberId, metadata ? JSON.stringify(metadata) : null,
          version, versionId, input.manifestDigest, input.manifest.length, at, at);
      }
      const resource = this.resourceRowSync(input.workspaceId, input.resourceId, false)!;
      const versionRow = versionFromRow(
        this.db.prepare('SELECT * FROM resource_versions WHERE workspace_id = ? AND resource_id = ? AND version = ?')
          .get(input.workspaceId, input.resourceId, version) as ResourceVersionSqlRow,
      );
      const teamProjects = this.teamProjectsByResourceSync(input.workspaceId, input.resourceId);
      const result = { resource, version: versionRow, created: !previous, teamProjects };
      this.applyEffects(effects(result));
      return { kind: 'published', ...result };
    });
    return run.immediate();
  }

  async tombstoneResource(
    workspaceId: string,
    resourceId: string,
    actor: { memberId: string; canManageAll: boolean },
    effects: (resource: ResourceRow) => SideEffects,
  ): Promise<TombstoneResult> {
    const run = this.db.transaction((): TombstoneResult => {
      const row = this.resourceRowSync(workspaceId, resourceId, true);
      if (!row) return { kind: 'not_found' };
      if (row.deletedAt) return { kind: 'already_removed' };
      if (!actor.canManageAll && row.ownerMemberId !== actor.memberId) return { kind: 'forbidden', ownerMemberId: row.ownerMemberId };
      const at = isoNow(this.now());
      this.db.prepare('UPDATE resources SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND resource_id = ? AND deleted_at IS NULL')
        .run(at, at, workspaceId, resourceId);
      const snapshot: ResourceRow = { ...row, deletedAt: at, updatedAt: at };
      this.applyEffects(effects(snapshot));
      return { kind: 'removed', resource: snapshot };
    });
    return run.immediate();
  }

  // ---- team projects ---------------------------------------------------------------

  private teamProjectSync(workspaceId: string, projectId: string): TeamProjectRow | null {
    const row = this.db.prepare('SELECT * FROM team_projects WHERE workspace_id = ? AND project_id = ?')
      .get(workspaceId, projectId) as TeamProjectSqlRow | undefined;
    return row ? teamProjectFromRow(row) : null;
  }

  private teamProjectsByResourceSync(workspaceId: string, resourceId: string): TeamProjectRow[] {
    const rows = this.db.prepare(
      'SELECT * FROM team_projects WHERE workspace_id = ? AND resource_id = ? ORDER BY created_at, project_id',
    ).all(workspaceId, resourceId) as TeamProjectSqlRow[];
    return rows.map(teamProjectFromRow);
  }

  async getTeamProject(workspaceId: string, projectId: string): Promise<TeamProjectRow | null> {
    return this.teamProjectSync(workspaceId, projectId);
  }

  async listTeamProjects(workspaceId: string): Promise<TeamProjectRow[]> {
    const rows = this.db.prepare('SELECT * FROM team_projects WHERE workspace_id = ? ORDER BY created_at, project_id')
      .all(workspaceId) as TeamProjectSqlRow[];
    return rows.map(teamProjectFromRow);
  }

  async listTeamProjectsByResource(workspaceId: string, resourceId: string): Promise<TeamProjectRow[]> {
    return this.teamProjectsByResourceSync(workspaceId, resourceId);
  }

  async upsertTeamProject(
    input: UpsertTeamProjectInput,
    options: { actorCanManageAll: boolean },
    effects: (row: TeamProjectRow, created: boolean) => SideEffects,
  ): Promise<UpsertTeamProjectResult> {
    const run = this.db.transaction((): UpsertTeamProjectResult => {
      const previous = this.teamProjectSync(input.workspaceId, input.projectId);
      if (previous && !options.actorCanManageAll && previous.ownerMemberId !== input.actorMemberId) {
        return { kind: 'forbidden', ownerMemberId: previous.ownerMemberId };
      }
      const at = isoNow(this.now());
      const next: TeamProjectRow = {
        id: previous?.id ?? teamProjectRowId(input.workspaceId, input.projectId),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        resourceId: input.resourceId,
        ownerMemberId: previous?.ownerMemberId ?? input.actorMemberId,
        displayName: input.displayName === undefined ? (previous?.displayName ?? null) : input.displayName,
        syncState: input.syncState ?? previous?.syncState ?? 'synced',
        lastSyncedVersionId: input.lastSyncedVersionId === undefined ? (previous?.lastSyncedVersionId ?? null) : input.lastSyncedVersionId,
        metadata: input.metadata === undefined ? (previous?.metadata ?? null) : input.metadata,
        createdAt: previous?.createdAt ?? at,
        updatedAt: at,
      };
      this.db.prepare(
        `INSERT INTO team_projects
           (id, workspace_id, project_id, resource_id, owner_member_id, display_name, sync_state, last_synced_version_id,
            published_version_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT (workspace_id, project_id) DO UPDATE SET
           resource_id = excluded.resource_id, display_name = excluded.display_name, sync_state = excluded.sync_state,
           last_synced_version_id = excluded.last_synced_version_id, metadata = excluded.metadata, updated_at = excluded.updated_at`,
      ).run(next.id, next.workspaceId, next.projectId, next.resourceId, next.ownerMemberId, next.displayName, next.syncState,
        next.lastSyncedVersionId, next.metadata ? JSON.stringify(next.metadata) : null, next.createdAt, next.updatedAt);
      this.applyEffects(effects(next, !previous));
      return { kind: 'upserted', row: next, created: !previous };
    });
    return run.immediate();
  }

  async removeTeamProject(
    workspaceId: string,
    projectId: string,
    actor: { memberId: string; canManageAll: boolean },
    effects: (row: TeamProjectRow) => SideEffects,
  ): Promise<RemoveTeamProjectResult> {
    const run = this.db.transaction((): RemoveTeamProjectResult => {
      const row = this.teamProjectSync(workspaceId, projectId);
      if (!row) return { kind: 'not_found' };
      if (!actor.canManageAll && row.ownerMemberId !== actor.memberId) return { kind: 'forbidden', ownerMemberId: row.ownerMemberId };
      this.db.prepare('DELETE FROM team_projects WHERE workspace_id = ? AND project_id = ?').run(workspaceId, projectId);
      this.applyEffects(effects(row));
      return { kind: 'removed', row };
    });
    return run.immediate();
  }

  // ---- pull receipts ---------------------------------------------------------------

  async createPullReceipt(row: PullReceiptRow, effects?: SideEffects): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO pull_receipts
           (nonce, workspace_id, project_id, resource_id, viewer_member_id, owner_member_id, version, version_id,
            manifest_digest, authorized_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(row.nonce, row.workspaceId, row.projectId, row.resourceId, row.viewerMemberId, row.ownerMemberId, row.version,
        row.versionId, row.manifestDigest, row.authorizedAt, row.expiresAt, row.consumedAt);
      if (effects) this.applyEffects(effects);
    }).immediate();
  }

  async getPullReceipt(nonce: string): Promise<PullReceiptRow | null> {
    const row = this.db.prepare('SELECT * FROM pull_receipts WHERE nonce = ?').get(nonce) as PullReceiptSqlRow | undefined;
    if (!row) return null;
    return {
      nonce: row.nonce, workspaceId: row.workspace_id, projectId: row.project_id, resourceId: row.resource_id ?? '',
      viewerMemberId: row.viewer_member_id, ownerMemberId: row.owner_member_id ?? '', version: row.version,
      versionId: row.version_id ?? '', manifestDigest: row.manifest_digest ?? '', authorizedAt: row.authorized_at ?? '',
      expiresAt: row.expires_at, consumedAt: row.consumed_at,
    };
  }

  async consumePullReceipt(nonce: string, now: Date = this.now()): Promise<boolean> {
    const result = this.db.prepare('UPDATE pull_receipts SET consumed_at = ? WHERE nonce = ? AND consumed_at IS NULL')
      .run(isoNow(now), nonce);
    return result.changes === 1;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
