import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Guards deploy/od-hub against drifting from the hub runtime contract in
// tools/od-hub. Source-level checks run without Docker; the real image build
// and container smoke run only when a Docker daemon is reachable.
//
//   node --test deploy/tests/od-hub-deploy.test.ts

const repoRoot = join(import.meta.dirname, '../..');
const deployDir = join(repoRoot, 'deploy/od-hub');
const dockerfilePath = join(deployDir, 'Dockerfile');
const composePath = join(deployDir, 'docker-compose.yml');
const envExamplePath = join(deployDir, '.env.example');
const readmePath = join(deployDir, 'README.md');
const hubReadmePath = join(repoRoot, 'tools/od-hub/README.md');

// Must match tools/od-hub/src/index.ts defaults and the /healthz route.
const CONTAINER_PORT = '18790';
const HEALTH_PATH = '/healthz';
const DATA_DIR = '/data';

// Server-side env vars documented in tools/od-hub/README.md "Environment
// variables" (the "Read by the hub server" table). Every one must appear in
// .env.example so an operator sees the full surface in one file.
const HUB_SERVER_ENV = [
  'GITLAB_URL',
  'GITLAB_OAUTH_CLIENT_ID',
  'GITLAB_OAUTH_CLIENT_SECRET',
  'GITLAB_MIN_ACCESS_LEVEL',
  'GITLAB_WORKSPACE_GROUP_MODE',
  'HUB_PUBLIC_URL',
  'LLM_GATEWAY_URL',
  'TOKEN_ENC_KEY',
  'CONTROL_KEY_TTL_DAYS',
  'BLOB_DIR',
  'PRESENCE_TTL_MS',
  'INVITE_TTL_HOURS',
  'DOWNLOAD_URL',
  'HUB_CONSOLE_URL',
  'GITLAB_GROUP_TOKEN',
  'SMTP_URL',
  'SMTP_FROM',
];

async function read(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('Dockerfile: copies only paths that exist in the repository', async () => {
  const src = await read(dockerfilePath);
  const copied = [...src.matchAll(/^COPY (?!--from=)(\S+) /gm)].map((m) => m[1]!);
  assert.ok(copied.length > 0, 'expected build-context COPY instructions');
  for (const rel of copied) {
    assert.ok(await exists(join(repoRoot, rel)), `Dockerfile copies ${rel}, which does not exist`);
  }
});

test('Dockerfile: ships dist, migrations and templates as siblings under one tool root', async () => {
  const src = await read(dockerfilePath);
  // dist/index.mjs resolves migrations/ and templates/ by walking up from its own
  // directory (src/server/{sqlite-store,templates}.ts), so the three must land
  // under the same parent in the runtime image.
  for (const dir of ['dist', 'migrations', 'templates']) {
    assert.match(
      src,
      new RegExp(`^COPY --from=build [^\\n]*/tools/od-hub/${dir} \\./tools/od-hub/${dir}$`, 'm'),
      `runtime stage must copy tools/od-hub/${dir}`,
    );
  }
  assert.match(src, /^CMD \["start", "--sqlite", "\/data\/hub\.sqlite"\]$/m, 'default command must start the SQLite store under /data');
  assert.match(src, /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "node", "tools\/od-hub\/dist\/index\.mjs"\]$/m);
});

test('Dockerfile: does not ship sources, tests, or a package manager in the runtime stage', async () => {
  const src = await read(dockerfilePath);
  const runtime = src.slice(src.lastIndexOf('FROM ${RUNTIME_IMAGE}'));
  assert.doesNotMatch(runtime, /tools\/od-hub\/(?:src|tests|scripts)\b/, 'runtime stage must not copy src/tests/scripts');
  const runInstructions = runtime.replace(/\\\n/g, ' ').split('\n').filter((line) => line.startsWith('RUN '));
  assert.ok(runInstructions.length > 0);
  for (const line of runInstructions) {
    assert.doesNotMatch(line, /corepack|pnpm/, 'runtime stage must not install pnpm');
  }
  assert.match(runtime, /^USER od-hub$/m, 'runtime must drop to the unprivileged user');
});

test('Dockerfile: pins the hub port, data dir and health endpoint', async () => {
  const src = await read(dockerfilePath);
  assert.match(src, new RegExp(`^EXPOSE ${CONTAINER_PORT}$`, 'm'));
  assert.match(src, new RegExp(`^ENV OD_HUB_PORT=${CONTAINER_PORT}$`, 'm'));
  assert.match(src, new RegExp(`^ENV OD_HUB_DATA_DIR=${DATA_DIR}$`, 'm'));
  // The probe follows OD_HUB_PORT so an operator who overrides the port in
  // the image env is not left with a permanently unhealthy container.
  assert.ok(
    src.includes(`fetch('http://127.0.0.1:'+(process.env.OD_HUB_PORT||'${CONTAINER_PORT}')+'${HEALTH_PATH}')`),
    `HEALTHCHECK must probe ${HEALTH_PATH} on OD_HUB_PORT (default ${CONTAINER_PORT})`,
  );
});

