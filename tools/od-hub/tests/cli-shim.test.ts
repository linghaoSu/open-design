import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveShimContext } from '../src/cli/config.js';
import { crashResult, runCli, type CliResult } from '../src/cli/shim.js';
import type { HubServer } from '../src/server/http.js';
import { deriveMemberId } from '../src/server/memory-store.js';
import { BILLING_SUMMARY_STUB, OD_VELA_VERSION } from '../src/shared/wire.js';
import {
  API_FAILURE_LINE,
  isExactTeamProjectLookupUnavailable,
  isWorkspaceBillingSnapshotUnsupported,
  parseAmrBillingSummary,
  parseBillingSummary,
  parseMediaModels,
  parseTerminalReceipt,
  parseVelaModelJson,
  parseVelaModels,
  parseWorkspaceBillingSnapshot,
} from './daemon-parsers.js';
import { CONTROL_KEY, OTHER_KEY, PERSONAL_WORKSPACE, TEAM_WORKSPACE, startHub } from './helpers.js';

let hub: HubServer;
let hubUrl: string;

beforeAll(async () => {
  ({ hub, url: hubUrl } = await startHub());
});

afterAll(async () => {
  await hub.close();
});

const baseEnv = () => ({
  VELA_API_URL: hubUrl,
  VELA_CONTROL_KEY: CONTROL_KEY,
  VELA_WORKSPACE_ID: TEAM_WORKSPACE,
  AMR_HOME: mkdtempSync(path.join(tmpdir(), 'od-vela-empty-')),
});

const run = (argv: string[], env: Record<string, string | undefined> = baseEnv()) => runCli(argv, env);

const FORBIDDEN_STDERR = ['unknown command', 'unknown flag:', 'billing_workspace_snapshot_unsupported'];

function expectClean(result: CliResult): void {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
}

function expectNotSupported(result: CliResult, scope: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`Error: ${scope}: API request failed with status 501: not_supported\n`);
  expect(result.stderr.trim()).toMatch(API_FAILURE_LINE);
  for (const banned of FORBIDDEN_STDERR) expect(result.stderr.toLowerCase()).not.toContain(banned);
  // Neither daemon compat heuristic must fire on this output.
  expect(isWorkspaceBillingSnapshotUnsupported(result.stderr, result.stderr)).toBe(false);
  expect(isExactTeamProjectLookupUnavailable(result.stderr)).toBe(false);
}

function parseSingleJsonLine(stdout: string): unknown {
  expect(stdout.endsWith('\n')).toBe(true);
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(stdout);
}

describe('--version', () => {
  it('prints the odhub version string (amr.ts:672 probes --version)', async () => {
    const result = await run(['--version']);
    expectClean(result);
    expect(result.stdout).toBe(`${OD_VELA_VERSION}\n`);
    expect(result.stdout).toBe('vela 0.0.35-odhub\n');
  });

  it('does not need credentials', async () => {
    const result = await run(['--version'], { AMR_HOME: mkdtempSync(path.join(tmpdir(), 'od-vela-noauth-')) });
    expectClean(result);
  });
});

describe('billing summary --format json', () => {
  it('satisfies vela-billing.ts:258-281 parseBillingSummary', async () => {
    const result = await run(['billing', 'summary', '--format', 'json']);
    expectClean(result);
    const parsed = parseBillingSummary(result.stdout);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      workspaceId: null,
      membershipTier: 'team',
      totalAvailableCredits: '999999',
      subscriptionCredits: '999999',
      rechargeCredits: '0',
      balanceUsd: '999999',
      subscriptionStatus: 'active',
      availableActions: [],
      workspaceBalance: null,
    });
  });

  it('satisfies amr.ts:618-665 fetchVelaBillingSummary (plan + balanceUsd)', async () => {
    const result = await run(['billing', 'summary', '--format', 'json']);
    expect(parseAmrBillingSummary(result.stdout)).toEqual({ plan: 'team', balanceUsd: '999999' });
  });

  it('emits exactly the documented stub as one JSON line', async () => {
    const result = await run(['billing', 'summary', '--format', 'json']);
    expect(parseSingleJsonLine(result.stdout)).toEqual(BILLING_SUMMARY_STUB);
  });
});

