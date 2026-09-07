/**
 * Verbatim copies of the daemon-side code that consumes the invite endpoints:
 * the create/consume outcome mapping and `mapVelaWorkspaceContext`. tools/* must
 * not import apps/daemon/src (root AGENTS.md boundary), so each block reproduces
 * the exact logic and cites the source location. Only type aliases and the
 * `@open-design/contracts` helpers it calls are inlined; function bodies are the
 * daemon's. `resolveWorkspaceSettingsUrl` (workspace-context.ts:192-226) reads
 * the daemon's console-origin env and is replaced by a stub returning undefined
 * — the hub never sends `workspaceSettingsUrl`, so the branch is inert here.
 */

export type WorkspaceType = 'personal' | 'team';
export type CollabMemberRole = 'owner' | 'admin' | 'member';
export type WorkspaceMemberStatus = 'active' | 'removed';
export type WorkspaceLifecycleState = 'active' | 'billing_past_due' | 'locked' | 'deleting' | 'deleted';
export type WorkspaceBillingState = 'free' | 'active' | 'past_due' | 'canceled' | 'inactive' | 'locked';
export type WorkspaceProviderMode = 'platform_credits' | 'personal_byok';

export interface WorkspaceSeatSummary {
  seatLimit: number;
  usedSeats: number;
  availableSeats: number;
  isSeatFull: boolean;
}

export interface WorkspacePermissions {
  canManageMembers: boolean;
  canManageBilling: boolean;
  canInviteMembers: boolean;
  canManageAutoRecharge: boolean;
  canShareProjects: boolean;
  canWriteSyncedFiles: boolean;
  canViewWorkspaceSettings: boolean;
  canManageSharedResources: boolean;
}

export interface WorkspaceCollabContext {
  workspaceId: string;
  workspaceType: WorkspaceType;
  workspaceMemberId: string;
  role: CollabMemberRole;
  memberStatus: WorkspaceMemberStatus;
  lifecycleState: WorkspaceLifecycleState;
  billingState: WorkspaceBillingState;
  planId: string | null;
  providerMode: WorkspaceProviderMode;
  seatSummary: WorkspaceSeatSummary;
  permissions: WorkspacePermissions;
  billingRecovery?: { canEnterBillingRecovery: boolean; recoveryUrl: string | null };
  lastActiveWorkspaceId?: string;
  workspaceSettingsUrl?: string;
  teamId?: string;
  workspaceName?: string;
  teamName?: string;
  displayName?: string;
}

// ---- packages/contracts/src/api/collab.ts:407-409, 462-464 ------------------------
export function isWorkspaceLifecycleReadable(state: WorkspaceLifecycleState): boolean {
  return state !== 'deleted';
}
export function isWorkspaceLifecycleWritable(state: WorkspaceLifecycleState): boolean {
  return state === 'active';
}

// ---- packages/contracts/src/api/collab.ts:466-489 (buildWorkspacePermissions) -------
export function buildWorkspacePermissions(input: {
  role: CollabMemberRole;
  lifecycleState: WorkspaceLifecycleState;
  memberStatus?: WorkspaceMemberStatus;
}): WorkspacePermissions {
  const memberStatus = input.memberStatus ?? 'active';
  const readable =
    memberStatus === 'active' && isWorkspaceLifecycleReadable(input.lifecycleState);
  const writable =
    memberStatus === 'active' && isWorkspaceLifecycleWritable(input.lifecycleState);
  const isOwner = input.role === 'owner';
  const isAdmin = input.role === 'admin';
  return {
    canManageMembers: writable && (isOwner || isAdmin),
    canManageBilling: readable && isOwner,
    canInviteMembers: writable && (isOwner || isAdmin),
    canManageAutoRecharge: writable && isOwner,
    canShareProjects: writable,
    canWriteSyncedFiles: writable,
    canViewWorkspaceSettings: readable,
    canManageSharedResources: writable && (isOwner || isAdmin),
  };
}

// ---- packages/contracts/src/api/collab.ts:491-501 (buildWorkspaceSeatSummary) -------
export function buildWorkspaceSeatSummary(input: {
  seatLimit: number;
  usedSeats: number;
}): WorkspaceSeatSummary {
  const availableSeats = Math.max(input.seatLimit - input.usedSeats, 0);
  return {
    seatLimit: input.seatLimit,
    usedSeats: input.usedSeats,
    availableSeats,
    isSeatFull: availableSeats === 0,
  };
}

