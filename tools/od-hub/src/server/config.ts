/**
 * Environment-driven hub configuration (PLAN §5, §8.2). Parsed once at startup;
 * every value has a documented default so a hub without GitLab (dev seed only)
 * still boots. `parseHubConfig` is pure so tests can feed it a plain object.
 */

import path from 'node:path';

export type WorkspaceGroupMode = 'top-level' | 'include-subgroups';

export interface HubConfig {
  /** GitLab origin, e.g. `https://gitlab.example.com`. Null disables the OAuth routes (501). */
  gitlabUrl: string | null;
  gitlabClientId: string | null;
  /** Optional: public OAuth applications have no secret. */
  gitlabClientSecret: string | null;
  /** Minimum GitLab access_level that yields a directory row (default 20 = Reporter). */
  gitlabMinAccessLevel: number;
  workspaceGroupMode: WorkspaceGroupMode;
  /** Origin the CLI should store as `apiUrl` after login. */
  publicUrl: string | null;
  /** Gateway origin written as `linkUrl`; falls back to `publicUrl`. */
  llmGatewayUrl: string | null;
  /** 32-byte key (base64) for AES-256-GCM envelope encryption of GitLab tokens; null = ephemeral. */
  tokenEncKey: Buffer | null;
  /** Sliding control/runtime key lifetime. */
  controlKeyTtlMs: number;
  /** How long a GitLab group listing is reused per user before re-fetching. */
  directoryCacheMs: number;
  /** How long a removed membership row stays visible with memberStatus=removed. */
  removedRetentionMs: number;
  /** Root of the content-addressed blob store (`BLOB_DIR`; default `<OD_HUB_DATA_DIR|.tmp/od-hub>/blobs`). */
  blobDir: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function trimmed(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  return v ? v : null;
}

function stripSlash(value: string | null): string | null {
  return value ? value.replace(/\/+$/, '') : null;
}

/**
 * Blob-root override from the `od-hub start` command line. `BLOB_DIR` (env)
 * keeps precedence so a deployment that pins it is never surprised by a flag;
 * otherwise `--blob-dir`, then a `blobs/` directory next to the SQLite file
 * (both back up together). Returns undefined to keep the `parseHubConfig`
 * default.
 */
export function resolveBlobDirFlag(flag: string | undefined, sqlite: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (trimmed(env.BLOB_DIR)) return undefined;
  if (trimmed(flag)) return trimmed(flag)!;
  const file = trimmed(sqlite);
  if (file && file !== ':memory:') return path.join(path.dirname(path.resolve(file)), 'blobs');
  return undefined;
}

export function parseHubConfig(env: NodeJS.ProcessEnv): HubConfig {
  const minAccess = Number.parseInt(env.GITLAB_MIN_ACCESS_LEVEL ?? '20', 10);
  if (!Number.isInteger(minAccess) || minAccess < 0) throw new Error('GITLAB_MIN_ACCESS_LEVEL must be a non-negative integer');
  const ttlDays = Number.parseFloat(env.CONTROL_KEY_TTL_DAYS ?? '30');
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) throw new Error('CONTROL_KEY_TTL_DAYS must be a positive number');
  const modeRaw = trimmed(env.GITLAB_WORKSPACE_GROUP_MODE) ?? 'top-level';
  if (modeRaw !== 'top-level' && modeRaw !== 'include-subgroups') {
    throw new Error('GITLAB_WORKSPACE_GROUP_MODE must be top-level or include-subgroups');
  }
  let tokenEncKey: Buffer | null = null;
  const rawKey = trimmed(env.TOKEN_ENC_KEY);
  if (rawKey) {
    tokenEncKey = Buffer.from(rawKey, 'base64');
    if (tokenEncKey.length !== 32) throw new Error('TOKEN_ENC_KEY must decode to exactly 32 bytes (base64)');
  }
  return {
    gitlabUrl: stripSlash(trimmed(env.GITLAB_URL)),
    gitlabClientId: trimmed(env.GITLAB_OAUTH_CLIENT_ID),
    gitlabClientSecret: trimmed(env.GITLAB_OAUTH_CLIENT_SECRET),
    gitlabMinAccessLevel: minAccess,
    workspaceGroupMode: modeRaw,
    publicUrl: stripSlash(trimmed(env.HUB_PUBLIC_URL)),
    llmGatewayUrl: stripSlash(trimmed(env.LLM_GATEWAY_URL)),
    tokenEncKey,
    controlKeyTtlMs: Math.round(ttlDays * DAY_MS),
    directoryCacheMs: 60_000,
    removedRetentionMs: 7 * DAY_MS,
    blobDir: trimmed(env.BLOB_DIR) ?? path.join(trimmed(env.OD_HUB_DATA_DIR) ?? path.join('.tmp', 'od-hub'), 'blobs'),
  };
}
