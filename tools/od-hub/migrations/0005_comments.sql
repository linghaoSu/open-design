-- od-hub schema v5: comment stream (PLAN §3.2 comments / comment_seq, §4.3 collab rows).
-- The base tables were declared in 0001; this migration adds the author column
-- the hub resolves from the caller's identity and the index the `sinceSeq`
-- pull walks. `body` stays TEXT (JSON) so SQLite and Postgres (jsonb) share
-- the same reader.

ALTER TABLE comments ADD COLUMN author_member_id TEXT;

CREATE INDEX IF NOT EXISTS comments_project_seq ON comments (workspace_id, project_id, seq);
