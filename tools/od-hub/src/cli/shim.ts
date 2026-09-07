import { BILLING_SUMMARY_STUB, OD_VELA_VERSION } from '../shared/wire.js';
import { flagString, parseArgs } from './args.js';
import { resolveShimContext, type Env, type ShimContext } from './config.js';
import { hubRequest, ShimError, type FetchLike } from './http.js';
import { runLogin, runLogout, type LoginIo } from './login.js';
import { handleResource, handleTeamProjects } from './resources.js';

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliDeps {
  fetch?: FetchLike;
  context?: ShimContext;
  /**
   * Streaming sinks for long-running commands (`login`). When provided, output
   * is written as it happens and the returned CliResult carries only what was
   * not already streamed. Without them everything is buffered.
   */
  io?: Partial<Pick<LoginIo, 'stdout' | 'stderr' | 'openBrowser' | 'sleep' | 'maxWaitMs'>>;
  /** stdin reader for `resource pull-batch --requests-file -`; defaults to empty input. */
  stdin?: () => Promise<string>;
}

/** Flags that always consume the following token as a value. */
const VALUE_FLAGS = new Set([
  'format', 'workspace-id', 'run-id', 'outcome', 'terminal-at', 'ref', 'name',
  'display-name', 'role', 'comment-json', 'since-seq', 'client-id', 'file-path',
  'activity-json', 'exclude', 'exclude-prefix', 'metadata-json', 'requests-file',
  'resource-id', 'sync-state', 'last-synced-version-id', 'expected-version',
  'live-dir', 'model', 'prompt', 'image', 'aspect-ratio', 'resolution', 'quality',
  'output', 'profile', 'team-id', 'plan-id', 'return-url',
]);


function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function ok(stdout: string): CliResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(error: ShimError): CliResult {
  return { stdout: '', stderr: `${error.stderrLine}\n`, exitCode: error.exitCode };
}

/**
 * Scope label used in stderr: the subcommand path (`billing workspace-balance`,
 * `collab member register`). Never echo user-supplied values here — stderr is
 * regex-classified by the daemon.
 */
function scopeOf(parts: string[]): string {
  return parts.filter((part) => !part.startsWith('--')).join(' ') || 'vela';
}

// ---- command handlers -------------------------------------------------------

function handleModel(argv: string[]): CliResult {
  const { positionals } = parseArgs(argv, VALUE_FLAGS);
  const sub = positionals[0];
  // amr.ts:133-165 parseVelaModelJson: `source` must match the command exactly.
  if (sub === 'list') return ok(jsonLine({ source: 'remote', data: [] }));
  if (sub === 'preset') return ok(jsonLine({ source: 'preset', data: [] }));
  return fail(ShimError.notSupported(scopeOf(['model', ...positionals.slice(0, 1)])));
}

function handleMedia(argv: string[]): CliResult {
  const { positionals } = parseArgs(argv, VALUE_FLAGS);
  // media/vela.ts:187-191 parseJsonObject requires an OBJECT with a `models` array.
  if (positionals[0] === 'models') return ok(jsonLine({ models: [] }));
  return fail(ShimError.notSupported(scopeOf(['media', ...positionals.slice(0, 1)])));
}

/**
 * image/video: media/vela.ts:375-422 reads a JSON error envelope from stdout on
 * non-zero exit (`velaMediaErrorFromFailure` consumes code/message/retryable),
 * so the refusal reaches the user as a verdict, not as a retryable poll failure.
 */
export const MEDIA_NOT_SUPPORTED_ENVELOPE = {
  error: { code: 'not_supported', message: 'od-hub does not provide media generation', retryable: false },
} as const;

function handleMediaGeneration(): CliResult {
  return { stdout: jsonLine(MEDIA_NOT_SUPPORTED_ENVELOPE), stderr: '', exitCode: 1 };
}

async function handleBilling(argv: string[], ctx: ShimContext, fetchImpl?: FetchLike): Promise<CliResult> {
  const { positionals, flags } = parseArgs(argv, VALUE_FLAGS);
  const sub = positionals[0];
  const scope = scopeOf(['billing', ...(sub ? [sub] : [])]);
  switch (sub) {
    case 'summary':
      return ok(jsonLine(BILLING_SUMMARY_STUB));
    case 'workspace-snapshot': {
      const workspaceId = flagString(flags, 'workspace-id')?.trim() ?? '';
      if (!workspaceId) return fail(ShimError.local(scope, 'required flag --workspace-id is missing'));
      try {
        const snapshot = await hubRequest(ctx, scope, '/api/v1/billing/workspace-snapshot', { workspaceId }, fetchImpl);
        return ok(jsonLine(snapshot));
      } catch (error) {
        return fail(error instanceof ShimError ? error : ShimError.network(scope, String(error)));
      }
    }
    case 'workspace-balance':
    case 'team-catalog':
    case 'checkout':
      // Deliberately closed (PLAN §4.3). The daemon must NOT see `unknown flag`
      // or `billing_workspace_snapshot_unsupported` here (vela-billing.ts:539-553).
      return fail(ShimError.notSupported(scope));
    default:
      return fail(ShimError.notSupported(scope));
  }
}

