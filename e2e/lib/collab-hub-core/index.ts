// Public surface of the collaboration hub core.
//
// Pure TypeScript: no Playwright, no Vitest. Consumers:
//   - `e2e/lib/playwright/fake-collab-hub.ts` (thin lifecycle wrapper)
//   - `e2e/lib/collab-hub-core/conformance.ts` (contract assertions)
//   - a future self-hosted hub under `tools/od-hub`

export * from './types.ts';
export { DEFAULT_PRESENCE_TTL_MS, InMemoryHubStore, latestSeq, type HubStore } from './store.ts';
export {
  AUTHORIZED_PULL_RECEIPT_TTL_MS,
  FAKE_VELA_VERSION,
  handleCommand,
  type CommandContext,
} from './commands.ts';
export {
  HUB_CAPABILITIES_BASIC,
  HUB_CAPABILITIES_STRICT,
  STRICT_HEARTBEAT_INTERVAL_MS,
  createCollabHubCore,
  personalWorkspaceId,
  sseFrame,
  type CollabHubCore,
} from './hub.ts';
export { fakeVelaScript, writeFakeVelaBin } from './vela-script.ts';
export {
  listenCollabHub,
  toHubRequest,
  writeHubResponse,
  type ListeningHubServer,
} from './node-http.ts';
export { computeSnapshotManifest, type SnapshotManifest } from './snapshots.ts';
