// `vela` argv interpreter.
//
// `handleCommand` turns one CLI invocation into the stdout the daemon parses.
// It is framework-neutral: no HTTP, no test runner. Failures are thrown as
// `HubCommandError`; the message is what the CLI writes to stderr and is what
// the daemon's text-based classifiers key on (plan §6.3), so the code strings
// `resource_not_found`, `team_project_not_found`, and friends must stay stable.

import { join } from 'node:path';

import { latestSeq, type HubStore } from './store.ts';
import {
  computeSnapshotManifest,
  materializeSnapshot,
  replaceDirectoryWithSnapshot,
} from './snapshots.ts';
import {
  HubCommandError,
  type ClientIdentity,
  type HubEvent,
  type PresenceEntry,
  type ResourceRecord,
  type ResourceVersion,
  type TeamProjectRecord,
} from './types.ts';

export const FAKE_VELA_VERSION = 'vela 0.0.0-e2e';

/** Receipt lifetime the daemon accepts: `expiresAt - authorizedAt <= 2000ms`. */
export const AUTHORIZED_PULL_RECEIPT_TTL_MS = 2_000;

export type CommandContext = {
  args: readonly string[];
  stdin: string;
  identity: ClientIdentity;
  workspaceId: string;
  store: HubStore;
  /** Directory under which resource snapshots are materialized. */
  resourcesRoot: string;
  emit: (event: HubEvent) => void;
  now?: () => number;
};

