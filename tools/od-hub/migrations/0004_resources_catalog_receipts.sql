-- od-hub schema v4: content-addressed resources, team-project catalog, pull receipts
-- (PLAN §3.2, §3.4). The base tables were declared in 0001; this migration adds
-- the columns the M2 implementation reads and the indexes its queries need.

-- resources: row revision time (distinct from created_at / deleted_at).
ALTER TABLE resources ADD COLUMN updated_at TEXT;

-- resource_versions: 0001 declared version_id UNIQUE across the whole table.
-- Version ids are derived from content (`v<n>-<digest[7:19]>`), so two
-- resources publishing identical trees legitimately share one id; uniqueness
-- holds per resource. The table was never written before this migration, so
-- it is rebuilt rather than migrated row by row.
DROP TABLE IF EXISTS resource_versions;
CREATE TABLE resource_versions (
  workspace_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  version_id TEXT NOT NULL,
  manifest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  created_by_member_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, resource_id, version),
  UNIQUE (workspace_id, resource_id, version_id)
);

-- pull_receipts: the receipt is persisted in full so a later audit can bind a
-- materialized mirror to the exact authorization that produced it.
ALTER TABLE pull_receipts ADD COLUMN resource_id TEXT;
ALTER TABLE pull_receipts ADD COLUMN owner_member_id TEXT;
ALTER TABLE pull_receipts ADD COLUMN version_id TEXT;
ALTER TABLE pull_receipts ADD COLUMN manifest_digest TEXT;
ALTER TABLE pull_receipts ADD COLUMN authorized_at TEXT;

CREATE INDEX IF NOT EXISTS resources_workspace_live ON resources (workspace_id, deleted_at);
CREATE INDEX IF NOT EXISTS team_projects_resource ON team_projects (workspace_id, resource_id);
CREATE INDEX IF NOT EXISTS pull_receipts_project ON pull_receipts (workspace_id, project_id, viewer_member_id);
