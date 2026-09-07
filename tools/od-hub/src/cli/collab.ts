import { flagString, parseArgs, type ParsedArgs } from './args.js';
import type { ShimContext } from './config.js';
import { hubRequest, ShimError, type FetchLike } from './http.js';

/**
 * `od-vela collab member|comment|presence *` — argv and stdout exactly as
 * apps/daemon/src/collab/vela-cli-collab-client.ts builds and parses them
 * (extract-1.md §2). Every call carries the ambient workspace header
 * (`VELA_WORKSPACE_ID`, injected per invocation by vela-command.ts:153-165);
 * memberId and role never travel in argv — the hub derives both from the
 * bearer.
 */

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const VALUE_FLAGS = new Set([
  'display-name', 'role', 'comment-json', 'since-seq', 'client-id', 'file-path', 'activity-json', 'workspace-id', 'format',
]);

/**
 * Presence budget: the daemon SIGTERMs the shim at 10 s
 * (PRESENCE_COMMAND_TIMEOUT_MS, vela-cli-collab-client.ts:233) and two such
 * kills open a 20 s negative cache (routes/collab-presence.ts). Failing at 8 s
 * with a typed line keeps the failure classified instead of killed.
 */
export const PRESENCE_HTTP_TIMEOUT_MS = 8_000;

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function ok(stdout: string): CliResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(error: ShimError): CliResult {
  return { stdout: '', stderr: `${error.stderrLine}\n`, exitCode: error.exitCode };
}

function toShimError(scope: string, error: unknown): ShimError {
  if (error instanceof ShimError) return error;
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.trim();
  return new ShimError(scope, message || 'unexpected failure', 1);
}

function encode(segment: string): string {
  return encodeURIComponent(segment);
}

function requireWorkspace(scope: string, ctx: ShimContext): void {
  if (!ctx.workspaceId) throw ShimError.local(scope, 'VELA_WORKSPACE_ID (or OPEN_DESIGN_WORKSPACE_ID) is required');
}

function requireProjectId(scope: string, projectId: string | undefined, usage: string): string {
  const value = projectId?.trim() ?? '';
  if (!value) throw ShimError.local(scope, `usage: ${usage}`);
  return value;
}

function parseJsonFlag(scope: string, flags: ParsedArgs['flags'], key: string): unknown {
  const raw = flagString(flags, key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw ShimError.local(scope, `--${key} is not valid JSON`);
  }
}

export async function handleCollab(argv: string[], ctx: ShimContext, fetchImpl?: FetchLike): Promise<CliResult> {
  const { positionals, flags } = parseArgs(argv, VALUE_FLAGS);
  const [domain, verb, projectArg] = positionals;
  const scope = ['collab', domain, verb].filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
  try {
    switch (`${domain ?? ''} ${verb ?? ''}`) {
      case 'member list': {
        requireWorkspace(scope, ctx);
        return ok(jsonLine(await hubRequest(ctx, scope, '/api/v1/collab/members', {}, fetchImpl)));
      }
      case 'member register': {
        requireWorkspace(scope, ctx);
        const displayName = flagString(flags, 'display-name')?.trim() ?? '';
        if (!displayName) throw ShimError.local(scope, 'required flag --display-name is missing');
        const body: Record<string, unknown> = { displayName };
        const role = flagString(flags, 'role');
        if (role !== null) body.role = role;
        return ok(jsonLine(await hubRequest(ctx, scope, '/api/v1/collab/members/register', { method: 'POST', body }, fetchImpl)));
      }
      case 'comment push': {
        const projectId = requireProjectId(scope, projectArg, 'collab comment push <projectId> --comment-json <json>');
        requireWorkspace(scope, ctx);
        const comment = parseJsonFlag(scope, flags, 'comment-json');
        if (comment === undefined) throw ShimError.local(scope, 'required flag --comment-json is missing');
        if (!comment || typeof comment !== 'object' || Array.isArray(comment)) throw ShimError.local(scope, '--comment-json must be a JSON object');
        return ok(jsonLine(await hubRequest(ctx, scope, `/api/v1/collab/projects/${encode(projectId)}/comments`, {
          method: 'POST', body: { comment }, timeoutMs: 30_000,
        }, fetchImpl)));
      }
      case 'comment pull': {
        const projectId = requireProjectId(scope, projectArg, 'collab comment pull <projectId> --since-seq <n>');
        requireWorkspace(scope, ctx);
        const raw = flagString(flags, 'since-seq') ?? '0';
        const sinceSeq = Number(raw);
        if (!Number.isSafeInteger(sinceSeq) || sinceSeq < 0) throw ShimError.local(scope, '--since-seq must be a non-negative integer');
        return ok(jsonLine(await hubRequest(ctx, scope, `/api/v1/collab/projects/${encode(projectId)}/comments`, {
          query: { sinceSeq: String(sinceSeq) }, timeoutMs: 30_000,
        }, fetchImpl)));
      }
      case 'presence heartbeat': {
        const projectId = requireProjectId(scope, projectArg, 'collab presence heartbeat <projectId> --client-id <id> [...]');
        requireWorkspace(scope, ctx);
        const body: Record<string, unknown> = {};
        const clientId = flagString(flags, 'client-id');
        if (clientId !== null) body.clientId = clientId;
        const displayName = flagString(flags, 'display-name');
        if (displayName !== null) body.displayName = displayName;
        const filePath = flagString(flags, 'file-path');
        if (filePath !== null) body.filePath = filePath;
        const activity = parseJsonFlag(scope, flags, 'activity-json');
        if (activity !== undefined) body.activity = activity;
        return ok(jsonLine(await hubRequest(ctx, scope, `/api/v1/collab/projects/${encode(projectId)}/presence/heartbeat`, {
          method: 'POST', body, timeoutMs: PRESENCE_HTTP_TIMEOUT_MS,
        }, fetchImpl)));
      }
      case 'presence list': {
        const projectId = requireProjectId(scope, projectArg, 'collab presence list <projectId>');
        requireWorkspace(scope, ctx);
        return ok(jsonLine(await hubRequest(ctx, scope, `/api/v1/collab/projects/${encode(projectId)}/presence`, {
          timeoutMs: PRESENCE_HTTP_TIMEOUT_MS,
        }, fetchImpl)));
      }
      case 'presence leave': {
        const projectId = requireProjectId(scope, projectArg, 'collab presence leave <projectId> --client-id <id>');
        requireWorkspace(scope, ctx);
        const body: Record<string, unknown> = {};
        const clientId = flagString(flags, 'client-id');
        if (clientId !== null) body.clientId = clientId;
        return ok(jsonLine(await hubRequest(ctx, scope, `/api/v1/collab/projects/${encode(projectId)}/presence/leave`, {
          method: 'POST', body, timeoutMs: PRESENCE_HTTP_TIMEOUT_MS,
        }, fetchImpl)));
      }
      default:
        // Unknown collab verb: typed 501, never "unknown command".
        return fail(ShimError.notSupported(scope));
    }
  } catch (error) {
    return fail(toShimError(scope, error));
  }
}
