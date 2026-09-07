import { createReadStream } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

import { isResourceKind, PUBLISHED_REF, type ManifestEntry, type ResourceKind } from '../shared/manifest.js';
import { flagString, parseArgs, type ParsedArgs } from './args.js';
import type { ShimContext } from './config.js';
import { hubFetchBinary, hubRequest, ShimError, type FetchLike } from './http.js';
import {
  createSiblingStage,
  DEFAULT_CONCURRENCY,
  isEmptyDirectory,
  mapLimit,
  materializeManifest,
  readableFromWeb,
  snapshotTree,
  swapDirectory,
} from './tree.js';

/**
 * `od-vela resource *` and `od-vela team-projects *` — argv, stdout, and stderr
 * exactly as apps/daemon/src/collab/vela-cli-resource-adapter.ts,
 * vela-cli-resource-pull-batcher.ts, vela-cli-team-projects.ts and
 * authorized-team-project-pull.ts parse them (extract-2.md).
 *
 * Every hub call carries the ambient workspace header; the daemon injects
 * `VELA_WORKSPACE_ID` per invocation (vela-command.ts:153-165).
 */

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const VALUE_FLAGS = new Set([
  'ref', 'exclude', 'exclude-prefix', 'metadata-json', 'requests-file', 'resource-id', 'display-name',
  'sync-state', 'last-synced-version-id', 'expected-version', 'live-dir', 'workspace-id', 'format', 'name',
]);

const PUSH_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 60_000;

interface HeadWire { version: number | null; versionId: string | null }
interface PublishWire { version: number; versionId: string; manifestDigest: string; entryCount: number }
interface ManifestWire { version: number; versionId: string; manifestDigest: string; entryCount: number; manifest: ManifestEntry[] }
interface ReceiptWire { version: number; versionId: string; manifestDigest: string; manifestEntryCount: number; resourceId: string; [k: string]: unknown }

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

