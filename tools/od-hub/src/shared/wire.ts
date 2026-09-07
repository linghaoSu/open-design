/**
 * Wire constants shared by the hub server and the od-vela shim. Each value is
 * pinned to the daemon parser that consumes it; change them only together
 * with that parser.
 */

/** apps/daemon/src/runtimes/defs/amr.ts:672 — `vela --version` is probed for presence only. */
export const OD_VELA_VERSION = 'vela 0.0.35-odhub';

/**
 * SSE `ready` capabilities, apps/daemon/src/collab/hub-events-subscriber.ts:46-54.
 * Order matches the strict fake hub in e2e/lib/playwright/fake-collab-hub.ts.
 */
export const HUB_CAPABILITIES = [
  'authoritative-project-presence-v1',
  'workspace-member-events-v1',
  'workspace-event-listener-status-v1',
  'billing-revision-clocks-v1',
  'workspace-directory-events-v1',
] as const;

/** Heartbeat cadence; the daemon watchdog fires at 45s (hub-events-subscriber.ts:220-244). */
export const HUB_HEARTBEAT_INTERVAL_MS = 10_000;

/** Header the daemon and the shim send to scope a request to one workspace. */
export const WORKSPACE_HEADER = 'x-vela-workspace-id';
export const INVOCATION_SOURCE_HEADER = 'x-vela-invocation-source';

/** apps/daemon/src/routes/vela.ts:75 */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * `vela billing summary --format json` stub. Must satisfy BOTH daemon parsers:
 * - apps/daemon/src/runtimes/defs/amr.ts:618-665 reads `balanceUsd` (string) and `membershipTier`.
 * - apps/daemon/src/integrations/vela-billing.ts:258-281 reads `balances.*`, `subscriptionStatus`, `availableActions`.
 */
export const BILLING_SUMMARY_STUB = {
  membershipTier: 'team',
  balanceUsd: '999999',
  totalAvailableCreditsUsd: '999999',
  balances: {
    totalAvailableCredits: '999999',
    subscriptionCredits: '999999',
    rechargeCredits: '0',
  },
  subscriptionStatus: 'active',
  availableActions: [] as string[],
};

/** Error code emitted for every not-yet-implemented or deliberately closed surface. */
export const NOT_SUPPORTED_CODE = 'not_supported';

/**
 * SSE frame names consumed by apps/daemon/src/collab/hub-events-subscriber.ts:541-663.
 * `workspace-directory-changed` is its OWN frame (line 632), not a
 * `workspace-event` payload type.
 */
export const SSE_EVENT_READY = 'ready';
export const SSE_EVENT_HEARTBEAT = 'heartbeat';
export const SSE_EVENT_WORKSPACE = 'workspace-event';
export const SSE_EVENT_DIRECTORY = 'workspace-directory-changed';
export const SSE_EVENT_ACCESS_REVOKED = 'access-revoked';

/** `access-revoked` reason, mirrors e2e/lib/collab-hub-core/hub.ts:315 (daemon logs it, server.ts:5872). */
export const ACCESS_REVOKED_MEMBERSHIP_REMOVED = 'workspace_membership_removed';

/** hub-events-subscriber.ts:56-68 — the `type` union parseHubWorkspaceEvent accepts. */
export const HUB_WORKSPACE_EVENT_TYPES = [
  'team-projects-changed',
  'comment-changed',
  'presence-changed',
  'workspace-context-changed',
  'workspace-members-changed',
  'billing-changed',
  'billing-subscription-changed',
  'wallet-balance-changed',
  'project-metadata-changed',
  'project-content-changed',
  'team-resources-changed',
] as const;
export type HubWorkspaceEventType = (typeof HUB_WORKSPACE_EVENT_TYPES)[number];

/** hub-events-subscriber.ts:120-127 — `change` values parseHubWorkspaceDirectoryEvent accepts. */
export const HUB_DIRECTORY_CHANGES = [
  'created',
  'updated',
  'deleted',
  'membership-added',
  'membership-updated',
  'membership-removed',
] as const;
export type HubDirectoryChange = (typeof HUB_DIRECTORY_CHANGES)[number];

/** hub-events-subscriber.ts:115-119 — `memberChange` values. */
export type HubMemberChange = 'added' | 'removed' | 'updated';

/**
 * `vela login` stdout contract, apps/daemon/src/integrations/vela.ts:332-358
 * (parseVelaLoginActivation). The URL line must follow the header line; the
 * `Code:` line must start a line of its own so the `user_code=` query param
 * inside the URL is never mistaken for it.
 */
export const LOGIN_ACTIVATION_HEADER = 'Open this URL to continue:';
export const LOGIN_CODE_PREFIX = 'Code: ';
/** vela.ts:355 — stderr marker the daemon turns into `browserOpenFailed`. */
export const LOGIN_BROWSER_OPEN_FAILED_PREFIX = 'could not open browser automatically: ';
/** mocks/lib/vela-subcommands.mjs:97 / apps/daemon/tests/fixtures/fake-vela.mjs — final stdout line (not parsed by the daemon). */
export const loginSuccessLine = (email: string): string => `Login successful for ${email}.`;

/**
 * Device-flow polling statuses on POST /api/v1/auth/device/token (RFC 8628 §3.5
 * codes carried in `{error}`): `authorization_pending` -> 428, `slow_down` -> 429,
 * `access_denied` / `expired_token` -> 400.
 */
export const DEVICE_FLOW_PENDING_STATUS = 428;
export const DEVICE_FLOW_SLOW_DOWN_STATUS = 429;