// ---- packages/contracts/src/api/collab.ts:283-291 (workspaceSeatCapacityState) ------
export function workspaceSeatCapacityState(
  summary: WorkspaceSeatSummary | null | undefined,
): 'available' | 'full' | 'unknown' {
  if (summary == null || (summary.seatLimit === 0 && summary.usedSeats === 0)) {
    return 'unknown';
  }
  return summary.isSeatFull ? 'full' : 'available';
}

// ---- apps/daemon/src/collab/vela-workspace-context.ts:57-75 ---------------------------
const WORKSPACE_TYPES = new Set<WorkspaceType>(['personal', 'team']);
const ROLES = new Set<CollabMemberRole>(['owner', 'admin', 'member']);
const MEMBER_STATUSES = new Set<WorkspaceMemberStatus>(['active', 'removed']);
const LIFECYCLE_STATES = new Set<WorkspaceLifecycleState>([
  'active',
  'billing_past_due',
  'locked',
  'deleting',
  'deleted',
]);
const BILLING_STATES = new Set<WorkspaceBillingState>([
  'free',
  'active',
  'past_due',
  'canceled',
  'inactive',
  'locked',
]);
const PROVIDER_MODES = new Set<WorkspaceProviderMode>(['platform_credits', 'personal_byok']);

// ---- apps/daemon/src/collab/workspace-context.ts:192-226 — stub (see file header) -----
function resolveWorkspaceSettingsUrl(
  _workspaceId: string,
  _explicit: unknown,
  _env: NodeJS.ProcessEnv,
  _configuredEnv: Record<string, string>,
): string | undefined {
  return undefined;
}

// ---- apps/daemon/src/collab/vela-workspace-context.ts:116-182 (mapVelaWorkspaceContext)
export function mapVelaWorkspaceContext(
  input: unknown,
  configuredEnv: Record<string, string> = {},
): WorkspaceCollabContext | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  const workspaceId = str(raw.workspaceId);
  const workspaceMemberId = str(raw.workspaceMemberId);
  if (!workspaceId || !workspaceMemberId) return null;
  if (!WORKSPACE_TYPES.has(raw.workspaceType as WorkspaceType)) return null;
  if (!ROLES.has(raw.role as CollabMemberRole)) return null;
  if (!MEMBER_STATUSES.has(raw.memberStatus as WorkspaceMemberStatus)) return null;
  if (!LIFECYCLE_STATES.has(raw.lifecycleState as WorkspaceLifecycleState)) return null;
  if (!PROVIDER_MODES.has(raw.providerMode as WorkspaceProviderMode)) return null;

  const workspaceType = raw.workspaceType as WorkspaceType;
  const role = raw.role as CollabMemberRole;
  const memberStatus = raw.memberStatus as WorkspaceMemberStatus;
  const lifecycleState = raw.lifecycleState as WorkspaceLifecycleState;
  const billingState = BILLING_STATES.has(raw.billingState as WorkspaceBillingState)
    ? raw.billingState as WorkspaceBillingState
    : billingStateFromLifecycle(lifecycleState);

  const context: WorkspaceCollabContext = {
    workspaceId,
    workspaceType,
    workspaceMemberId,
    role,
    memberStatus,
    lifecycleState,
    billingState,
    planId: str(raw.planId) || null,
    providerMode: raw.providerMode as WorkspaceProviderMode,
    seatSummary: parseSeatSummary(raw.seatSummary),
    permissions:
      parsePermissions(raw.permissions) ??
      buildWorkspacePermissions({ role, lifecycleState, memberStatus }),
  };
  const billingRecovery = parseBillingRecovery(raw.billingRecovery);
  if (billingRecovery) context.billingRecovery = billingRecovery;
  const lastActive = str(raw.lastActiveWorkspaceId);
  if (lastActive) context.lastActiveWorkspaceId = lastActive;
  // The team workspace IS the team scope; carry its id as teamId so the resource
  // hub principal derives from this one context.
  const settingsUrl = resolveWorkspaceSettingsUrl(
    workspaceId,
    (raw as { workspaceSettingsUrl?: unknown }).workspaceSettingsUrl,
    process.env,
    configuredEnv,
  );
  if (settingsUrl) context.workspaceSettingsUrl = settingsUrl;

  if (workspaceType === 'team') {
    context.teamId = workspaceId;
  }
  const workspaceName = str((raw as { workspaceName?: unknown }).workspaceName);
  // B names EVERY workspace, personal included, so the name belongs on the
  // context for both types — that is what lets a surface label the current
  // workspace off the startup context alone. `teamName` stays team-only: it is
  // the team switcher's field and doubles as an "is a team" signal.
  if (workspaceName) context.workspaceName = workspaceName;
  if (workspaceName && workspaceType === 'team') context.teamName = workspaceName;
  const displayName = str((raw as { displayName?: unknown }).displayName);
  if (displayName) context.displayName = displayName;
  return context;
}

