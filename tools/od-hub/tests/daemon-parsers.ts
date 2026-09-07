/**
 * Faithful copies of the daemon-side parsers that consume od-vela stdout.
 * tools/* must not import apps/daemon/src (root AGENTS.md boundary), so the
 * exact logic is reproduced here with the source location cited. If one of
 * these drifts from the daemon, the conformance test goes red for the wrong
 * reason — update the copy together with the daemon.
 */

// ---- apps/daemon/src/integrations/vela.ts:343-358 (parseVelaLoginActivation) ----
export function parseVelaLoginActivation(stdout: string, stderr: string) {
  const urlMatch = /Open this URL to continue:\s*\r?\n\s*(\S+)/i.exec(stdout);
  // Anchor on a line start so a `user_code=` query param inside the URL is not
  // mistaken for the dedicated `Code:` line.
  const codeMatch = /^[^\S\r\n]*Code:\s*(\S+)/im.exec(stdout);
  return {
    activationUrl: urlMatch?.[1] ?? null,
    userCode: codeMatch?.[1] ?? null,
    browserOpenFailed: /could not open browser automatically/i.test(stderr),
  };
}

// ---- apps/daemon/src/collab/vela-workspace-context.ts:57-66,196-219 ----------
const WORKSPACE_TYPES = new Set(['personal', 'team']);
const ROLES = new Set(['owner', 'admin', 'member']);
const MEMBER_STATUSES = new Set(['active', 'removed']);
const LIFECYCLE_STATES = new Set(['active', 'billing_past_due', 'locked', 'deleting', 'deleted']);
export function mapVelaWorkspaceDirectoryItem(input: unknown) {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const workspaceId = str(raw.workspaceId);
  const workspaceName = str(raw.workspaceName);
  const workspaceMemberId = str(raw.workspaceMemberId);
  if (!workspaceId || !workspaceName || !workspaceMemberId) return null;
  if (!WORKSPACE_TYPES.has(raw.workspaceType as string)) return null;
  if (!ROLES.has(raw.role as string)) return null;
  if (!MEMBER_STATUSES.has(raw.memberStatus as string)) return null;
  if (!LIFECYCLE_STATES.has(raw.lifecycleState as string)) return null;
  const item: Record<string, unknown> = {
    workspaceId,
    workspaceName,
    workspaceType: raw.workspaceType,
    workspaceMemberId,
    role: raw.role,
    memberStatus: raw.memberStatus,
    lifecycleState: raw.lifecycleState,
  };
  const workspaceIconKey = str(raw.workspaceIconKey);
  if (workspaceIconKey) item.workspaceIconKey = workspaceIconKey;
  return item;
}