describe('billing workspace-snapshot --workspace-id X --format json', () => {
  it('returns a snapshot whose workspaceMemberId equals the directory member id', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', TEAM_WORKSPACE, '--format', 'json']);
    expectClean(result);
    const raw = parseSingleJsonLine(result.stdout) as Record<string, unknown>;
    expect(raw).toMatchObject({
      schemaVersion: 1,
      billingScopeVersion: 2,
      workspaceId: TEAM_WORKSPACE,
      workspaceMemberId: deriveMemberId('u1', TEAM_WORKSPACE),
      billing: { billingState: 'active', planId: 'team_plus' },
      wallet: { balanceUsd: '999999', expiresAt: null },
      revisions: { billing: '1', wallet: '1' },
    });
    expect(typeof (raw.wallet as { updatedAt: unknown }).updatedAt).toBe('string');

    // Cross-check against the directory the daemon fetches.
    const directory = await fetch(`${hubUrl}/api/v1/workspaces`, { headers: { authorization: `Bearer ${CONTROL_KEY}` } });
    const { items } = await directory.json() as { items: Array<{ workspaceId: string; workspaceMemberId: string }> };
    expect(items.find((i) => i.workspaceId === TEAM_WORKSPACE)?.workspaceMemberId).toBe(raw.workspaceMemberId);
  });

  it('passes vela-billing.ts:319-393 parseWorkspaceBillingSnapshot', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', TEAM_WORKSPACE, '--format', 'json']);
    const snapshot = parseWorkspaceBillingSnapshot(result.stdout, TEAM_WORKSPACE);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.balanceUsd).toBe('999999');
  });

  it('works for the personal workspace too', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', PERSONAL_WORKSPACE, '--format', 'json']);
    expectClean(result);
    expect(parseWorkspaceBillingSnapshot(result.stdout, PERSONAL_WORKSPACE)?.workspaceMemberId).toBe(deriveMemberId('u1', PERSONAL_WORKSPACE));
  });

  it('uses --workspace-id over the ambient VELA_WORKSPACE_ID', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', PERSONAL_WORKSPACE, '--format', 'json'], {
      ...baseEnv(),
      VELA_WORKSPACE_ID: TEAM_WORKSPACE,
    });
    expect((parseSingleJsonLine(result.stdout) as { workspaceId: string }).workspaceId).toBe(PERSONAL_WORKSPACE);
  });

  it('reports 403 workspace_not_authorized for a non-member, without the unsupported sentinel', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', PERSONAL_WORKSPACE, '--format', 'json'], {
      ...baseEnv(),
      VELA_CONTROL_KEY: OTHER_KEY,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('Error: billing workspace-snapshot: API request failed with status 403: workspace_not_authorized\n');
    expect(isWorkspaceBillingSnapshotUnsupported(result.stderr, result.stderr)).toBe(false);
  });

  it('reports 401 invalid_api_key for a bad key', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', TEAM_WORKSPACE, '--format', 'json'], {
      ...baseEnv(),
      VELA_CONTROL_KEY: 'bogus',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Error: billing workspace-snapshot: API request failed with status 401: invalid_api_key\n');
  });

  it('exits 2 with a local error when --workspace-id is missing (no "unknown flag")', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--format', 'json']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('Error: billing workspace-snapshot: required flag --workspace-id is missing\n');
    expect(isWorkspaceBillingSnapshotUnsupported(result.stderr, result.stderr)).toBe(false);
  });

  it('exits 2 when no credential is available anywhere', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', TEAM_WORKSPACE, '--format', 'json'], {
      VELA_API_URL: hubUrl,
      AMR_HOME: mkdtempSync(path.join(tmpdir(), 'od-vela-nocreds-')),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Error: billing workspace-snapshot: not logged in/);
  });

  it('reports a network failure as `request failed:` exit 1', async () => {
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', TEAM_WORKSPACE, '--format', 'json'], {
      ...baseEnv(),
      VELA_API_URL: 'http://127.0.0.1:9',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^Error: billing workspace-snapshot: request failed: /);
  });
});

describe('closed billing subcommands', () => {
  for (const sub of ['workspace-balance', 'team-catalog', 'checkout']) {
    it(`billing ${sub} -> 501 not_supported`, async () => {
      const result = await run(['billing', sub, '--workspace-id', TEAM_WORKSPACE, '--format', 'json']);
      expectNotSupported(result, `billing ${sub}`);
    });
  }

  it('billing with an unknown verb -> 501 not_supported', async () => {
    const result = await run(['billing', 'refund']);
    expectNotSupported(result, 'billing refund');
  });
});

