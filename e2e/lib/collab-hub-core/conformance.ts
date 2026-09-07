// Hub contract conformance.
//
// `runHubConformance` asserts the daemon-facing contract against ANY hub: the
// in-process fake (via `startFakeCollabHub`) or a real self-hosted deployment
// (via its base URL and a real `vela`/`od-vela` binary). It has no test-runner
// dependency; failures throw `ConformanceError` with the failing check name so a
// Vitest or CLI harness can surface them uniformly.
//
// Shapes asserted here are the ones the daemon parsers require. Line references
// are into apps/daemon/src at the time of writing:
//   directory rows           collab/vela-workspace-context.ts (parse of /api/v1/workspaces)
//   SSE ready frame          collab/hub-events-subscriber.ts
//   sync digest              collab/sync-digest.ts parseSyncDigest
//   wallet balance           integrations/vela-wallet.ts isValidUsdBalance
//   billing summary/snapshot integrations/vela-billing.ts, runtimes/defs/amr.ts
//   presence/comments        collab/vela-cli-collab-client.ts
//   receipt                  collab/authorized-team-project-pull.ts

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AUTHORIZED_PULL_RECEIPT_TTL_MS } from './commands.ts';
import type { HubMemberRole } from './types.ts';

export type ConformanceAccount = {
  controlKey: string;
  memberId: string;
  role: HubMemberRole;
};

export type VelaInvocation = {
  args: readonly string[];
  controlKey: string;
  workspaceId: string;
  stdin?: string;
};

export type VelaInvocationResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type VelaInvoker = (invocation: VelaInvocation) => Promise<VelaInvocationResult>;

export type ConformanceTarget = {
  hubUrl: string;
  workspaceId: string;
  /** An owner of `workspaceId`. */
  owner: ConformanceAccount;
  /** A second, non-owner member of `workspaceId`. */
  member: ConformanceAccount;
  runVela: VelaInvoker;
  /** Scratch directory the suite may create fixtures in. */
  scratchDir: string;
  /**
   * Presence lease length the hub is configured with. When provided and short
   * enough to wait for (<= 10s) the suite asserts eviction after expiry; the
   * production default of 30s is only asserted structurally.
   */
  presenceTtlMs?: number;
  /** Per-network-call budget. */
  timeoutMs?: number;
  /** Unique suffix for ids so repeated runs against a real hub do not collide. */
  runId?: string;
  /** Called after each check passes, so a CLI harness can report progress on failure. */
  onPassed?: (check: string) => void;
};

export type ConformanceReport = {
  passed: string[];
};

export class ConformanceError extends Error {
  constructor(readonly check: string, detail: string) {
    super(`[${check}] ${detail}`);
    this.name = 'ConformanceError';
  }
}

const MANIFEST_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const USD_PATTERN = /^\d+(?:\.\d+)?$/;
const REQUIRED_CAPABILITIES = [
  'authoritative-project-presence-v1',
  'workspace-directory-events-v1',
] as const;

