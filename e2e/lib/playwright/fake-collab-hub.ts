// Playwright/e2e lifecycle wrapper around `@/collab-hub-core`.
//
// The hub state machine, `vela` argv interpreter, HTTP handlers, and fake CLI
// script all live in `e2e/lib/collab-hub-core/`. This file only binds them to a
// listening node:http server and exposes the log-waiting helpers e2e specs use.

import {
  createCollabHubCore,
  listenCollabHub,
  writeFakeVelaBin,
  type ClientIdentity,
  type CollabHubCore,
  type CollabHubOptions,
  type CommandLog,
  type HubEvent,
} from '../collab-hub-core/index.ts';

export type {
  ClientIdentity,
  CommandLog,
  HubEvent,
  RequestLog,
  WorkspaceDirectoryEvent,
} from '../collab-hub-core/index.ts';

export type FakeCollabHub = {
  url: string;
  workspaceId: string;
  /** The framework-neutral core, for specs that need direct store access. */
  core: CollabHubCore;
  commandLog: CollabHubCore['commandLog'];
  eventLog: CollabHubCore['eventLog'];
  requestLog: CollabHubCore['requestLog'];
  writeVelaBin: (path: string) => Promise<string>;
  waitForCommand: (
    predicate: (entry: CommandLog) => boolean,
    timeoutMs?: number,
  ) => Promise<CommandLog>;
  waitForEvent: (
    predicate: (entry: HubEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<HubEvent>;
  setEventsAvailable: CollabHubCore['setEventsAvailable'];
  eventSubscriberCount: CollabHubCore['eventSubscriberCount'];
  emitEvent: CollabHubCore['emitEvent'];
  removeMember: CollabHubCore['removeMember'];
  setMemberRole: (memberId: string, role: ClientIdentity['role']) => void;
  addWorkspace: CollabHubCore['addWorkspace'];
  setAccountMembershipTier: CollabHubCore['setAccountMembershipTier'];
  setWorkspacePlan: CollabHubCore['setWorkspacePlan'];
  setWorkspaceBalance: CollabHubCore['setWorkspaceBalance'];
  close: () => Promise<void>;
};

export async function startFakeCollabHub(options: CollabHubOptions): Promise<FakeCollabHub> {
  const core = await createCollabHubCore(options);
  const listening = await listenCollabHub(core);

  return {
    url: listening.url,
    workspaceId: options.workspaceId,
    core,
    commandLog: core.commandLog,
    eventLog: core.eventLog,
    requestLog: core.requestLog,
    writeVelaBin: writeFakeVelaBin,
    waitForCommand: (predicate, timeoutMs = 15_000) =>
      waitForLog(core.commandLog, predicate, timeoutMs, 'Vela command'),
    waitForEvent: (predicate, timeoutMs = 15_000) =>
      waitForLog(core.eventLog, predicate, timeoutMs, 'workspace event'),
    setEventsAvailable: core.setEventsAvailable,
    eventSubscriberCount: core.eventSubscriberCount,
    emitEvent: core.emitEvent,
    removeMember: core.removeMember,
    setMemberRole: core.setMemberRole,
    addWorkspace: core.addWorkspace,
    setAccountMembershipTier: core.setAccountMembershipTier,
    setWorkspacePlan: core.setWorkspacePlan,
    setWorkspaceBalance: core.setWorkspaceBalance,
    close: async () => {
      // Close streams first so the HTTP server can drain its keep-alive sockets.
      const closeCore = core.close();
      await listening.close();
      await closeCore;
    },
  };
}

async function waitForLog<T>(
  values: T[],
  predicate: (entry: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = values.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}; observed ${JSON.stringify(values)}`);
}
