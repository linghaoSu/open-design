import { flagString, parseArgs } from './args.js';
import type { ShimContext } from './config.js';
import { hubRequest, ShimError, type FetchLike } from './http.js';

/**
 * `od-vela admin audit export [--since <iso>] [--actor <userId>] [--action <a>] [--limit <n>] [--json]`
 *
 * Hub-only operator command (no daemon contract): pages through
 * `GET /api/v1/admin/audit` until `nextCursor` is null and prints one JSON
 * object `{events, count}`. Without `--json` the same events print one per
 * line as `<at> <action> <actorUserId> <workspaceId> <target>`.
 */

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const VALUE_FLAGS = new Set(['since', 'actor', 'action', 'limit', 'workspace-id', 'format']);
const MAX_PAGES = 1000;

export interface AuditEventWire {
  id: number;
  at: string;
  actorUserId: string | null;
  actorMemberId: string | null;
  workspaceId: string | null;
  action: string;
  target: string | null;
  details: Record<string, unknown> | null;
}

interface AuditPageWire {
  events: AuditEventWire[];
  nextCursor: string | null;
}

function fail(error: ShimError): CliResult {
  return { stdout: '', stderr: `${error.stderrLine}\n`, exitCode: error.exitCode };
}

export async function handleAdmin(argv: string[], ctx: ShimContext, fetchImpl?: FetchLike): Promise<CliResult> {
  const { positionals, flags } = parseArgs(argv, VALUE_FLAGS);
  const scope = ['admin', ...positionals.slice(0, 2)].join(' ');
  if (positionals[0] !== 'audit' || positionals[1] !== 'export') return fail(ShimError.notSupported(scope));
  const since = flagString(flags, 'since');
  if (since !== null && Number.isNaN(Date.parse(since))) return fail(ShimError.local(scope, '--since must be an ISO-8601 timestamp'));
  const limitRaw = flagString(flags, 'limit');
  const limit = limitRaw === null ? 500 : Number.parseInt(limitRaw, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return fail(ShimError.local(scope, '--limit must be an integer between 1 and 1000'));
  try {
    const events: AuditEventWire[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body: AuditPageWire = await hubRequest<AuditPageWire>(ctx, scope, '/api/v1/admin/audit', {
        query: {
          since: since === null ? undefined : new Date(Date.parse(since)).toISOString(),
          actor: flagString(flags, 'actor') ?? undefined,
          action: flagString(flags, 'action') ?? undefined,
          limit: String(limit),
          cursor: cursor ?? undefined,
        },
        workspaceId: null,
      }, fetchImpl);
      events.push(...(Array.isArray(body.events) ? body.events : []));
      cursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null;
      if (!cursor) break;
    }
    if (flags.json === true || flagString(flags, 'format') === 'json') {
      return { stdout: `${JSON.stringify({ events, count: events.length })}\n`, stderr: '', exitCode: 0 };
    }
    const lines = events.map((e) => [e.at, e.action, e.actorUserId ?? '-', e.workspaceId ?? '-', e.target ?? '-'].join(' '));
    return { stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '', exitCode: 0 };
  } catch (error) {
    return fail(error instanceof ShimError ? error : ShimError.network(scope, error instanceof Error ? error.message : String(error)));
  }
}
