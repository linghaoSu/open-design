/**
 * End-to-end login smoke for od-hub, run out of process the way a deployment is:
 *
 *   1. start the fake GitLab (`tests/helpers/fake-gitlab-main.ts`) as its own process;
 *   2. start `od-hub start --sqlite <tmp>` pointed at it, with GitLab login enabled;
 *   3. run `bin/od-vela.mjs login` with `AMR_HOME=<tmp>` exactly as the daemon
 *      spawns it (stdin ignored, browser launch disabled);
 *   4. assert stdout matches the daemon's activation regexes
 *      (apps/daemon/src/integrations/vela.ts parseVelaLoginActivation), approve
 *      the code on the fake GitLab, and wait for the success line + exit 0;
 *   5. read the minted key back from `$AMR_HOME/config.json`, call
 *      `GET /api/v1/workspaces`, and check the directory items pass the daemon's
 *      item validation and contain Alice's personal + team workspaces.
 *
 * Exits non-zero on the first mismatch. Requires a prior
 * `pnpm --filter @open-design/tools-od-hub build` (the shim runs from dist/).
 *
 *   pnpm --filter @open-design/tools-od-hub smoke
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapVelaWorkspaceDirectoryItem, parseVelaLoginActivation } from '../tests/daemon-parsers.js';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_ID = 'od-hub-smoke-client';
const CLIENT_SECRET = 'od-hub-smoke-secret';
const ALICE_ID = 101;
const STEP_TIMEOUT_MS = 15_000;

class SmokeFailure extends Error {}

function fail(message: string): never {
  throw new SmokeFailure(message);
}

function expect(condition: unknown, message: string): void {
  if (!condition) fail(message);
}

interface Managed {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
}

const children: ChildProcess[] = [];

function start(label: string, args: string[], env: NodeJS.ProcessEnv): Managed {
  let out = '';
  let err = '';
  const child = spawn(process.execPath, args, {
    cwd: toolRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
  child.once('exit', (code, signal) => {
    if (code !== 0 && code !== null && !shuttingDown) {
      process.stderr.write(`[smoke] ${label} exited early (code ${code}, signal ${signal})\n${err}`);
    }
  });
  children.push(child);
  return { child, stdout: () => out, stderr: () => err };
}

let shuttingDown = false;
function stopAll(): void {
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}

async function waitFor<T>(label: string, probe: () => T | null | undefined, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const distEntry = path.join(toolRoot, 'dist', 'od-vela.mjs');
  expect(existsSync(distEntry), `${distEntry} is missing: run \`pnpm --filter @open-design/tools-od-hub build\` first`);
  const tmp = mkdtempSync(path.join(tmpdir(), 'od-hub-smoke-'));
  const amrHome = path.join(tmp, 'amr');
  const sqlitePath = path.join(tmp, 'hub.sqlite');
  const tsx = path.join(toolRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  expect(existsSync(tsx), `tsx not found at ${tsx}; run pnpm install`);

  // 1. fake GitLab
  const gitlab = start('fake-gitlab', [tsx, path.join(toolRoot, 'tests', 'helpers', 'fake-gitlab-main.ts')], {
    GITLAB_OAUTH_CLIENT_ID: CLIENT_ID,
    GITLAB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  });
  const gitlabUrl = await waitFor('fake GitLab origin', () => /^(http:\/\/[^\s]+)/m.exec(gitlab.stdout())?.[1]);
  process.stdout.write(`[smoke] fake GitLab at ${gitlabUrl}\n`);

  // 2. od-hub (sqlite, GitLab login enabled)
  const hub = start('od-hub', [path.join(toolRoot, 'dist', 'index.mjs'), 'start', '--port', '0', '--sqlite', sqlitePath], {
    GITLAB_URL: gitlabUrl,
    GITLAB_OAUTH_CLIENT_ID: CLIENT_ID,
    GITLAB_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
    TOKEN_ENC_KEY: Buffer.alloc(32, 42).toString('base64'),
  });
  const hubUrl = await waitFor('od-hub listen line', () => /od-hub listening on (http:\/\/[^\s]+)/.exec(hub.stdout())?.[1]);
  process.stdout.write(`[smoke] od-hub at ${hubUrl} (sqlite ${sqlitePath})\n`);
  const health = await (await fetch(`${hubUrl}/healthz`)).json() as { gitlab?: boolean };
  expect(health.gitlab === true, `/healthz reports gitlab=${String(health.gitlab)}; login routes would answer 501`);

  // 3. od-vela login exactly as the daemon spawns it
  const login = start('od-vela login', [path.join(toolRoot, 'bin', 'od-vela.mjs'), 'login'], {
    AMR_HOME: amrHome,
    VELA_API_URL: hubUrl,
    VELA_PROFILE: 'selfhost',
    OD_VELA_OPEN_BROWSER: '0',
  });
  const startedAt = Date.now();
  let loginExit: number | null = null;
  const loginClosed = new Promise<void>((resolve) => login.child.once('close', (code) => { loginExit = code; resolve(); }));

  // 4. activation block -> daemon regexes
  await waitFor('activation block on stdout', () => /^[^\S\r\n]*Code:\s*\S+/m.test(login.stdout()) || null, 10_000);
  const activation = parseVelaLoginActivation(login.stdout(), login.stderr());
  expect(activation.activationUrl, `daemon regex found no activation URL in stdout:\n${login.stdout()}`);
  expect(activation.userCode && /^ABCD-\d{4}$/.test(activation.userCode), `unexpected user code ${String(activation.userCode)}`);
  expect(activation.activationUrl!.startsWith(`${gitlabUrl}/-/oauth/device?user_code=`), `activation URL does not point at GitLab: ${activation.activationUrl}`);
  expect(activation.browserOpenFailed, `OD_VELA_OPEN_BROWSER=0 must surface the browser-open warning; stderr was:\n${login.stderr()}`);
  expect(loginExit === null, 'login exited before approval');
  process.stdout.write(`[smoke] activation URL ${activation.activationUrl} (code ${activation.userCode}) after ${Date.now() - startedAt}ms\n`);
  // vela.ts waitForImmediateLoginFailure: the process must still be alive after 250ms.
  await new Promise((r) => setTimeout(r, Math.max(0, 300 - (Date.now() - startedAt))));
  expect(loginExit === null, 'login exited within the daemon\'s immediate-failure window');

  const approve = await fetch(`${gitlabUrl}/__fake/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userCode: activation.userCode, userId: ALICE_ID }),
  });
  expect(approve.status === 200, `fake GitLab approve -> ${approve.status}`);

  await Promise.race([loginClosed, new Promise((_, reject) => setTimeout(() => reject(new SmokeFailure('login did not exit after approval')), STEP_TIMEOUT_MS))]);
  expect(loginExit === 0, `login exit code ${String(loginExit)}; stderr:\n${login.stderr()}`);
  const lastLine = login.stdout().trimEnd().split('\n').at(-1);
  expect(lastLine === 'Login successful for alice@example.test.', `unexpected final stdout line: ${String(lastLine)}`);
  const stderrLines = login.stderr().split('\n').filter(Boolean);
  expect(stderrLines.length === 1 && /^could not open browser automatically: /.test(stderrLines[0]!), `unexpected stderr:\n${login.stderr()}`);

  // 5. minted key -> directory
  const configPath = path.join(amrHome, 'config.json');
  expect(existsSync(configPath), `${configPath} was not written`);
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { profiles?: Record<string, { controlKey?: string; runtimeKey?: string; apiUrl?: string; user?: { email?: string } }> };
  const profile = config.profiles?.selfhost;
  expect(profile?.controlKey?.startsWith('odc_'), 'profiles.selfhost.controlKey missing or not odc_');
  expect(profile?.runtimeKey?.startsWith('odr_'), 'profiles.selfhost.runtimeKey missing or not odr_');
  expect(profile?.apiUrl === hubUrl, `profiles.selfhost.apiUrl ${String(profile?.apiUrl)} != ${hubUrl}`);
  expect(profile?.user?.email === 'alice@example.test', `profile user email ${String(profile?.user?.email)}`);

  const directory = await fetch(`${hubUrl}/api/v1/workspaces`, { headers: { authorization: `Bearer ${profile!.controlKey}` } });
  const directoryText = await directory.text();
  expect(directory.status === 200, `GET /api/v1/workspaces -> ${directory.status}: ${directoryText}`);
  const { items } = JSON.parse(directoryText) as { items: unknown[] };
  expect(Array.isArray(items) && items.length > 0, 'directory has no items');
  const mapped = items.map(mapVelaWorkspaceDirectoryItem);
  expect(mapped.every(Boolean), `some directory items fail the daemon's validation: ${JSON.stringify(items)}`);
  const ids = mapped.map((i) => (i as { workspaceId: string }).workspaceId);
  for (const wanted of ['u101', 'g1000', 'g2000']) expect(ids.includes(wanted), `directory is missing ${wanted}; got ${ids.join(', ')}`);
  const me = await fetch(`${hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${profile!.runtimeKey}` } });
  expect(me.status === 200, `GET /api/v1/me with runtime key -> ${me.status}`);

  process.stdout.write(`[smoke] OK: login minted keys, directory = ${ids.join(', ')}\n`);
  rmSync(tmp, { recursive: true, force: true });
}

main().then(
  () => {
    stopAll();
    process.exit(0);
  },
  (error: unknown) => {
    stopAll();
    process.stderr.write(`[smoke] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