test('docker-compose.yml: one service, one data volume, health check on the hub port', async () => {
  const src = await read(composePath);
  const services = [...src.matchAll(/^  ([a-z0-9-]+):$/gm)].map((m) => m[1]);
  assert.deepEqual(services, ['od-hub'], 'compose must declare exactly the od-hub service (SQLite is the shipped store; no database service)');
  assert.match(src, /dockerfile: deploy\/od-hub\/Dockerfile/);
  assert.match(src, /context: \.\.\/\.\./, 'build context must be the repository root for the pnpm lockfile');
  assert.match(src, new RegExp(`- od_hub_data:${DATA_DIR}$`, 'm'));
  assert.match(
    src,
    /env_file:\s*\n\s*- path: \.env\s*\n\s*required: false/,
    'the operator .env must be optional so `docker compose config` validates before it exists',
  );
  assert.ok(src.includes(`http://127.0.0.1:${CONTAINER_PORT}${HEALTH_PATH}`));
  assert.match(src, /\$\{OD_HUB_BIND:-127\.0\.0\.1\}/, 'compose must default to a loopback bind');
  assert.match(src, /read_only: true/);
});

test('.env.example: documents every hub server environment variable', async () => {
  const src = await read(envExamplePath);
  for (const name of HUB_SERVER_ENV) {
    assert.match(src, new RegExp(`^${name}=`, 'm'), `.env.example is missing ${name}=`);
  }
  assert.doesNotMatch(src, /^TOKEN_ENC_KEY=.+$/m, 'TOKEN_ENC_KEY must ship empty (operator generates it)');
  assert.doesNotMatch(src, /^GITLAB_OAUTH_CLIENT_SECRET=.+$/m, 'the client secret must ship empty');
});

test('.env.example: stays in sync with the hub README variable table', async () => {
  const hubReadme = await read(hubReadmePath);
  const serverSection = hubReadme.slice(
    hubReadme.indexOf('Read by the hub server:'),
    hubReadme.indexOf('Read by the shim'),
  );
  const documented = [...serverSection.matchAll(/^\| `([A-Z_]+)`(?: \/ `([A-Z_]+)`)? \|/gm)]
    .flatMap((m) => [m[1]!, m[2]].filter((v): v is string => v != null));
  assert.ok(documented.length >= HUB_SERVER_ENV.length, 'could not parse the hub README variable table');
  const envExample = await read(envExamplePath);
  // OD_HUB_HOST/OD_HUB_PORT/OD_HUB_DATA_DIR are fixed by the image and compose
  // file; everything else the server reads must be in the operator's .env.
  const imageOwned = new Set(['OD_HUB_HOST', 'OD_HUB_PORT', 'OD_HUB_DATA_DIR']);
  for (const name of documented) {
    if (imageOwned.has(name)) continue;
    assert.match(envExample, new RegExp(`^${name}=`, 'm'), `tools/od-hub/README.md documents ${name} but .env.example lacks it`);
  }
});

test('README: covers OAuth redirect URI, SSE proxy rules, backup and upgrade', async () => {
  const src = await read(readmePath);
  assert.ok(src.includes('/console/oauth/callback'), 'must name the exact GitLab redirect URI path (src/server/http.ts)');
  assert.ok(src.includes('Device Authorization Grant'));
  assert.ok(src.includes('read_user'), 'must list the OAuth scopes');
  assert.ok(src.includes('openssl rand -base64 32'), 'must show TOKEN_ENC_KEY generation');
  assert.ok(src.includes('proxy_buffering     off'), 'nginx example must disable buffering for SSE');
  assert.ok(src.includes('x-accel-buffering'), 'must mention the SSE anti-buffering header');
  assert.ok(src.includes('45 s'), 'must state the idle-timeout floor for the SSE stream');
  assert.ok(src.includes('.backup('), 'must show the SQLite online backup');
  assert.match(src, /## Operations[\s\S]*### Backup[\s\S]*### Upgrade/, 'operations runbook sections');
  assert.ok(src.includes('schema_migrations'), 'upgrade section must explain auto-applied migrations');
  assert.ok(src.includes('docs/deployment/self-hosted-hub.md'), 'must link the client-side connection guide');
});

// ---------------------------------------------------------------------------
// Compose validation (needs only the docker CLI, no daemon) and the real
// build + container smoke (only when a Docker daemon answers).

function dockerCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['compose', 'version'], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { timeout: 10_000 }, (err) => resolve(!err));
  });
}

