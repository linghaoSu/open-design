-- od-hub schema v6: workspace invites + continuations, public snapshots, audit export
-- (PLAN §3.2 invites / invite_continuations / public_snapshots; F8). The base
-- tables were declared in 0001; this migration adds the columns the
-- implementation reads and the indexes its queries walk.

-- invites: who accepted and when; the inviter's user id next to the member id
-- (a member id alone cannot be joined back once the membership row is removed).
ALTER TABLE invites ADD COLUMN created_by_user_id TEXT;
ALTER TABLE invites ADD COLUMN accepted_at TEXT;
ALTER TABLE invites ADD COLUMN accepted_by_user_id TEXT;
ALTER TABLE invites ADD COLUMN updated_at TEXT;

-- invite_continuations: `nonce` holds the sha256 of the nonce handed to the
-- desktop deeplink (a database read-out cannot consume a continuation);
-- workspace_id is denormalized so consume never has to join invites.
ALTER TABLE invite_continuations ADD COLUMN workspace_id TEXT;
ALTER TABLE invite_continuations ADD COLUMN created_at TEXT;

CREATE INDEX IF NOT EXISTS invites_workspace_email ON invites (workspace_id, invited_email, status);
CREATE INDEX IF NOT EXISTS invite_continuations_invite ON invite_continuations (invite_id);
CREATE INDEX IF NOT EXISTS public_snapshots_resource ON public_snapshots (workspace_id, resource_id);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at, id);
CREATE INDEX IF NOT EXISTS audit_log_workspace ON audit_log (workspace_id, id);
CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log (actor_user_id, id);
