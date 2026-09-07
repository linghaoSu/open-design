/**
 * Verbatim copies of the daemon-side parse/validate functions that consume
 * `od-vela resource *` / `od-vela team-projects *` stdout. tools/* must not
 * import apps/daemon/src (root AGENTS.md boundary), so each block reproduces
 * the exact logic and cites the source location. If one of these drifts from
 * the daemon, the conformance test goes red for the wrong reason: update the
 * copy together with the daemon.
 *
 * Only the type aliases are inlined (the daemon's interfaces live in modules
 * this file cannot import); function bodies are byte-for-byte the daemon's.
 */

// ---- apps/daemon/src/collab/vela-cli-resource-adapter.ts:303-306 (isMissingResourceError)
export function isMissingResourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /resource_not_found|status\s+404|ref_not_found/u.test(message);
}

// ---- apps/daemon/src/collab/vela-cli-resource-adapter.ts:316-319 (isRetractedHubResourceError)
export function isRetractedHubResourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /resource_not_found/u.test(message);
}

// ---- apps/daemon/src/collab/vela-cli-resource-adapter.ts:324-343 (parseVersion)
interface VelaVersionRecord {
  id?: unknown;
  version?: unknown;
  versionId?: unknown;
}
export function parseVersion(
  stdout: string,
): { version: number; versionId?: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as VelaVersionRecord;
  if (parsed.version == null) return null;
  if (typeof parsed.version !== 'number') {
    throw new Error('vela resource response has an invalid version');
  }
  const versionId = typeof parsed.versionId === 'string' && parsed.versionId.trim()
    ? parsed.versionId.trim()
    : typeof parsed.id === 'string' && parsed.id.trim()
      ? parsed.id.trim()
      : null;
  return {
    version: parsed.version,
    ...(versionId ? { versionId } : {}),
  };
}

