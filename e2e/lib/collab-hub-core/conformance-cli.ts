// Hub conformance as a standalone process.
//
// Runs `runHubConformance` against ANY hub reachable over HTTP with a real
// `vela`-compatible executable, so a self-hosted deployment (tools/od-hub, or
// a future Postgres hub) can be checked without importing e2e sources across
// the package boundary. Pure Node: no Vitest, no Playwright.
//
//   HUB_URL=http://127.0.0.1:18790 VELA_BIN=/abs/od-vela.mjs \
//   HUB_WORKSPACE_ID=g1 \
//   HUB_OWNER_KEY=odc_... HUB_OWNER_MEMBER_ID=m_... \
//   HUB_MEMBER_KEY=odc_... HUB_MEMBER_MEMBER_ID=m_... \
//   [HUB_PRESENCE_TTL_MS=2000] [HUB_SCRATCH_DIR=/tmp/x] [HUB_TIMEOUT_MS=10000] \
//     tsx e2e/lib/collab-hub-core/conformance-cli.ts
//
// stdout: one JSON line `{ok:true, passed:[...]}` or `{ok:false, check, detail, passed:[...]}`.
// exit 0 when every check passed, 1 on the first failing check, 2 on bad input.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConformanceError, createSpawnVelaInvoker, runHubConformance } from './conformance.ts';
import type { HubMemberRole } from './types.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `${name} is required` })}\n`);
    process.exit(2);
  }
  return value;
}

function optionalInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `${name} must be a positive integer` })}\n`);
    process.exit(2);
  }
  return value;
}

function role(name: string, fallback: HubMemberRole): HubMemberRole {
  const raw = process.env[name]?.trim();
  return raw === 'owner' || raw === 'admin' || raw === 'member' ? raw : fallback;
}

async function main(): Promise<number> {
  const hubUrl = required('HUB_URL');
  const bin = required('VELA_BIN');
  const workspaceId = required('HUB_WORKSPACE_ID');
  const owner = { controlKey: required('HUB_OWNER_KEY'), memberId: required('HUB_OWNER_MEMBER_ID'), role: role('HUB_OWNER_ROLE', 'owner') };
  const member = { controlKey: required('HUB_MEMBER_KEY'), memberId: required('HUB_MEMBER_MEMBER_ID'), role: role('HUB_MEMBER_ROLE', 'member') };
  // A caller-provided scratch dir is theirs to keep; one we created is removed on exit.
  const providedScratchDir = process.env.HUB_SCRATCH_DIR?.trim();
  const scratchDir = providedScratchDir || await mkdtemp(join(tmpdir(), 'hub-conformance-'));
  const presenceTtlMs = optionalInt('HUB_PRESENCE_TTL_MS');
  const timeoutMs = optionalInt('HUB_TIMEOUT_MS');
  let passed: string[] = [];
  try {
    const report = await runHubConformance({
      hubUrl,
      workspaceId,
      owner,
      member,
      scratchDir,
      runVela: createSpawnVelaInvoker({ bin, hubUrl, timeoutMs: timeoutMs ?? 15_000 }),
      ...(presenceTtlMs === undefined ? {} : { presenceTtlMs }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      onPassed: (name) => { passed = [...passed, name]; },
    });
    process.stdout.write(`${JSON.stringify({ ok: true, passed: report.passed })}\n`);
    return 0;
  } catch (error) {
    const body = error instanceof ConformanceError
      ? { ok: false, check: error.check, detail: error.message, passed }
      : { ok: false, check: null, detail: error instanceof Error ? error.message : String(error), passed };
    process.stdout.write(`${JSON.stringify(body)}\n`);
    return 1;
  } finally {
    if (!providedScratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then((code) => process.exit(code), (error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
