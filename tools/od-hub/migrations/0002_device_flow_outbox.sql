-- od-hub schema v2: GitLab device flow + event outbox targeting (PLAN §5.1, §4.2).
-- Portable ALTERs (SQLite and Postgres both accept ADD COLUMN without defaults
-- that depend on other columns).

-- device_auths: keep GitLab's complete verification URI (carries user_code) and
-- the last poll time so slow_down can be enforced hub-side.
ALTER TABLE device_auths ADD COLUMN verification_uri_complete TEXT;
ALTER TABLE device_auths ADD COLUMN last_polled_at TEXT;

-- events_outbox: directory / access events are addressed to one user, not to
-- every subscriber of the workspace.
ALTER TABLE events_outbox ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS events_outbox_unpublished ON events_outbox (published_at, id);
CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id, revoked_at);
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members (user_id);