export async function runHubConformance(target: ConformanceTarget): Promise<ConformanceReport> {
  const passed: string[] = [];
  const runId = target.runId ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const timeoutMs = target.timeoutMs ?? 10_000;
  const ids = {
    projectId: `conf-project-${runId}`,
    projectResourceId: `conf-project-resource-${runId}`,
    pluginResourceId: `conf-plugin-${runId}`,
    missingResourceId: `conf-missing-${runId}`,
    presenceClient: `conf-client-${runId}`,
    commentPrefix: `conf-comment-${runId}`,
  };

  const ownerVela = velaAs(target, target.owner);
  const memberVela = velaAs(target, target.member);

  async function step(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (error instanceof ConformanceError) throw error;
      throw new ConformanceError(name, error instanceof Error ? error.message : String(error));
    }
    passed.push(name);
    target.onPassed?.(name);
  }

  const check = (name: string) => (condition: unknown, detail: string): void => {
    if (!condition) throw new ConformanceError(name, detail);
  };

  // --- HTTP: directory ------------------------------------------------------
  await step('http.workspaces.directory', async () => {
    const ok = check('http.workspaces.directory');
    const unauthorized = await httpJson(target, '/api/v1/workspaces', { controlKey: 'not-a-key' }, timeoutMs);
    ok(unauthorized.status === 401, `expected 401 without a valid key, got ${unauthorized.status}`);
    const response = await httpJson(target, '/api/v1/workspaces', { controlKey: target.owner.controlKey }, timeoutMs);
    ok(response.status === 200, `expected 200, got ${response.status}`);
    const items = (response.body as { items?: unknown }).items;
    ok(Array.isArray(items) && items.length > 0, 'items must be a non-empty array');
    const row = (items as Array<Record<string, unknown>>).find((item) => item.workspaceId === target.workspaceId);
    ok(row, `directory lacks a row for ${target.workspaceId}`);
    ok(row!.workspaceType === 'team', `workspaceType must be 'team', got ${String(row!.workspaceType)}`);
    ok(typeof row!.workspaceName === 'string' && row!.workspaceName, 'workspaceName must be a non-empty string');
    ok(typeof row!.workspaceMemberId === 'string' && row!.workspaceMemberId, 'workspaceMemberId required');
    ok(row!.role === 'owner', `owner row role must be 'owner', got ${String(row!.role)}`);
    ok(row!.memberStatus === 'active', 'memberStatus must be active');
    ok(row!.lifecycleState === 'active', 'lifecycleState must be active');
  });

  // --- HTTP: SSE ready frame -------------------------------------------------
  await step('http.events.ready', async () => {
    const ok = check('http.events.ready');
    const frame = await readFirstSseFrame(target, target.owner.controlKey, timeoutMs);
    ok(frame.event === 'ready', `first frame must be 'ready', got '${frame.event}'`);
    const data = frame.data as Record<string, unknown>;
    ok(data.workspaceId === target.workspaceId, `ready.workspaceId must echo the request header (${String(data.workspaceId)})`);
    ok(Array.isArray(data.capabilities), 'ready.capabilities must be an array');
    for (const capability of REQUIRED_CAPABILITIES) {
      ok((data.capabilities as unknown[]).includes(capability), `ready.capabilities missing ${capability}`);
    }
    if ((data.capabilities as unknown[]).includes('workspace-event-listener-status-v1')) {
      ok(typeof data.listenerEpoch === 'string', 'listener-status capability requires listenerEpoch');
      ok(['starting', 'healthy', 'reconnecting', 'stopped'].includes(String(data.listenerHealth)), 'listenerHealth must be a known state');
      ok(typeof data.sourceGap === 'boolean', 'sourceGap must be boolean');
    }
  });

  // --- HTTP: sync digest ------------------------------------------------------
  let digestBefore: Record<string, unknown> | null = null;
  await step('http.sync-digest.shape', async () => {
    const ok = check('http.sync-digest.shape');
    const response = await httpJson(target, '/api/v1/collab/sync-digest', {
      controlKey: target.owner.controlKey,
      workspaceId: target.workspaceId,
    }, timeoutMs);
    ok(response.status === 200, `expected 200, got ${response.status}`);
    const body = response.body as Record<string, unknown>;
    for (const key of ['catalogToken', 'membersToken', 'contextToken', 'billingToken']) {
      ok(typeof body[key] === 'string', `${key} must be a string`);
    }
    const again = await httpJson(target, '/api/v1/collab/sync-digest', {
      controlKey: target.owner.controlKey,
      workspaceId: target.workspaceId,
    }, timeoutMs);
    ok(JSON.stringify(again.body) === JSON.stringify(body), 'digest must be stable when nothing changed');
    digestBefore = body;
  });

  // --- HTTP: wallet -----------------------------------------------------------
  await step('http.wallet.balance', async () => {
    const ok = check('http.wallet.balance');
    const response = await httpJson(target, '/api/v1/wallet/balance', { controlKey: target.owner.controlKey }, timeoutMs);
    ok(response.status === 200, `expected 200, got ${response.status}`);
    const body = response.body as Record<string, unknown>;
    ok(typeof body.balanceUsd === 'string' && USD_PATTERN.test(body.balanceUsd), `balanceUsd must match ${USD_PATTERN}`);
    ok(body.updatedAt === undefined || typeof body.updatedAt === 'string', 'updatedAt must be a string when present');
  });

  // --- CLI: misc --------------------------------------------------------------
  await step('cli.version', async () => {
    const result = await ownerVela(['--version']);
    check('cli.version')(result.exitCode === 0 && result.stdout.trim(), 'must print a version and exit 0');
  });

  await step('cli.media.models', async () => {
    const ok = check('cli.media.models');
    const body = await ownerVela.json(['media', 'models', '--json']);
    ok(body && typeof body === 'object' && !Array.isArray(body), 'must return an object, not an array');
    ok(Array.isArray((body as Record<string, unknown>).models), 'models must be an array');
  });

  await step('cli.run.terminal', async () => {
    const ok = check('cli.run.terminal');
    const terminalAt = new Date().toISOString();
    const body = await ownerVela.json([
      'run', 'terminal', '--run-id', `conf-run-${runId}`, '--outcome', 'completed',
      '--terminal-at', terminalAt, '--json',
    ]) as Record<string, unknown>;
    ok(body.runId === `conf-run-${runId}`, 'receipt.runId must echo the request');
    ok(body.outcome === 'completed', 'receipt.outcome must echo the request');
    ok(typeof body.terminalAt === 'string' && Date.parse(body.terminalAt) === Date.parse(terminalAt), 'receipt.terminalAt must equal the request instant');
    ok(typeof body.recorded === 'boolean', 'receipt.recorded must be boolean');
  });

  // --- CLI: billing -----------------------------------------------------------
  await step('cli.billing.summary', async () => {
    const ok = check('cli.billing.summary');
    const body = await ownerVela.json(['billing', 'summary', '--format', 'json']) as Record<string, unknown>;
    ok(typeof body.balanceUsd === 'string', 'balanceUsd must be a string');
    ok(typeof body.membershipTier === 'string', 'membershipTier must be a string');
    const balances = body.balances as Record<string, unknown> | undefined;
    ok(balances && typeof balances === 'object', 'balances object required');
    for (const key of ['totalAvailableCredits', 'subscriptionCredits', 'rechargeCredits']) {
      ok(typeof balances![key] === 'string', `balances.${key} must be a string`);
    }
    ok(typeof body.subscriptionStatus === 'string', 'subscriptionStatus must be a string');
    ok(Array.isArray(body.availableActions), 'availableActions must be an array');
  });

  await step('cli.billing.workspace-snapshot', async () => {
    const ok = check('cli.billing.workspace-snapshot');
    const directory = await httpJson(target, '/api/v1/workspaces', { controlKey: target.owner.controlKey }, timeoutMs);
    const row = ((directory.body as { items: Array<Record<string, unknown>> }).items)
      .find((item) => item.workspaceId === target.workspaceId)!;
    const body = await ownerVela.json([
      'billing', 'workspace-snapshot', '--workspace-id', target.workspaceId, '--format', 'json',
    ]) as Record<string, unknown>;
    ok(body.schemaVersion === 1, 'schemaVersion must be 1');
    ok(body.billingScopeVersion === 2, 'billingScopeVersion must be 2');
    ok(body.workspaceId === target.workspaceId, 'workspaceId must echo --workspace-id');
    ok(body.workspaceMemberId === row.workspaceMemberId, 'workspaceMemberId must equal the directory row');
    const billing = body.billing as Record<string, unknown>;
    const wallet = body.wallet as Record<string, unknown>;
    const revisions = body.revisions as Record<string, unknown>;
    ok(billing && typeof billing === 'object', 'billing object required');
    ok(billing.billingState === null || typeof billing.billingState === 'string', 'billing.billingState must be string|null');
    ok(billing.planId === null || (typeof billing.planId === 'string' && billing.planId), 'billing.planId must be non-empty string|null');
    ok(wallet && typeof wallet.balanceUsd === 'string' && wallet.balanceUsd, 'wallet.balanceUsd required');
    ok(wallet.expiresAt === null || typeof wallet.expiresAt === 'string', 'wallet.expiresAt must be string|null');
    ok(wallet.updatedAt === null || typeof wallet.updatedAt === 'string', 'wallet.updatedAt must be string|null');
    ok(revisions && typeof revisions.billing === 'string' && revisions.billing, 'revisions.billing required');
    ok(typeof revisions.wallet === 'string' && revisions.wallet, 'revisions.wallet required');
  });

  // --- CLI: collab members ------------------------------------------------------
  await step('cli.collab.member', async () => {
    const ok = check('cli.collab.member');
    const registered = await ownerVela.json([
      'collab', 'member', 'register', '--display-name', 'Conformance Owner', '--role', 'owner',
    ]) as { member?: Record<string, unknown> };
    ok(registered.member?.memberId === target.owner.memberId, 'register must echo the caller memberId');
    const list = await memberVela.json(['collab', 'member', 'list']) as { members?: Array<Record<string, unknown>> };
    ok(Array.isArray(list.members), 'members must be an array');
    const ownerRow = list.members!.find((m) => m.memberId === target.owner.memberId);
    ok(ownerRow, 'member list must include the owner');
    ok(['owner', 'admin', 'member'].includes(String(ownerRow!.role)), 'role must be a known value');
    ok(typeof ownerRow!.displayName === 'string', 'displayName must be a string');
  });

  // --- CLI: comments ------------------------------------------------------------
  await step('cli.collab.comment.seq', async () => {
    const ok = check('cli.collab.comment.seq');
    const projectId = `${ids.projectId}-comments`;
    const baseline = await ownerVela.json([
      'collab', 'comment', 'pull', projectId, '--since-seq', '0',
    ]) as { comments: unknown[]; latestSeq: number };
    ok(Array.isArray(baseline.comments) && typeof baseline.latestSeq === 'number', 'pull must return {comments, latestSeq}');
    const start = baseline.latestSeq;
    const first = await ownerVela.json([
      'collab', 'comment', 'push', projectId, '--comment-json',
      JSON.stringify({ id: `${ids.commentPrefix}-1`, body: 'one', updatedAt: new Date().toISOString() }),
    ]) as { seq: number };
    const second = await memberVela.json([
      'collab', 'comment', 'push', projectId, '--comment-json',
      JSON.stringify({ id: `${ids.commentPrefix}-2`, body: 'two', updatedAt: new Date().toISOString() }),
    ]) as { seq: number };
    ok(first.seq === start + 1 && second.seq === start + 2, `seq must increase monotonically (${first.seq}, ${second.seq} after ${start})`);
    const pulled = await memberVela.json([
      'collab', 'comment', 'pull', projectId, '--since-seq', String(start),
    ]) as { comments: Array<Record<string, unknown>>; latestSeq: number };
    ok(pulled.latestSeq === second.seq, 'latestSeq must equal the last assigned seq');
    ok(pulled.comments.length === 2, `pull since ${start} must return both comments`);
    ok(pulled.comments.every((c, i) => i === 0 || (c.seq as number) > (pulled.comments[i - 1]!.seq as number)), 'comments must be seq-ascending');
    ok(pulled.comments.every((c) => c.projectId === projectId), 'comments must carry projectId');
    // Upsert by id re-sequences the same comment; the old seq must not survive.
    const third = await ownerVela.json([
      'collab', 'comment', 'push', projectId, '--comment-json',
      JSON.stringify({ id: `${ids.commentPrefix}-1`, body: 'one-edited', updatedAt: new Date().toISOString() }),
    ]) as { seq: number };
    ok(third.seq === second.seq + 1, 'upsert must assign a fresh seq');
    const delta = await memberVela.json([
      'collab', 'comment', 'pull', projectId, '--since-seq', String(second.seq),
    ]) as { comments: Array<Record<string, unknown>>; latestSeq: number };
    ok(delta.comments.length === 1 && delta.comments[0]!.id === `${ids.commentPrefix}-1` && delta.comments[0]!.body === 'one-edited', 'delta pull must return only the re-sequenced comment');
    const all = await memberVela.json([
      'collab', 'comment', 'pull', projectId, '--since-seq', String(start),
    ]) as { comments: Array<Record<string, unknown>> };
    ok(all.comments.filter((c) => c.id === `${ids.commentPrefix}-1`).length === 1, 'an upserted id must appear exactly once');
    const empty = await memberVela.json([
      'collab', 'comment', 'pull', projectId, '--since-seq', String(delta.latestSeq),
    ]) as { comments: unknown[] };
    ok(empty.comments.length === 0, 'pull at latestSeq must be empty');
  });

  // --- CLI: presence -------------------------------------------------------------
  await step('cli.collab.presence', async () => {
    const ok = check('cli.collab.presence');
    const projectId = `${ids.projectId}-presence`;
    const activity = { kind: 'editing', filePath: 'index.html', nested: { n: 1 } };
    const heartbeat = await ownerVela.json([
      'collab', 'presence', 'heartbeat', projectId,
      '--client-id', ids.presenceClient,
      '--display-name', 'Conformance Owner',
      '--file-path', 'index.html',
      '--activity-json', JSON.stringify(activity),
    ]) as { viewers: Array<Record<string, unknown>> };
    ok(Array.isArray(heartbeat.viewers), 'viewers must be an array');
    const mine = heartbeat.viewers.find((v) => v.memberId === target.owner.memberId);
    ok(mine, 'heartbeat must return the caller in viewers');
    ok(mine!.filePath === 'index.html', 'filePath must round-trip');
    ok(JSON.stringify(mine!.activity) === JSON.stringify(activity), '--activity-json must round-trip verbatim into viewers[].activity');
    ok(typeof mine!.heartbeatAt === 'string' && Number.isFinite(Date.parse(mine!.heartbeatAt as string)), 'heartbeatAt must be an ISO timestamp');
    ok(Math.abs(Date.now() - Date.parse(mine!.heartbeatAt as string)) < 60_000, 'heartbeatAt must be recent');
    const seen = await memberVela.json(['collab', 'presence', 'list', projectId]) as { viewers: Array<Record<string, unknown>> };
    ok(seen.viewers.some((v) => v.memberId === target.owner.memberId), 'another member must observe the heartbeat');
    if (target.presenceTtlMs !== undefined && target.presenceTtlMs <= 10_000) {
      await sleep(target.presenceTtlMs + 200);
      const expired = await memberVela.json(['collab', 'presence', 'list', projectId]) as { viewers: Array<Record<string, unknown>> };
      ok(!expired.viewers.some((v) => v.memberId === target.owner.memberId), `presence must expire after ${target.presenceTtlMs}ms without heartbeat`);
      await ownerVela.json([
        'collab', 'presence', 'heartbeat', projectId, '--client-id', ids.presenceClient,
      ]);
    }
    const left = await ownerVela.json([
      'collab', 'presence', 'leave', projectId, '--client-id', ids.presenceClient,
    ]) as { viewers: Array<Record<string, unknown>> };
    ok(!left.viewers.some((v) => v.memberId === target.owner.memberId), 'leave must remove the lease');
  });

  // --- CLI: resource round-trip ---------------------------------------------------
  const pluginSource = join(target.scratchDir, `plugin-src-${runId}`);
  const pluginTarget = join(target.scratchDir, `plugin-dst-${runId}`);
  await step('cli.resource.round-trip', async () => {
    const ok = check('cli.resource.round-trip');
    await mkdir(pluginSource, { recursive: true });
    await writeFile(join(pluginSource, 'manifest.json'), JSON.stringify({ id: ids.pluginResourceId }), 'utf8');
    await writeFile(join(pluginSource, 'README.md'), `# conformance ${runId}\n`, 'utf8');
    const missingHead = await ownerVela.json(['resource', 'head', ids.missingResourceId, '--ref', 'published', '--json']) as Record<string, unknown>;
    ok(missingHead.version === null, 'head on an unpublished resource must return version null');
    const pushed = await ownerVela.json([
      'resource', 'push', 'plugin', ids.pluginResourceId, pluginSource, '--ref', 'published', '--json',
    ]) as Record<string, unknown>;
    ok(typeof pushed.version === 'number' && pushed.version >= 1, 'push must return a numeric version');
    ok(typeof (pushed.versionId ?? pushed.id) === 'string', 'push must return versionId (or id)');
    const head = await memberVela.json(['resource', 'head', ids.pluginResourceId, '--ref', 'published', '--json']) as Record<string, unknown>;
    ok(head.version === pushed.version, 'head must report the pushed version');
    ok(head.versionId === (pushed.versionId ?? pushed.id), 'head.versionId must match push');
    await mkdir(pluginTarget, { recursive: true });
    const pulled = await memberVela.json([
      'resource', 'pull', 'plugin', ids.pluginResourceId, pluginTarget, '--ref', 'published', '--json',
    ]) as Record<string, unknown>;
    ok(pulled.version === pushed.version, 'pull must report the pushed version');
    const readme = await readFile(join(pluginTarget, 'README.md'), 'utf8');
    ok(readme.includes(runId), 'pulled content must match pushed content');
    const missingPull = await memberVela([
      'resource', 'pull', 'plugin', ids.missingResourceId, join(target.scratchDir, `missing-${runId}`), '--ref', 'published', '--json',
    ]);
    ok(missingPull.exitCode !== 0, 'pull of a missing resource must fail');
    ok(/resource_not_found/.test(missingPull.stderr), `stderr must contain resource_not_found (got: ${missingPull.stderr.trim()})`);
    const shared = await memberVela.json(['resource', 'shared', '--json']) as { resources: Array<Record<string, unknown>> };
    const sharedRow = shared.resources.find((r) => r.id === ids.pluginResourceId);
    ok(sharedRow, 'shared must list the pushed non-project resource');
    ok(sharedRow!.kind === 'plugin' && sharedRow!.deletedAt === null, 'shared row must carry kind and deletedAt null');
    ok((sharedRow!.publishedVersion as Record<string, unknown>)?.version === pushed.version, 'shared.publishedVersion.version must match');
    const removed = await ownerVela.json(['resource', 'remove', ids.pluginResourceId, '--json']) as Record<string, unknown>;
    ok(removed.ok === true, 'remove must return {ok:true}');
  });

  // --- CLI: team-projects -----------------------------------------------------------
  const projectSource = join(target.scratchDir, `project-src-${runId}`);
  await step('cli.team-projects.catalog', async () => {
    const ok = check('cli.team-projects.catalog');
    const help = await ownerVela(['team-projects', '--help']);
    ok(help.exitCode === 0 && help.stdout.trim(), '--help must exit 0 with stdout text');
    ok(help.stderr.trim() === '', '--help must not write to stderr (daemon treats stderr as legacy fallback)');
    const missing = await ownerVela(['team-projects', 'get', `${ids.projectId}-missing`, '--json']);
    ok(missing.exitCode !== 0 && /team_project_not_found/.test(missing.stderr), 'get on unknown project must fail with team_project_not_found');

    await mkdir(join(projectSource, 'assets'), { recursive: true });
    await writeFile(join(projectSource, 'index.html'), `<h1>${runId}</h1>`, 'utf8');
    await writeFile(join(projectSource, 'assets', 'style.css'), 'h1{color:red}', 'utf8');
    const pushed = await ownerVela.json([
      'resource', 'push', 'project', ids.projectResourceId, projectSource, '--ref', 'published', '--json',
      '--metadata-json', JSON.stringify({ projectId: ids.projectId }),
    ]) as { version: number };
    const upserted = await ownerVela.json([
      'team-projects', 'upsert', ids.projectId, '--resource-id', ids.projectResourceId,
      '--display-name', 'Conformance project', '--sync-state', 'synced',
      '--last-synced-version-id', `v${pushed.version}`, '--json',
    ]) as Record<string, unknown>;
    ok(upserted.projectId === ids.projectId && upserted.resourceId === ids.projectResourceId, 'upsert must echo ids');
    ok(upserted.ownerMemberId === target.owner.memberId, 'first upsert fixes the owner');
    const access = upserted.access as Record<string, unknown>;
    ok(access && typeof access.canView === 'boolean' && typeof access.canEdit === 'boolean' && typeof access.canComment === 'boolean' && typeof access.frozen === 'boolean', 'access must carry four booleans');
    const got = await memberVela.json(['team-projects', 'get', ids.projectId, '--json']) as Record<string, unknown>;
    ok(got.projectId === ids.projectId, 'get must return the record');
    ok((got.access as Record<string, unknown>).canEdit === false, 'non-owner viewer must not have canEdit');
    const list = await memberVela.json(['team-projects', 'list', '--json']) as { workspaceId: string; projects: Array<Record<string, unknown>> };
    ok(list.workspaceId === target.workspaceId, 'list.workspaceId must echo the scope');
    ok(list.projects.some((p) => p.projectId === ids.projectId), 'list must contain the upserted project');
  });

  await step('cli.team-projects.pull-receipt', async () => {
    const ok = check('cli.team-projects.pull-receipt');
    const authorize = await memberVela.json([
      'team-projects', 'pull', ids.projectId, '--authorize-only', '--ref', 'published',
      '--expected-version', '1', '--json',
    ]) as Record<string, unknown>;
    assertReceipt(ok, authorize, target, ids, 1);
    ok(authorize.manifestEntryCount === 2, `authorize-only must report manifestEntryCount=2 (got ${String(authorize.manifestEntryCount)})`);

    const stageDir = join(target.scratchDir, `stage-${runId}`);
    const liveDir = join(target.scratchDir, `live-${runId}`);
    await mkdir(stageDir, { recursive: true });
    await mkdir(liveDir, { recursive: true });
    const receipt = await memberVela.json([
      'team-projects', 'pull', ids.projectId, stageDir, '--live-dir', liveDir, '--ref', 'published',
      '--expected-version', '1', '--json',
    ]) as Record<string, unknown>;
    assertReceipt(ok, receipt, target, ids, 1);
    ok(receipt.manifestDigest === authorize.manifestDigest, 'materializing pull must report the same digest as authorize-only');
    const html = await readFile(join(stageDir, 'index.html'), 'utf8');
    ok(html.includes(runId), 'stage dir must contain the published snapshot');
    const rejected = await memberVela([
      'team-projects', 'pull', ids.projectId, '--authorize-only', '--ref', 'published',
      '--expected-version', '999', '--json',
    ]);
    ok(rejected.exitCode !== 0, 'pull for a non-existent version must fail');
  });

  // --- HTTP: digest moved after catalog mutations ------------------------------------
  await step('http.sync-digest.moves', async () => {
    const ok = check('http.sync-digest.moves');
    const response = await httpJson(target, '/api/v1/collab/sync-digest', {
      controlKey: target.owner.controlKey,
      workspaceId: target.workspaceId,
    }, timeoutMs);
    const after = response.body as Record<string, unknown>;
    ok(digestBefore && after.catalogToken !== digestBefore.catalogToken, 'catalogToken must change after resource/team-project mutations');
  });

  // --- cleanup -----------------------------------------------------------------------
  await step('cli.team-projects.remove', async () => {
    const removed = await ownerVela.json(['team-projects', 'remove', ids.projectId, '--json']) as Record<string, unknown>;
    check('cli.team-projects.remove')(removed.ok === true, 'remove must return {ok:true}');
    await ownerVela.json(['resource', 'remove', ids.projectResourceId, '--json']);
    await rm(pluginSource, { force: true, recursive: true });
    await rm(pluginTarget, { force: true, recursive: true });
    await rm(projectSource, { force: true, recursive: true });
  });

  return { passed };
}

