// Framework-neutral wire and state types for the collaboration hub core.
//
// This module must not import Playwright, Vitest, or node:http. Everything in
// here is shared between the in-process fake hub used by e2e, the conformance
// suite that can target a real hub, and (eventually) a self-hosted hub server.

export type HubMemberRole = 'owner' | 'admin' | 'member';

export type ClientIdentity = {
  controlKey: string;
  memberId: string;
  name: string;
  role: HubMemberRole;
};

export type TeamProjectAccess = {
  canView: boolean;
  canComment: boolean;
  canEdit: boolean;
  frozen: boolean;
};

export type TeamProjectRecord = {
  id: string;
  workspaceId: string;
  projectId: string;
  resourceId: string;
  ownerMemberId: string;
  displayName: string | null;
  syncState: string;
  lastSyncedVersionId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  access: TeamProjectAccess;
};

export type ResourceVersion = {
  version: number;
  versionId: string;
  /** Directory holding the materialized snapshot for this version. */
  snapshotDir: string;
  /** `sha256:<64 hex>` digest over the sorted manifest of the snapshot. */
  manifestDigest: string;
  /** Number of regular files in the snapshot. */
  manifestEntryCount: number;
};

export type ResourceRecord = {
  workspaceId: string;
  projectId: string | null;
  resourceId: string;
  kind: string;
  ownerMemberId: string;
  metadata: Record<string, unknown> | null;
  /** Latest published version number. */
  version: number;
  versions: Map<number, ResourceVersion>;
};

export type PresenceEntry = {
  memberId: string;
  displayName: string;
  role: HubMemberRole;
  filePath: string | null;
  heartbeatAt: string;
  activity?: unknown;
  avatarUrl?: string | null;
};

export type CommentRecord = Record<string, unknown> & { projectId: string; seq: number };

export type AccountBilling = {
  membershipTier: string;
  balanceUsd: string;
  revision: number;
};

export type WorkspaceBilling = {
  billingState: string;
  planId: string | null;
  revision: number;
};

export type WorkspaceBalance = {
  balanceUsd: string;
  revision: number;
};

export type AddedWorkspace = {
  workspaceId: string;
  workspaceName: string;
  workspaceMemberId: string;
};

export type WorkspaceDirectoryItem = {
  workspaceId: string;
  workspaceName: string;
  workspaceType: 'team' | 'personal';
  workspaceMemberId: string;
  role: HubMemberRole;
  memberStatus: 'active' | 'removed';
  lifecycleState: 'active';
};

export type HubEvent = {
  type: string;
  workspaceId: string;
  workspaceMemberId?: string;
  /** `workspace-members-changed`: the affected member and what happened to them. */
  memberId?: string;
  memberChange?: 'added' | 'updated' | 'removed';
  projectId?: string;
  resourceId?: string;
  resourceKind?: string;
  resourceStatus?: 'shared' | 'retracted';
  revision?: string;
  version?: number;
};

export type WorkspaceDirectoryEvent = {
  type: 'workspace-directory-changed';
  workspaceId: string;
  change:
    | 'created'
    | 'updated'
    | 'deleted'
    | 'membership-added'
    | 'membership-updated'
    | 'membership-removed';
  at: string;
};

export type SyncDigest = {
  catalogToken: string;
  membersToken: string;
  contextToken: string;
  billingToken: string;
};

export type CommandLog = {
  args: string[];
  memberId: string;
  workspaceId: string;
};

export type RequestLog = {
  method: string;
  path: string;
  memberId: string | null;
  workspaceId: string;
};

/** Options describing one hub workspace and the accounts allowed to reach it. */
export type CollabHubOptions = {
  /** Scratch directory where resource snapshots are materialized. */
  root: string;
  workspaceId: string;
  workspaceName: string;
  clients: readonly ClientIdentity[];
  includePersonalWorkspace?: boolean;
  /** Opt into the producer-health contract used by authority-cache E2E. */
  strictAuthorityEvents?: boolean;
  /** Presence heartbeat lease. Entries older than this are swept from rosters. */
  presenceTtlMs?: number;
};

// ---------------------------------------------------------------------------
// Request / response abstraction
// ---------------------------------------------------------------------------

/** Minimal request view the hub handlers need; adapters map real servers onto it. */
export type HubRequest = {
  method: string;
  /** Path portion only (no query string). */
  path: string;
  /** Lower-cased header names; multi-valued headers reduced to the first value. */
  headers: Record<string, string | undefined>;
  /** Lazily read the full request body as UTF-8 text. */
  readBody: () => Promise<string>;
};

export type HubJsonResponse = {
  kind: 'json';
  status: number;
  body: unknown;
};

/** A live stream sink; the adapter owns the socket, the core owns the frames. */
export type StreamSink = {
  write: (chunk: string) => void;
  end: () => void;
  /** Register a callback that fires when the peer disconnects. */
  onClose: (callback: () => void) => void;
};

export type HubStreamResponse = {
  kind: 'stream';
  status: number;
  headers: Record<string, string>;
  /** Called once the adapter has flushed headers and can accept writes. */
  open: (sink: StreamSink) => void;
};

export type HubResponse = HubJsonResponse | HubStreamResponse;

/** Result of interpreting one `vela` argv against the hub. */
export type CommandResult = {
  stdout: string;
};

/**
 * Thrown by command handlers. The message becomes the fake CLI's stderr; the
 * daemon classifies failures purely by message text (see plan §6.3).
 */
export class HubCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubCommandError';
  }
}