/** amr-terminal-report-outbox: receipt {runId,outcome,terminalAt,recorded} or stdout error envelope. */
function handleRun(argv: string[]): CliResult {
  const { positionals, flags } = parseArgs(argv, VALUE_FLAGS);
  if (positionals[0] !== 'terminal') {
    return fail(ShimError.notSupported(scopeOf(['run', ...positionals.slice(0, 1)])));
  }
  const runId = flagString(flags, 'run-id')?.trim() ?? '';
  const outcome = flagString(flags, 'outcome')?.trim() ?? '';
  const terminalAt = flagString(flags, 'terminal-at')?.trim() ?? '';
  if (!runId || !outcome || !terminalAt || Number.isNaN(Date.parse(terminalAt))) {
    return {
      stdout: jsonLine({ error: 'invalid_input', retryable: false, message: 'run terminal requires --run-id, --outcome and an ISO --terminal-at' }),
      stderr: '',
      exitCode: 1,
    };
  }
  return ok(jsonLine({ runId, outcome, terminalAt, recorded: true }));
}

function handleTodo(group: string, argv: string[], depth: number): CliResult {
  const { positionals } = parseArgs(argv, VALUE_FLAGS);
  // TODO(M3): collab member|comment|presence; agent run (M5).
  return fail(ShimError.notSupported(scopeOf([group, ...positionals.slice(0, depth)])));
}

/**
 * login/logout stream their output (the daemon needs the activation URL long
 * before the process exits). Buffer into the CliResult only when the caller
 * gave no sinks.
 */
async function handleAuth(command: 'login' | 'logout', ctx: ShimContext, env: Env, deps: CliDeps): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const io: LoginIo = {
    stdout: deps.io?.stdout ?? ((text) => { stdout += text; }),
    stderr: deps.io?.stderr ?? ((text) => { stderr += text; }),
    ...(deps.io?.openBrowser ? { openBrowser: deps.io.openBrowser } : {}),
    ...(deps.io?.sleep ? { sleep: deps.io.sleep } : {}),
    ...(deps.io?.maxWaitMs !== undefined ? { maxWaitMs: deps.io.maxWaitMs } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  try {
    const exitCode = command === 'login' ? await runLogin(ctx, env, io) : await runLogout(ctx, env, io);
    return { stdout, stderr, exitCode };
  } catch (error) {
    const shimError = error instanceof ShimError ? error : ShimError.network(command, error instanceof Error ? error.message : String(error));
    return { stdout, stderr: `${stderr}${shimError.stderrLine}\n`, exitCode: shimError.exitCode };
  }
}

// ---- entry ------------------------------------------------------------------

/**
 * Render an unexpected throw (bug, ENOENT, bad JSON) in the same single-line
 * stderr shape as routed failures so the daemon never sees a stack trace and
 * never one of its compat-fallback triggers (`unknown command`, `unknown flag:`).
 */
export function crashResult(argv: string[], error: unknown): CliResult {
  const scope = argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ') || 'vela';
  const message = (error instanceof Error ? error.message : String(error)).split('\n')[0]!.trim() || 'unexpected failure';
  return { stdout: '', stderr: `Error: ${scope}: ${message}\n`, exitCode: 1 };
}

export async function runCli(argv: string[], env: Env, deps: CliDeps = {}): Promise<CliResult> {
  const [command, ...rest] = argv;
  if (command === '--version' || command === 'version' || command === '-v') {
    return ok(`${OD_VELA_VERSION}\n`);
  }
  if (!command) {
    return fail(ShimError.notSupported('vela'));
  }
  const ctx = deps.context ?? resolveShimContext(env);
  switch (command) {
    case 'model': return handleModel(rest);
    case 'models': return ok('');
    case 'media': return handleMedia(rest);
    case 'image':
    case 'video': return handleMediaGeneration();
    case 'billing': return handleBilling(rest, ctx, deps.fetch);
    case 'run': return handleRun(rest);
    case 'team-projects': return handleTeamProjects(rest, ctx, deps.fetch);
    case 'login':
    case 'logout': return handleAuth(command, ctx, env, deps);
    case 'collab': return handleTodo(command, rest, 2);
    case 'resource': return handleResource(rest, ctx, deps.stdin ?? (async () => ''), deps.fetch);
    case 'agent': return handleTodo(command, rest, 1);
    default:
      // Generic unknown subcommand: typed 501, never "unknown command".
      return fail(ShimError.notSupported(scopeOf([command])));
  }
}