export async function handleCommand(input: CommandContext): Promise<string> {
  const { args } = input;
  if (args[0] === '--version') return `${FAKE_VELA_VERSION}\n`;
  if (args[0] === 'models') return '';
  if (args[0] === 'model' && args[1] === 'list') {
    return jsonLine({ source: 'remote', data: [] });
  }
  if (args[0] === 'model' && args[1] === 'preset') {
    return jsonLine({ source: 'preset', data: [] });
  }
  if (args[0] === 'media' && args[1] === 'models') {
    // Must be an object: the daemon's `parseJsonObject` rejects arrays.
    return jsonLine({ models: [] });
  }
  if (args[0] === 'run' && args[1] === 'terminal') {
    return handleRunTerminal(input);
  }
  if (args[0] === 'billing') return handleBillingCommand(input);
  if (args[0] === 'team-projects') return await handleTeamProjectsCommand(input);
  if (args[0] === 'resource') return await handleResourceCommand(input);
  if (args[0] === 'collab') return handleCollabCommand(input);
  throw new HubCommandError(`unsupported fake Vela command: ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// run terminal
// ---------------------------------------------------------------------------

function handleRunTerminal(input: CommandContext): string {
  const runId = flag(input.args, '--run-id');
  const outcome = flag(input.args, '--outcome');
  const terminalAt = flag(input.args, '--terminal-at');
  if (!runId || !outcome || !terminalAt || !Number.isFinite(Date.parse(terminalAt))) {
    // The outbox reads a failure envelope from stdout, not stderr.
    return jsonLine({ error: 'invalid_input', retryable: false });
  }
  return jsonLine({ runId, outcome, terminalAt, recorded: true });
}

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------

function handleBillingCommand(input: CommandContext): string {
  const [, command] = input.args;
  if (command === 'summary') {
    const billing = input.store.accountBilling(input.identity.memberId);
    // Satisfies both parsers: `runtimes/defs/amr.ts` reads
    // balanceUsd/membershipTier; `integrations/vela-billing.ts` additionally
    // reads balances.*, subscriptionStatus and availableActions.
    return jsonLine({
      membershipTier: billing.membershipTier,
      balanceUsd: billing.balanceUsd,
      totalAvailableCreditsUsd: billing.balanceUsd,
      balances: {
        totalAvailableCredits: billing.balanceUsd,
        subscriptionCredits: billing.balanceUsd,
        rechargeCredits: '0',
      },
      subscriptionStatus: 'active',
      availableActions: [],
    });
  }
  if (command === 'workspace-snapshot') {
    // The daemon passes the workspace as an explicit argument and rejects a
    // snapshot whose `workspaceId` differs from the requested one; fall back to
    // the ambient header workspace for callers that omit the flag.
    const workspaceId = flag(input.args, '--workspace-id') ?? input.workspaceId;
    const billing = input.store.workspaceBilling(workspaceId);
    const balance = input.store.workspaceBalance(workspaceId, input.identity.memberId);
    const updatedAt = new Date(nowOf(input)).toISOString();
    return jsonLine({
      schemaVersion: 1,
      workspaceId,
      workspaceMemberId: input.identity.memberId,
      billingScopeVersion: 2,
      billing: {
        billingState: billing.billingState,
        planId: billing.planId,
      },
      wallet: { balanceUsd: balance.balanceUsd, expiresAt: null, updatedAt },
      revisions: {
        billing: `billing-${billing.revision}`,
        wallet: `wallet-${balance.revision}`,
      },
    });
  }
  if (command === 'workspace-balance' || command === 'team-catalog' || command === 'checkout') {
    throw new HubCommandError(
      `billing ${command}: API request failed with status 501: not_supported`,
    );
  }
  throw new HubCommandError(`unsupported billing command: ${input.args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// team-projects
// ---------------------------------------------------------------------------

async function handleTeamProjectsCommand(input: CommandContext): Promise<string> {
  const { args, store, identity, workspaceId } = input;
  const [, command, projectId] = args;
  if (command === '--help') return 'team-projects list get upsert remove\n';
  if (command === 'list' || command == null) {
    return jsonLine({
      workspaceId,
      projects: store.listProjects(workspaceId)
        .map((project) => recordForIdentity(project, identity)),
    });
  }
  if (command === 'get' && projectId) {
    const project = store.getProject(projectId);
    if (!project) throw new HubCommandError('team_project_not_found');
    return jsonLine(recordForIdentity(project, identity));
  }
  if (command === 'pull' && projectId) {
    const authorizeOnly = args.includes('--authorize-only');
    // `pull <p> <stageDir> --live-dir <live> --ref published --expected-version N`
    // The stage directory is the first positional after the project id; flags
    // and their values may appear before it, so scan instead of indexing.
    const targetDir = authorizeOnly ? null : positionalAfter(args, 3);
    const expectedVersion = Number(flag(args, '--expected-version'));
    const project = store.getProject(projectId);
    const resource = project ? store.getResource(workspaceId, project.resourceId) : undefined;
    const requested = resource?.versions.get(expectedVersion);
    if (
      !project ||
      !resource ||
      !requested ||
      (!authorizeOnly && !targetDir) ||
      !Number.isSafeInteger(expectedVersion)
    ) {
      throw new HubCommandError('authorized_team_project_pull_rejected');
    }
    if (targetDir) {
      // Vela replaces the caller-created empty stage inode before returning its
      // short-lived authorization receipt.
      await replaceDirectoryWithSnapshot(requested.snapshotDir, targetDir);
    }
    const authorizedAt = nowOf(input);
    return jsonLine({
      schemaVersion: 1,
      workspaceId,
      resourceTeamId: workspaceId,
      viewerMemberId: identity.memberId,
      ownerMemberId: project.ownerMemberId,
      projectId,
      resourceId: project.resourceId,
      ref: 'published',
      version: expectedVersion,
      versionId: requested.versionId,
      manifestDigest: requested.manifestDigest,
      lifecycleState: 'active',
      authorizedAt: new Date(authorizedAt).toISOString(),
      expiresAt: new Date(authorizedAt + AUTHORIZED_PULL_RECEIPT_TTL_MS).toISOString(),
      ...(authorizeOnly ? { manifestEntryCount: requested.manifestEntryCount } : {}),
    });
  }
  if (command === 'upsert' && projectId) {
    const now = new Date(nowOf(input)).toISOString();
    const previous = store.getProject(projectId);
    const resourceId = flag(args, '--resource-id') ?? previous?.resourceId;
    if (!resourceId) throw new HubCommandError('missing resource id');
    const record: TeamProjectRecord = {
      id: previous?.id ?? `catalog-${projectId}`,
      workspaceId,
      projectId,
      resourceId,
      ownerMemberId: previous?.ownerMemberId ?? identity.memberId,
      displayName: flag(args, '--display-name') ?? previous?.displayName ?? null,
      syncState: flag(args, '--sync-state') ?? previous?.syncState ?? 'synced',
      lastSyncedVersionId:
        flag(args, '--last-synced-version-id') ?? previous?.lastSyncedVersionId ?? null,
      metadata: parseJsonFlag(args, '--metadata-json') ?? previous?.metadata ?? null,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      access: {
        canView: true,
        canComment: true,
        canEdit: identity.role === 'owner',
        frozen: false,
      },
    };
    store.putProject(record);
    input.emit({
      type: previous ? 'project-metadata-changed' : 'team-projects-changed',
      workspaceId,
      projectId,
    });
    return jsonLine(recordForIdentity(record, identity));
  }
  if (command === 'remove' && projectId) {
    store.deleteProject(projectId);
    input.emit({ type: 'team-projects-changed', workspaceId, projectId });
    return jsonLine({ ok: true });
  }
  throw new HubCommandError(`unsupported team-projects command: ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// resource
// ---------------------------------------------------------------------------

async function handleResourceCommand(input: CommandContext): Promise<string> {
  const { args, store, identity, workspaceId } = input;
  const [, command] = args;
  if (command === 'push') {
    const kind = args[2];
    const resourceId = args[3];
    const sourceDir = args[4];
    if (!kind || !resourceId || !sourceDir) throw new HubCommandError('invalid resource push');
    const metadata = parseJsonFlag(args, '--metadata-json');
    const projectId =
      typeof metadata?.projectId === 'string'
        ? metadata.projectId
        : store.listProjects(workspaceId)
            .find((project) => project.resourceId === resourceId)?.projectId ?? null;
    if (kind === 'project' && !projectId) {
      throw new HubCommandError('resource push missing project id');
    }
    const previous = store.getResource(workspaceId, resourceId);
    const version = (previous?.version ?? 0) + 1;
    const resourceRoot = join(
      input.resourcesRoot,
      encodeURIComponent(`${workspaceId}\0${resourceId}`),
    );
    const snapshotDir = join(resourceRoot, `v${version}`);
    await materializeSnapshot(sourceDir, snapshotDir);
    const manifest = await computeSnapshotManifest(snapshotDir);
    const versions = previous?.versions ?? new Map<number, ResourceVersion>();
    versions.set(version, {
      version,
      versionId: `v${version}`,
      snapshotDir,
      manifestDigest: manifest.digest,
      manifestEntryCount: manifest.entryCount,
    });
    const record: ResourceRecord = {
      workspaceId,
      projectId,
      resourceId,
      kind,
      ownerMemberId: previous?.ownerMemberId ?? identity.memberId,
      metadata,
      version,
      versions,
    };
    store.putResource(record);
    if (projectId && store.getProject(projectId)) {
      input.emit({ type: 'project-content-changed', workspaceId, projectId, version });
    } else {
      input.emit({
        type: 'team-resources-changed',
        workspaceId,
        resourceId,
        resourceKind: kind,
        resourceStatus: 'shared',
      });
    }
    return jsonLine({ version, versionId: `v${version}` });
  }
  if (command === 'head') {
    const resourceId = args[2];
    const resource = resourceId ? store.getResource(workspaceId, resourceId) : undefined;
    return jsonLine(
      resource
        ? { version: resource.version, versionId: `v${resource.version}` }
        : { version: null },
    );
  }
  if (command === 'pull') {
    const resourceId = args[3];
    const targetDir = args[4];
    const resource = resourceId ? store.getResource(workspaceId, resourceId) : undefined;
    if (!resource || !targetDir) throw new HubCommandError('resource_not_found');
    await replaceDirectoryWithSnapshot(latestSnapshotDir(resource), targetDir);
    return jsonLine({ version: resource.version, versionId: `v${resource.version}` });
  }
  if (command === 'pull-batch') {
    if (flag(args, '--requests-file') !== '-') {
      throw new HubCommandError('fake resource pull-batch requires --requests-file -');
    }
    const parsed = JSON.parse(input.stdin) as { requests?: unknown };
    if (!Array.isArray(parsed.requests) || parsed.requests.length === 0) {
      throw new HubCommandError('resource pull batch requires at least one request');
    }
    if (parsed.requests.length > 128) {
      throw new HubCommandError('resource pull batch contains more than 128 requests');
    }
    const keys = new Set<string>();
    const requests = parsed.requests.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HubCommandError(`requests[${index}] must be an object`);
      }
      const request = raw as Record<string, unknown>;
      const key = typeof request.key === 'string' ? request.key.trim() : '';
      const kind = typeof request.kind === 'string' ? request.kind.trim() : '';
      const resourceId =
        typeof request.resourceId === 'string' ? request.resourceId.trim() : '';
      const dir = typeof request.dir === 'string' ? request.dir.trim() : '';
      const ref = typeof request.ref === 'string' && request.ref.trim()
        ? request.ref.trim()
        : 'latest';
      if (!key || !kind || !resourceId || !dir) {
        throw new HubCommandError(`requests[${index}] is missing a required field`);
      }
      if (keys.has(key)) throw new HubCommandError(`duplicate resource pull key: ${key}`);
      keys.add(key);
      return { key, kind, resourceId, dir, ref };
    });
    const results = [];
    let succeeded = 0;
    for (const request of requests) {
      const resource = store.getResource(workspaceId, request.resourceId);
      if (!resource) {
        results.push({
          ...request,
          ok: false,
          error: 'resource_not_found',
          errorCode: 'resource_not_found',
        });
        continue;
      }
      await replaceDirectoryWithSnapshot(latestSnapshotDir(resource), request.dir);
      succeeded++;
      results.push({
        ...request,
        ok: true,
        version: resource.version,
        versionId: `v${resource.version}`,
      });
    }
    return jsonLine({ results, succeeded, failed: results.length - succeeded });
  }
  if (command === 'remove') {
    const resourceId = args[2];
    const resource = resourceId ? store.deleteResource(workspaceId, resourceId) : undefined;
    if (resource && resource.kind !== 'project') {
      input.emit({
        type: 'team-resources-changed',
        workspaceId,
        resourceId: resource.resourceId,
        resourceKind: resource.kind,
        resourceStatus: 'retracted',
      });
    }
    return jsonLine({ ok: true });
  }
  if (command === 'list') {
    return jsonLine({ resources: [] });
  }
  if (command === 'shared') {
    return jsonLine({
      resources: store.listResources(workspaceId)
        .filter((resource) => resource.kind !== 'project')
        .map((resource) => ({
          id: resource.resourceId,
          kind: resource.kind,
          deletedAt: null,
          ownerMemberId: resource.ownerMemberId,
          metadata: resource.metadata,
          publishedVersion: {
            id: `v${resource.version}`,
            version: resource.version,
          },
        })),
    });
  }
  throw new HubCommandError(`unsupported resource command: ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// collab
// ---------------------------------------------------------------------------

function handleCollabCommand(input: CommandContext): string {
  const { args, store, identity, workspaceId } = input;
  const [, domain, command, projectId] = args;
  if (domain === 'member' && command === 'list') {
    return jsonLine({
      members: store.members()
        .filter((client) => !store.isRemoved(client.memberId))
        .map((client) => ({
          memberId: client.memberId,
          displayName: client.name,
          role: store.roleOf(client.memberId),
        })),
    });
  }
  if (domain === 'member' && command === 'register') {
    return jsonLine({
      member: {
        memberId: identity.memberId,
        displayName: flag(args, '--display-name') ?? identity.name,
        role: flag(args, '--role') ?? identity.role,
      },
    });
  }
  if (domain === 'presence' && projectId) {
    const now = nowOf(input);
    const roster = store.presence(projectId, now);
    if (store.sweptPresence(projectId, now)) {
      // Rosters only shrink on the TTL boundary when someone looks; tell
      // subscribers so their viewer lists do not stay stale until the next join.
      input.emit({ type: 'presence-changed', workspaceId, projectId });
    }
    const clientId = flag(args, '--client-id') ?? identity.memberId;
    if (command === 'heartbeat') {
      const joined = !roster.has(clientId);
      const activity = parseJsonFlagValue(args, '--activity-json');
      const entry: PresenceEntry = {
        memberId: identity.memberId,
        displayName: flag(args, '--display-name') ?? identity.name,
        role: identity.role,
        filePath: flag(args, '--file-path') ?? null,
        heartbeatAt: new Date(nowOf(input)).toISOString(),
        ...(activity === undefined ? {} : { activity }),
      };
      store.setPresence(projectId, clientId, entry);
      if (joined) input.emit({ type: 'presence-changed', workspaceId, projectId });
    } else if (command === 'leave') {
      const explicitClientId = flag(args, '--client-id');
      let removed = store.deletePresence(projectId, clientId);
      // Preserve compatibility with a legacy leave that has no session lease:
      // it means "this member left everywhere". Modern clients always send a
      // client id, so closing one tab must not evict another tab for the same
      // member.
      if (!explicitClientId) {
        for (const [key, entry] of roster) {
          if (entry.memberId === identity.memberId) {
            roster.delete(key);
            removed = true;
          }
        }
      }
      if (removed) input.emit({ type: 'presence-changed', workspaceId, projectId });
    } else if (command !== 'list') {
      throw new HubCommandError(`unsupported presence command: ${args.join(' ')}`);
    }
    return jsonLine({ viewers: [...store.presence(projectId, nowOf(input)).values()] });
  }
  if (domain === 'comment' && command === 'pull') {
    const sinceSeq = Number(flag(args, '--since-seq') ?? 0);
    const projectComments = store.comments(projectId ?? '');
    return jsonLine({
      comments: projectComments.filter(
        (comment) => typeof comment.seq === 'number' && comment.seq > sinceSeq,
      ),
      latestSeq: latestSeq(projectComments),
    });
  }
  if (domain === 'comment' && command === 'push' && projectId) {
    const parsed = parseJsonFlag(args, '--comment-json');
    if (!parsed) throw new HubCommandError('comment push missing payload');
    const seq = store.pushComment(projectId, parsed);
    input.emit({ type: 'comment-changed', workspaceId, projectId });
    return jsonLine({ seq });
  }
  throw new HubCommandError(`unsupported collab command: ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function recordForIdentity(
  project: TeamProjectRecord,
  identity: ClientIdentity,
): TeamProjectRecord {
  return {
    ...project,
    access: {
      ...project.access,
      canEdit: project.ownerMemberId === identity.memberId,
    },
  };
}

function latestSnapshotDir(resource: ResourceRecord): string {
  const latest = resource.versions.get(resource.version);
  if (!latest) throw new HubCommandError('resource_not_found');
  return latest.snapshotDir;
}

function nowOf(input: CommandContext): number {
  return input.now ? input.now() : Date.now();
}

/** Flags that take no value; every other `--flag` consumes the next argv entry. */
const BOOLEAN_FLAGS = new Set(['--authorize-only', '--json']);

/** First positional argument at or after `start` that is not a flag or a flag value. */
export function positionalAfter(args: readonly string[], start: number): string | null {
  for (let index = start; index < args.length; index++) {
    const value = args[index];
    if (value === undefined) break;
    if (value.startsWith('--')) {
      if (!BOOLEAN_FLAGS.has(value)) index++;
      continue;
    }
    return value;
  }
  return null;
}

export function flag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1]! : null;
}

export function parseJsonFlag(
  args: readonly string[],
  name: string,
): Record<string, unknown> | null {
  const value = flag(args, name);
  if (!value) return null;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

/** Parse a JSON flag preserving any JSON value (used for `--activity-json`). */
function parseJsonFlagValue(args: readonly string[], name: string): unknown {
  const value = flag(args, name);
  if (value == null) return undefined;
  return JSON.parse(value) as unknown;
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