describe('model / models', () => {
  it('model list --all --format json -> {"source":"remote","data":[]} (amr.ts:133-165)', async () => {
    const result = await run(['model', 'list', '--all', '--format', 'json']);
    expectClean(result);
    expect(parseSingleJsonLine(result.stdout)).toEqual({ source: 'remote', data: [] });
    expect(parseVelaModelJson(result.stdout, 'remote')).toEqual([]);
    expect(() => parseVelaModelJson(result.stdout, 'preset')).toThrow(/source/);
  });

  it('model preset --format json -> {"source":"preset","data":[]}', async () => {
    const result = await run(['model', 'preset', '--format', 'json']);
    expectClean(result);
    expect(parseSingleJsonLine(result.stdout)).toEqual({ source: 'preset', data: [] });
    expect(parseVelaModelJson(result.stdout, 'preset')).toEqual([]);
  });

  it('models -> empty text, exit 0 (amr.ts:116-131)', async () => {
    const result = await run(['models']);
    expectClean(result);
    expect(result.stdout).toBe('');
    expect(parseVelaModels(result.stdout)).toEqual([]);
  });

  it('model <other> -> 501', async () => {
    expectNotSupported(await run(['model', 'pin', 'x']), 'model pin');
  });
});

describe('media', () => {
  it('media models --json -> object with empty models array (media/vela.ts:187-191)', async () => {
    const result = await run(['media', 'models', '--json']);
    expectClean(result);
    const parsed = parseSingleJsonLine(result.stdout);
    expect(parsed).toEqual({ models: [] });
    expect(Array.isArray(parsed)).toBe(false);
    expect(parseMediaModels(result.stdout)).toEqual([]);
  });

  for (const argv of [
    ['image', 'gen', '--model', 'vela/x', '--prompt', 'p', '--output', '/tmp/o', '--json'],
    ['image', 'edit', '--model', 'vela/x', '--prompt', 'p', '--image', '/tmp/i', '--output', '/tmp/o', '--json'],
    ['image', 'get', 'task-1', '--wait', '--output', '/tmp/o', '--json'],
    ['video', 'gen', '--model', 'vela/v', '--prompt', 'p', '--json'],
    ['video', 'get', 'task-2', '--json'],
  ]) {
    it(`${argv[0]} ${argv[1]} -> exit 1 with stdout {"error":{"code":"not_supported"}}`, async () => {
      const result = await run(argv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('');
      expect(parseSingleJsonLine(result.stdout)).toEqual({
        error: { code: 'not_supported', message: 'od-hub does not provide media generation', retryable: false },
      });
    });
  }
});

describe('run terminal', () => {
  const record = { runId: 'run_123', outcome: 'failed', terminalAt: '2026-09-08T01:02:03.000Z' };

  it('echoes a receipt the outbox accepts (amr-terminal-report-outbox.ts:342-363)', async () => {
    const result = await run(['run', 'terminal', '--run-id', record.runId, '--outcome', record.outcome, '--terminal-at', record.terminalAt, '--json']);
    expectClean(result);
    expect(parseSingleJsonLine(result.stdout)).toEqual({ ...record, recorded: true });
    expect(parseTerminalReceipt(result.stdout, record)).toBe('ok');
  });

  it('accepts outcome=canceled', async () => {
    const result = await run(['run', 'terminal', '--run-id', 'r', '--outcome', 'canceled', '--terminal-at', record.terminalAt, '--json']);
    expectClean(result);
    expect((parseSingleJsonLine(result.stdout) as { outcome: string }).outcome).toBe('canceled');
  });

  it('on bad input emits the stdout error envelope, not stderr (outbox:288-340)', async () => {
    const result = await run(['run', 'terminal', '--run-id', 'r', '--json']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(parseSingleJsonLine(result.stdout)).toMatchObject({ error: 'invalid_input', retryable: false });
  });

  it('run <other> -> 501', async () => {
    expectNotSupported(await run(['run', 'start']), 'run start');
  });
});

describe('team-projects', () => {
  it('--help -> stdout help text, exit 0, EMPTY stderr (vela-cli-team-projects.ts:499-541)', async () => {
    const result = await run(['team-projects', '--help']);
    expectClean(result);
    expect(result.stdout).toContain('team-projects');
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('-h also works', async () => {
    expectClean(await run(['team-projects', '-h']));
  });

  it('unknown team-projects verb -> 501 not_supported, never a compat trigger', async () => {
    expectNotSupported(await run(['team-projects', 'frobnicate', '--json']), 'team-projects frobnicate');
  });
  // list/get/upsert/remove/pull are covered end to end in tests/resources-cli.test.ts.
});

describe('TODO stubs keep the typed 501 contract', () => {
  it('login against a hub without GitLab configured -> 501 not_supported, still no compat trigger', async () => {
    const result = await run(['login'], { ...baseEnv(), VELA_CONTROL_KEY: undefined });
    expectNotSupported(result, 'login');
  });

  const cases: Array<[string[], string]> = [
    // collab member|comment|presence are implemented; see tests/collab-cli.test.ts.
    [['collab', 'invite', 'create'], 'collab invite create'],
    [['resource', 'snapshot', 'r1', '--ref', 'published', '--name', 'n', '--json'], 'resource snapshot'],
    [['resource', 'snapshot-redact', 'r1', 'slug', '--json'], 'resource snapshot-redact'],
    [['agent', 'run'], 'agent run'],
  ];
  for (const [argv, scope] of cases) {
    it(`${argv.join(' ')}`, async () => {
      expectNotSupported(await run(argv), scope);
    });
  }
});

describe('unknown subcommands', () => {
  it('top-level unknown -> Error: <cmd>: API request failed with status 501: not_supported', async () => {
    expectNotSupported(await run(['frobnicate', '--json']), 'frobnicate');
  });

  it('no arguments -> 501 for scope "vela"', async () => {
    expectNotSupported(await run([]), 'vela');
  });

  it('never echoes flag values into stderr', async () => {
    const result = await run(['resource', 'weird', '--json', 'SECRET_VALUE']);
    expect(result.stderr).not.toContain('SECRET_VALUE');
    expectNotSupported(result, 'resource weird');
  });
});

describe('credential resolution (vela.ts:751-795 precedence)', () => {
  it('VELA_CONTROL_KEY wins and VELA_API_URL is used', () => {
    const ctx = resolveShimContext({ VELA_CONTROL_KEY: 'k', VELA_API_URL: 'http://a/', AMR_HOME: mkdtempSync(path.join(tmpdir(), 'x-')) });
    expect(ctx).toMatchObject({ controlKey: 'k', apiUrl: 'http://a/', profile: 'prod' });
  });

  it('falls back to $AMR_HOME/config.json profiles[VELA_PROFILE]; stored apiUrl beats env', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'amr-home-'));
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      profiles: {
        selfhost: { controlKey: 'stored-key', apiUrl: 'http://stored/' },
        prod: { controlKey: 'prod-key' },
      },
    }));
    const ctx = resolveShimContext({ AMR_HOME: home, VELA_PROFILE: 'selfhost', VELA_API_URL: 'http://env/' });
    expect(ctx).toMatchObject({ controlKey: 'stored-key', apiUrl: 'http://stored/', profile: 'selfhost' });
    const prod = resolveShimContext({ AMR_HOME: home });
    expect(prod).toMatchObject({ controlKey: 'prod-key', apiUrl: 'https://amr-api.open-design.ai', profile: 'prod' });
  });

  it('OPEN_DESIGN_AMR_PROFILE beats VELA_PROFILE', () => {
    const ctx = resolveShimContext({ OPEN_DESIGN_AMR_PROFILE: 'selfhost', VELA_PROFILE: 'prod', VELA_CONTROL_KEY: 'k' });
    expect(ctx.profile).toBe('selfhost');
  });

  it('workspace id falls back from VELA_WORKSPACE_ID to OPEN_DESIGN_WORKSPACE_ID', () => {
    expect(resolveShimContext({ VELA_CONTROL_KEY: 'k', OPEN_DESIGN_WORKSPACE_ID: 'w2' }).workspaceId).toBe('w2');
    expect(resolveShimContext({ VELA_CONTROL_KEY: 'k', VELA_WORKSPACE_ID: 'w1', OPEN_DESIGN_WORKSPACE_ID: 'w2' }).workspaceId).toBe('w1');
  });

  it('a config-file credential reaches the hub end to end', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'amr-home-e2e-'));
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      profiles: { selfhost: { controlKey: CONTROL_KEY, apiUrl: hubUrl } },
    }));
    const result = await run(['billing', 'workspace-snapshot', '--workspace-id', TEAM_WORKSPACE, '--format', 'json'], {
      AMR_HOME: home,
      VELA_PROFILE: 'selfhost',
    });
    expectClean(result);
  });
});