// ---- apps/daemon/src/collab/vela-cli-resource-pull-batcher.ts:25-32, 76-120 (flush settlement)
// The daemon settles per-item promises inside `flush`; this copy keeps the same
// parse + duplicate/omission/ok/error decisions and returns them as a Map so a
// test can assert what each caller would have observed.
interface PullBatchResult {
  results?: Array<{
    key?: unknown;
    ok?: unknown;
    error?: unknown;
    errorCode?: unknown;
  }>;
}
export type PullBatchVerdict = { ok: true } | { ok: false; error: Error };
export function settlePullBatch(stdout: string, keys: readonly string[]): Map<string, PullBatchVerdict> {
  const verdicts = new Map<string, PullBatchVerdict>();
  const rejectAll = (error: Error) => {
    for (const key of keys) verdicts.set(key, { ok: false, error });
    return verdicts;
  };

  let parsed: PullBatchResult;
  try {
    parsed = JSON.parse(stdout) as PullBatchResult;
  } catch {
    return rejectAll(new Error('vela resource pull-batch returned invalid JSON'));
  }
  if (!Array.isArray(parsed.results)) {
    return rejectAll(new Error('vela resource pull-batch response is missing results'));
  }

  const results = new Map<string, NonNullable<PullBatchResult['results']>[number]>();
  const duplicateKeys = new Set<string>();
  for (const result of parsed.results) {
    if (typeof result.key !== 'string') continue;
    if (results.has(result.key)) duplicateKeys.add(result.key);
    else results.set(result.key, result);
  }
  for (const key of keys) {
    const result = results.get(key);
    if (duplicateKeys.has(key)) {
      verdicts.set(key, { ok: false, error: new Error(`vela resource pull-batch duplicated result ${key}`) });
    } else if (!result) {
      verdicts.set(key, { ok: false, error: new Error(`vela resource pull-batch omitted result ${key}`) });
    } else if (result.ok === true) {
      verdicts.set(key, { ok: true });
    } else {
      const message =
        typeof result.error === 'string' && result.error.trim()
          ? result.error
          : 'vela resource pull-batch item failed';
      const code =
        typeof result.errorCode === 'string' && result.errorCode.trim()
          ? ` (${result.errorCode})`
          : '';
      verdicts.set(key, { ok: false, error: new Error(`${message}${code}`) });
    }
  }
  return verdicts;
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:58-69 (TeamProjectWire)
type TeamProjectWire = {
  projectId?: unknown;
  resourceId?: unknown;
  ownerMemberId?: unknown;
  displayName?: unknown;
  syncState?: unknown;
  lastSyncedVersionId?: unknown;
  publishedVersionId?: unknown;
  metadata?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type VelaTeamProjectSyncState = 'pending_upload' | 'syncing' | 'synced' | 'failed';

interface VelaTeamProjectRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  resourceId: string;
  ownerMemberId: string;
  displayName: string | null;
  syncState: VelaTeamProjectSyncState;
  lastSyncedVersionId: string | null;
  publishedVersionId?: string | null;
  createdAt: string;
  originProjectUpdatedAt: number | null;
  updatedAt: string;
  access: { canView: boolean; canComment: boolean; canEdit: boolean; frozen: boolean };
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:407-462 (toVelaTeamProjectRecord)
export function toVelaTeamProjectRecord(input: unknown): VelaTeamProjectRecord | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as TeamProjectWire & {
    id?: unknown;
    workspaceId?: unknown;
    access?: unknown;
    lastSyncedVersionId?: unknown;
  };
  if (
    typeof record.id !== 'string' ||
    typeof record.workspaceId !== 'string' ||
    typeof record.projectId !== 'string' ||
    typeof record.resourceId !== 'string' ||
    typeof record.ownerMemberId !== 'string' ||
    typeof record.syncState !== 'string' ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null;
  }
  const access = record.access && typeof record.access === 'object' && !Array.isArray(record.access)
    ? record.access as Partial<VelaTeamProjectRecord['access']>
    : {};
  const metadata = recordObject(record.metadata);
  const originProjectUpdatedAt = metadata?.updatedAt;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    resourceId: record.resourceId,
    ownerMemberId: record.ownerMemberId,
    displayName: typeof record.displayName === 'string' ? record.displayName : null,
    syncState: toVelaSyncState(record.syncState),
    lastSyncedVersionId: typeof record.lastSyncedVersionId === 'string' ? record.lastSyncedVersionId : null,
    ...(Object.hasOwn(record, 'publishedVersionId')
      ? {
          publishedVersionId:
            typeof record.publishedVersionId === 'string' && record.publishedVersionId.trim()
              ? record.publishedVersionId.trim()
              : null,
        }
      : {}),
    createdAt: record.createdAt,
    originProjectUpdatedAt:
      typeof originProjectUpdatedAt === 'number' && Number.isFinite(originProjectUpdatedAt)
        ? originProjectUpdatedAt
        : null,
    updatedAt: record.updatedAt,
    access: {
      canView: access.canView ?? true,
      canComment: access.canComment ?? true,
      canEdit: access.canEdit ?? false,
      frozen: access.frozen ?? false,
    },
  };
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:464-476 (hasReadablePublishedVersion)
export function hasReadablePublishedVersion(record: TeamProjectWire): boolean {
  if (Object.hasOwn(record, 'publishedVersionId')) {
    return typeof record.publishedVersionId === 'string'
      && record.publishedVersionId.trim().length > 0;
  }
  // The original team-project response did not include publication fields or
  // sync state. Preserve its established visibility until Vela explicitly
  // supplies one of the newer publication signals.
  if (typeof record.syncState !== 'string') return true;
  return record.syncState === 'synced'
    || (typeof record.lastSyncedVersionId === 'string'
      && record.lastSyncedVersionId.trim().length > 0);
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:478-481 (toVelaSyncState)
function toVelaSyncState(value: string): VelaTeamProjectSyncState {
  if (value === 'syncing' || value === 'synced' || value === 'failed') return value;
  return 'pending_upload';
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:483-487 (recordObject)
function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:489-491 (isAuthoritativeTeamProjectNotFound)
export function isAuthoritativeTeamProjectNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('team_project_not_found');
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:582-591 (isSharedProjectResource)
export function isSharedProjectResource(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const resource = value as Record<string, unknown>;
  return resource.kind === 'project' &&
    typeof resource.id === 'string' &&
    typeof resource.teamId === 'string' &&
    typeof resource.ownerMemberId === 'string' &&
    typeof resource.createdAt === 'string' &&
    (resource.deletedAt === null || resource.deletedAt === undefined);
}

// ---- apps/daemon/src/integrations/vela-team-projects.ts:52-62 (projectResourceIdFor)
export function projectResourceIdFor(
  projectId: string,
  principal?: { teamId: string; memberId: string } | null,
): string {
  if (!principal) return `project-${projectId}`;
  const scoped = Buffer.from(
    JSON.stringify([principal.teamId, principal.memberId, projectId]),
    'utf8',
  ).toString('base64url');
  return `project-${scoped}`;
}

// ---- apps/daemon/src/collab/authorized-team-project-pull.ts:13-14, 26-41, 80-133 (receipt)
const RECEIPT_MAX_AGE_MS = 2_000;
const MANIFEST_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export class AuthorizedTeamProjectPullReceiptExpiredError extends Error {
  readonly code = 'AUTHORIZED_TEAM_PROJECT_PULL_RECEIPT_EXPIRED';
}

export interface AuthorizedTeamProjectPullReceipt {
  schemaVersion: 1;
  workspaceId: string;
  resourceTeamId: string;
  viewerMemberId: string;
  ownerMemberId: string;
  projectId: string;
  resourceId: string;
  ref: 'published';
  version: number;
  versionId: string;
  manifestDigest: string;
  lifecycleState: 'active';
  authorizedAt: string;
  expiresAt: string;
}

/** routes/collab-sync.ts TeamMirrorPullScope — only the fields validateReceipt reads. */
export interface TeamMirrorPullScope {
  workspaceId: string;
  resourceTeamId: string;
  viewerMemberId: string;
  ownerMemberId: string;
}

interface ReceiptValidationInput {
  projectId: string;
  scope: TeamMirrorPullScope;
  expectedVersion: number;
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`authorized pull receipt has invalid ${key}`);
  }
  return value;
}

// ---- apps/daemon/src/collab/authorized-team-project-pull.ts:102-133 (parseReceipt)
export function parseReceipt(stdout: string): AuthorizedTeamProjectPullReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error('authorized pull response is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('authorized pull response must be an object');
  }
  const version = parsed.version;
  if (!Number.isSafeInteger(version) || Number(version) < 0) {
    throw new Error('authorized pull receipt has invalid version');
  }
  return {
    schemaVersion: parsed.schemaVersion as 1,
    workspaceId: requiredString(parsed, 'workspaceId'),
    resourceTeamId: requiredString(parsed, 'resourceTeamId'),
    viewerMemberId: requiredString(parsed, 'viewerMemberId'),
    ownerMemberId: requiredString(parsed, 'ownerMemberId'),
    projectId: requiredString(parsed, 'projectId'),
    resourceId: requiredString(parsed, 'resourceId'),
    ref: parsed.ref as 'published',
    version: Number(version),
    versionId: requiredString(parsed, 'versionId'),
    manifestDigest: requiredString(parsed, 'manifestDigest'),
    lifecycleState: parsed.lifecycleState as 'active',
    authorizedAt: requiredString(parsed, 'authorizedAt'),
    expiresAt: requiredString(parsed, 'expiresAt'),
  };
}