// ---- apps/daemon/src/collab/vela-workspace-context.ts:935-993 ---------------------------
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function billingStateFromLifecycle(
  lifecycleState: WorkspaceLifecycleState,
): WorkspaceBillingState {
  if (lifecycleState === 'billing_past_due') return 'past_due';
  if (lifecycleState === 'locked') return 'locked';
  if (lifecycleState === 'deleting' || lifecycleState === 'deleted') {
    return 'inactive';
  }
  return 'active';
}

function parseSeatSummary(value: unknown): WorkspaceSeatSummary {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    if (typeof raw.seatLimit === 'number' && typeof raw.usedSeats === 'number') {
      // Re-derive availableSeats/isSeatFull from the authoritative counts so a
      // stale or inconsistent summary can never disagree with itself.
      return buildWorkspaceSeatSummary({ seatLimit: raw.seatLimit, usedSeats: raw.usedSeats });
    }
  }
  return buildWorkspaceSeatSummary({ seatLimit: 0, usedSeats: 0 });
}

export function parsePermissions(value: unknown): WorkspacePermissions | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const keys: (keyof WorkspacePermissions)[] = [
    'canManageMembers',
    'canManageBilling',
    'canInviteMembers',
    'canManageAutoRecharge',
    'canShareProjects',
    'canWriteSyncedFiles',
    'canViewWorkspaceSettings',
    'canManageSharedResources',
  ];
  const permissions = {} as WorkspacePermissions;
  for (const key of keys) {
    if (typeof raw[key] !== 'boolean') return null;
    permissions[key] = raw[key] as boolean;
  }
  return permissions;
}

function parseBillingRecovery(
  value: unknown,
): { canEnterBillingRecovery: boolean; recoveryUrl: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.canEnterBillingRecovery !== 'boolean') return null;
  return {
    canEnterBillingRecovery: raw.canEnterBillingRecovery,
    recoveryUrl: typeof raw.recoveryUrl === 'string' ? raw.recoveryUrl : null,
  };
}

// ---- apps/daemon/src/collab/invite-continue.ts:64-75 (response handling) ----------------
export type InviteContinueOutcome =
  | { ok: true; context: WorkspaceCollabContext | null; workspaceMemberId: string }
  | { ok: false; status: number; error: string };

export async function consumeOutcomeFromResponse(response: Response, configuredEnv: Record<string, string> = {}): Promise<InviteContinueOutcome> {
  if (!response.ok) {
    return { ok: false, status: response.status, error: `continuation_${response.status}` };
  }
  const body = (await response.json()) as {
    workspaceMemberId?: unknown;
    currentWorkspaceContext?: unknown;
  };
  return {
    ok: true,
    context: mapVelaWorkspaceContext(body.currentWorkspaceContext, configuredEnv),
    workspaceMemberId: typeof body.workspaceMemberId === 'string' ? body.workspaceMemberId : '',
  };
}

// ---- packages/contracts/src/api/workspace-invites.ts:34-72 ------------------------------
export const WORKSPACE_INVITE_CREATE_ERROR_CODES = [
  'already_member',
  'active_pending_invite',
  'workspace_seat_limit_reached',
  'workspace_subscription_seat_allocation_unavailable',
] as const;
export type WorkspaceInviteCreateErrorCode = (typeof WORKSPACE_INVITE_CREATE_ERROR_CODES)[number];
const WORKSPACE_INVITE_CREATE_ERROR_ALIASES: Readonly<Record<string, WorkspaceInviteCreateErrorCode>> = {
  already_member: 'already_member',
  invite_existing_member: 'already_member',
  active_pending_invite: 'active_pending_invite',
  invite_duplicate: 'active_pending_invite',
  workspace_seat_limit_reached: 'workspace_seat_limit_reached',
  workspace_subscription_seat_allocation_unavailable:
    'workspace_subscription_seat_allocation_unavailable',
};
export function normalizeWorkspaceInviteCreateErrorCode(
  value: unknown,
): WorkspaceInviteCreateErrorCode | null {
  return typeof value === 'string'
    ? WORKSPACE_INVITE_CREATE_ERROR_ALIASES[value] ?? null
    : null;
}

// ---- apps/daemon/src/collab/invite-create.ts:80-104 (response handling) -----------------
export type CreateInviteOutcome =
  | { ok: true; inviteId: string }
  | { ok: false; status: number; error: string };