describe('request headers', () => {
  it('sends authorization, x-vela-workspace-id and x-vela-invocation-source', async () => {
    let seen: Record<string, string> = {};
    const fetchImpl = async (input: string, init: RequestInit) => {
      seen = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
      seen.url = input;
      return new Response(JSON.stringify({}), { status: 200 });
    };
    await runCli(['billing', 'workspace-snapshot', '--workspace-id', 'g9', '--format', 'json'], {
      VELA_CONTROL_KEY: 'k1',
      VELA_API_URL: 'http://hub.test',
      VELA_WORKSPACE_ID: 'ambient',
      VELA_INVOCATION_SOURCE: 'open-design',
    }, { fetch: fetchImpl });
    expect(seen.authorization).toBe('Bearer k1');
    expect(seen['x-vela-workspace-id']).toBe('g9');
    expect(seen['x-vela-invocation-source']).toBe('open-design');
    expect(seen['user-agent']).toBe('od-vela/0.0.35-odhub');
    expect(seen.url).toBe('http://hub.test/api/v1/billing/workspace-snapshot');
  });

  it('defaults x-vela-invocation-source to open-design', async () => {
    let source = '';
    await runCli(['billing', 'workspace-snapshot', '--workspace-id', 'g9', '--format', 'json'], {
      VELA_CONTROL_KEY: 'k1', VELA_API_URL: 'http://hub.test',
    }, {
      fetch: async (_input, init) => {
        source = (init.headers as Record<string, string>)['x-vela-invocation-source']!;
        return new Response('{}', { status: 200 });
      },
    });
    expect(source).toBe('open-design');
  });

  it('a non-JSON error body still yields `status NNN: <code>` with a colon', async () => {
    const result = await runCli(['billing', 'workspace-snapshot', '--workspace-id', 'g9', '--format', 'json'], {
      VELA_CONTROL_KEY: 'k1', VELA_API_URL: 'http://hub.test',
    }, { fetch: async () => new Response('gateway down', { status: 404 }) });
    expect(result.stderr).toBe('Error: billing workspace-snapshot: API request failed with status 404: http_404\n');
    expect(isExactTeamProjectLookupUnavailable(result.stderr)).toBe(false);
  });
});