function assertReceipt(
  ok: (condition: unknown, detail: string) => void,
  receipt: Record<string, unknown>,
  target: ConformanceTarget,
  ids: { projectId: string; projectResourceId: string },
  expectedVersion: number,
): void {
  ok(receipt.schemaVersion === 1, 'receipt.schemaVersion must be 1');
  ok(receipt.workspaceId === target.workspaceId, 'receipt.workspaceId must match scope');
  ok(receipt.resourceTeamId === target.workspaceId, 'receipt.resourceTeamId must match scope');
  ok(receipt.viewerMemberId === target.member.memberId, 'receipt.viewerMemberId must be the caller');
  ok(receipt.ownerMemberId === target.owner.memberId, 'receipt.ownerMemberId must be the project owner');
  ok(receipt.ownerMemberId !== receipt.viewerMemberId, 'owner must differ from viewer');
  ok(receipt.projectId === ids.projectId, 'receipt.projectId must match');
  ok(receipt.resourceId === ids.projectResourceId, 'receipt.resourceId must match');
  ok(receipt.ref === 'published', "receipt.ref must be 'published'");
  ok(receipt.version === expectedVersion, `receipt.version must equal expected (${expectedVersion})`);
  ok(typeof receipt.versionId === 'string' && receipt.versionId, 'receipt.versionId required');
  ok(typeof receipt.manifestDigest === 'string' && MANIFEST_DIGEST_PATTERN.test(receipt.manifestDigest), 'receipt.manifestDigest must be sha256:<64 hex>');
  ok(receipt.lifecycleState === 'active', "receipt.lifecycleState must be 'active'");
  const authorizedAt = Date.parse(String(receipt.authorizedAt));
  const expiresAt = Date.parse(String(receipt.expiresAt));
  ok(Number.isFinite(authorizedAt) && Number.isFinite(expiresAt), 'authorizedAt/expiresAt must be ISO timestamps');
  ok(expiresAt > authorizedAt, 'expiresAt must be after authorizedAt');
  ok(expiresAt - authorizedAt <= AUTHORIZED_PULL_RECEIPT_TTL_MS, `receipt lifetime must be <= ${AUTHORIZED_PULL_RECEIPT_TTL_MS}ms`);
}