function docker(args: string[], timeout = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { cwd: repoRoot, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${stderr || err.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`);
      if (resp.ok) return await resp.text();
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const skipDocker = Boolean(process.env.OD_HUB_DEPLOY_TEST_SKIP_DOCKER);
const hasDockerCli = skipDocker ? false : await dockerCliAvailable();
const hasDocker = skipDocker ? false : await dockerAvailable();

test(
  'docker-compose.yml: `docker compose config` resolves with and without an operator .env',
  { skip: hasDockerCli ? false : 'docker compose CLI not available' },
  async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'od-hub-compose-'));
    try {
      // Mirror deploy/od-hub into a scratch dir two levels deep so the relative
      // `context: ../..` in the compose file resolves the same way it does in
      // the repository, while we control whether a .env exists next to it.
      const scratchRoot = join(tmp, 'repo');
      const scratchDeploy = join(scratchRoot, 'deploy/od-hub');
      await mkdir(scratchDeploy, { recursive: true });
      await copyFile(composePath, join(scratchDeploy, 'docker-compose.yml'));

      const composeConfig = (args: string[]) =>
        new Promise<string>((resolve, reject) => {
          execFile(
            'docker',
            ['compose', '-f', 'docker-compose.yml', 'config', ...args],
            { cwd: scratchDeploy, timeout: 30_000, env: { ...process.env, OD_HUB_IMAGE: 'od-hub:test' } },
            (err, stdout, stderr) => (err ? reject(new Error(`docker compose config failed: ${stderr || err.message}`)) : resolve(stdout)),
          );
        });

      // Without .env: must validate (env_file is optional).
      assert.equal(await exists(join(scratchDeploy, '.env')), false);
      await composeConfig(['--quiet']);
      const resolved = JSON.parse(await composeConfig(['--format', 'json'])) as {
        services: Record<string, { build?: { context?: string; dockerfile?: string } }>;
      };
      const build = resolved.services['od-hub']?.build;
      assert.ok(build, 'od-hub service must declare a build section');
      assert.equal(await realpath(build.context!), await realpath(scratchRoot), 'build context must resolve to the repository root');
      assert.ok(build.dockerfile, 'build must name the dockerfile');
      // Verified against the real repository, not the scratch mirror.
      assert.ok(await exists(join(repoRoot, build.dockerfile!)), `<context>/${build.dockerfile} must exist in the repository`);

      // With .env (the shipped example): still validates and picks it up.
      await copyFile(envExamplePath, join(scratchDeploy, '.env'));
      await composeConfig(['--quiet']);
      const withEnv = JSON.parse(await composeConfig(['--format', 'json'])) as {
        services: Record<string, { environment?: Record<string, string> }>;
      };
      assert.ok(withEnv.services['od-hub']?.environment, 'resolved service must carry an environment map');
      assert.ok('GITLAB_URL' in withEnv.services['od-hub']!.environment!, 'variables from .env must be merged into the service environment');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test(
  'image: builds from the repository root and serves /healthz with a persistent SQLite store',
  { skip: hasDocker ? false : 'docker daemon not reachable', timeout: 15 * 60_000 },
  async () => {
    const tag = `od-hub-deploy-test:${process.pid}`;
    const name = `od-hub-deploy-test-${process.pid}`;
    const port = 18700 + (process.pid % 90);
    const controlKey = 'odc_deploy_test_key_1';
    try {
      await docker(['build', '-q', '-f', 'deploy/od-hub/Dockerfile', '-t', tag, '.'], 14 * 60_000);
      await docker([
        'run', '-d', '--name', name, '-p', `127.0.0.1:${port}:${CONTAINER_PORT}`,
        tag, 'start', '--sqlite', '/data/hub.sqlite', '--seed-dev', '--control-key', controlKey,
      ]);
      const health = await waitForHealth(port, 30_000);
      assert.ok(health, 'container never answered /healthz');
      const parsed = JSON.parse(health) as { ok: boolean; service: string; gitlab: boolean };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.service, 'od-hub');
      assert.equal(parsed.gitlab, false, 'no GitLab env was passed');

      // Bearer path exercises SQLite (better-sqlite3 native module) and migrations.
      const me = await fetch(`http://127.0.0.1:${port}/api/v1/me`, { headers: { authorization: `Bearer ${controlKey}` } });
      assert.equal(me.status, 200, `GET /api/v1/me -> ${me.status}`);
      const body = (await me.json()) as { user: { id: string } };
      assert.equal(body.user.id, 'u1');

      // Console pages prove templates/ was shipped next to dist/.
      const page = await fetch(`http://127.0.0.1:${port}/console/does-not-exist`, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 404);
      assert.match(await page.text(), /<!DOCTYPE html>/i);

      const { stdout: files } = await docker(['exec', name, 'ls', '/data']);
      assert.ok(files.split('\n').includes('hub.sqlite'), `expected hub.sqlite under ${DATA_DIR}: ${files}`);
      const { stdout: who } = await docker(['exec', name, 'id', '-u']);
      assert.equal(who.trim(), '1001', 'hub must run unprivileged');
    } finally {
      await docker(['rm', '-f', name]).catch(() => {});
      await docker(['image', 'rm', '-f', tag]).catch(() => {});
    }
  },
);