function parseMetadataJson(scope: string, flags: ParsedArgs['flags']): Record<string, unknown> | undefined {
  const raw = flagString(flags, 'metadata-json');
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw ShimError.local(scope, '--metadata-json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw ShimError.local(scope, '--metadata-json must be a JSON object');
  return parsed as Record<string, unknown>;
}

function flagList(flags: ParsedArgs['flags'], key: string): string[] {
  const value = flags[key];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return [];
}

function requireRef(scope: string, flags: ParsedArgs['flags']): void {
  const ref = flagString(flags, 'ref') ?? PUBLISHED_REF;
  if (ref !== PUBLISHED_REF) throw ShimError.http(scope, 404, 'ref_not_found');
}

function requireKind(scope: string, value: string | undefined): ResourceKind {
  if (!isResourceKind(value)) throw ShimError.local(scope, `unsupported resource kind ${JSON.stringify(value ?? '')}`);
  return value;
}

function requireWorkspace(scope: string, ctx: ShimContext): void {
  if (!ctx.workspaceId) throw ShimError.local(scope, 'VELA_WORKSPACE_ID (or OPEN_DESIGN_WORKSPACE_ID) is required');
}

// ---- resource ---------------------------------------------------------------

export async function handleResource(argv: string[], ctx: ShimContext, stdin: () => Promise<string>, fetchImpl?: FetchLike): Promise<CliResult> {
  const { positionals, flags } = parseArgs(argv, VALUE_FLAGS);
  const sub = positionals[0];
  const scope = sub ? `resource ${sub}` : 'resource';
  try {
    switch (sub) {
      case 'push': return ok(jsonLine(await push(positionals.slice(1), flags, ctx, fetchImpl)));
      case 'head': return ok(jsonLine(await head(positionals.slice(1), flags, ctx, fetchImpl)));
      case 'pull': return ok(jsonLine(await pull(positionals.slice(1), flags, ctx, fetchImpl)));
      case 'pull-batch': return ok(jsonLine(await pullBatch(flags, ctx, stdin, fetchImpl)));
      case 'remove': return ok(jsonLine(await remove(positionals.slice(1), ctx, fetchImpl)));
      case 'shared': {
        requireWorkspace(scope, ctx);
        return ok(jsonLine(await hubRequest(ctx, scope, '/api/v1/resources/shared', {}, fetchImpl)));
      }
      case 'list': {
        // Nothing in the daemon reads this (extract-2.md §1.9); mirror the fake hub.
        requireWorkspace(scope, ctx);
        return ok(jsonLine(await hubRequest(ctx, scope, '/api/v1/resources/shared', {}, fetchImpl)));
      }
      case 'snapshot': return ok(jsonLine(await snapshot(positionals.slice(1), flags, ctx, fetchImpl)));
      case 'snapshot-redact': return ok(jsonLine(await snapshotRedact(positionals.slice(1), ctx, fetchImpl)));
      default:
        // Unknown verbs: typed 501.
        return fail(ShimError.notSupported(['resource', ...positionals.slice(0, 1)].join(' ')));
    }
  } catch (error) {
    return fail(toShimError(scope, error));
  }
}

/**
 * `snapshot <id> --ref published --name N --json` -> `{slug, name, kind, versionId, createdAt}`
 * (collab-sync.ts:1312-1322; parsed by vela-cli-resource-adapter.ts:345-362).
 */
async function snapshot(positionals: string[], flags: ParsedArgs['flags'], ctx: ShimContext, fetchImpl?: FetchLike): Promise<unknown> {
  const scope = 'resource snapshot';
  const resourceId = positionals[0]?.trim() ?? '';
  if (!resourceId) throw ShimError.local(scope, 'usage: resource snapshot <resourceId> --ref published --name <name> --json');
  requireWorkspace(scope, ctx);
  requireRef(scope, flags);
  const name = flagString(flags, 'name') ?? '';
  return hubRequest(ctx, scope, `/api/v1/resources/${encode(resourceId)}/snapshots`, {
    method: 'POST',
    body: { ref: PUBLISHED_REF, name },
  }, fetchImpl);
}

/** `snapshot-redact <id> <slug> --json` -> `{ok:true}`, idempotent (collab-sync.ts:1335-1340, 1408-1413). */
async function snapshotRedact(positionals: string[], ctx: ShimContext, fetchImpl?: FetchLike): Promise<unknown> {
  const scope = 'resource snapshot-redact';
  const resourceId = positionals[0]?.trim() ?? '';
  const slug = positionals[1]?.trim() ?? '';
  if (!resourceId || !slug) throw ShimError.local(scope, 'usage: resource snapshot-redact <resourceId> <slug> --json');
  requireWorkspace(scope, ctx);
  return hubRequest(ctx, scope, `/api/v1/resources/${encode(resourceId)}/snapshots/${encode(slug)}`, { method: 'DELETE' }, fetchImpl);
}

/** `push <kind> <id> <dir> --ref published --json [--exclude]* [--exclude-prefix]* [--metadata-json]`. */
async function push(positionals: string[], flags: ParsedArgs['flags'], ctx: ShimContext, fetchImpl?: FetchLike): Promise<{ version: number; versionId: string }> {
  const scope = 'resource push';
  const kind = requireKind(scope, positionals[0]);
  const resourceId = positionals[1]?.trim() ?? '';
  const dir = positionals[2] ?? '';
  if (!resourceId || !dir) throw ShimError.local(scope, 'usage: resource push <kind> <resourceId> <dir> --ref published --json');
  requireWorkspace(scope, ctx);
  requireRef(scope, flags);
  const metadata = parseMetadataJson(scope, flags);

  const entries = await snapshotTree(path.resolve(dir), {
    exclude: flagList(flags, 'exclude'),
    excludePrefix: flagList(flags, 'exclude-prefix'),
  });
  const manifest: ManifestEntry[] = entries.map(({ path: p, sha256, size, mode }) => ({ path: p, sha256, size, mode }));

  // CAS: the version we publish over is the one we observed now.
  const current = await hubRequest<HeadWire>(ctx, scope, `/api/v1/resources/${encode(resourceId)}/head`, { query: { ref: PUBLISHED_REF } }, fetchImpl);
  const expectedVersion = current.version ?? 0;

  // Upload only what the hub does not hold yet, bounded concurrency.
  const digests = [...new Set(manifest.map((e) => e.sha256))];
  const missing = new Set<string>();
  for (let i = 0; i < digests.length; i += 2000) {
    const chunk = digests.slice(i, i + 2000);
    const response = await hubRequest<{ missing: string[] }>(ctx, scope, '/api/v1/blobs/missing', { method: 'POST', body: { sha256: chunk } }, fetchImpl);
    for (const d of response.missing) missing.add(d);
  }
  const bySha = new Map(entries.map((e) => [e.sha256, e] as const));
  await mapLimit([...missing], DEFAULT_CONCURRENCY, async (sha256) => {
    const entry = bySha.get(sha256)!;
    // Stream from disk: a multi-hundred-MiB asset must not be buffered in memory.
    const stream = Readable.toWeb(createReadStream(entry.absolutePath)) as ReadableStream<Uint8Array>;
    await hubRequest(ctx, scope, `/api/v1/blobs/${sha256}`, { method: 'PUT', rawStream: { stream, size: entry.size }, timeoutMs: PUSH_TIMEOUT_MS }, fetchImpl);
  });

  const published = await hubRequest<PublishWire>(ctx, scope, `/api/v1/resources/${kind}/${encode(resourceId)}/versions`, {
    method: 'POST',
    body: { manifest, expectedVersion, ...(metadata !== undefined ? { metadata } : {}) },
    timeoutMs: PUSH_TIMEOUT_MS,
  }, fetchImpl);
  return { version: published.version, versionId: published.versionId };
}

/** `head <id> --ref published --json` -> `{version|null, versionId|null}`. */
async function head(positionals: string[], flags: ParsedArgs['flags'], ctx: ShimContext, fetchImpl?: FetchLike): Promise<HeadWire> {
  const scope = 'resource head';
  const resourceId = positionals[0]?.trim() ?? '';
  if (!resourceId) throw ShimError.local(scope, 'usage: resource head <resourceId> --ref published --json');
  requireWorkspace(scope, ctx);
  requireRef(scope, flags);
  const wire = await hubRequest<HeadWire>(ctx, scope, `/api/v1/resources/${encode(resourceId)}/head`, { query: { ref: PUBLISHED_REF } }, fetchImpl);
  return { version: wire.version ?? null, versionId: wire.versionId ?? null };
}

interface PullOutcome { version: number; versionId: string; manifestDigest: string; entryCount: number }

/**
 * Download the published version of `resourceId` into `dir`, replacing the
 * directory inode atomically (vela-cli-resource-adapter.ts:248-276 and the
 * fake hub's `rm && cp`). Every blob is verified before the swap.
 */
async function materializeResource(scope: string, resourceId: string, dir: string, ctx: ShimContext, options: { reuseFrom?: string | null; expectedVersion?: number | null; stageInto?: string | null }, fetchImpl?: FetchLike): Promise<PullOutcome> {
  const wire = await hubRequest<ManifestWire>(ctx, scope, `/api/v1/resources/${encode(resourceId)}/versions/${PUBLISHED_REF}/manifest`, { timeoutMs: PULL_TIMEOUT_MS }, fetchImpl);
  if (options.expectedVersion != null && wire.version !== options.expectedVersion) {
    throw ShimError.http(scope, 409, 'authorized_team_project_pull_rejected');
  }
  const fetchBlob = async (sha256: string): Promise<Readable> => {
    const response = await hubFetchBinary(ctx, scope, `/api/v1/blobs/${sha256}`, { timeoutMs: PULL_TIMEOUT_MS }, fetchImpl);
    if (!response.body) throw ShimError.network(scope, `empty body for blob ${sha256}`);
    return readableFromWeb(response.body);
  };
  const stage = options.stageInto ?? (await createSiblingStage(dir, 'od-pull'));
  try {
    await materializeManifest(stage, wire.manifest, wire.manifestDigest, { fetchBlob, reuseFrom: options.reuseFrom ?? null });
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (!options.stageInto) {
    const swap = await swapDirectory(stage, dir);
    await swap.commit();
  }
  return { version: wire.version, versionId: wire.versionId, manifestDigest: wire.manifestDigest, entryCount: wire.entryCount };
}

/** `pull <kind> <id> <dir> --ref published --json` -> `{version, versionId}`. */
async function pull(positionals: string[], flags: ParsedArgs['flags'], ctx: ShimContext, fetchImpl?: FetchLike): Promise<{ version: number; versionId: string }> {
  const scope = 'resource pull';
  requireKind(scope, positionals[0]);
  const resourceId = positionals[1]?.trim() ?? '';
  const dir = positionals[2] ?? '';
  if (!resourceId || !dir) throw ShimError.local(scope, 'usage: resource pull <kind> <resourceId> <dir> --ref published --json');
  requireWorkspace(scope, ctx);
  requireRef(scope, flags);
  const outcome = await materializeResource(scope, resourceId, path.resolve(dir), ctx, {}, fetchImpl);
  return { version: outcome.version, versionId: outcome.versionId };
}

interface BatchRequest { key: string; kind: string; resourceId: string; dir: string; ref: string }

/**
 * `pull-batch --requests-file - --json`: stdin `{requests:[...]}`; every item
 * succeeds or fails on its own and the process exits 0 whenever the response
 * is well-formed (vela-cli-resource-pull-batcher.ts:84-120).
 */
async function pullBatch(flags: ParsedArgs['flags'], ctx: ShimContext, stdin: () => Promise<string>, fetchImpl?: FetchLike): Promise<unknown> {
  const scope = 'resource pull-batch';
  if (flagString(flags, 'requests-file') !== '-') throw ShimError.local(scope, 'only --requests-file - (stdin) is supported');
  requireWorkspace(scope, ctx);
  let parsed: { requests?: unknown };
  try {
    parsed = JSON.parse(await stdin()) as { requests?: unknown };
  } catch {
    throw ShimError.local(scope, 'stdin is not valid JSON');
  }
  if (!Array.isArray(parsed.requests) || parsed.requests.length === 0) throw ShimError.local(scope, 'requests must be a non-empty array');
  if (parsed.requests.length > 128) throw ShimError.local(scope, 'a batch may contain at most 128 requests');
  const keys = new Set<string>();
  const requests: BatchRequest[] = parsed.requests.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw ShimError.local(scope, `requests[${index}] must be an object`);
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key.trim() : '';
    const kind = typeof r.kind === 'string' ? r.kind.trim() : '';
    const resourceId = typeof r.resourceId === 'string' ? r.resourceId.trim() : '';
    const dir = typeof r.dir === 'string' ? r.dir.trim() : '';
    const ref = typeof r.ref === 'string' && r.ref.trim() ? r.ref.trim() : PUBLISHED_REF;
    if (!key || !kind || !resourceId || !dir) throw ShimError.local(scope, `requests[${index}] is missing a required field`);
    if (keys.has(key)) throw ShimError.local(scope, `duplicate request key ${key}`);
    keys.add(key);
    return { key, kind, resourceId, dir, ref };
  });
  const results: unknown[] = [];
  let succeeded = 0;
  // Sequential across requests, concurrent within one (blob downloads).
  for (const request of requests) {
    try {
      if (!isResourceKind(request.kind)) throw ShimError.local(scope, `unsupported resource kind ${request.kind}`);
      if (request.ref !== PUBLISHED_REF) throw ShimError.http(scope, 404, 'ref_not_found');
      const outcome = await materializeResource(scope, request.resourceId, path.resolve(request.dir), ctx, {}, fetchImpl);
      succeeded += 1;
      results.push({ ...request, ok: true, version: outcome.version, versionId: outcome.versionId });
    } catch (error) {
      const shim = toShimError(scope, error);
      const httpCode = /API request failed with status \d{3}: ([a-z_0-9]+)$/.exec(shim.detail)?.[1];
      // Mirror fake-collab-hub.ts:800-806: `error` and `errorCode` both carry the hub code.
      results.push(httpCode
        ? { ...request, ok: false, error: httpCode, errorCode: httpCode }
        : { ...request, ok: false, error: shim.detail, errorCode: shim.exitCode === 2 ? 'invalid_request' : 'pull_failed' });
    }
  }
  return { results, succeeded, failed: results.length - succeeded };
}

