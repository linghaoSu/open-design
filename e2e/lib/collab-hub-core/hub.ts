// Framework-neutral hub: HTTP handlers, SSE fan-out, control operations.
//
// `createCollabHubCore` owns the state machine and produces `HubResponse`
// values from `HubRequest`s. It does not open sockets; adapters (node:http for
// e2e, a real server framework for tools/od-hub) translate to and from their
// own request/response types. The `/__e2e/*` control surface is included here
// because the fake `vela` script depends on `/__e2e/command`; a real hub simply
// does not mount it.

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { handleCommand } from './commands.ts';
import { InMemoryHubStore, type HubStore } from './store.ts';
import type {
  ClientIdentity,
  CollabHubOptions,
  CommandLog,
  HubEvent,
  HubMemberRole,
  HubRequest,
  HubResponse,
  RequestLog,
  StreamSink,
  WorkspaceDirectoryEvent,
  WorkspaceDirectoryItem,
} from './types.ts';

export const HUB_CAPABILITIES_STRICT = [
  'authoritative-project-presence-v1',
  'workspace-member-events-v1',
  'workspace-event-listener-status-v1',
  'billing-revision-clocks-v1',
  'workspace-directory-events-v1',
] as const;

export const HUB_CAPABILITIES_BASIC = [
  'authoritative-project-presence-v1',
  'workspace-directory-events-v1',
] as const;

export const STRICT_HEARTBEAT_INTERVAL_MS = 5_000;

type Subscriber = {
  sink: StreamSink;
  workspaceId: string;
  memberId: string;
  heartbeat: ReturnType<typeof setInterval> | null;
};

export type CollabHubCore = {
  readonly options: CollabHubOptions;
  readonly store: HubStore;
  readonly workspaceId: string;
  readonly commandLog: CommandLog[];
  readonly eventLog: HubEvent[];
  readonly requestLog: RequestLog[];
  /** Interpret one request. Never throws; internal errors become 500 JSON. */
  handleRequest: (request: HubRequest) => Promise<HubResponse>;
  /** Directory rows the authenticated account sees on `GET /api/v1/workspaces`. */
  directoryFor: (identity: ClientIdentity) => WorkspaceDirectoryItem[];
  emitEvent: (event: HubEvent) => void;
  setEventsAvailable: (memberId: string, available: boolean) => void;
  eventSubscriberCount: (memberId: string) => number;
  removeMember: (memberId: string) => void;
  setMemberRole: (memberId: string, role: HubMemberRole) => void;
  addWorkspace: (memberId: string, workspaceId: string, workspaceName: string) => void;
  setAccountMembershipTier: (memberId: string, membershipTier: string) => void;
  setWorkspacePlan: (planId: string, billingState?: string) => void;
  setWorkspaceBalance: (memberId: string, balanceUsd: string) => void;
  /** Close every stream and remove materialized snapshots. */
  close: () => Promise<void>;
};

