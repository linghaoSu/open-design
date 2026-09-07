import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  HUB_CAPABILITIES,
  HUB_HEARTBEAT_INTERVAL_MS,
  NOT_SUPPORTED_CODE,
  WORKSPACE_HEADER,
  WORKSPACE_ID_PATTERN,
} from '../shared/wire.js';
import { DEFAULT_BILLING } from './memory-store.js';
import type { AuthenticatedPrincipal, HubStore } from './store.js';

export interface HubServerOptions {
  store: HubStore;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface HubServer {
  readonly server: Server;
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

type Handler = (ctx: RequestContext) => Promise<void> | void;

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  principal: AuthenticatedPrincipal | null;
  params: Record<string, string>;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  auth: boolean;
  handler: Handler;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** 401 shape the daemon treats as `reauth_required` (vela-workspace-context.ts:858-905). */
function unauthorized(res: ServerResponse): void {
  json(res, 401, { error: 'invalid_api_key' });
}

function notSupported(res: ServerResponse): void {
  json(res, 501, { error: NOT_SUPPORTED_CODE });
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

function workspaceIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers[WORKSPACE_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return WORKSPACE_ID_PATTERN.test(value) ? value : null;
}

async function drainBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('payload_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function compile(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') return '(.*)';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${source}$`), keys };
}

export function createHubServer(options: HubServerOptions): HubServer {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS;
  const log = options.log ?? (() => {});
  // One epoch per process: a restart is exactly the "source may have gapped"
  // signal the daemon uses to re-sync (hub-events-subscriber.ts:420-428).
  const listenerEpoch = `odhub-${randomUUID()}`;
  const routes: Route[] = [];
  const openStreams = new Set<ServerResponse>();

  const route = (method: string, path: string, auth: boolean, handler: Handler) => {
    const { pattern, keys } = compile(path);
    routes.push({ method, pattern, keys, auth, handler });
  };

  route('GET', '/healthz', false, ({ res }) => {
    json(res, 200, { ok: true, service: 'od-hub', listenerEpoch, at: now().toISOString() });
  });

  // ---- identity ---------------------------------------------------------------
  // Consumed by the CLI/console; optional fields are omitted rather than null.
  route('GET', '/api/v1/me', true, ({ res, principal }) => {
    const { user } = principal!;
    json(res, 200, {
      user: {
        id: user.id,
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        ...(user.avatarUrl ? { image: user.avatarUrl } : {}),
      },
    });
  });

  // ---- directory -----------------------------------------------------------
  route('GET', '/api/v1/workspaces', true, async ({ res, principal }) => {
    const items = await store.listDirectory(principal!.user.id);
    json(res, 200, { items });
  });

  // ---- SSE ------------------------------------------------------------------
  route('GET', '/api/v1/collab/events', true, async ({ req, res, principal }) => {
    const workspaceId = workspaceIdHeader(req);
    if (!workspaceId) return json(res, 400, { error: 'workspace_id_required' });
    const membership = await store.getMembership(principal!.user.id, workspaceId);
    if (!membership || membership.memberStatus !== 'active') {
      return json(res, 403, { error: 'workspace_not_authorized' });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Reverse proxies must not buffer SSE (PLAN §11.4.1).
      'x-accel-buffering': 'no',
    });
    openStreams.add(res);
    const status = { listenerEpoch, listenerHealth: 'healthy' as const, sourceGap: false };
    res.write(
      `event: ready\ndata: ${JSON.stringify({
        workspaceId,
        capabilities: [...HUB_CAPABILITIES],
        ...status,
      })}\n\n`,
    );
    const writeHeartbeat = () => {
      if (res.destroyed) return;
      res.write(`event: heartbeat\ndata: ${JSON.stringify(status)}\n\n`);
    };
    // Immediate heartbeat: `ready` alone is not authority health for the daemon.
    writeHeartbeat();
    const timer = setInterval(writeHeartbeat, heartbeatIntervalMs);
    timer.unref?.();
    req.on('close', () => {
      clearInterval(timer);
      openStreams.delete(res);
    });
  });

  // ---- sync digest ----------------------------------------------------------
  route('GET', '/api/v1/collab/sync-digest', true, async ({ req, res, principal }) => {
    const workspaceId = workspaceIdHeader(req);
    if (!workspaceId) return json(res, 400, { error: 'workspace_id_required' });
    const membership = await store.getMembership(principal!.user.id, workspaceId);
    if (!membership || membership.memberStatus !== 'active') {
      return json(res, 403, { error: 'workspace_not_authorized' });
    }
    const digest = await store.getSyncDigest(workspaceId);
    json(res, 200, {
      catalogToken: digest.catalogToken,
      membersToken: digest.membersToken,
      contextToken: digest.contextToken,
      billingToken: digest.billingToken,
    });
  });

  // ---- billing stubs --------------------------------------------------------
  // integrations/vela-wallet.ts:137-154 — only a real credential failure may 401.
  route('GET', '/api/v1/wallet/balance', true, ({ res }) => {
    json(res, 200, { balanceUsd: `${DEFAULT_BILLING.balanceUsd}.00`, updatedAt: now().toISOString() });
  });

  /**
   * Internal endpoint consumed by `od-vela billing workspace-snapshot`. The
   * member id is the directory's id for the caller so collab-context.ts can
   * match the two (PLAN §4.3, vela-billing.ts:319-393).
   */
  route('GET', '/api/v1/billing/workspace-snapshot', true, async ({ req, res, principal }) => {
    const workspaceId = workspaceIdHeader(req);
    if (!workspaceId) return json(res, 400, { error: 'workspace_id_required' });
    const membership = await store.getMembership(principal!.user.id, workspaceId);
    if (!membership || membership.memberStatus !== 'active') {
      return json(res, 403, { error: 'workspace_not_authorized' });
    }
    const billing = await store.getWorkspaceBilling(workspaceId);
    json(res, 200, {
      schemaVersion: 1,
      billingScopeVersion: 2,
      workspaceId,
      workspaceMemberId: membership.memberId,
      billing: { billingState: billing.billingState, planId: billing.planId },
      wallet: { balanceUsd: billing.balanceUsd, expiresAt: null, updatedAt: now().toISOString() },
      revisions: { billing: billing.revisionBilling, wallet: billing.revisionWallet },
    });
  });

  // ---- telemetry / analytics sinks -----------------------------------------
  route('POST', '/api/v1/open-design/telemetry', true, async ({ req, res }) => {
    await drainBody(req).catch(() => Buffer.alloc(0));
    res.writeHead(202, { 'content-length': 0 });
    res.end();
  });
  route('POST', '/api/v1/analytics/events', false, async ({ req, res }) => {
    await drainBody(req).catch(() => Buffer.alloc(0));
    res.writeHead(204);
    res.end();
  });

  // ---- message center stubs (routes/vela.ts:341-404) -----------------------
  const emptyMessages = { messages: [], nextCursor: null, unreadCount: 0 };
  route('GET', '/api/v1/message-center/messages', true, ({ res }) => json(res, 200, emptyMessages));
  route('POST', '/api/v1/message-center/read-all', true, async ({ req, res }) => {
    await drainBody(req).catch(() => Buffer.alloc(0));
    json(res, 200, { ok: true, unreadCount: 0 });
  });
  route('POST', '/api/v1/message-center/messages/:id/read', true, async ({ req, res, params }) => {
    await drainBody(req).catch(() => Buffer.alloc(0));
    json(res, 200, { ok: true, id: params.id, unreadCount: 0 });
  });
  // Public variant used by the signed-out web shell; no auth by design.
  route('GET', '/api/v1/message-center-public/messages', false, ({ res }) => json(res, 200, emptyMessages));

  const server = createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://od-hub.local');
    try {
      const matched = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!matched) {
        const pathKnown = routes.some((r) => r.pattern.test(url.pathname));
        if (pathKnown) return json(res, 405, { error: 'method_not_allowed' });
        // Anything under /api/v1 the hub does not implement yet is a typed 501,
        // never an untyped 404 (untyped 404s trigger daemon compat fallbacks).
        if (url.pathname.startsWith('/api/v1/')) return notSupported(res);
        return json(res, 404, { error: 'not_found' });
      }
      let principal: AuthenticatedPrincipal | null = null;
      if (matched.auth) {
        principal = await store.authenticate(bearerToken(req));
        if (!principal) return unauthorized(res);
      }
      const values = matched.pattern.exec(url.pathname) ?? [];
      const params: Record<string, string> = {};
      matched.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(values[index + 1] ?? '');
      });
      await matched.handler({ req, res, url, principal, params });
    } catch (error) {
      log(`[od-hub] ${method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
      else res.end();
    }
  });

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address() as AddressInfo;
          const hostname = host.includes(':') ? `[${host}]` : host;
          resolve({ port: address.port, url: `http://${hostname}:${address.port}` });
        });
      });
    },
    close() {
      for (const stream of openStreams) stream.end();
      openStreams.clear();
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
