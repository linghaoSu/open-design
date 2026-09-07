import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { apiKeyIdFromHash, deriveMemberId, hashApiKey, isoNow, mintApiKeySecret, newDigestToken } from './ids.js';
import { DEFAULT_BILLING, freshSyncDigest, slideExpiry, sortDirectory, toDirectoryItem } from './memory-store.js';
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

  async appendAudit(entry: AuditInput): Promise<void> {
    this.insertAudit(entry);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
