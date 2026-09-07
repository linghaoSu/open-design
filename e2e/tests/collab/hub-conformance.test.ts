// @vitest-environment node

// Hub contract conformance, run in-process against the fake collaboration hub.
//
// The same `runHubConformance` can be pointed at a real self-hosted hub by
// supplying its base URL and a `createSpawnVelaInvoker` for the real CLI shim;
// this spec pins the fake hub to the contract so both stay aligned.

import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createHttpCommandInvoker,
  createSpawnVelaInvoker,
  runHubConformance,
} from '@/collab-hub-core/conformance';
import { startFakeCollabHub, type FakeCollabHub } from '@/playwright/fake-collab-hub';
import { createSmokeSuite, type SmokeSuite } from '@/vitest/suite';

const WORKSPACE_ID = 'ws-conformance';
const OWNER = {
  controlKey: 'conformance-owner-key',
  memberId: 'mem-conformance-owner',
  name: 'Conformance Owner',
  role: 'owner' as const,
};
const MEMBER = {
  controlKey: 'conformance-member-key',
  memberId: 'mem-conformance-member',
  name: 'Conformance Member',
  role: 'member' as const,
};

/** Every conformance step, in the order `runHubConformance` executes them. */
const ALL_CHECKS = [
  'http.workspaces.directory',
  'http.events.ready',
  'http.sync-digest.shape',
  'http.wallet.balance',
  'cli.version',
  'cli.media.models',
  'cli.run.terminal',
  'cli.billing.summary',
  'cli.billing.workspace-snapshot',
  'cli.collab.member',
  'cli.collab.comment.seq',
  'cli.collab.presence',
  'cli.resource.round-trip',
  'cli.team-projects.catalog',
  'cli.team-projects.pull-receipt',
  'http.sync-digest.moves',
  'cli.team-projects.remove',
];

let hub: FakeCollabHub | null = null;

afterEach(async () => {
  await hub?.close();
  hub = null;
});

/** Run one witness inside a smoke suite so the report and scratch lifecycle follow e2e/AGENTS.md. */
async function withSuite(name: string, run: (suite: SmokeSuite) => Promise<void>): Promise<void> {
  const suite = await createSmokeSuite(name);
  let success = false;
  let error: unknown;
  try {
    await run(suite);
    success = true;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await suite.finalize({ error, success });
  }
}