/** `remove <id> --json` -> `{ok:true}`; a 404 from the hub still surfaces so the daemon can classify it (it treats resource_not_found as success). */
async function remove(positionals: string[], ctx: ShimContext, fetchImpl?: FetchLike): Promise<{ ok: true }> {
  const scope = 'resource remove';
  const resourceId = positionals[0]?.trim() ?? '';
  if (!resourceId) throw ShimError.local(scope, 'usage: resource remove <resourceId> --json');
  requireWorkspace(scope, ctx);
  await hubRequest(ctx, scope, `/api/v1/resources/${encode(resourceId)}`, { method: 'DELETE' }, fetchImpl);
  return { ok: true };
}

// ---- team-projects ------------------------------------------------------------

/** Flags whose next token is a value; everything else (`--json`, `--authorize-only`) is boolean. */
export const TEAM_PROJECTS_HELP = [
  'Manage team project catalog entries.',
  '',
  'Usage:',
  '  vela team-projects [command]',
  '',
  'Available Commands:',
  '  get         Show one catalog entry',
  '  list        List catalog entries for the workspace',
  '  pull        Pull a published project version (with receipt)',
  '  remove      Remove a catalog entry',
  '  upsert      Create or update a catalog entry',
  '',
  'Flags:',
  '  -h, --help   help for team-projects',
  '      --json   emit machine-readable output',
  '',
].join('\n');