export async function createCollabHubCore(
  options: CollabHubOptions,
  store: HubStore = new InMemoryHubStore({
    workspaceId: options.workspaceId,
    clients: options.clients,
    ...(options.presenceTtlMs === undefined ? {} : { presenceTtlMs: options.presenceTtlMs }),
  }),
): Promise<CollabHubCore> {
  const resourcesRoot = join(options.root, 'resources');
  await mkdir(resourcesRoot, { recursive: true });

  const subscribers = new Set<Subscriber>();
  const blockedEventMembers = new Set<string>();
  const commandLog: CommandLog[] = [];
  const eventLog: HubEvent[] = [];
  const requestLog: RequestLog[] = [];

  const closeSubscriber = (subscriber: Subscriber): void => {
    if (subscriber.heartbeat) clearInterval(subscriber.heartbeat);
    subscriber.heartbeat = null;
    subscribers.delete(subscriber);
    subscriber.sink.end();
  };

  function emit(event: HubEvent): void {
    eventLog.push(event);
    store.noteEvent(event);
    const frame = sseFrame('workspace-event', event);
    for (const subscriber of subscribers) {
      if (subscriber.workspaceId === event.workspaceId) subscriber.sink.write(frame);
    }
  }

  function emitDirectory(memberId: string, event: WorkspaceDirectoryEvent): void {
    const frame = sseFrame('workspace-directory-changed', event);
    for (const subscriber of subscribers) {
      if (subscriber.memberId === memberId) subscriber.sink.write(frame);
    }
  }

  function directoryFor(identity: ClientIdentity): WorkspaceDirectoryItem[] {
    // This is a membership directory for the authenticated app user, not a
    // workspace roster. Two clients in the same workspace each receive their
    // own one membership row.
    return [
      ...(store.isRemoved(identity.memberId)
        ? [personalWorkspaceDirectoryItem(identity)]
        : options.includePersonalWorkspace
          ? [personalWorkspaceDirectoryItem(identity), workspaceDirectoryItem(options, identity)]
          : [workspaceDirectoryItem(options, identity)]),
      ...store.addedWorkspaces(identity.memberId).map(addedWorkspaceDirectoryItem),
    ];
  }

  function openEventStream(identity: ClientIdentity, workspaceId: string): HubResponse {
    return {
      kind: 'stream',
      status: 200,
      headers: {
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      },
      open: (sink) => {
        const subscriber: Subscriber = {
          sink,
          workspaceId,
          memberId: identity.memberId,
          heartbeat: null,
        };
        subscribers.add(subscriber);
        const listenerStatus = {
          listenerEpoch: `fake-hub-${identity.memberId}`,
          listenerHealth: 'healthy',
          sourceGap: false,
        } as const;
        sink.write(sseFrame('ready', {
          workspaceId,
          capabilities: options.strictAuthorityEvents
            ? [...HUB_CAPABILITIES_STRICT]
            : [...HUB_CAPABILITIES_BASIC],
          ...(options.strictAuthorityEvents ? listenerStatus : {}),
        }));
        if (options.strictAuthorityEvents) {
          const writeHeartbeat = () => {
            if (!subscribers.has(subscriber)) return;
            sink.write(sseFrame('heartbeat', listenerStatus));
          };
          // `ready` is deliberately not sufficient for authority health. The
          // immediate post-ready heartbeat proves the producer listener has
          // crossed its membership revalidation boundary.
          writeHeartbeat();
          subscriber.heartbeat = setInterval(writeHeartbeat, STRICT_HEARTBEAT_INTERVAL_MS);
          subscriber.heartbeat.unref?.();
        }
        sink.onClose(() => {
          if (subscribers.has(subscriber)) closeSubscriber(subscriber);
        });
      },
    };
  }

  async function handleRequest(request: HubRequest): Promise<HubResponse> {
    try {
      const identity = identityFor(request.headers.authorization, store);
      const workspaceId = request.headers['x-vela-workspace-id'] || options.workspaceId;
      requestLog.push({
        method: request.method,
        path: request.path,
        memberId: identity?.memberId ?? null,
        workspaceId,
      });

      // --- e2e control plane --------------------------------------------------
      if (request.path === '/__e2e/stats' && request.method === 'GET') {
        return json(200, {
          commands: commandLog,
          events: eventLog,
          requests: requestLog,
          subscribers: [...subscribers].map((subscriber) => ({
            memberId: subscriber.memberId,
            workspaceId: subscriber.workspaceId,
          })),
        });
      }
      if (request.path === '/__e2e/event' && request.method === 'POST') {
        emit(await readJson(request) as HubEvent);
        return json(200, { ok: true });
      }
      if (request.path === '/__e2e/events-available' && request.method === 'POST') {
        const body = await readJson(request) as { available?: unknown; memberId?: unknown };
        const memberId = typeof body.memberId === 'string' ? body.memberId.trim() : '';
        if (!memberId || typeof body.available !== 'boolean') {
          return json(400, { error: 'invalid_events_available_input' });
        }
        setEventsAvailable(memberId, body.available);
        return json(200, { ok: true });
      }
      if (request.path === '/__e2e/command' && request.method === 'POST') {
        if (!identity) return json(401, { error: 'unauthorized' });
        if (store.isRemoved(identity.memberId)) {
          return json(403, { error: 'workspace_membership_removed' });
        }
        const body = await readJson(request) as { args?: unknown; stdin?: unknown };
        const args = Array.isArray(body.args)
          ? body.args.filter((value): value is string => typeof value === 'string')
          : [];
        const stdin = typeof body.stdin === 'string' ? body.stdin : '';
        commandLog.push({ args, memberId: identity.memberId, workspaceId });
        const stdout = await handleCommand({
          args,
          stdin,
          identity,
          workspaceId,
          store,
          resourcesRoot,
          emit,
        });
        return json(200, { stdout });
      }

      // --- daemon-facing API --------------------------------------------------
      if (request.path === '/api/v1/workspaces' && request.method === 'GET') {
        if (!identity) return json(401, { error: 'unauthorized' });
        return json(200, { items: directoryFor(identity) });
      }
      if (request.path === '/api/v1/collab/events' && request.method === 'GET') {
        if (!identity) return json(401, { error: 'unauthorized' });
        if (blockedEventMembers.has(identity.memberId)) {
          return json(503, { error: 'event_stream_unavailable' });
        }
        return openEventStream(identity, workspaceId);
      }
      if (request.path === '/api/v1/collab/sync-digest' && request.method === 'GET') {
        if (!identity) return json(401, { error: 'unauthorized' });
        if (store.isRemoved(identity.memberId)) {
          return json(403, { error: 'workspace_not_authorized' });
        }
        return json(200, store.syncDigest(workspaceId));
      }
      if (request.path === '/api/v1/wallet/balance' && request.method === 'GET') {
        if (!identity) return json(401, { error: 'unauthorized' });
        const billing = store.accountBilling(identity.memberId);
        return json(200, {
          balanceUsd: billing.balanceUsd,
          updatedAt: new Date().toISOString(),
        });
      }
      return json(404, { error: 'not_found', path: request.path });
    } catch (error) {
      return json(500, {
        error: 'fake_hub_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function setEventsAvailable(memberId: string, available: boolean): void {
    if (available) {
      blockedEventMembers.delete(memberId);
      return;
    }
    blockedEventMembers.add(memberId);
    for (const subscriber of [...subscribers]) {
      if (subscriber.memberId === memberId) closeSubscriber(subscriber);
    }
  }

  function assertKnownMember(memberId: string): void {
    if (!store.hasMember(memberId)) {
      throw new Error(`unknown fake collaboration member: ${memberId}`);
    }
  }

  return {
    options,
    store,
    workspaceId: options.workspaceId,
    commandLog,
    eventLog,
    requestLog,
    handleRequest,
    directoryFor,
    emitEvent: emit,
    setEventsAvailable,
    eventSubscriberCount: (memberId) =>
      [...subscribers].filter((subscriber) => subscriber.memberId === memberId).length,
    removeMember: (memberId) => {
      store.markRemoved(memberId);
      store.evictMemberPresence(memberId);
      emit({ type: 'workspace-context-changed', workspaceId: options.workspaceId });
      emit({
        type: 'workspace-members-changed',
        workspaceId: options.workspaceId,
        memberId,
        memberChange: 'removed',
      });
      // The removed account's own streams learn about the revocation and are
      // closed; other members observe it through `workspace-context-changed`
      // and `workspace-members-changed`.
      const frame = sseFrame('access-revoked', { reason: 'workspace_membership_removed' });
      for (const subscriber of [...subscribers]) {
        if (subscriber.memberId !== memberId) continue;
        subscriber.sink.write(frame);
        closeSubscriber(subscriber);
      }
    },
    setMemberRole: (memberId, role) => {
      assertKnownMember(memberId);
      store.setRole(memberId, role);
      emit({ type: 'workspace-context-changed', workspaceId: options.workspaceId });
    },
    addWorkspace: (memberId, workspaceId, workspaceName) => {
      assertKnownMember(memberId);
      store.addWorkspace(memberId, {
        workspaceId,
        workspaceName,
        workspaceMemberId: `member-${memberId}-${workspaceId}`,
      });
      // Account-directory invalidation rides any existing Workspace stream for
      // this account; the new Workspace itself need not be subscribed yet.
      emitDirectory(memberId, {
        type: 'workspace-directory-changed',
        workspaceId,
        change: 'created',
        at: new Date().toISOString(),
      });
    },
    setAccountMembershipTier: (memberId, membershipTier) => {
      const previous = store.accountBilling(memberId);
      const revision = previous.revision + 1;
      store.setAccountBilling(memberId, { ...previous, membershipTier, revision });
      emit({
        type: 'billing-changed',
        workspaceId: options.workspaceId,
        revision: `account-${memberId}-${revision}`,
      });
    },
    setWorkspacePlan: (planId, billingState = 'active') => {
      const previous = store.workspaceBilling(options.workspaceId);
      const revision = previous.revision + 1;
      store.setWorkspaceBilling(options.workspaceId, { billingState, planId, revision });
      emit({
        type: 'billing-subscription-changed',
        workspaceId: options.workspaceId,
        revision: `billing-${revision}`,
      });
    },
    setWorkspaceBalance: (memberId, balanceUsd) => {
      const previous = store.workspaceBalance(options.workspaceId, memberId);
      const revision = previous.revision + 1;
      store.setWorkspaceBalance(options.workspaceId, memberId, { balanceUsd, revision });
      emit({
        type: 'wallet-balance-changed',
        workspaceId: options.workspaceId,
        workspaceMemberId: memberId,
        revision: `wallet-${revision}`,
      });
    },
    close: async () => {
      for (const subscriber of [...subscribers]) closeSubscriber(subscriber);
      await rm(resourcesRoot, { force: true, recursive: true });
    },
  };
}

// ---------------------------------------------------------------------------
// directory rows
// ---------------------------------------------------------------------------

function workspaceDirectoryItem(
  options: { workspaceId: string; workspaceName: string },
  identity: ClientIdentity,
): WorkspaceDirectoryItem {
  return {
    workspaceId: options.workspaceId,
    workspaceName: options.workspaceName,
    workspaceType: 'team',
    workspaceMemberId: identity.memberId,
    role: identity.role,
    memberStatus: 'active',
    lifecycleState: 'active',
  };
}

function addedWorkspaceDirectoryItem(workspace: {
  workspaceId: string;
  workspaceName: string;
  workspaceMemberId: string;
}): WorkspaceDirectoryItem {
  return {
    ...workspace,
    workspaceType: 'team',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
  };
}

export function personalWorkspaceId(memberId: string): string {
  return `personal-${memberId}`;
}

function personalWorkspaceDirectoryItem(identity: ClientIdentity): WorkspaceDirectoryItem {
  return {
    workspaceId: personalWorkspaceId(identity.memberId),
    workspaceName: `${identity.name} workspace`,
    workspaceType: 'personal',
    workspaceMemberId: `personal-member-${identity.memberId}`,
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function identityFor(authorization: string | undefined, store: HubStore): ClientIdentity | null {
  const key = authorization?.replace(/^Bearer\s+/i, '').trim();
  return key ? store.identityForControlKey(key) : null;
}

function json(status: number, body: unknown): HubResponse {
  return { kind: 'json', status, body };
}

async function readJson(request: HubRequest): Promise<unknown> {
  const text = await request.readBody();
  return text ? JSON.parse(text) : {};
}