// ---- apps/daemon/src/collab/authorized-team-project-pull.ts:135-184 (validateAuthorizedTeamProjectPullReceipt)
export function validateReceipt(
  receipt: AuthorizedTeamProjectPullReceipt,
  input: ReceiptValidationInput,
): void {
  const expectedResourceId = projectResourceIdFor(input.projectId, {
    teamId: input.scope.resourceTeamId,
    memberId: input.scope.ownerMemberId,
  });
  if (receipt.schemaVersion !== 1) {
    throw new Error('authorized pull receipt has unsupported schemaVersion');
  }
  if (
    receipt.workspaceId !== input.scope.workspaceId ||
    receipt.resourceTeamId !== input.scope.resourceTeamId ||
    receipt.viewerMemberId !== input.scope.viewerMemberId ||
    receipt.ownerMemberId !== input.scope.ownerMemberId ||
    receipt.projectId !== input.projectId ||
    receipt.resourceId !== expectedResourceId ||
    receipt.ref !== 'published' ||
    receipt.version !== input.expectedVersion
  ) {
    throw new Error('authorized pull receipt binding does not match the pull');
  }
  if (
    !receipt.versionId.trim() ||
    !MANIFEST_DIGEST_PATTERN.test(receipt.manifestDigest) ||
    receipt.lifecycleState !== 'active' ||
    receipt.ownerMemberId === receipt.viewerMemberId
  ) {
    throw new Error('authorized pull receipt binding is incomplete');
  }
  const authorizedAt = Date.parse(receipt.authorizedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  const nowMs = input.nowMs ?? Date.now();
  if (
    !Number.isFinite(authorizedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= authorizedAt ||
    expiresAt - authorizedAt > RECEIPT_MAX_AGE_MS
  ) {
    throw new Error('authorized pull receipt is stale');
  }
  if (nowMs >= expiresAt) {
    throw new AuthorizedTeamProjectPullReceiptExpiredError(
      'authorized pull receipt is stale',
    );
  }
}

// ---- apps/daemon/src/collab/authorized-team-project-pull.ts:186-193 (isAuthorizedTeamProjectPullUnavailable)
export function isAuthorizedTeamProjectPullUnavailable(
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown command ["']?pull["']?.*team-projects/iu.test(message) ||
    /unknown command ["']?team-projects["']?/iu.test(message) ||
    /unknown flag:\s*--(?:expected-version|live-dir|ref|json)\b/iu.test(message);
}
