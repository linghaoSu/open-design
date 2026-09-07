import { INVOCATION_SOURCE_HEADER, OD_VELA_VERSION, WORKSPACE_HEADER } from '../shared/wire.js';
import type { ShimContext } from './config.js';

/**
 * Failure classes, PLAN §6.3:
 *   http    -> `Error: <verb> <noun>: API request failed with status <NNN>: <code>` exit 1
 *   network -> `Error: <verb> <noun>: request failed: <detail>`                    exit 1
 *   local   -> `Error: <verb> <noun>: <message>`                                    exit 2
 */
export class ShimError extends Error {
  constructor(
    readonly scope: string,
    readonly detail: string,
    readonly exitCode: 1 | 2,
  ) {
    super(`${scope}: ${detail}`);
  }

  static http(scope: string, status: number, code: string): ShimError {
    return new ShimError(scope, `API request failed with status ${status}: ${code}`, 1);
  }

  static network(scope: string, detail: string): ShimError {
    return new ShimError(scope, `request failed: ${detail}`, 1);
  }

  static local(scope: string, message: string): ShimError {
    return new ShimError(scope, message, 2);
  }

  static notSupported(scope: string): ShimError {
    return ShimError.http(scope, 501, 'not_supported');
  }

  /** Full stderr line, including the `Error: ` prefix the daemon regexes expect. */
  get stderrLine(): string {
    return `Error: ${this.message}`;
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HubRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** Override the workspace header (e.g. `--workspace-id` on billing commands). */
  workspaceId?: string | null;
}

export function hubHeaders(ctx: ShimContext, workspaceId: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': `od-vela/${OD_VELA_VERSION.replace(/^vela\s+/, '')}`,
    [INVOCATION_SOURCE_HEADER]: ctx.invocationSource,
  };
  if (ctx.controlKey) headers.authorization = `Bearer ${ctx.controlKey}`;
  if (workspaceId) headers[WORKSPACE_HEADER] = workspaceId;
  return headers;
}

function errorCodeFromBody(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    const error = parsed?.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error && typeof error === 'object') {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code.trim()) return code.trim();
    }
  } catch {
    // fall through
  }
  // Always emit `status NNN: <code>` — a bare `status 404` without a colon
  // routes the daemon into compat fallbacks (vela-cli-team-projects.ts:503).
  return status === 401 ? 'invalid_api_key' : `http_${status}`;
}

/** Perform one JSON request against the hub, translating failures to ShimError. */
export async function hubRequest<T = unknown>(
  ctx: ShimContext,
  scope: string,
  pathname: string,
  options: HubRequestOptions = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  if (!ctx.controlKey) {
    throw ShimError.local(scope, `not logged in (no VELA_CONTROL_KEY and no controlKey in ${ctx.configPath} for profile ${ctx.profile})`);
  }
  const url = new URL(pathname, ctx.apiUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  timer.unref?.();
  const headers = hubHeaders(ctx, options.workspaceId === undefined ? ctx.workspaceId : options.workspaceId);
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error
      ? (error.name === 'AbortError' ? 'timeout' : ((error as { cause?: { code?: string } }).cause?.code ?? error.message))
      : String(error);
    throw ShimError.network(scope, detail);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    throw ShimError.http(scope, response.status, errorCodeFromBody(text, response.status));
  }
  if (!text.trim()) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw ShimError.network(scope, 'invalid JSON response');
  }
}