export async function handleTeamProjects(argv: string[], ctx: ShimContext, fetchImpl?: FetchLike): Promise<CliResult> {
  const { positionals, flags } = parseArgs(argv, VALUE_FLAGS);
  // vela-cli-team-projects.ts:499-541 — `--help` must be stdout-only with exit 0;
  // anything on stderr flips the daemon into `resource shared` compat mode.
  if (flags.help === true || argv.includes('-h') || positionals[0] === 'help') return ok(TEAM_PROJECTS_HELP);
  const sub = positionals[0];
  const projectId = positionals[1]?.trim() ?? '';
  const verbScope = (verb: string) => `team-projects ${verb}`;
  try {
    switch (sub) {
      case undefined:
      case 'list': {
        const scope = verbScope('list');
        requireWorkspace(scope, ctx);
        return ok(jsonLine(await hubRequest(ctx, scope, '/api/v1/team-projects', {}, fetchImpl)));
      }
      case 'get': {
        const scope = verbScope('get');
        if (!projectId) throw ShimError.local(scope, 'usage: team-projects get <projectId> --json');
        requireWorkspace(scope, ctx);
        return ok(jsonLine(await hubRequest(ctx, scope, `/api/v1/team-projects/${encode(projectId)}`, {}, fetchImpl)));
      }
      case 'upsert': {
        const scope = verbScope('upsert');
        if (!projectId) throw ShimError.local(scope, 'usage: team-projects upsert <projectId> --resource-id <id> [...]');
        requireWorkspace(scope, ctx);
        const resourceId = flagString(flags, 'resource-id')?.trim() ?? '';
        if (!resourceId) throw ShimError.local(scope, 'required flag --resource-id is missing');
        const body: Record<string, unknown> = { resourceId };
        const displayName = flagString(flags, 'display-name');
        if (displayName !== null) body.displayName = displayName;
        const syncState = flagString(flags, 'sync-state');
        if (syncState !== null) body.syncState = syncState;
        const lastSynced = flagString(flags, 'last-synced-version-id');
        if (lastSynced !== null) body.lastSyncedVersionId = lastSynced;
        const metadata = parseMetadataJson(scope, flags);
        if (metadata !== undefined) body.metadata = metadata;
        return ok(jsonLine(await hubRequest(ctx, scope, `/api/v1/team-projects/${encode(projectId)}`, { method: 'PUT', body }, fetchImpl)));
      }
      case 'remove': {
        const scope = verbScope('remove');
        if (!projectId) throw ShimError.local(scope, 'usage: team-projects remove <projectId>');
        requireWorkspace(scope, ctx);
        await hubRequest(ctx, scope, `/api/v1/team-projects/${encode(projectId)}`, { method: 'DELETE' }, fetchImpl);
        return ok(jsonLine({ ok: true }));
      }
      case 'pull':
        return ok(jsonLine(await teamProjectPull(projectId, positionals.slice(2), flags, ctx, fetchImpl)));
      default:
        return fail(ShimError.notSupported(['team-projects', sub].join(' ')));
    }
  } catch (error) {
    return fail(toShimError(verbScope(sub ?? 'list'), error));
  }
}

