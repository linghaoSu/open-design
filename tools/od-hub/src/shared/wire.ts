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
