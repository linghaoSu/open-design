import { createHash, randomBytes } from 'node:crypto';

import type { ApiKeyKind } from './store.js';

/** sha256 hex digest of a presented bearer token. Only the hash is persisted. */
export function hashApiKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a new control/runtime key secret. The `odc_`/`odr_` prefixes follow
 * PLAN §0 so operators can tell which kind leaked from a log line.
 */
export function mintApiKeySecret(kind: ApiKeyKind): string {
  const prefix = kind === 'control' ? 'odc_' : 'odr_';
  return `${prefix}${randomBytes(24).toString('base64url')}`;
}

/**
 * Stable member id for one (user x workspace) pair (PLAN §3.1). The daemon
 * requires this value to be identical wherever it appears (directory,
 * `billing workspace-snapshot`, collab member registry), so it is derived,
 * never generated: `m_<sha256(userId:workspaceId)[:24]>`.
 */
export function deriveMemberId(userId: string, workspaceId: string): string {
  return `m_${createHash('sha256').update(`${userId}:${workspaceId}`).digest('hex').slice(0, 24)}`;
}

/** Deterministic api key row id for a given hash so re-seeding is idempotent. */
export function apiKeyIdFromHash(keyHash: string): string {
  return `key_${keyHash.slice(0, 16)}`;
}

/** Opaque digest token; content is by contract meaningless to the daemon. */
export function newDigestToken(): string {
  return randomBytes(12).toString('base64url');
}

export function isoNow(now: Date = new Date()): string {
  return now.toISOString();
}