/**
 * `team-projects pull <p> --authorize-only --ref published --expected-version N --json`
 * `team-projects pull <p> <stageDir> --live-dir <live> --ref published --expected-version N --json`
 *
 * The materializing form downloads and verifies the whole tree into stageDir
 * FIRST and only then asks the hub for the receipt, so the 2000 ms receipt
 * window (authorized-team-project-pull.ts:13) is never spent on transfer.
 * stageDir is the caller's empty mkdtemp directory; we replace its inode with
 * the verified tree (the daemon re-reads the identity, :410-417).
 */
async function teamProjectPull(projectId: string, rest: string[], flags: ParsedArgs['flags'], ctx: ShimContext, fetchImpl?: FetchLike): Promise<unknown> {
  const scope = 'team-projects pull';
  if (!projectId) throw ShimError.local(scope, 'usage: team-projects pull <projectId> [<stageDir> --live-dir <dir>] --ref published --expected-version <n> --json');
  requireWorkspace(scope, ctx);
  requireRef(scope, flags);
  const rawVersion = flagString(flags, 'expected-version');
  const expectedVersion = rawVersion === null ? Number.NaN : Number(rawVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw ShimError.local(scope, '--expected-version must be a non-negative integer');
  const authorizeOnly = flags['authorize-only'] === true;
  const authorize = () => hubRequest<ReceiptWire>(ctx, scope, `/api/v1/team-projects/${encode(projectId)}/pull-authorization`, {
    method: 'POST',
    body: { ref: PUBLISHED_REF, expectedVersion },
  }, fetchImpl);

  if (authorizeOnly) {
    const { nonce: _nonce, ...receipt } = await authorize();
    return receipt;
  }

  // parseArgs already stripped flag/value pairs, so the first remaining positional is the stage dir.
  const stageDir = rest[0] ? path.resolve(rest[0]) : '';
  if (!stageDir) throw ShimError.local(scope, 'stage directory is required unless --authorize-only is given');
  const liveDir = flagString(flags, 'live-dir');
  const stageInfo = await lstat(stageDir).catch(() => null);
  if (!stageInfo || stageInfo.isSymbolicLink() || !stageInfo.isDirectory()) throw ShimError.local(scope, 'stage directory must be an existing real directory');
  if (!(await isEmptyDirectory(stageDir))) throw ShimError.local(scope, 'stage directory must be empty');

  // Resolve the catalog row to the resource we must pull, then materialize.
  const project = await hubRequest<{ resourceId: string; ownerMemberId: string }>(ctx, scope, `/api/v1/team-projects/${encode(projectId)}`, {}, fetchImpl);
  const tmp = await createSiblingStage(stageDir, 'od-tp-pull');
  const outcome = await materializeResource(scope, project.resourceId, stageDir, ctx, {
    reuseFrom: liveDir ? path.resolve(liveDir) : null,
    expectedVersion,
    stageInto: tmp,
  }, fetchImpl);

  // Bytes are verified and staged; now take the short-lived receipt.
  let receipt: ReceiptWire;
  try {
    receipt = await authorize();
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  if (receipt.version !== outcome.version || receipt.versionId !== outcome.versionId || receipt.manifestDigest !== outcome.manifestDigest) {
    // Published version moved between download and authorization: do not hand
    // the daemon bytes that do not match the receipt it will persist.
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw ShimError.http(scope, 409, 'authorized_team_project_pull_rejected');
  }
  const swap = await swapDirectory(tmp, stageDir);
  await swap.commit();
  const { nonce: _nonce, ...wire } = receipt;
  return wire;
}