// ---------------------------------------------------------------------------
// invokers
// ---------------------------------------------------------------------------

type BoundVela = ((args: readonly string[], stdin?: string) => Promise<VelaInvocationResult>) & {
  json: (args: readonly string[], stdin?: string) => Promise<unknown>;
};

function velaAs(target: ConformanceTarget, account: ConformanceAccount): BoundVela {
  const run = (args: readonly string[], stdin?: string) =>
    target.runVela({
      args,
      controlKey: account.controlKey,
      workspaceId: target.workspaceId,
      ...(stdin === undefined ? {} : { stdin }),
    });
  const bound = run as BoundVela;
  bound.json = async (args, stdin) => {
    const result = await run(args, stdin);
    if (result.exitCode !== 0) {
      throw new Error(`vela ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim()}`);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch {
      throw new Error(`vela ${args.join(' ')} did not print JSON: ${result.stdout.slice(0, 200)}`);
    }
  };
  return bound;
}

/**
 * Invoke a real `vela`-compatible executable. Works for the generated fake
 * script and for a self-hosted shim alike.
 */
export function createSpawnVelaInvoker(input: {
  bin: string;
  hubUrl: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): VelaInvoker {
  return (invocation) =>
    new Promise<VelaInvocationResult>((resolve, reject) => {
      const child = spawn(input.bin, [...invocation.args], {
        env: {
          ...process.env,
          ...input.env,
          VELA_API_URL: input.hubUrl,
          VELA_CONTROL_KEY: invocation.controlKey,
          VELA_WORKSPACE_ID: invocation.workspaceId,
          VELA_INVOCATION_SOURCE: 'open-design',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`vela ${invocation.args.join(' ')} timed out`));
      }, input.timeoutMs ?? 15_000);
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
      child.stdin.end(invocation.stdin ?? '');
    });
}

/**
 * Invoke commands through the fake hub's `/__e2e/command` control endpoint,
 * skipping process spawn. Only valid against the fake hub.
 */
export function createHttpCommandInvoker(hubUrl: string): VelaInvoker {
  return async (invocation) => {
    const response = await fetch(new URL('/__e2e/command', hubUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${invocation.controlKey}`,
        'content-type': 'application/json',
        'x-vela-workspace-id': invocation.workspaceId,
      },
      body: JSON.stringify({ args: invocation.args, stdin: invocation.stdin ?? '' }),
    });
    const payload = await response.json() as { stdout?: string; message?: string; error?: string };
    if (!response.ok) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: `${payload.message || payload.error || 'fake Vela command failed'}\n`,
      };
    }
    return { exitCode: 0, stdout: payload.stdout ?? '', stderr: '' };
  };
}

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

async function httpJson(
  target: ConformanceTarget,
  path: string,
  auth: { controlKey: string; workspaceId?: string },
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, target.hubUrl), {
      headers: {
        authorization: `Bearer ${auth.controlKey}`,
        accept: 'application/json',
        ...(auth.workspaceId ? { 'x-vela-workspace-id': auth.workspaceId } : {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function readFirstSseFrame(
  target: ConformanceTarget,
  controlKey: string,
  timeoutMs: number,
): Promise<{ event: string; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/api/v1/collab/events', target.hubUrl), {
      headers: {
        authorization: `Bearer ${controlKey}`,
        accept: 'text/event-stream',
        'x-vela-workspace-id': target.workspaceId,
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`events stream responded ${response.status}`);
    }
    if (!/text\/event-stream/.test(response.headers.get('content-type') ?? '')) {
      throw new Error('events stream must use content-type text/event-stream');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('events stream closed before the first frame');
      buffer += decoder.decode(value, { stream: true });
      const end = buffer.indexOf('\n\n');
      if (end < 0) continue;
      const frame = buffer.slice(0, end);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const raw = dataLines.join('\n');
      return { event, data: raw ? JSON.parse(raw) as unknown : null };
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