export async function createOutcomeFromResponse(response: Response): Promise<CreateInviteOutcome> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { code?: unknown; error?: unknown }
      | null;
    const typedError =
      normalizeWorkspaceInviteCreateErrorCode(body?.code) ??
      normalizeWorkspaceInviteCreateErrorCode(body?.error);
    return {
      ok: false,
      status: response.status,
      error: typedError ?? `create_${response.status}`,
    };
  }
  const body = (await response.json().catch(() => null)) as
    | { inviteId?: unknown; id?: unknown }
    | null;
  const inviteId =
    typeof body?.inviteId === 'string'
      ? body.inviteId
      : typeof body?.id === 'string'
        ? body.id
        : '';
  return { ok: true, inviteId };
}

// ---- packages/contracts/src/api/workspace-invites.ts:236-262, 310-350 -------------------
export const WORKSPACE_INVITE_ERROR_CODES = [
  'invite_expired',
  'invite_consumed',
  'workspace_seat_limit_reached',
  'workspace_subscription_locked',
  'workspace_not_found',
  'workspace_forbidden',
] as const;
export type WorkspaceInviteErrorCode = (typeof WORKSPACE_INVITE_ERROR_CODES)[number];
export const WORKSPACE_INVITE_ERROR_STATUS: Record<WorkspaceInviteErrorCode, number> = {
  invite_expired: 410,
  invite_consumed: 409,
  workspace_seat_limit_reached: 409,
  workspace_subscription_locked: 409,
  workspace_not_found: 404,
  workspace_forbidden: 403,
};
export function isWorkspaceInviteErrorCode(value: unknown): value is WorkspaceInviteErrorCode {
  return (
    typeof value === 'string' &&
    (WORKSPACE_INVITE_ERROR_CODES as readonly string[]).includes(value)
  );
}
export function resolveWorkspaceInviteError(input: {
  status: number;
  code?: string | null;
}): WorkspaceInviteErrorCode | null {
  if (isWorkspaceInviteErrorCode(input.code)) return input.code;
  switch (input.status) {
    case 410:
      return 'invite_expired';
    case 404:
      return 'workspace_not_found';
    case 403:
      return 'workspace_forbidden';
    case 409:
      return 'invite_consumed';
    default:
      return null;
  }
}

export const INVITE_DEEPLINK_SCHEME = 'opendesign' as const;
export const INVITE_DEEPLINK_PATH = 'workspace/invite/continue' as const;
export interface InviteDeeplinkPayload {
  workspaceId: string;
  memberId: string;
  inviteId: string;
  nonce: string;
}
export function parseInviteDeeplink(url: string): InviteDeeplinkPayload | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${INVITE_DEEPLINK_SCHEME}:`) return null;
  // Non-special scheme: `opendesign://workspace/invite/continue` parses to
  // host='workspace', pathname='/invite/continue'. Recombine and strip any
  // trailing slash before comparing to the fixed authority+path.
  const path = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
  if (path !== INVITE_DEEPLINK_PATH) return null;
  const workspaceId = parsed.searchParams.get('workspace_id')?.trim() ?? '';
  const memberId = parsed.searchParams.get('member_id')?.trim() ?? '';
  const inviteId = parsed.searchParams.get('invite_id')?.trim() ?? '';
  const nonce = parsed.searchParams.get('nonce')?.trim() ?? '';
  if (!workspaceId || !memberId || !inviteId || !nonce) return null;
  return { workspaceId, memberId, inviteId, nonce };
}

// ---- apps/daemon/src/collab/vela-cli-resource-adapter.ts:345-362 (parseVelaResourceSnapshot)
export interface VelaResourceSnapshotRecord {
  slug: string;
  name: string;
  kind: string;
  versionId: string;
  createdAt: string;
}
export function parseVelaResourceSnapshot(stdout: string): VelaResourceSnapshotRecord | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<VelaResourceSnapshotRecord>;
    return typeof parsed.slug === 'string' && parsed.slug
      ? {
          slug: parsed.slug,
          name: typeof parsed.name === 'string' ? parsed.name : '',
          kind: typeof parsed.kind === 'string' ? parsed.kind : '',
          versionId: typeof parsed.versionId === 'string' ? parsed.versionId : '',
          createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
        }
      : null;
  } catch {
    return null;
  }
}

// ---- apps/daemon/src/routes/collab-sync.ts:563-565, 627-630 (publicSnapshotFileUrl) -----------
function encodePublicFileUrlPath(filePath: string): string {
  return filePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}
export function publicSnapshotFileUrl(baseUrl: string, slug: string, filePath: string): string {
  const relative = `/api/v1/public/snapshots/${encodeURIComponent(slug)}/files/${encodePublicFileUrlPath(filePath)}`;
  return new URL(relative, baseUrl).toString();
}
