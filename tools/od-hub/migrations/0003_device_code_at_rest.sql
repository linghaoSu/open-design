-- od-hub schema v3: device codes at rest (PLAN §5.1).
-- The hub device code the CLI polls with is stored only as sha256 hex, and
-- GitLab's own device_code is sealed with the TokenCipher (AES-256-GCM,
-- key id recorded in key_id) so a database read-out cannot complete a login
-- that is still pending. Pending authorizations live for ten minutes, so
-- dropping in-flight rows on upgrade only costs an interrupted `od-vela login`.
-- Portable: a rebuild rather than ALTER so SQLite and Postgres agree.

DROP TABLE IF EXISTS device_auths;

CREATE TABLE device_auths (
  device_code_hash TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  gitlab_device_code_enc BLOB,
  key_id TEXT,
  verification_uri TEXT,
  verification_uri_complete TEXT,
  interval_s INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL,
  user_id TEXT,
  profile TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_polled_at TEXT
);
