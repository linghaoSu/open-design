import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';

import {
  DEVICE_FLOW_PENDING_STATUS,
  DEVICE_FLOW_SLOW_DOWN_STATUS,
  HUB_CAPABILITIES,
  HUB_HEARTBEAT_INTERVAL_MS,
  NOT_SUPPORTED_CODE,
  SSE_EVENT_HEARTBEAT,
  SSE_EVENT_READY,
  WORKSPACE_HEADER,
  WORKSPACE_ID_PATTERN,
} from '../shared/wire.js';
import { AuthService, GitLabNotConfiguredError, GitLabSessionRevokedError, GitLabUnavailableError } from './auth-service.js';
import { BlobDigestMismatchError, BlobStore, BlobTooLargeError } from './blob-store.js';
import { CollabService, CollabServiceError } from './collab-service.js';
import { parseHubConfig, type HubConfig } from './config.js';
import { DirectoryService } from './directory-service.js';
import { EventRelay, sseFrame } from './event-relay.js';
import type { GitLabClient } from './gitlab.js';
import { GitLabTokenError } from './gitlab.js';
import { hashApiKey } from './ids.js';
import {
  acceptUrlFor,
  InviteService,
  InviteServiceError,
  mintSecret,
  pkceChallenge,
  SECRET_PATTERN,
} from './invite-service.js';
import { createSmtpMailer, type Mailer } from './mailer.js';
import { DEFAULT_BILLING } from './memory-store.js';
import { PresenceService } from './presence-service.js';
import { contentTypeFor, normalizePublicFilePath } from './public-files.js';
import { canManageAll, ResourceService, ResourceServiceError, type Actor } from './resource-service.js';
import { Templates, type TemplateVars } from './templates.js';
import { createEphemeralTokenCipher, createTokenCipher, type TokenCipher } from './token-cipher.js';
import type { AuditRow, AuthenticatedPrincipal, HubStore } from './store.js';
import { isResourceKind, RESOURCE_ID_PATTERN, SHA256_HEX_PATTERN } from '../shared/manifest.js';