describe('collab hub conformance (fake hub)', () => {
  test('[P1] fake hub satisfies the daemon contract through the generated vela binary', async () => {
    await withSuite('collab-hub-conformance', async (suite) => {
      hub = await startFakeCollabHub({
        root: suite.scratchDir,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Conformance workspace',
        clients: [OWNER, MEMBER],
        strictAuthorityEvents: true,
      });
      const velaBin = await hub.writeVelaBin(join(suite.scratchDir, 'vela'));

      const report = await runHubConformance({
        hubUrl: hub.url,
        workspaceId: WORKSPACE_ID,
        owner: OWNER,
        member: MEMBER,
        scratchDir: join(suite.scratchDir, 'conformance'),
        runVela: createSpawnVelaInvoker({ bin: velaBin, hubUrl: hub.url }),
      });
      await suite.report.json('conformance.json', report);

      expect(report.passed).toEqual(ALL_CHECKS);
    });
  }, 60_000);

  test('[P2] presence leases expire at the configured TTL', async () => {
    await withSuite('collab-hub-conformance-ttl', async (suite) => {
      const presenceTtlMs = 400;
      hub = await startFakeCollabHub({
        root: suite.scratchDir,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Conformance TTL workspace',
        clients: [OWNER, MEMBER],
        presenceTtlMs,
      });

      const report = await runHubConformance({
        hubUrl: hub.url,
        workspaceId: WORKSPACE_ID,
        owner: OWNER,
        member: MEMBER,
        scratchDir: join(suite.scratchDir, 'conformance'),
        presenceTtlMs,
        runVela: createHttpCommandInvoker(hub.url),
      });
      await suite.report.json('conformance.json', report);

      expect(report.passed).toEqual(ALL_CHECKS);
      // The sweep that evicted the expired lease must announce itself so
      // subscribers refresh their viewer lists.
      const presenceProjectId = hub.eventLog.find((event) =>
        event.type === 'presence-changed' && event.projectId?.endsWith('-presence'))?.projectId;
      expect(presenceProjectId).toBeDefined();
      const presenceEvents = hub.eventLog.filter((event) =>
        event.type === 'presence-changed' && event.projectId === presenceProjectId);
      // join, TTL eviction, re-join, leave
      expect(presenceEvents).toHaveLength(4);
    });
  }, 30_000);

  test('[P2] removing a member emits members-changed then access-revoked and 403s later commands', async () => {
    await withSuite('collab-hub-conformance-revoke', async (suite) => {
      hub = await startFakeCollabHub({
        root: suite.scratchDir,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Conformance revoke workspace',
        clients: [OWNER, MEMBER],
      });
      const before = await syncDigest(hub.url, OWNER.controlKey);

      const controller = new AbortController();
      const response = await fetch(new URL('/api/v1/collab/events', hub.url), {
        headers: {
          authorization: `Bearer ${MEMBER.controlKey}`,
          accept: 'text/event-stream',
          'x-vela-workspace-id': WORKSPACE_ID,
        },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const framesPromise = readAllFrames(response);
      await waitFor(() => hub!.eventSubscriberCount(MEMBER.memberId) === 1);

      hub.removeMember(MEMBER.memberId);

      const frames = await framesPromise;
      const names = frames.map((frame) => frame.event);
      expect(names[0]).toBe('ready');
      expect(names.at(-1)).toBe('access-revoked');
      const workspaceEvents = frames
        .filter((frame) => frame.event === 'workspace-event')
        .map((frame) => JSON.parse(frame.data) as Record<string, unknown>);
      expect(workspaceEvents).toEqual([
        { type: 'workspace-context-changed', workspaceId: WORKSPACE_ID },
        {
          type: 'workspace-members-changed',
          workspaceId: WORKSPACE_ID,
          memberId: MEMBER.memberId,
          memberChange: 'removed',
        },
      ]);
      expect(hub.eventSubscriberCount(MEMBER.memberId)).toBe(0);

      const run = createHttpCommandInvoker(hub.url);
      const result = await run({
        args: ['collab', 'member', 'list'],
        controlKey: MEMBER.controlKey,
        workspaceId: WORKSPACE_ID,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('workspace_membership_removed');

      const revoked = await fetch(new URL('/api/v1/collab/sync-digest', hub.url), {
        headers: {
          authorization: `Bearer ${MEMBER.controlKey}`,
          'x-vela-workspace-id': WORKSPACE_ID,
        },
      });
      expect(revoked.status).toBe(403);

      const after = await syncDigest(hub.url, OWNER.controlKey);
      expect(after.membersToken).not.toBe(before.membersToken);
      expect(after.contextToken).not.toBe(before.contextToken);
      expect(after.catalogToken).toBe(before.catalogToken);
      expect(after.billingToken).toBe(before.billingToken);
      controller.abort();
    });
  }, 20_000);

  test('[P2] control-plane billing mutations move only the billing digest token', async () => {
    await withSuite('collab-hub-conformance-billing-digest', async (suite) => {
      hub = await startFakeCollabHub({
        root: suite.scratchDir,
        workspaceId: WORKSPACE_ID,
        workspaceName: 'Conformance billing workspace',
        clients: [OWNER, MEMBER],
      });
      const before = await syncDigest(hub.url, OWNER.controlKey);

      hub.setWorkspaceBalance(OWNER.memberId, '12.50');
      const afterBalance = await syncDigest(hub.url, OWNER.controlKey);
      expect(afterBalance.billingToken).not.toBe(before.billingToken);
      expect(afterBalance.catalogToken).toBe(before.catalogToken);
      expect(afterBalance.membersToken).toBe(before.membersToken);
      expect(afterBalance.contextToken).toBe(before.contextToken);

      hub.setWorkspacePlan('team_pro');
      const afterPlan = await syncDigest(hub.url, OWNER.controlKey);
      expect(afterPlan.billingToken).not.toBe(afterBalance.billingToken);

      hub.setAccountMembershipTier(OWNER.memberId, 'team_pro');
      const afterTier = await syncDigest(hub.url, OWNER.controlKey);
      expect(afterTier.billingToken).not.toBe(afterPlan.billingToken);
      expect(afterTier.catalogToken).toBe(before.catalogToken);
    });
  }, 20_000);
});

async function syncDigest(hubUrl: string, controlKey: string): Promise<Record<string, string>> {
  const response = await fetch(new URL('/api/v1/collab/sync-digest', hubUrl), {
    headers: { authorization: `Bearer ${controlKey}`, 'x-vela-workspace-id': WORKSPACE_ID },
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, string>;
}

async function readAllFrames(response: Response): Promise<Array<{ event: string; data: string }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      let event = 'message';
      const data: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      return { event, data: data.join('\n') };
    });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}