describe('crashResult (unexpected throw at the process entry)', () => {
  it('renders `Error: <scope>: <message>` exit 1 with no stack trace or compat triggers', () => {
    const result = crashResult(['collab', 'member', 'register', '--workspace-id', 'g1'], new Error('ENOENT: no such file\n    at fs.open'));
    expect(result).toEqual({ stdout: '', stderr: 'Error: collab member: ENOENT: no such file\n', exitCode: 1 });
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stderr).not.toMatch(/unknown command|unknown flag:/);
    expect(isWorkspaceBillingSnapshotUnsupported(result.stderr, result.stderr)).toBe(false);
    expect(isExactTeamProjectLookupUnavailable(result.stderr)).toBe(false);
  });

  it('falls back to the `vela` scope and a generic message', () => {
    expect(crashResult([], '')).toEqual({ stdout: '', stderr: 'Error: vela: unexpected failure\n', exitCode: 1 });
    expect(crashResult(['--json'], 42).stderr).toBe('Error: vela: 42\n');
  });
});

describe('spawned binary (tsx) — real process stdout/stderr/exit', () => {
  const entry = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
  const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  // Async spawn: a blocking spawnSync would stall the in-process hub's event loop.
  const spawn = (args: string[], env: Record<string, string | undefined>) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(tsx, [entry, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
        const status = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error ? null : 0;
        resolve({ status, stdout, stderr });
      });
    });

  it('--version', async () => {
    const child = await spawn(['--version'], {});
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('vela 0.0.35-odhub\n');
    expect(child.stderr).toBe('');
  });

  it('team-projects --help writes nothing to stderr', async () => {
    const child = await spawn(['team-projects', '--help'], {});
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toContain('Usage:');
  });

  it('unknown subcommand exits 1 with the typed stderr line', async () => {
    const child = await spawn(['nope'], {});
    expect(child.status).toBe(1);
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('Error: nope: API request failed with status 501: not_supported\n');
  });

  it('billing workspace-snapshot round-trips through the hub', async () => {
    const child = await spawn(['billing', 'workspace-snapshot', '--workspace-id', TEAM_WORKSPACE, '--format', 'json'], baseEnv());
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(parseWorkspaceBillingSnapshot(child.stdout, TEAM_WORKSPACE)).not.toBeNull();
  });

  it('image gen exits 1 with the JSON envelope on stdout', async () => {
    const child = await spawn(['image', 'gen', '--model', 'm', '--prompt', 'p', '--json'], {});
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toEqual({
      error: { code: 'not_supported', message: 'od-hub does not provide media generation', retryable: false },
    });
  });
});