// ---- apps/daemon/src/collab/hub-events-subscriber.ts:56-68,115-127,132-196 --
const HUB_EVENT_TYPES = new Set([
  'team-projects-changed', 'comment-changed', 'presence-changed', 'workspace-context-changed',
  'workspace-members-changed', 'billing-changed', 'billing-subscription-changed', 'wallet-balance-changed',
  'project-metadata-changed', 'project-content-changed', 'team-resources-changed',
]);
const HUB_WORKSPACE_MEMBER_CHANGES = new Set(['added', 'removed', 'updated']);
const HUB_RESOURCE_STATUSES = new Set(['shared', 'retracted']);
const HUB_WORKSPACE_DIRECTORY_CHANGES = new Set([
  'created', 'updated', 'deleted', 'membership-added', 'membership-updated', 'membership-removed',
]);
export function parseHubWorkspaceEvent(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed.type !== 'string' || !HUB_EVENT_TYPES.has(parsed.type)) return null;
    const event: Record<string, unknown> = { type: parsed.type };
    if (typeof parsed.workspaceId === 'string') event.workspaceId = parsed.workspaceId;
    if (typeof parsed.workspaceMemberId === 'string') event.workspaceMemberId = parsed.workspaceMemberId;
    if (typeof parsed.memberId === 'string') event.memberId = parsed.memberId;
    if (typeof parsed.memberChange === 'string' && HUB_WORKSPACE_MEMBER_CHANGES.has(parsed.memberChange)) {
      event.memberChange = parsed.memberChange;
    }
    if (typeof parsed.revision === 'string') event.revision = parsed.revision;
    // (revisionClock is parsed by the daemon too; no od-hub route emits it, so it is not mirrored here.)
    if (typeof parsed.projectId === 'string') event.projectId = parsed.projectId;
    if (typeof parsed.resourceId === 'string') event.resourceId = parsed.resourceId;
    if (typeof parsed.resourceKind === 'string') event.resourceKind = parsed.resourceKind;
    if (typeof parsed.resourceStatus === 'string' && HUB_RESOURCE_STATUSES.has(parsed.resourceStatus)) {
      event.resourceStatus = parsed.resourceStatus;
    }
    if (typeof parsed.seq === 'number') event.seq = parsed.seq;
    if (typeof parsed.version === 'number') event.version = parsed.version;
    if (typeof parsed.at === 'string') event.at = parsed.at;
    return event;
  } catch {
    return null;
  }
}
export function parseHubWorkspaceDirectoryEvent(data: string): Record<string, unknown> | null {
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw: unknown = JSON.parse(data);
    parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
  const workspaceId = typeof parsed?.workspaceId === 'string' ? parsed.workspaceId.trim() : '';
  const change = parsed?.change;
  if (
    parsed?.type !== 'workspace-directory-changed'
    || !workspaceId
    || typeof change !== 'string'
    || !HUB_WORKSPACE_DIRECTORY_CHANGES.has(change)
  ) {
    return null;
  }
  return { type: 'workspace-directory-changed', workspaceId, change, ...(typeof parsed.at === 'string' ? { at: parsed.at } : {}) };
}
// hub-events-subscriber.ts:222-244 parseHubListenerStatusRecord
export function parseHubListenerStatus(parsed: Record<string, unknown> | null) {
  if (!parsed) return null;
  const listenerEpoch = typeof parsed.listenerEpoch === 'string' ? parsed.listenerEpoch.trim() : '';
  const listenerHealth = parsed.listenerHealth;
  if (
    !listenerEpoch
    || (listenerHealth !== 'starting' && listenerHealth !== 'healthy' && listenerHealth !== 'reconnecting' && listenerHealth !== 'stopped')
    || typeof parsed.sourceGap !== 'boolean'
  ) {
    return null;
  }
  return { listenerEpoch, listenerHealth, sourceGap: parsed.sourceGap };
}

// ---- apps/daemon/src/collab/sync-digest.ts:88-101 (parseSyncDigest) ---------
export function parseSyncDigest(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { catalogToken, membersToken, contextToken, billingToken } = record;
  if (
    typeof catalogToken !== 'string' || typeof membersToken !== 'string'
    || typeof contextToken !== 'string' || typeof billingToken !== 'string'
  ) {
    return null;
  }
  return { catalogToken, membersToken, contextToken, billingToken };
}

// ---- apps/daemon/src/integrations/vela-billing.ts:258-281 ------------------
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function credits(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '0';
}
export function parseBillingSummary(stdout: string) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const balances = (raw.balances ?? {}) as Record<string, unknown>;
  return {
    workspaceId: null,
    membershipTier: str(raw.membershipTier),
    totalAvailableCredits: credits(balances.totalAvailableCredits),
    subscriptionCredits: credits(balances.subscriptionCredits),
    rechargeCredits: credits(balances.rechargeCredits),
    balanceUsd: str(raw.balanceUsd) || '0',
    subscriptionStatus: str(raw.subscriptionStatus),
    availableActions: Array.isArray(raw.availableActions)
      ? raw.availableActions.filter((a): a is string => typeof a === 'string')
      : [],
    workspaceBalance: null,
  };
}

// ---- apps/daemon/src/runtimes/defs/amr.ts:618-665 --------------------------
export function parseAmrBillingSummary(stdout: string): { plan: string; balanceUsd: string | null } {
  const data = JSON.parse(String(stdout)) as {
    balanceUsd?: unknown;
    totalAvailableCreditsUsd?: unknown;
    membershipTier?: unknown;
  };
  const balanceUsd =
    typeof data.balanceUsd === 'string'
      ? data.balanceUsd
      : typeof data.totalAvailableCreditsUsd === 'string'
        ? data.totalAvailableCreditsUsd
        : null;
  const tier =
    typeof data.membershipTier === 'string' && data.membershipTier.trim()
      ? data.membershipTier.trim()
      : 'free';
  return { plan: tier, balanceUsd };
}

