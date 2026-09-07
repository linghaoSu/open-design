/**
 * Full daemon-contract conformance against a REAL out-of-process od-hub and
 * the bundled `bin/od-vela.mjs`, the way a deployment is wired:
 *
 *   1. start `od-hub start --port 0 --seed <two users, one team>` (memory
 *      store, PRESENCE_TTL_MS=2000 so the TTL branch of the suite runs);
 *   2. run `e2e/lib/collab-hub-core/conformance-cli.ts` under tsx with
 *      HUB_URL / VELA_BIN / account env. That entry is owned by e2e/ and spawns
 *      `od-vela` per command exactly like `createSpawnVelaInvoker`.
 *
 * tools/od-hub/src never imports e2e/; this script only *spawns* the e2e entry,
 * which keeps the repository boundary (root AGENTS.md: cross-app consistency
 * checks belong to e2e) while giving this package a one-command check.
 * Requires a prior `pnpm --filter @open-design/tools-od-hub build`.
 *
 *   pnpm --filter @open-design/tools-od-hub conformance
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveMemberId } from '../src/server/ids.js';
import type { MemoryHubStoreSeed } from '../src/server/memory-store.js';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(toolRoot, '..', '..');
const STEP_TIMEOUT_MS = 20_000;
const PRESENCE_TTL_MS = 2_000;
const WORKSPACE_ID = 'g-conformance';
const OWNER_KEY = 'odc_conformance_owner_key';
const MEMBER_KEY = 'odc_conformance_member_key';

class Failure extends Error {}
const fail = (message: string): never => { throw new Failure(message); };
const expect = (condition: unknown, message: string): void => { if (!condition) fail(message); };

const children: ChildProcess[] = [];
let shuttingDown = false;

function start(label: string, args: string[], env: NodeJS.ProcessEnv, cwd = toolRoot) {
  let out = '';
  let err = '';
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
  child.once('exit', (code, signal) => {
    if (code !== 0 && code !== null && !shuttingDown) process.stderr.write(`[conformance] ${label} exited early (code ${code}, signal ${signal})\n${err}`);
  });
  children.push(child);
  return { child, stdout: () => out, stderr: () => err };
}

function stopAll(): void {
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}

async function waitFor<T>(label: string, probe: () => T | null | undefined | false, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const hubEntry = path.join(toolRoot, 'dist', 'index.mjs');
  const velaBin = path.join(toolRoot, 'bin', 'od-vela.mjs');
  expect(existsSync(hubEntry) && existsSync(path.join(toolRoot, 'dist', 'od-vela.mjs')), 'dist/ is missing: run `pnpm --filter @open-design/tools-od-hub build` first');
  const tsx = path.join(toolRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  expect(existsSync(tsx), `tsx not found at ${tsx}; run pnpm install`);
  const conformanceCli = path.join(repoRoot, 'e2e', 'lib', 'collab-hub-core', 'conformance-cli.ts');
  expect(existsSync(conformanceCli), `${conformanceCli} is missing`);

  const tmp = mkdtempSync(path.join(tmpdir(), 'od-hub-conformance-'));
  const seed: MemoryHubStoreSeed = {
    users: [
      { id: 'u-owner', email: 'owner@od-hub.local', name: 'Conformance Owner', controlKey: OWNER_KEY },
      { id: 'u-member', email: 'member@od-hub.local', name: 'Conformance Member', controlKey: MEMBER_KEY },
    ],
    workspaces: [
      { id: 'u-owner', name: "Owner's workspace", kind: 'personal', members: [{ userId: 'u-owner', role: 'owner' }] },
      { id: WORKSPACE_ID, name: 'Conformance workspace', kind: 'team', members: [{ userId: 'u-owner', role: 'owner' }, { userId: 'u-member', role: 'member' }] },
    ],
  };
  const seedFile = path.join(tmp, 'seed.json');
  writeFileSync(seedFile, JSON.stringify(seed));

  // 1. od-hub, out of process, memory store, short presence TTL.
  const hub = start('od-hub', [hubEntry, 'start', '--port', '0', '--seed', seedFile, '--blob-dir', path.join(tmp, 'blobs')], {
    PRESENCE_TTL_MS: String(PRESENCE_TTL_MS),
  });
  const hubUrl = await waitFor('od-hub listen line', () => /od-hub listening on (http:\/\/[^\s]+)/.exec(hub.stdout())?.[1]);
  process.stdout.write(`[conformance] od-hub at ${hubUrl}\n`);

  // 2. the e2e-owned conformance runner, spawning bin/od-vela.mjs per command.
  const runner = start('conformance-cli', [tsx, conformanceCli], {
    HUB_URL: hubUrl,
    VELA_BIN: velaBin,
    HUB_WORKSPACE_ID: WORKSPACE_ID,
    HUB_OWNER_KEY: OWNER_KEY,
    HUB_OWNER_MEMBER_ID: deriveMemberId('u-owner', WORKSPACE_ID),
    HUB_MEMBER_KEY: MEMBER_KEY,
    HUB_MEMBER_MEMBER_ID: deriveMemberId('u-member', WORKSPACE_ID),
    HUB_PRESENCE_TTL_MS: String(PRESENCE_TTL_MS),
    HUB_SCRATCH_DIR: path.join(tmp, 'scratch'),
    AMR_HOME: path.join(tmp, 'amr'),
  }, repoRoot);
  let runnerExit: number | null = null;
  await new Promise<void>((resolve) => runner.child.once('close', (code) => { runnerExit = code; resolve(); }));
  const lastLine = runner.stdout().trim().split('\n').at(-1) ?? '';
  let report: { ok?: boolean; passed?: string[]; check?: string | null; detail?: string; error?: string } = {};
  try {
    report = JSON.parse(lastLine) as typeof report;
  } catch {
    fail(`conformance-cli printed no JSON report (exit ${String(runnerExit)}):\n${runner.stdout()}\n${runner.stderr()}`);
  }
  for (const name of report.passed ?? []) process.stdout.write(`[conformance] PASS ${name}\n`);
  if (!report.ok) {
    fail(`${report.check ?? 'setup'}: ${report.detail ?? report.error ?? 'unknown failure'}\n${runner.stderr()}\nhub stderr:\n${hub.stderr()}`);
  }
  expect(runnerExit === 0, `conformance-cli exit code ${String(runnerExit)}`);
  process.stdout.write(`[conformance] OK: ${report.passed!.length} checks passed against ${hubUrl} via ${velaBin}\n`);
  rmSync(tmp, { recursive: true, force: true });
}

main().then(
  () => { stopAll(); process.exit(0); },
  (error: unknown) => {
    stopAll();
    process.stderr.write(`[conformance] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
