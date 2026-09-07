import type { WorkspaceBillingRow, WorkspaceLifecycleState, WorkspaceMemberRow, WorkspaceMemberStatus, WorkspaceRole, WorkspaceRow } from './store.js';

/**
 * The rich `currentWorkspaceContext` returned by invite accept / continuation
 * consume, shaped exactly as `mapVelaWorkspaceContext`
 * (apps/daemon/src/collab/vela-workspace-context.ts:116-182) reads it. Every
 * enum value below is one the daemon accepts; a field it re-derives locally
 * (`seatSummary.availableSeats`, `isSeatFull`, `teamId`) is deliberately not
 * sent.
 */
export interface WorkspaceContextWire {
  workspaceId: string;
  workspaceMemberId: string;
  workspaceType: 'personal' | 'team';
  workspaceName: string;
  displayName?: string;
  role: WorkspaceRole;
  memberStatus: WorkspaceMemberStatus;
  lifecycleState: WorkspaceLifecycleState;
  providerMode: 'platform_credits';
  billingState: string;
  planId: string;
  /**
   * od-hub has no seats. `0/0` is the daemon's unknown-capacity sentinel
   * (contracts collab.ts:279-291 workspaceSeatCapacityState): anything else
   * with `seatLimit: 0` re-derives to `isSeatFull: true` and
   * EntryNavRail.workspaceInviteEnabled hides the invite form from admins.
   */
  seatSummary: { seatLimit: 0; usedSeats: 0 };
  permissions: WorkspacePermissionsWire;
}

export interface WorkspacePermissionsWire {
  canManageMembers: boolean;
  canManageBilling: boolean;
  canInviteMembers: boolean;
  canManageAutoRecharge: boolean;
  canShareProjects: boolean;
  canWriteSyncedFiles: boolean;
  canViewWorkspaceSettings: boolean;
  canManageSharedResources: boolean;
}

// ---- packages/contracts/src/api/collab.ts:407-409 (isWorkspaceLifecycleReadable)
function isWorkspaceLifecycleReadable(state: WorkspaceLifecycleState): boolean {
  return state !== 'deleted';
}

// ---- packages/contracts/src/api/collab.ts:462-464 (isWorkspaceLifecycleWritable)
function isWorkspaceLifecycleWritable(state: WorkspaceLifecycleState): boolean {
  return state === 'active';
}

/**
 * Verbatim copy of `buildWorkspacePermissions`
 * (packages/contracts/src/api/collab.ts:466-489). tools/od-hub has no workspace
 * dependency on @open-design/contracts (adding one would touch the lockfile),
 * so the logic is reproduced here with its source cited; the daemon accepts
 * the object only when all eight keys are booleans, and otherwise re-derives
 * it with the same function, so the two must agree.
 */
export function buildWorkspacePermissions(input: {
  role: WorkspaceRole;
  lifecycleState: WorkspaceLifecycleState;
  memberStatus?: WorkspaceMemberStatus;
}): WorkspacePermissionsWire {
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

export function toWorkspaceContextWire(input: {
  workspace: WorkspaceRow;
  membership: WorkspaceMemberRow;
  billing: WorkspaceBillingRow;
}): WorkspaceContextWire {
  const { workspace, membership, billing } = input;
  const context: WorkspaceContextWire = {
    workspaceId: workspace.id,
    workspaceMemberId: membership.memberId,
    workspaceType: workspace.gitlabKind,
    workspaceName: workspace.name,
    role: membership.role,
    memberStatus: membership.memberStatus,
    lifecycleState: workspace.lifecycleState,
    providerMode: 'platform_credits',
    billingState: billing.billingState,
    planId: billing.planId,
    seatSummary: { seatLimit: 0, usedSeats: 0 },
    permissions: buildWorkspacePermissions({ role: membership.role, lifecycleState: workspace.lifecycleState, memberStatus: membership.memberStatus }),
  };
  if (membership.displayName?.trim()) context.displayName = membership.displayName.trim();
  return context;
}
