-- od-hub schema, PLAN-selfhosted-hub-gitlab-oauth.md §3.2.
-- Written in portable SQL (Postgres 15 target; SQLite-compatible where noted).
-- Only the tables consumed by src/server/store.ts are exercised today; the
-- remainder are declared so later milestones (M2-M4) add columns, not tables.

-- identity and credentials
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  gitlab_id BIGINT UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  access_token_enc BLOB,
  refresh_token_enc BLOB,
  key_id TEXT,
  access_expires_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('control', 'runtime')),
  profile TEXT,
  device_label TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS device_auths (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  gitlab_device_code TEXT,
  verification_uri TEXT,
  interval_s INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL,
  user_id TEXT,
  profile TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- workspaces and member mirror
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  gitlab_kind TEXT NOT NULL CHECK (gitlab_kind IN ('personal', 'team')),
  gitlab_id BIGINT UNIQUE,
  name TEXT NOT NULL,
  icon_key TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'locked', 'deleting', 'deleted')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  member_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  member_status TEXT NOT NULL DEFAULT 'active' CHECK (member_status IN ('active', 'removed')),
  display_name TEXT,
  avatar_url TEXT,
  seen_at TEXT,
  removed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- blobs / resources / versions
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  size BIGINT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_member_id TEXT,
  metadata TEXT,
  published_version INTEGER NOT NULL DEFAULT 0,
  published_version_id TEXT,
  manifest_digest TEXT,
  manifest_entry_count INTEGER,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (workspace_id, resource_id)
);

CREATE TABLE IF NOT EXISTS resource_versions (
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  version_id TEXT NOT NULL UNIQUE,
  manifest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  created_by_member_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, resource_id, version)
);

CREATE TABLE IF NOT EXISTS team_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner_member_id TEXT,
  display_name TEXT,
  sync_state TEXT,
  last_synced_version_id TEXT,
  published_version_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS public_snapshots (
  slug TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  name TEXT,
  kind TEXT,
  created_at TEXT NOT NULL,
  redacted_at TEXT
);

CREATE TABLE IF NOT EXISTS pull_receipts (
  nonce TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  viewer_member_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- comment stream
CREATE TABLE IF NOT EXISTS comments (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq BIGINT NOT NULL,
  body TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  server_received_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, project_id, id),
  UNIQUE (workspace_id, project_id, seq)
);

CREATE TABLE IF NOT EXISTS comment_seq (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  latest_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, project_id)
);

-- invites
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  invited_email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by_member_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_continuations (
  nonce TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL REFERENCES invites(id),
  user_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

-- event outbox and audit
CREATE TABLE IF NOT EXISTS events_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  topic TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_user_id TEXT,
  actor_member_id TEXT,
  workspace_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  user_agent TEXT,
  details TEXT
);

-- billing (constants)
CREATE TABLE IF NOT EXISTS workspace_billing (
  workspace_id TEXT PRIMARY KEY,
  billing_state TEXT NOT NULL DEFAULT 'active',
  plan_id TEXT NOT NULL DEFAULT 'team_plus',
  balance_usd TEXT NOT NULL DEFAULT '999999',
  revision_billing TEXT NOT NULL DEFAULT '1',
  revision_wallet TEXT NOT NULL DEFAULT '1'
);

-- sync digest tokens (Redis in the full design; table form for single-node)
CREATE TABLE IF NOT EXISTS sync_digests (
  workspace_id TEXT PRIMARY KEY,
  catalog_token TEXT NOT NULL,
  members_token TEXT NOT NULL,
  context_token TEXT NOT NULL,
  billing_token TEXT NOT NULL DEFAULT ''
);