// ---- apps/daemon/src/integrations/vela-billing.ts:319-393 ------------------
function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function objectRecord(v: unknown): Record<string, unknown> {
  return isObjectRecord(v) ? v : {};
}
function isNullableNonEmptyString(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim().length > 0);
}
// vela-billing.ts:476-483 / packages/contracts/src/api/collab.ts:243-249
const BILLING_STATES = new Set(['free', 'active', 'past_due', 'canceled', 'inactive', 'locked']);
function isNullableBillingState(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && BILLING_STATES.has(v));
}
export function parseWorkspaceBillingSnapshot(stdout: string, requestedWorkspaceId: string) {
  const requested = requestedWorkspaceId.trim();
  const trimmed = stdout.trim();
  if (!requested || !trimmed) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const workspaceId = str(raw.workspaceId).trim();
  const workspaceMemberId = str(raw.workspaceMemberId).trim();
  const billing = objectRecord(raw.billing);
  const wallet = objectRecord(raw.wallet);
  const revisions = objectRecord(raw.revisions);
  const balanceUsd = str(wallet.balanceUsd).trim();
  const billingRevision = str(revisions.billing).trim();
  const walletRevision = str(revisions.wallet).trim();
  if (
    raw.schemaVersion !== 1 ||
    raw.billingScopeVersion !== 2 ||
    !isObjectRecord(raw.billing) ||
    !isObjectRecord(raw.wallet) ||
    !isObjectRecord(raw.revisions) ||
    workspaceId !== requested ||
    !workspaceMemberId ||
    !balanceUsd ||
    !billingRevision ||
    !walletRevision ||
    !isNullableBillingState(billing.billingState) ||
    !isNullableNonEmptyString(billing.planId) ||
    !isNullableNonEmptyString(wallet.expiresAt) ||
    !isNullableNonEmptyString(wallet.updatedAt)
  ) {
    return null;
  }
  return { workspaceId, workspaceMemberId, balanceUsd, billingRevision, walletRevision };
}

// ---- apps/daemon/src/integrations/vela-billing.ts:539-553 ------------------
export function isWorkspaceBillingSnapshotUnsupported(message: string, stderr: string): boolean {
  const detail = [stderr, message].join('\n').toLowerCase();
  return (
    detail.includes('billing_workspace_snapshot_unsupported') ||
    detail.includes('workspace billing snapshot unsupported') ||
    detail.includes('unknown flag: --workspace-id') ||
    (detail.includes('unknown command') && detail.includes('workspace-snapshot'))
  );
}

// ---- apps/daemon/src/collab/vela-cli-team-projects.ts:499-505 --------------
export function isExactTeamProjectLookupUnavailable(message: string): boolean {
  return /unknown command ["']?(?:get|team-projects)["']?/i.test(message) ||
    /unknown flag:\s*--json/i.test(message) ||
    /API request failed with status 404(?!\s*:)/i.test(message);
}

// ---- apps/daemon/src/runtimes/defs/amr.ts:133-165 --------------------------
export function parseVelaModelJson(stdout: string, expectedSource: 'remote' | 'preset'): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid vela model JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid vela model JSON: expected object');
  }
  const source = (parsed as { source?: unknown }).source;
  if (source !== expectedSource) {
    throw new Error(`Invalid vela model JSON source: expected ${expectedSource}, got ${String(source)}`);
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('Invalid vela model JSON: expected data array');
  }
  return data;
}

// ---- apps/daemon/src/runtimes/defs/amr.ts:116-131 --------------------------
export function parseVelaModels(stdout: string): string[] {
  const models: string[] = [];
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [rawId] = trimmed.split(/\s+/);
    if (rawId) models.push(rawId);
  }
  return models;
}

// ---- apps/daemon/src/media/vela.ts:187-191 (parseJsonObject + models) ------
export function parseMediaModels(stdout: string): unknown[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('media models: expected a JSON object');
  }
  const models = (parsed as { models?: unknown }).models;
  return Array.isArray(models) ? models : [];
}

// ---- apps/daemon/src/collab/*/amr-terminal-report-outbox.ts:288-363 --------
export function parseTerminalReceipt(
  stdout: string,
  record: { runId: string; outcome: string; terminalAt: string },
): 'ok' | 'invalid_receipt' {
  const raw = JSON.parse(stdout) as Record<string, unknown>;
  if (
    raw.runId !== record.runId ||
    raw.outcome !== record.outcome ||
    typeof raw.terminalAt !== 'string' ||
    Date.parse(raw.terminalAt) !== Date.parse(record.terminalAt) ||
    typeof raw.recorded !== 'boolean'
  ) {
    return 'invalid_receipt';
  }
  return 'ok';
}

/** Regex from PLAN §6.3 / vela-cli-resource-adapter error classification. */
export const API_FAILURE_LINE = /^Error: [a-z][a-z0-9 -]*: API request failed with status (\d{3}): ([a-z_]+)$/;