export interface HubServerOptions {
  store: HubStore;
  /** Content-addressed blob storage; defaults to `config.blobDir`. */
  blobs?: BlobStore;
  /** Null (default) disables the GitLab login routes; they answer 501 not_supported. */
  gitlab?: GitLabClient | null;
  config?: HubConfig;
  cipher?: TokenCipher;
  heartbeatIntervalMs?: number;
  /** Presence lease TTL; defaults to `config.presenceTtlMs` (PRESENCE_TTL_MS env, 30s). */
  presenceTtlMs?: number;
  /** Invite mail transport; defaults to SMTP when `config.smtpUrl` is set, else null (URL is logged). */
  mailer?: Mailer | null;
  /** Console page templates; defaults to `<tool root>/templates`. */
  templates?: Templates;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface HubServer {
  readonly server: Server;
  readonly auth: AuthService;
  readonly directory: DirectoryService;
  readonly relay: EventRelay;
  readonly resources: ResourceService;
  readonly collab: CollabService;
  readonly presence: PresenceService;
  readonly invites: InviteService;
  readonly blobs: BlobStore;
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
  /** Bearer as presented (needed by /auth/revoke). */
  bearer: string;
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

/** GitLab unreachable while a token had to be refreshed: transient, keys intact, client should retry. */
function gitlabUnavailable(res: ServerResponse): void {
  json(res, 503, { error: 'gitlab_unavailable' });
}

/** Body rejected before the handler ran; carries the status the route must answer with. */
class BodyError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
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

function headerString(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
  return value || null;
}

async function drainBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new BodyError(413, 'payload_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Parse a JSON object body. An empty body is `{}` (every field optional);
 * malformed JSON or a non-object answers 400 invalid_json and an oversized
 * body 413 payload_too_large, instead of being silently coerced to `{}`.
 */
async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const raw = (await drainBody(req, limit)).toString('utf8').trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BodyError(400, 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BodyError(400, 'invalid_json');
  return parsed as Record<string, unknown>;
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

/** Origin the CLI should store when HUB_PUBLIC_URL is unset: reconstruct from the request. */
function requestOrigin(req: IncomingMessage): string {
  const proto = headerString(req, 'x-forwarded-proto') ?? 'http';
  const host = headerString(req, 'x-forwarded-host') ?? headerString(req, 'host') ?? 'localhost';
  return `${proto}://${host}`;
}

function clientIp(req: IncomingMessage): string | null {
  return headerString(req, 'x-forwarded-for')?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? null;
}

/** Content negotiation for the dual JSON/HTML invite preview: HTML only when the client says so explicitly. */
function wantsHtml(req: IncomingMessage): boolean {
  const accept = headerString(req, 'accept') ?? '';
  const html = accept.indexOf('text/html');
  const jsonAt = accept.indexOf('application/json');
  if (html === -1) return false;
  return jsonAt === -1 || html < jsonAt;
}

function html(res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Console pages carry identity and one-click accept links: never framable.
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(body);
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Constant-time string compare for OAuth `state`; a length mismatch is simply false. */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Browser copy for error.html, keyed by the machine code the JSON surface
 * answers with (InviteServiceError codes, OAuth callback failures, GitLab
 * outcomes). Codes not listed fall back to a generic title/message; the code
 * itself is still shown so support can identify the case.
 */
const ERROR_COPY: Record<string, { title: string; message: string }> = {
  invite_not_found: { title: 'Invitation not found', message: 'This invitation link is not valid. Check the link or ask for a new invitation.' },
  invite_expired: { title: 'Invitation expired', message: 'This invitation has expired. Ask the workspace administrator for a new one.' },
  invite_consumed: { title: 'Invitation already used', message: 'This invitation has already been accepted. Open the OpenDesign app to switch to the workspace.' },
  invite_revoked: { title: 'Invitation revoked', message: 'This invitation was revoked by the workspace administrator.' },
  invite_email_mismatch: { title: 'Different account', message: 'The GitLab account you signed in with does not match the invited address.' },
  already_member: { title: 'Already a member', message: 'You are already a member of this workspace. Open the OpenDesign app to switch to it.' },
  active_pending_invite: { title: 'Invitation pending', message: 'An invitation for this address is already pending.' },
  workspace_not_found: { title: 'Workspace not found', message: 'The workspace this invitation points to no longer exists.' },
  workspace_forbidden: { title: 'Not allowed', message: 'You are not allowed to join this workspace.' },
  workspace_subscription_locked: { title: 'Workspace unavailable', message: 'This workspace is not accepting new members right now.' },
  oauth_state_missing: { title: 'Sign-in session missing', message: 'Your sign-in session expired or the cookie was not sent. Open the invitation link again.' },
  oauth_state_invalid: { title: 'Sign-in could not be verified', message: 'The sign-in session was not valid. Open the invitation link again.' },
  oauth_state_expired: { title: 'Sign-in took too long', message: 'The sign-in session expired. Open the invitation link again.' },
  oauth_state_mismatch: { title: 'Sign-in could not be verified', message: 'The sign-in response did not match this browser session. Start again from the invitation link.' },
  gitlab_access_denied: { title: 'Sign-in cancelled', message: 'GitLab reported that you declined the sign-in.' },
  gitlab_invalid_grant: { title: 'GitLab sign-in failed', message: 'GitLab rejected the sign-in code. Start again from the invitation link.' },
  gitlab_session_revoked: { title: 'GitLab sign-in failed', message: 'GitLab rejected the sign-in. Start again from the invitation link.' },
  gitlab_unavailable: { title: 'GitLab unavailable', message: 'GitLab could not be reached, or the hub service account lacks rights on this group (check GITLAB_GROUP_TOKEN). Nothing was changed; try again in a moment or contact the operator.' },
  not_supported: { title: 'Sign-in not configured', message: 'This hub has no GitLab sign-in configured; ask the operator.' },
  not_found: { title: 'Not found', message: 'There is nothing at this address.' },
  user_not_found: { title: 'Unknown device authorization', message: 'This device authorization is not known.' },
  internal_error: { title: 'Something went wrong', message: 'The hub hit an unexpected error. Try again in a moment.' },
};

function padTwo(n: number): string {
  return String(n).padStart(2, '0');
}

/** `2026-09-15 00:00 UTC` — stable, no locale dependency; a non-date falls through unchanged. */
export function humanUtc(value: string | number | Date): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getUTCFullYear()}-${padTwo(d.getUTCMonth() + 1)}-${padTwo(d.getUTCDate())} ${padTwo(d.getUTCHours())}:${padTwo(d.getUTCMinutes())} UTC`;
}

const OAUTH_COOKIE = 'od_hub_oauth';
const OAUTH_COOKIE_TTL_S = 600;

function oauthCookie(value: string, secure: boolean, maxAge: number = OAUTH_COOKIE_TTL_S): string {
  return `${OAUTH_COOKIE}=${value}; Path=/console/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/** Cursor for the audit export: opaque base64url of the last row id. */
function encodeAuditCursor(id: number): string {
  return Buffer.from(String(id), 'utf8').toString('base64url');
}
function decodeAuditCursor(raw: string | null): number | null | undefined {
  if (!raw) return null;
  const id = Number.parseInt(Buffer.from(raw, 'base64url').toString('utf8'), 10);
  return Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function toAuditWire(row: AuditRow) {
  return {
    id: row.id,
    at: row.at,
    actorUserId: row.actorUserId,
    actorMemberId: row.actorMemberId ?? null,
    workspaceId: row.workspaceId ?? null,
    action: row.action,
    target: row.target ?? null,
    details: row.details ?? null,
  };
}

export function createHubServer(options: HubServerOptions): HubServer {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const config = options.config ?? parseHubConfig({});
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HUB_HEARTBEAT_INTERVAL_MS;
  const log = options.log ?? (() => {});
  const gitlab = options.gitlab ?? null;
  const cipher = options.cipher ?? (config.tokenEncKey ? createTokenCipher(config.tokenEncKey) : createEphemeralTokenCipher());
  // One epoch per process: a restart is exactly the "source may have gapped"
  // signal the daemon uses to re-sync (hub-events-subscriber.ts:420-428).
  const listenerEpoch = `odhub-${randomUUID()}`;
  const relay = new EventRelay(store, log);
  const auth = new AuthService({ store, gitlab, cipher, config, now, log });
  const blobs = options.blobs ?? new BlobStore(config.blobDir);
  const resources = new ResourceService({ store, blobs, now, onOutbox: () => void relay.publish() });
  const presence = new PresenceService({ ttlMs: options.presenceTtlMs ?? config.presenceTtlMs, now });
  const collab = new CollabService({ store, presence, now, onOutbox: () => void relay.publish() });
  const directory = new DirectoryService({
    store, gitlab, auth, config, now, log,
    onOutbox: () => relay.publish(),
    // A removed member must not linger in project rosters until the TTL sweeps it.
    onMembershipRemoved: (workspaceId, memberId) => collab.evictMemberPresence(workspaceId, memberId),
  });
  const mailer = options.mailer !== undefined ? options.mailer : (config.smtpUrl ? createSmtpMailer(config.smtpUrl) : null);
  const templates = options.templates ?? new Templates();
  const invites = new InviteService({
    store, directory, gitlab, mailer, now, log,
    gitlabGroupToken: config.gitlabGroupToken,
    mailFrom: config.smtpFrom,
    inviteTtlMs: config.inviteTtlMs,
    continuationTtlMs: config.inviteContinuationTtlMs,
    downloadUrl: config.downloadUrl,
    onOutbox: () => void relay.publish(),
  });
  /** Browser-facing origin for console URLs: HUB_CONSOLE_URL, else HUB_PUBLIC_URL, else the request. */
  const consoleOrigin = (req: IncomingMessage): string => config.consoleUrl ?? requestOrigin(req);
  /**
   * Render error.html for browser-context failures (never JSON in a tab).
   * Copy comes from ERROR_COPY by code; `message` is only a fallback for codes
   * the table does not know (e.g. `gitlab_<upstream>` pass-throughs).
   */
  const htmlError = (res: ServerResponse, status: number, code: string, message: string, backUrl = '') => {
    const copy = ERROR_COPY[code] ?? { title: status >= 500 ? 'Something went wrong' : 'Cannot continue', message };
    html(res, status, templates.render('error', { title: copy.title, message: copy.message, code, backUrl }));
  };
  const routes: Route[] = [];

  const route = (method: string, path: string, authRequired: boolean, handler: Handler) => {
    const { pattern, keys } = compile(path);
    routes.push({ method, pattern, keys, auth: authRequired, handler });
  };

  /**
   * Bearer + GitLab-session check shared by every authenticated route. When
   * GitLab rejected the refresh the AuthService has already revoked the user's
   * keys and the response is the plain 401 the daemon maps to reauth (PLAN
   * §5.3). When GitLab was merely unreachable the keys survive and the request
   * fails with 503 so the daemon retries instead of latching reauth_required.
   * Returns the GitLab access token (null for dev-seed accounts).
   */
  async function gitlabAccessOr401(ctx: RequestContext): Promise<string | null | undefined> {
    try {
      return await auth.ensureGitLabAccess(ctx.principal!.user);
    } catch (error) {
      if (error instanceof GitLabSessionRevokedError) {
        unauthorized(ctx.res);
        return undefined;
      }
      if (error instanceof GitLabUnavailableError) {
        gitlabUnavailable(ctx.res);
        return undefined;
      }
      throw error;
    }
  }

  /** Membership gate for workspace-scoped routes; writes the 400/403 itself and returns null. */
  async function activeMembershipOr403(ctx: RequestContext) {
    const workspaceId = workspaceIdHeader(ctx.req);
    if (!workspaceId) {
      json(ctx.res, 400, { error: 'workspace_id_required' });
      return null;
    }
    const token = await gitlabAccessOr401(ctx);
    if (token === undefined) return null;
    try {
      await directory.ensureFresh(ctx.principal!.user, token);
    } catch (error) {
      if (error instanceof GitLabSessionRevokedError) {
        unauthorized(ctx.res);
        return null;
      }
      throw error;
    }
    const membership = await store.getMembership(ctx.principal!.user.id, workspaceId);
    if (!membership || membership.memberStatus !== 'active') {
      json(ctx.res, 403, { error: 'workspace_not_authorized' });
      return null;
    }
    return { workspaceId, membership };
  }

  /**
   * Mirror-only membership gate for latency-critical routes (presence). No
   * GitLab refresh, no directory sync: the stored membership row decides. A
   * removal still takes effect within the directory cache window because the
   * removing refresh (triggered by any other authenticated call of that user)
   * flips `member_status` in the same mirror this reads.
   */
  async function mirrorMembershipOr403(ctx: RequestContext) {
    const workspaceId = workspaceIdHeader(ctx.req);
    if (!workspaceId) {
      json(ctx.res, 400, { error: 'workspace_id_required' });
      return null;
    }
    const membership = await store.getMembership(ctx.principal!.user.id, workspaceId);
    if (!membership || membership.memberStatus !== 'active') {
      json(ctx.res, 403, { error: 'workspace_not_authorized' });
      return null;
    }
    return { workspaceId, membership };
  }

  route('GET', '/healthz', false, ({ res }) => {
    json(res, 200, { ok: true, service: 'od-hub', listenerEpoch, gitlab: auth.enabled, at: now().toISOString() });
  });

  // ---- GitLab device flow (PLAN §5.1) -----------------------------------------------
  route('POST', '/api/v1/auth/device', false, async ({ req, res }) => {
    if (!auth.enabled) return notSupported(res);
    const body = await readJsonBody(req);
    const profile = typeof body.profile === 'string' && body.profile.trim() ? body.profile.trim().slice(0, 64) : null;
    const started = await auth.startDevice(profile);
    json(res, 200, {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete ?? started.verificationUri,
      interval: started.interval,
      expiresIn: started.expiresIn,
    });
  });

  route('POST', '/api/v1/auth/device/token', false, async ({ req, res }) => {
    if (!auth.enabled) return notSupported(res);
    const body = await readJsonBody(req);
    const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode.trim() : '';
    if (!deviceCode) return json(res, 400, { error: 'invalid_request' });
    const outcome = await auth.pollDevice(deviceCode, {
      apiUrl: requestOrigin(req),
      ip: clientIp(req),
      userAgent: headerString(req, 'user-agent'),
    });
    switch (outcome.kind) {
      case 'pending':
        return json(res, DEVICE_FLOW_PENDING_STATUS, { error: 'authorization_pending' });
      case 'slow_down':
        return json(res, DEVICE_FLOW_SLOW_DOWN_STATUS, { error: 'slow_down' });
      case 'denied':
        return json(res, 400, { error: 'access_denied' });
      case 'expired':
        return json(res, 400, { error: 'expired_token' });
      case 'unknown_device':
        return json(res, 400, { error: 'invalid_grant' });
      case 'success':
        return json(res, 200, outcome.result);
      default:
        return json(res, 500, { error: 'internal_error' });
    }
  });

  route('POST', '/api/v1/auth/revoke', true, async ({ req, res, principal, bearer }) => {
    await drainBody(req).catch(() => Buffer.alloc(0));
    await auth.revokeKey(bearer, principal!.user.id);
    json(res, 200, { ok: true });
  });

  // ---- identity ---------------------------------------------------------------
  // Consumed by the CLI/console; optional fields are omitted rather than null.
  route('GET', '/api/v1/me', true, async (ctx) => {
    const token = await gitlabAccessOr401(ctx);
    if (token === undefined) return;
    const { user } = ctx.principal!;
    json(ctx.res, 200, {
      user: {
        id: user.id,
        email: user.email,
        ...(user.name ? { name: user.name } : {}),
        ...(user.avatarUrl ? { image: user.avatarUrl } : {}),
        plan: 'team',
        balanceUsd: `${DEFAULT_BILLING.balanceUsd}.00`,
      },
    });
  });

  // ---- directory -----------------------------------------------------------
  route('GET', '/api/v1/workspaces', true, async (ctx) => {
    const token = await gitlabAccessOr401(ctx);
    if (token === undefined) return;
    try {
      await directory.ensureFresh(ctx.principal!.user, token);
    } catch (error) {
      // GitLab rejected the token AND the one refresh retry: the user has been revoked.
      if (error instanceof GitLabSessionRevokedError) return unauthorized(ctx.res);
      // GitLab down: serve the mirror rather than a 5xx, but say so.
      log(`[od-hub] directory refresh failed for ${ctx.principal!.user.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const items = await directory.directoryFor(ctx.principal!.user);
    json(ctx.res, 200, { items });
  });

  // ---- SSE ------------------------------------------------------------------
  route('GET', '/api/v1/collab/events', true, async (ctx) => {
    const gate = await activeMembershipOr403(ctx);
    if (!gate) return;
    const { req, res, principal } = ctx;
    const { workspaceId, membership } = gate;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Reverse proxies must not buffer SSE (PLAN §11.4.1).
      'x-accel-buffering': 'no',
    });
    const status = { listenerEpoch, listenerHealth: 'healthy' as const, sourceGap: false };
    res.write(sseFrame(SSE_EVENT_READY, { workspaceId, capabilities: [...HUB_CAPABILITIES], ...status }));
    const writeHeartbeat = () => {
      if (res.destroyed || res.writableEnded) return;
      res.write(sseFrame(SSE_EVENT_HEARTBEAT, status));
    };
    // Immediate heartbeat: `ready` alone is not authority health for the daemon.
    writeHeartbeat();
    const timer = setInterval(writeHeartbeat, heartbeatIntervalMs);
    timer.unref?.();
    let unsubscribe = () => {};
    const subscriber = {
      workspaceId,
      userId: principal!.user.id,
      memberId: membership.memberId,
      res,
      close: () => {
        clearInterval(timer);
        unsubscribe();
        if (!res.writableEnded) res.end();
      },
    };
    unsubscribe = relay.subscribe(subscriber);
    req.on('close', subscriber.close);
  });

  // ---- sync digest ----------------------------------------------------------
  route('GET', '/api/v1/collab/sync-digest', true, async (ctx) => {
    const gate = await activeMembershipOr403(ctx);
    if (!gate) return;
    const digest = await store.getSyncDigest(gate.workspaceId);
    json(ctx.res, 200, {
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
  route('GET', '/api/v1/billing/workspace-snapshot', true, async (ctx) => {
    const gate = await activeMembershipOr403(ctx);
    if (!gate) return;
    const { workspaceId, membership } = gate;
    const billing = await store.getWorkspaceBilling(workspaceId);
    json(ctx.res, 200, {
      schemaVersion: 1,
      billingScopeVersion: 2,
      workspaceId,
      workspaceMemberId: membership.memberId,
      billing: { billingState: billing.billingState, planId: billing.planId },
      wallet: { balanceUsd: billing.balanceUsd, expiresAt: null, updatedAt: now().toISOString() },
      revisions: { billing: billing.revisionBilling, wallet: billing.revisionWallet },
    });
  });

  // ---- blobs (hub-internal contract, consumed by od-vela) --------------------
  // Blobs are content-addressed and workspace-agnostic (a digest is a digest);
  // reads still require an active membership of SOME workspace so an
  // unauthenticated or removed principal cannot probe for known content.
  route('POST', '/api/v1/blobs/missing', true, async (ctx) => {
    const gate = await activeMembershipOr403(ctx);
    if (!gate) return;
    const body = await readJsonBody(ctx.req, 16 * 1024 * 1024);
    const list = Array.isArray(body.sha256) ? body.sha256 : null;
    if (!list || list.some((d) => typeof d !== 'string' || !SHA256_HEX_PATTERN.test(d))) {
      return json(ctx.res, 400, { error: 'invalid_sha256' });
    }
    json(ctx.res, 200, { missing: await blobs.missing(list as string[]) });
  });

  route('PUT', '/api/v1/blobs/:sha256', true, async (ctx) => {
    const gate = await activeMembershipOr403(ctx);
    if (!gate) {
      ctx.req.resume();
      return;
    }
    const digest = ctx.params.sha256;
    if (!SHA256_HEX_PATTERN.test(digest)) {
      ctx.req.resume();
      return json(ctx.res, 400, { error: 'invalid_sha256' });
    }
    try {
      const { size, created } = await blobs.put(digest, ctx.req);
      json(ctx.res, created ? 201 : 200, { sha256: digest, size });
    } catch (error) {
      if (error instanceof BlobDigestMismatchError) return json(ctx.res, 400, { error: 'blob_digest_mismatch' });
      if (error instanceof BlobTooLargeError) return json(ctx.res, 413, { error: 'payload_too_large' });
      throw error;
    }
  });

  route('GET', '/api/v1/blobs/:sha256', true, async (ctx) => {
    const gate = await activeMembershipOr403(ctx);
    if (!gate) return;
    const digest = ctx.params.sha256;
    if (!SHA256_HEX_PATTERN.test(digest)) return json(ctx.res, 400, { error: 'invalid_sha256' });
    const size = await blobs.size(digest);
    if (size === null) return json(ctx.res, 404, { error: 'blob_not_found' });
    ctx.res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': size,
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${digest}"`,
    });
    await pipeline(blobs.open(digest), ctx.res);
  });

  // ---- resources / versions (PLAN §3.4) ----------------------------------------
  const resourceActor = (ctx: RequestContext, gate: NonNullable<Awaited<ReturnType<typeof activeMembershipOr403>>>): Actor => ({
    workspaceId: gate.workspaceId,
    membership: gate.membership,
    userId: ctx.principal!.user.id,
  });

  /** Translate ResourceServiceError into the typed JSON reply; rethrow anything else. */
  const resourceRoute = (handler: (ctx: RequestContext, actor: Actor) => Promise<void>): Handler => async (ctx) => {
    const gate = await activeMembershipOr403(ctx);
    if (!gate) return;
    try {
      await handler(ctx, resourceActor(ctx, gate));
    } catch (error) {
      if (error instanceof ResourceServiceError) return json(ctx.res, error.status, { error: error.code });
      throw error;
    }
  };

  const validResourceId = (ctx: RequestContext, id: string): boolean => {
    if (RESOURCE_ID_PATTERN.test(id)) return true;
    json(ctx.res, 400, { error: 'invalid_resource_id' });
    return false;
  };

  route('GET', '/api/v1/resources/shared', true, resourceRoute(async (ctx, actor) => {
    json(ctx.res, 200, { resources: await resources.shared(actor.workspaceId) });
  }));

  route('POST', '/api/v1/resources/:kind/:id/versions', true, resourceRoute(async (ctx, actor) => {
    if (!isResourceKind(ctx.params.kind)) return json(ctx.res, 400, { error: 'invalid_resource_kind' });
    if (!validResourceId(ctx, ctx.params.id)) return;
    const body = await readJsonBody(ctx.req, 64 * 1024 * 1024);
    const { resource, version } = await resources.publish(actor, ctx.params.kind, ctx.params.id, body);
    json(ctx.res, 201, {
      version: version.version,
      versionId: version.versionId,
      manifestDigest: version.manifestDigest,
      entryCount: version.entryCount,
      ownerMemberId: resource.ownerMemberId,
    });
  }));

  route('GET', '/api/v1/resources/:id/head', true, resourceRoute(async (ctx, actor) => {
    if (!validResourceId(ctx, ctx.params.id)) return;
    json(ctx.res, 200, await resources.head(actor.workspaceId, ctx.params.id, ctx.url.searchParams.get('ref') ?? 'published'));
  }));

  route('GET', '/api/v1/resources/:id/versions/:versionId/manifest', true, resourceRoute(async (ctx, actor) => {
    if (!validResourceId(ctx, ctx.params.id)) return;
    const version = await resources.manifest(actor.workspaceId, ctx.params.id, ctx.params.versionId);
    json(ctx.res, 200, {
      resourceId: version.resourceId,
      version: version.version,
      versionId: version.versionId,
      manifestDigest: version.manifestDigest,
      entryCount: version.entryCount,
      manifest: version.manifest,
      createdAt: version.createdAt,
    });
  }));

  route('DELETE', '/api/v1/resources/:id', true, resourceRoute(async (ctx, actor) => {
    if (!validResourceId(ctx, ctx.params.id)) return;
    await drainBody(ctx.req).catch(() => Buffer.alloc(0));
    // Idempotent: an already-tombstoned id is still `{ok:true}`.
    await resources.remove(actor, ctx.params.id);
    json(ctx.res, 200, { ok: true });
  }));

  // ---- team project catalog ------------------------------------------------------
  route('GET', '/api/v1/team-projects', true, resourceRoute(async (ctx, actor) => {
    json(ctx.res, 200, { workspaceId: actor.workspaceId, projects: await resources.listTeamProjects(actor) });
  }));

  route('GET', '/api/v1/team-projects/:projectId', true, resourceRoute(async (ctx, actor) => {
    json(ctx.res, 200, await resources.getTeamProject(actor, ctx.params.projectId));
  }));

  route('PUT', '/api/v1/team-projects/:projectId', true, resourceRoute(async (ctx, actor) => {
    const body = await readJsonBody(ctx.req, 1024 * 1024);
    json(ctx.res, 200, await resources.upsertTeamProject(actor, ctx.params.projectId, body));
  }));

  route('DELETE', '/api/v1/team-projects/:projectId', true, resourceRoute(async (ctx, actor) => {
    await drainBody(ctx.req).catch(() => Buffer.alloc(0));
    // Idempotent: a missing row is still `{ok:true}` (the daemon's unshare retry expects it).
    await resources.removeTeamProject(actor, ctx.params.projectId);
    json(ctx.res, 200, { ok: true });
  }));

  route('POST', '/api/v1/team-projects/:projectId/pull-authorization', true, resourceRoute(async (ctx, actor) => {
    const body = await readJsonBody(ctx.req);
    json(ctx.res, 200, await resources.authorizePull(actor, ctx.params.projectId, body));
  }));

  // ---- collab: members / comments / presence (PLAN §4.3) --------------------------
  const collabRoute = (
    handler: (ctx: RequestContext, actor: Actor) => Promise<void>,
    gate: (ctx: RequestContext) => ReturnType<typeof activeMembershipOr403> = activeMembershipOr403,
  ): Handler => async (ctx) => {
    const g = await gate(ctx);
    if (!g) return;
    try {
      await handler(ctx, resourceActor(ctx, g));
    } catch (error) {
      if (error instanceof CollabServiceError) return json(ctx.res, error.status, { error: error.code });
      throw error;
    }
  };

  route('GET', '/api/v1/collab/members', true, collabRoute(async (ctx, actor) => {
    json(ctx.res, 200, { members: await collab.listMembers(actor.workspaceId) });
  }));

  route('POST', '/api/v1/collab/members/register', true, collabRoute(async (ctx, actor) => {
    const body = await readJsonBody(ctx.req);
    json(ctx.res, 200, { member: await collab.registerMember(actor, body) });
  }));

  route('POST', '/api/v1/collab/projects/:projectId/comments', true, collabRoute(async (ctx, actor) => {
    const body = await readJsonBody(ctx.req, 1024 * 1024);
    json(ctx.res, 200, await collab.pushComment(actor, ctx.params.projectId, body));
  }));

  route('GET', '/api/v1/collab/projects/:projectId/comments', true, collabRoute(async (ctx, actor) => {
    const raw = ctx.url.searchParams.get('sinceSeq') ?? '0';
    const sinceSeq = Number(raw);
    if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) return json(ctx.res, 400, { error: 'invalid_since_seq' });
    json(ctx.res, 200, await collab.pullComments(actor.workspaceId, ctx.params.projectId, sinceSeq));
  }));

  // Presence answers from the mirror only (p99 < 2s; the daemon kills the shim at 10s).
  route('POST', '/api/v1/collab/projects/:projectId/presence/heartbeat', true, collabRoute(async (ctx, actor) => {
    const body = await readJsonBody(ctx.req);
    json(ctx.res, 200, await collab.heartbeat(actor, ctx.params.projectId, body));
  }, mirrorMembershipOr403));

  route('GET', '/api/v1/collab/projects/:projectId/presence', true, collabRoute(async (ctx, actor) => {
    json(ctx.res, 200, await collab.listPresence(actor.workspaceId, ctx.params.projectId));
  }, mirrorMembershipOr403));

  route('POST', '/api/v1/collab/projects/:projectId/presence/leave', true, collabRoute(async (ctx, actor) => {
    const body = await readJsonBody(ctx.req);
    json(ctx.res, 200, await collab.leavePresence(actor, ctx.params.projectId, body));
  }, mirrorMembershipOr403));

  // ---- public snapshots (collab-sync.ts:1312-1340, :563-565) --------------------------------
  route('POST', '/api/v1/resources/:id/snapshots', true, resourceRoute(async (ctx, actor) => {
    if (!validResourceId(ctx, ctx.params.id)) return;
    const body = await readJsonBody(ctx.req);
    json(ctx.res, 201, await resources.createSnapshot(actor, ctx.params.id, body));
  }));

  route('DELETE', '/api/v1/resources/:id/snapshots/:slug', true, resourceRoute(async (ctx, actor) => {
    if (!validResourceId(ctx, ctx.params.id)) return;
    await drainBody(ctx.req).catch(() => Buffer.alloc(0));
    await resources.redactSnapshot(actor, ctx.params.id, ctx.params.slug);
    json(ctx.res, 200, { ok: true });
  }));

  // Anonymous by design: the 256-bit slug is the capability. The path is taken
  // from the RAW request line so encoded traversal is judged before any decoding
  // (the dispatcher already rejected requests the URL parser had to normalise).
  route('GET', '/api/v1/public/snapshots/:slug/files/*', false, async (ctx) => {
    const rawPath = (ctx.req.url ?? '').split('?')[0] ?? '';
    const rawTail = (/^\/api\/v1\/public\/snapshots\/[^/]+\/files\/(.*)$/.exec(rawPath) ?? [])[1] ?? '';
    const path = normalizePublicFilePath(rawTail);
    // A traversal probe learns nothing more than a missing file would tell it.
    if (!path) return json(ctx.res, 404, { error: 'not_found' });
    const resolved = await resources.resolvePublicFile(ctx.params.slug, path);
    if (!resolved) return json(ctx.res, 404, { error: 'not_found' });
    const size = await blobs.size(resolved.entry.sha256);
    if (size === null) return json(ctx.res, 404, { error: 'not_found' });
    const etag = `"${resolved.entry.sha256}"`;
    const headers: Record<string, string | number> = {
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      etag,
    };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return;
    }
    ctx.res.writeHead(200, {
      ...headers,
      'content-type': contentTypeFor(path),
      'content-length': size,
      // Shared links render untrusted HTML: sandbox it so it cannot reach the hub API with the viewer's cookies.
      'content-security-policy': "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src 'self' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:",
    });
    await pipeline(blobs.open(resolved.entry.sha256), ctx.res);
  });

  // ---- invites (contracts workspace-invites.ts; invite-create.ts; invite-continue.ts) -----------
  const inviteRoute = (handler: Handler): Handler => async (ctx) => {
    try {
      await handler(ctx);
    } catch (error) {
      if (error instanceof InviteServiceError) return json(ctx.res, error.status, { error: error.code });
      if (error instanceof ResourceServiceError) return json(ctx.res, error.status, { error: error.code });
      throw error;
    }
  };

  /** Caller must be an active owner/admin of `:workspaceId` (header not required: the path names the workspace). */
  route('POST', '/api/v1/workspaces/:workspaceId/invites', true, inviteRoute(async (ctx) => {
    const workspaceId = ctx.params.workspaceId;
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) return json(ctx.res, 404, { error: 'workspace_not_found' });
    const token = await gitlabAccessOr401(ctx);
    if (token === undefined) return;
    try {
      await directory.ensureFresh(ctx.principal!.user, token);
    } catch (error) {
      if (error instanceof GitLabSessionRevokedError) return unauthorized(ctx.res);
      throw error;
    }
    const workspace = await store.getWorkspace(workspaceId);
    const membership = await store.getMembership(ctx.principal!.user.id, workspaceId);
    if (!workspace || !membership || membership.memberStatus !== 'active') return json(ctx.res, 403, { error: 'workspace_forbidden' });
    const body = await readJsonBody(ctx.req);
    const { invite } = await invites.create(
      { user: ctx.principal!.user, membership, ip: clientIp(ctx.req), userAgent: headerString(ctx.req, 'user-agent') },
      workspace,
      body,
      consoleOrigin(ctx.req),
    );
    // invite-create.ts:95-104 reads `inviteId` (or `id`).
    json(ctx.res, 201, { inviteId: invite.id });
  }));

  const previewVars = (preview: Awaited<ReturnType<InviteService['preview']>>, req: IncomingMessage, token: string): TemplateVars => ({
    workspaceName: preview.workspace.name,
    inviterName: preview.inviter?.name ?? 'A teammate',
    role: preview.invite.role,
    invitedEmailMasked: preview.wire.invitedEmailMasked,
    expiresAt: humanUtc(preview.wire.expiresAt),
    acceptUrl: acceptUrlFor(consoleOrigin(req), token),
    downloadUrl: preview.wire.clientHints.downloadUrl,
    state: preview.invite.status === 'pending' ? 'pending' : preview.invite.status === 'accepted' ? 'already-accepted' : 'expired',
    statePending: preview.invite.status === 'pending',
    stateExpired: preview.invite.status === 'expired' || preview.invite.status === 'revoked',
    stateAlreadyAccepted: preview.invite.status === 'accepted',
  });

  /** JSON preview (contracts :97-107); `Accept: text/html` renders invite-landing.html instead. */
  const previewHandler: Handler = async (ctx) => {
    const token = ctx.params.token;
    if (wantsHtml(ctx.req)) {
      try {
        const preview = await invites.preview(token);
        return html(ctx.res, 200, templates.render('invite-landing', previewVars(preview, ctx.req, token)));
      } catch (error) {
        if (error instanceof InviteServiceError) return htmlError(ctx.res, error.status, error.code, 'This invite link is not valid.');
        throw error;
      }
    }
    try {
      json(ctx.res, 200, (await invites.preview(token)).wire);
    } catch (error) {
      if (error instanceof InviteServiceError) return json(ctx.res, error.status, { error: error.code });
      throw error;
    }
  };
  route('GET', '/api/v1/workspace-invites/:token', false, previewHandler);
  // The browser landing URL mailed to the invitee is the console alias of the same preview.
  route('GET', '/console/invites/:token', false, previewHandler);

  /** JSON accept (contracts :116-153) for a signed-in API client. */
  route('POST', '/api/v1/workspace-invites/:token/accept', true, inviteRoute(async (ctx) => {
    // Mirror the acceptor's GitLab memberships first so `already_member` sees a
    // member who has never called the hub before (the create-time email check
    // cannot, because GitLab may hide the address).
    const token = await gitlabAccessOr401(ctx);
    if (token === undefined) return;
    try {
      await directory.ensureFresh(ctx.principal!.user, token);
    } catch (error) {
      if (error instanceof GitLabSessionRevokedError) return unauthorized(ctx.res);
      throw error;
    }
    const body = await readJsonBody(ctx.req);
    const result = await invites.accept(ctx.params.token, ctx.principal!.user, {
      continueWithCurrentAccount: body.continueWithCurrentAccount === true,
      ip: clientIp(ctx.req),
      userAgent: headerString(ctx.req, 'user-agent'),
    });
    json(ctx.res, 200, result);
  }));

  /** Desktop hand-off (invite-continue.ts:59-75): Bearer, no body, single use. */
  route('POST', '/api/v1/workspace-invites/continuations/:nonce/consume', true, inviteRoute(async (ctx) => {
    await drainBody(ctx.req).catch(() => Buffer.alloc(0));
    const result = await invites.consume(ctx.params.nonce, ctx.principal!.user, { ip: clientIp(ctx.req), userAgent: headerString(ctx.req, 'user-agent') });
    json(ctx.res, 200, result);
  }));

  // ---- browser OAuth authorization-code flow for invite accept --------------------------------
  // State + PKCE verifier + invite token travel in one HttpOnly cookie sealed
  // with the token cipher (never in the URL, never in the store); GitLab only
  // ever sees `state`. The callback path is fixed so the cookie is scoped to it.
  route('GET', '/console/invites/:token/accept', false, async (ctx) => {
    const token = ctx.params.token;
    if (!SECRET_PATTERN.test(token)) return htmlError(ctx.res, 404, 'invite_not_found', 'This invite link is not valid.');
    if (!auth.enabled) return htmlError(ctx.res, 501, NOT_SUPPORTED_CODE, 'GitLab sign-in is not configured on this hub.');
    let preview;
    try {
      preview = await invites.preview(token);
    } catch (error) {
      if (error instanceof InviteServiceError) return htmlError(ctx.res, error.status, error.code, 'This invite link is not valid.');
      throw error;
    }
    if (preview.invite.status !== 'pending') {
      return html(ctx.res, 200, templates.render('invite-landing', previewVars(preview, ctx.req, token)));
    }
    const origin = consoleOrigin(ctx.req);
    const state = mintSecret();
    const verifier = mintSecret();
    const sealed = cipher.encrypt(JSON.stringify({ state, verifier, token, at: now().getTime() })).toString('base64url');
    const location = auth.browserAuthorizationUrl({ redirectUri: `${origin}/console/oauth/callback`, state, codeChallenge: pkceChallenge(verifier) });
    ctx.res.writeHead(302, {
      location,
      'set-cookie': oauthCookie(sealed, origin.startsWith('https:')),
      'cache-control': 'no-store',
    });
    ctx.res.end();
  });

  route('GET', '/console/oauth/callback', false, async (ctx) => {
    const origin = consoleOrigin(ctx.req);
    const clear = oauthCookie('', origin.startsWith('https:'), 0);
    const fail = (status: number, code: string, message: string) => {
      ctx.res.setHeader('set-cookie', clear);
      htmlError(ctx.res, status, code, message);
    };
    const sealed = parseCookies(ctx.req)[OAUTH_COOKIE];
    if (!sealed) return fail(400, 'oauth_state_missing', 'Your sign-in session expired. Open the invite link again.');
    let session: { state: string; verifier: string; token: string; at: number };
    try {
      session = JSON.parse(cipher.decrypt(Buffer.from(sealed, 'base64url'), cipher.keyId)) as typeof session;
    } catch {
      return fail(400, 'oauth_state_invalid', 'Your sign-in session is not valid. Open the invite link again.');
    }
    if (now().getTime() - session.at > OAUTH_COOKIE_TTL_S * 1000) return fail(400, 'oauth_state_expired', 'Your sign-in session expired. Open the invite link again.');
    const upstreamError = ctx.url.searchParams.get('error');
    if (upstreamError) return fail(403, `gitlab_${upstreamError}`, 'GitLab did not authorize the sign-in.');
    const state = ctx.url.searchParams.get('state') ?? '';
    const code = ctx.url.searchParams.get('code') ?? '';
    if (!code || typeof session.state !== 'string' || !secretEquals(state, session.state)) return fail(400, 'oauth_state_mismatch', 'The sign-in response did not match this browser session.');
    let user;
    try {
      user = await auth.completeBrowserLogin({ code, redirectUri: `${origin}/console/oauth/callback`, codeVerifier: session.verifier });
    } catch (error) {
      if (error instanceof GitLabTokenError) return fail(403, `gitlab_${error.code}`, 'GitLab rejected the sign-in code.');
      throw error;
    }
    // Mirror the fresh account's GitLab memberships so `already_member` is judged on facts.
    try {
      await directory.ensureFresh(user, await auth.ensureGitLabAccess(user));
    } catch (error) {
      if (error instanceof GitLabSessionRevokedError) return fail(403, 'gitlab_session_revoked', 'GitLab rejected the sign-in.');
      if (!(error instanceof GitLabUnavailableError)) throw error;
      log(`[od-hub] directory refresh after browser login for ${user.id} failed transiently: ${error.message}`);
    }
    try {
      const result = await invites.accept(session.token, user, {
        continueWithCurrentAccount: true,
        ip: clientIp(ctx.req),
        userAgent: headerString(ctx.req, 'user-agent'),
      });
      const workspace = await store.getWorkspace(result.workspaceId);
      ctx.res.setHeader('set-cookie', clear);
      html(ctx.res, 200, templates.render('invite-accepted', {
        workspaceName: workspace?.name ?? result.workspaceId,
        role: result.role,
        deeplinkUrl: result.continuation.deeplinkUrl,
        fallbackDownloadUrl: result.continuation.fallbackDownloadUrl,
        expiresInMinutes: Math.max(1, Math.round((result.continuation.expiresAt - now().getTime()) / 60_000)),
      }));
    } catch (error) {
      if (error instanceof InviteServiceError) {
        const message = error.code === 'already_member'
          ? 'You are already a member of this workspace.'
          : error.code === 'invite_consumed'
            ? 'This invite has already been accepted.'
            : error.code === 'invite_expired'
              ? 'This invite has expired. Ask the inviter for a new one.'
              : 'The invite could not be accepted.';
        return fail(error.status, error.code, message);
      }
      throw error;
    }
  });

  /**
   * Friendlier landing after the device flow completed; the CLI may print this
   * URL. Identity is shown only when the request itself proves it (a Bearer
   * the store accepts); a `?user=` hint is ignored because a URL parameter is
   * not proof of identity and GitLab ids are enumerable.
   */
  route('GET', '/console/device/done', false, async (ctx) => {
    const principal = ctx.bearer ? await store.authenticate(ctx.bearer, now(), { slidingTtlMs: config.controlKeyTtlMs }) : null;
    const gitlabHost = config.gitlabUrl ? new URL(config.gitlabUrl).host : 'GitLab';
    const deeplink = ctx.url.searchParams.get('deeplink') ?? '';
    html(ctx.res, 200, templates.render('device-authorized', {
      userName: principal?.user.name ?? 'your GitLab account',
      userEmail: principal?.user.email ?? '',
      gitlabHost,
      deeplinkUrl: deeplink.startsWith('opendesign://') ? deeplink : '',
    }));
  });

  // Any other /console path renders the error page, never a JSON 404 in a browser tab.
  route('GET', '/console/*', false, (ctx) => htmlError(ctx.res, 404, 'not_found', 'There is nothing at this address.'));

  // ---- audit export ---------------------------------------------------------------------------
  /**
   * Visibility: rows in workspaces the caller administers (owner/admin, active)
   * plus the caller's own actions anywhere. Cursor paging by row id.
   */
  route('GET', '/api/v1/admin/audit', true, async (ctx) => {
    const token = await gitlabAccessOr401(ctx);
    if (token === undefined) return;
    try {
      await directory.ensureFresh(ctx.principal!.user, token);
    } catch (error) {
      if (error instanceof GitLabSessionRevokedError) return unauthorized(ctx.res);
      throw error;
    }
    const memberships = await store.listMemberships(ctx.principal!.user.id);
    const administered = memberships.filter((m) => m.memberStatus === 'active' && canManageAll(m)).map((m) => m.workspaceId);
    if (administered.length === 0) return json(ctx.res, 403, { error: 'admin_required' });
    const q = ctx.url.searchParams;
    const since = q.get('since');
    if (since && Number.isNaN(Date.parse(since))) return json(ctx.res, 400, { error: 'invalid_since' });
    const limitRaw = q.get('limit');
    const limit = limitRaw === null ? 100 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return json(ctx.res, 400, { error: 'invalid_limit' });
    const afterId = decodeAuditCursor(q.get('cursor'));
    if (afterId === undefined) return json(ctx.res, 400, { error: 'invalid_cursor' });
    const rows = await store.queryAudit({
      since: since || null,
      actorUserId: q.get('actor')?.trim() || null,
      action: q.get('action')?.trim() || null,
      workspaceIds: administered,
      ownActorUserId: ctx.principal!.user.id,
      afterId,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeAuditCursor(page[page.length - 1]!.id) : null;
    json(ctx.res, 200, { events: page.map(toAuditWire), nextCursor });
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
      // The WHATWG parser silently resolves `.`/`..` (and `%2e%2e`) segments. A
      // request whose raw path is not already normal was written by something
      // probing for traversal; refuse it before any route sees it.
      const rawPath = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
      if (rawPath !== url.pathname) {
        // Under the anonymous public tree a probe gets the same answer as a
        // missing file, so it cannot distinguish "blocked" from "absent".
        if (rawPath.startsWith('/api/v1/public/')) return json(res, 404, { error: 'not_found' });
        return json(res, 400, { error: 'invalid_path' });
      }
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
      const bearer = bearerToken(req);
      if (matched.auth) {
        principal = await store.authenticate(bearer, now(), { slidingTtlMs: config.controlKeyTtlMs });
        if (!principal) return unauthorized(res);
      }
      const values = matched.pattern.exec(url.pathname) ?? [];
      const params: Record<string, string> = {};
      matched.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(values[index + 1] ?? '');
      });
      await matched.handler({ req, res, url, principal, params, bearer });
    } catch (error) {
      if (error instanceof GitLabNotConfiguredError) {
        if (!res.headersSent) return url.pathname.startsWith('/console/') ? htmlError(res, 501, NOT_SUPPORTED_CODE, 'GitLab sign-in is not configured on this hub.') : notSupported(res);
      }
      if (error instanceof BodyError) {
        if (!res.headersSent) return json(res, error.status, { error: error.code });
      }
      log(`[od-hub] ${method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        if (url.pathname.startsWith('/console/')) htmlError(res, 500, 'internal_error', 'The hub hit an unexpected error. Try again in a moment.');
        else json(res, 500, { error: 'internal_error' });
      } else res.end();
    }
  });

  return {
    server,
    auth,
    directory,
    relay,
    resources,
    collab,
    presence,
    invites,
    blobs,
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
      relay.closeAll();
      return new Promise((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
