import { spawn } from 'node:child_process';

import {
  LOGIN_ACTIVATION_HEADER,
  LOGIN_BROWSER_OPEN_FAILED_PREFIX,
  LOGIN_CODE_PREFIX,
  loginSuccessLine,
} from '../shared/wire.js';
import { writeProfile, type Env, type ShimContext, type StoredProfile } from './config.js';
import { hubHeaders, ShimError, type FetchLike } from './http.js';

/** Streaming sinks: login must print the activation block before it finishes. */
export interface LoginIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Injectable for tests; defaults to `xdg-open` / `open` / `cmd /c start`. */
  openBrowser?: (url: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  fetch?: FetchLike;
  /** Absolute deadline for the whole flow; defaults to the hub-provided expiresIn. */
  maxWaitMs?: number;
}

interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Best-effort browser launch; failures are reported by the caller on stderr (vela.ts:355). */
export function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, args] = process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function postJson<T>(ctx: ShimContext, scope: string, pathname: string, body: unknown, fetchImpl: FetchLike): Promise<{ status: number; body: T }> {
  const url = new URL(pathname, ctx.apiUrl);
  const headers = hubHeaders({ ...ctx, controlKey: ctx.controlKey }, null);
  headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (error) {
    const detail = error instanceof Error
      ? (error.name === 'AbortError' ? 'timeout' : ((error as { cause?: { code?: string } }).cause?.code ?? error.message))
      : String(error);
    throw ShimError.network(scope, detail);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text.trim() ? JSON.parse(text) : null;
  } catch {
    if (response.ok) throw ShimError.network(scope, 'invalid JSON response');
  }
  return { status: response.status, body: parsed as T };
}

function errorCode(body: unknown, status: number): string {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  return status === 401 ? 'invalid_api_key' : `http_${status}`;
}

/**
 * `od-vela login` (PLAN §5.1). Stdout is exactly what
 * apps/daemon/src/integrations/vela.ts:345-348 parses:
 *
 *   Open this URL to continue:
 *   <verificationUriComplete>
 *
 *   Code: <userCode>
 *
 * then, on success, `Login successful for <email>.`; exit 0. The daemon spawns
 * us with stdin ignored and judges success by `runtimeKey` appearing in
 * config.json, not by the exit code (vela.ts:522-534).
 */
export async function runLogin(ctx: ShimContext, env: Env, io: LoginIo): Promise<number> {
  const scope = 'login';
  const fetchImpl = io.fetch ?? fetch;
  const sleep = io.sleep ?? defaultSleep;
  const openBrowser = io.openBrowser ?? defaultOpenBrowser;
  // Login must not reuse a stale bearer; the device routes are public.
  const anon: ShimContext = { ...ctx, controlKey: null };

  const started = await postJson<DeviceStartResponse>(anon, scope, '/api/v1/auth/device', { profile: ctx.profile }, fetchImpl);
  if (started.status !== 200 || !started.body?.deviceCode) {
    throw ShimError.http(scope, started.status, errorCode(started.body, started.status));
  }
  const { deviceCode, userCode, interval, expiresIn } = started.body;
  const activationUrl = started.body.verificationUriComplete || started.body.verificationUri;
  if (!activationUrl || !userCode) throw ShimError.network(scope, 'hub returned no verification URL');

  io.stdout(`${LOGIN_ACTIVATION_HEADER}\n${activationUrl}\n\n${LOGIN_CODE_PREFIX}${userCode}\n\n`);
  try {
    // OD_VELA_OPEN_BROWSER=0 opts out (headless hosts, smoke scripts). It takes the
    // same stderr line as a failed launch so the daemon shows the URL itself.
    if (env.OD_VELA_OPEN_BROWSER === '0') throw new Error('disabled by OD_VELA_OPEN_BROWSER=0');
    await openBrowser(activationUrl);
  } catch (error) {
    io.stderr(`${LOGIN_BROWSER_OPEN_FAILED_PREFIX}${error instanceof Error ? error.message : String(error)}\n`);
  }

  let waitMs = Math.max(1, Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000;
  const deadline = Date.now() + (io.maxWaitMs ?? Math.max(30, expiresIn || 600) * 1000);
  for (;;) {
    if (Date.now() > deadline) throw new ShimError(scope, 'device authorization expired before approval', 1);
    await sleep(waitMs);
    const poll = await postJson<Record<string, unknown>>(anon, scope, '/api/v1/auth/device/token', { deviceCode }, fetchImpl);
    if (poll.status === 200 && poll.body) {
      const result = poll.body as unknown as StoredProfile;
      if (typeof result.controlKey !== 'string' || typeof result.runtimeKey !== 'string' || !result.user?.email) {
        throw ShimError.network(scope, 'hub login response is missing keys');
      }
      writeProfile(env, ctx.profile, {
        controlKey: result.controlKey,
        runtimeKey: result.runtimeKey,
        apiUrl: typeof result.apiUrl === 'string' && result.apiUrl ? result.apiUrl : ctx.apiUrl,
        linkUrl: typeof result.linkUrl === 'string' && result.linkUrl ? result.linkUrl : ctx.apiUrl,
        user: result.user,
      });
      io.stdout(`${loginSuccessLine(result.user.email)}\n`);
      return 0;
    }
    const code = errorCode(poll.body, poll.status);
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      // RFC 8628 §3.5: add 5s and keep polling.
      waitMs += 5_000;
      continue;
    }
    throw ShimError.http(scope, poll.status, code);
  }
}

/** `od-vela logout`: revoke the key at the hub, then drop it from the profile. Daemon never calls this (vela.ts:797-815). */
export async function runLogout(ctx: ShimContext, env: Env, io: LoginIo): Promise<number> {
  const scope = 'logout';
  const fetchImpl = io.fetch ?? fetch;
  if (ctx.controlKey) {
    const res = await postJson(ctx, scope, '/api/v1/auth/revoke', {}, fetchImpl);
    // 401 means the key is already dead; treat as success locally.
    if (res.status !== 200 && res.status !== 401) throw ShimError.http(scope, res.status, errorCode(res.body, res.status));
  }
  writeProfile(env, ctx.profile, null);
  io.stdout('Logged out.\n');
  return 0;
}
