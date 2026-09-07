import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/shim.js';
import { ShimError } from '../src/cli/http.js';
import { DEVICE_CODE_PATTERN } from '../src/server/auth-service.js';
import { hashApiKey } from '../src/server/ids.js';
import { createTokenCipher } from '../src/server/token-cipher.js';
import { DEVICE_FLOW_PENDING_STATUS, DEVICE_FLOW_SLOW_DOWN_STATUS } from '../src/shared/wire.js';
import { parseVelaLoginActivation } from './daemon-parsers.js';
import { ALICE, BOB, loginViaHttp, startGitLabHub, type GitLabHubFixture } from './helpers/gitlab-hub.js';

const fixtures: GitLabHubFixture[] = [];
const dirs: string[] = [];

async function fx(options: Parameters<typeof startGitLabHub>[0] = {}): Promise<GitLabHubFixture> {
  const created = await startGitLabHub(options);
  fixtures.push(created);
  return created;
}

function tmpHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'od-vela-amr-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('token cipher', () => {
  it('round-trips with AES-256-GCM and rejects a foreign key id', () => {
    const cipher = createTokenCipher(Buffer.alloc(32, 1));
    const blob = cipher.encrypt('glpat-secret');
    expect(blob.length).toBe(12 + 16 + 'glpat-secret'.length);
    expect(blob.toString('utf8')).not.toContain('glpat');
    expect(cipher.decrypt(blob, cipher.keyId)).toBe('glpat-secret');
    expect(() => cipher.decrypt(blob, 'k_other')).toThrow(/unknown key/);
    const other = createTokenCipher(Buffer.alloc(32, 2));
    expect(() => other.decrypt(blob, other.keyId)).toThrow();
    expect(() => createTokenCipher(Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it('binds the key id as AAD so a blob cannot be re-associated with another key id', () => {
    const key = Buffer.alloc(32, 3);
    const cipher = createTokenCipher(key);
    // Same key, same layout, but sealed without (or under a different) AAD: must fail the tag check.
    const seal = (aad: Buffer | null) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      if (aad) c.setAAD(aad);
      const body = Buffer.concat([c.update('glpat-secret', 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]);
    };
    expect(() => cipher.decrypt(seal(null), cipher.keyId)).toThrow();
    expect(() => cipher.decrypt(seal(Buffer.from('k_somebodyelse')), cipher.keyId)).toThrow();
    expect(cipher.decrypt(seal(Buffer.from(cipher.keyId)), cipher.keyId)).toBe('glpat-secret');
  });
});

describe('POST /api/v1/auth/device', () => {
  it('proxies GitLab authorize_device with scope read_user read_api and returns a hub device code', async () => {
    const f = await fx();
    const res = await post(`${f.hubUrl}/api/v1/auth/device`, { profile: 'selfhost' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['deviceCode', 'expiresIn', 'interval', 'userCode', 'verificationUri', 'verificationUriComplete']);
    // >=128-bit random, base64url; never GitLab's own device_code
    expect(body.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(String(body.deviceCode)).not.toMatch(/^gl-device/);
    expect(body.userCode).toMatch(/^ABCD-\d{4}$/);
    expect(body.verificationUriComplete).toBe(`${f.gitlab.url}/-/oauth/device?user_code=${body.userCode}`);
    expect(body.interval).toBe(1);
    expect(body.expiresIn).toBe(600);
    const upstream = f.gitlab.requests.find((r) => r.path === '/oauth/authorize_device')!;
    const form = new URLSearchParams(upstream.body);
    expect(form.get('scope')).toBe('read_user read_api');
    expect(form.get('client_id')).toBe('od-hub-test-client');
    expect(form.get('client_secret')).toBe('od-hub-test-secret');
    // Only sha256(hub device code) is stored, and GitLab's device code is sealed with the token cipher.
    expect(await f.store.getDeviceAuth(body.deviceCode as string)).toBeNull();
    const row = await f.store.getDeviceAuth(hashApiKey(body.deviceCode as string));
    expect(row?.deviceCodeHash).toBe(hashApiKey(body.deviceCode as string));
    expect(row?.gitlabDeviceCodeEnc.toString('utf8')).not.toContain('gl-device');
    expect(row?.keyId).toMatch(/^k_/);
    const cipher = createTokenCipher(f.config.tokenEncKey!);
    expect(cipher.decrypt(row!.gitlabDeviceCodeEnc, row!.keyId)).toMatch(/^gl-device/);
    expect(row?.profile).toBe('selfhost');
    expect(row?.status).toBe('pending');
  });

  it('rejects malformed JSON with 400 invalid_json and an oversized body with 413', async () => {
    const f = await fx();
    const raw = (body: string) => fetch(`${f.hubUrl}/api/v1/auth/device`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    let res = await raw('{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    res = await raw('[1,2]');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    res = await raw(JSON.stringify({ profile: 'x'.repeat(70 * 1024) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    // Empty body is still fine (profile optional); GitLab was never consulted for the bad ones.
    expect((await raw('')).status).toBe(200);
    expect(f.gitlab.requests.filter((r) => r.path === '/oauth/authorize_device')).toHaveLength(1);
  });

  it('answers 501 not_supported when GitLab is not configured', async () => {
    const { createHubServer } = await import('../src/server/http.js');
    const { MemoryHubStore } = await import('../src/server/memory-store.js');
    const hub = createHubServer({ store: new MemoryHubStore() });
    const { url } = await hub.listen(0);
    try {
      const res = await post(`${url}/api/v1/auth/device`, {});
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: 'not_supported' });
    } finally {
      await hub.close();
    }
  });
});

describe('POST /api/v1/auth/device/token', () => {
  it('maps pending -> 428, slow_down -> 429, denied/expired/unknown -> 400 with RFC 8628 codes', async () => {
    const f = await fx();
    const start = await (await post(`${f.hubUrl}/api/v1/auth/device`, {})).json() as { deviceCode: string; userCode: string };
    const poll = () => post(`${f.hubUrl}/api/v1/auth/device/token`, { deviceCode: start.deviceCode });

    let res = await poll();
    expect(res.status).toBe(DEVICE_FLOW_PENDING_STATUS);
    expect(await res.json()).toEqual({ error: 'authorization_pending' });

    // Polling again within interval/2 is throttled hub-side before GitLab sees it.
    const upstreamBefore = f.gitlab.pollCount(start.userCode);
    res = await poll();
    expect(res.status).toBe(DEVICE_FLOW_SLOW_DOWN_STATUS);
    expect(await res.json()).toEqual({ error: 'slow_down' });
    expect(f.gitlab.pollCount(start.userCode)).toBe(upstreamBefore);

    // GitLab-side slow_down is passed through and widens the stored interval.
    f.clock.now = new Date(f.clock.now.getTime() + 5_000);
    f.gitlab.slowDown(start.userCode, 1);
    res = await poll();
    expect(res.status).toBe(DEVICE_FLOW_SLOW_DOWN_STATUS);
    expect((await f.store.getDeviceAuth(hashApiKey(start.deviceCode)))?.intervalS).toBe(6);

    f.clock.now = new Date(f.clock.now.getTime() + 10_000);
    f.gitlab.deny(start.userCode);
    res = await poll();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'access_denied' });
    // denied is terminal even if GitLab later says otherwise
    f.clock.now = new Date(f.clock.now.getTime() + 10_000);
    expect((await poll()).status).toBe(400);

    const other = await (await post(`${f.hubUrl}/api/v1/auth/device`, {})).json() as { deviceCode: string; userCode: string };
    f.gitlab.expire(other.userCode);
    res = await post(`${f.hubUrl}/api/v1/auth/device/token`, { deviceCode: other.deviceCode });
    expect(await res.json()).toEqual({ error: 'expired_token' });

    const third = await (await post(`${f.hubUrl}/api/v1/auth/device`, {})).json() as { deviceCode: string };
    f.clock.now = new Date(f.clock.now.getTime() + 601_000);
    res = await post(`${f.hubUrl}/api/v1/auth/device/token`, { deviceCode: third.deviceCode });
    expect(await res.json()).toEqual({ error: 'expired_token' });

    res = await post(`${f.hubUrl}/api/v1/auth/device/token`, { deviceCode: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    // Well-formed but unknown, and malformed (wrong length / alphabet) codes are both invalid_grant;
    // the store is only consulted for codes matching the strict pattern.
    expect(DEVICE_CODE_PATTERN.test(start.deviceCode)).toBe(true);
    expect(DEVICE_CODE_PATTERN.test(`${start.deviceCode}A`)).toBe(false);
    expect(DEVICE_CODE_PATTERN.test('a'.repeat(42) + '=')).toBe(false);
    res = await post(`${f.hubUrl}/api/v1/auth/device/token`, { deviceCode: 'A'.repeat(43) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    res = await post(`${f.hubUrl}/api/v1/auth/device/token`, {});
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('on approval upserts the GitLab user, encrypts the grant, mints odc_/odr_ keys and returns the profile payload', async () => {
    const f = await fx({ env: { HUB_PUBLIC_URL: 'https://hub.example.test/', LLM_GATEWAY_URL: 'https://llm.example.test' } });
    const { deviceCode, ...result } = await loginViaHttp(f, ALICE.id);
    expect(result).toEqual({
      controlKey: expect.stringMatching(/^odc_[A-Za-z0-9_-]{32}$/),
      runtimeKey: expect.stringMatching(/^odr_[A-Za-z0-9_-]{32}$/),
      apiUrl: 'https://hub.example.test',
      linkUrl: 'https://llm.example.test',
      // vela.ts:238-250 VelaUser: id string, email, name?, image?, plan?
      user: { id: '101', email: 'alice@example.test', name: 'Alice Liddell', image: 'https://gitlab.example.test/alice.png', plan: 'team' },
    });
    expect(result.controlKey).not.toBe(result.runtimeKey);

    const user = await f.store.getUser('101');
    expect(user).toMatchObject({ id: '101', gitlabId: 101, email: 'alice@example.test', name: 'Alice Liddell' });
    const grant = await f.store.getOAuthGrant('101');
    expect(grant).not.toBeNull();
    expect(grant!.accessTokenEnc.toString('utf8')).not.toContain('gl-access');
    expect(grant!.refreshTokenEnc!.toString('utf8')).not.toContain('gl-refresh');
    expect(grant!.keyId).toMatch(/^k_/);

    const principal = await f.store.authenticate(result.controlKey, f.clock.now);
    expect(principal?.apiKey).toMatchObject({ kind: 'control', profile: 'selfhost' });
    expect(principal!.apiKey.keyHash).not.toContain(result.controlKey.slice(4));
    // 30-day expiry (CONTROL_KEY_TTL_DAYS default)
    expect(principal!.apiKey.expiresAt).toBe(new Date(f.clock.now.getTime() + 30 * 86_400_000).toISOString());
    expect((await f.store.authenticate(result.runtimeKey, f.clock.now))?.apiKey.kind).toBe('runtime');
    expect((await f.store.getDeviceAuth(hashApiKey(deviceCode)))?.status).toBe('complete');

    // The completed device code is single use.
    const replay = await post(`${f.hubUrl}/api/v1/auth/device/token`, { deviceCode });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: 'expired_token' });
  });

  it('falls back to <username>@<gitlab-host> when GitLab hides the email (PLAN §3.1) and derives apiUrl from the request without HUB_PUBLIC_URL', async () => {
    const f = await fx();
    const result = await loginViaHttp(f, BOB.id);
    const host = new URL(f.gitlab.url).hostname;
    expect(result.user).toEqual({ id: '202', email: `bob@${host}`, name: 'Bob Builder', image: null, plan: 'team' });
    expect(result.apiUrl).toBe(f.hubUrl);
    expect(result.linkUrl).toBe(f.hubUrl);
  });
});

describe('bearer lifecycle (PLAN §5.3)', () => {
  it('slides the expiry on every authenticated request and rejects an idle key after the TTL', async () => {
    const f = await fx({ env: { CONTROL_KEY_TTL_DAYS: '1' } });
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    const day = 86_400_000;
    const auth = { authorization: `Bearer ${controlKey}` };

    f.clock.now = new Date(f.clock.now.getTime() + 0.9 * day);
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: auth })).status).toBe(200);
    // used at +0.9d -> expires at +1.9d
    f.clock.now = new Date(f.clock.now.getTime() + 0.9 * day);
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: auth })).status).toBe(200);
    // idle for more than a day
    f.clock.now = new Date(f.clock.now.getTime() + 1.1 * day);
    const expired = await fetch(`${f.hubUrl}/api/v1/me`, { headers: auth });
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: 'invalid_api_key' });
  });

  it('GET /api/v1/me is real: returns the GitLab identity behind the bearer', async () => {
    const f = await fx();
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    const res = await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${controlKey}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: '101', email: 'alice@example.test', name: 'Alice Liddell', image: 'https://gitlab.example.test/alice.png', plan: 'team', balanceUsd: '999999.00' },
    });
  });

  it('POST /api/v1/auth/revoke kills exactly the presented key', async () => {
    const f = await fx();
    const { controlKey, runtimeKey } = await loginViaHttp(f, ALICE.id);
    const res = await post(`${f.hubUrl}/api/v1/auth/revoke`, {}, { authorization: `Bearer ${controlKey}` });
    expect(res.status).toBe(200);
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${controlKey}` } })).status).toBe(401);
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${runtimeKey}` } })).status).toBe(200);
    expect((await post(`${f.hubUrl}/api/v1/auth/revoke`, {})).status).toBe(401);
  });

  it('refreshes an expired GitLab access token once under a per-user lock, then serves the directory', async () => {
    const f = await fx({ gitlab: { accessTokenTtlS: 60 } });
    const { controlKey } = await loginViaHttp(f, ALICE.id);
    const auth = { authorization: `Bearer ${controlKey}` };
    expect((await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth })).status).toBe(200);
    const refreshesBefore = f.gitlab.requests.filter((r) => r.body.includes('grant_type=refresh_token')).length;
    expect(refreshesBefore).toBe(0);

    // Access token now stale in the hub's own bookkeeping AND rejected by GitLab.
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    f.gitlab.expireAccessTokens();
    f.hub.directory.invalidate('101');
    const responses = await Promise.all([
      fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth }),
      fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth }),
      fetch(`${f.hubUrl}/api/v1/me`, { headers: auth }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const refreshes = f.gitlab.requests.filter((r) => r.body.includes('grant_type=refresh_token'));
    expect(refreshes).toHaveLength(1);
    // GitLab rotated the refresh token; the hub stored the new one (next refresh must still work).
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    f.gitlab.expireAccessTokens();
    f.hub.directory.invalidate('101');
    expect((await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth })).status).toBe(200);
    expect(f.gitlab.requests.filter((r) => r.body.includes('grant_type=refresh_token'))).toHaveLength(2);
  });

  it('refresh failure revokes every key of the user and answers 401 invalid_api_key from then on', async () => {
    const f = await fx({ gitlab: { accessTokenTtlS: 60 } });
    const { controlKey, runtimeKey } = await loginViaHttp(f, ALICE.id);
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    f.gitlab.failRefresh = true;
    f.hub.directory.invalidate('101');
    const res = await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: { authorization: `Bearer ${controlKey}` } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_api_key' });
    // Both keys are gone, even before GitLab is consulted again.
    f.gitlab.failRefresh = false;
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${runtimeKey}` } })).status).toBe(401);
    expect((await fetch(`${f.hubUrl}/api/v1/wallet/balance`, { headers: { authorization: `Bearer ${controlKey}` } })).status).toBe(401);
    expect(await f.store.getOAuthGrant('101')).toBeNull();
    // A fresh login works again.
    const again = await loginViaHttp(f, ALICE.id);
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${again.controlKey}` } })).status).toBe(200);
  });

  it('a GitLab outage at refresh time answers 503 and keeps every key; the next request retries and succeeds', async () => {
    const f = await fx({ gitlab: { accessTokenTtlS: 60 } });
    const { controlKey, runtimeKey } = await loginViaHttp(f, ALICE.id);
    const auth = { authorization: `Bearer ${controlKey}` };
    f.clock.now = new Date(f.clock.now.getTime() + 120_000);
    f.hub.directory.invalidate('101');

    // 5xx from GitLab: transient.
    f.gitlab.refreshOutageStatus = 502;
    let res = await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'gitlab_unavailable' });
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: auth })).status).toBe(503);
    expect(await f.store.getOAuthGrant('101')).not.toBeNull();
    expect(await f.store.authenticate(controlKey, f.clock.now)).not.toBeNull();
    expect(await f.store.authenticate(runtimeKey, f.clock.now)).not.toBeNull();

    // GitLab unreachable entirely (connection refused): still transient.
    f.gitlab.refreshOutageStatus = null;
    await f.gitlab.stop();
    res = await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth });
    expect(res.status).toBe(503);
    expect(await f.store.getOAuthGrant('101')).not.toBeNull();

    // GitLab back: the same keys refresh and serve. Three refresh attempts reached the fake
    // (two answered 502 during the outage, then the successful retry); the refused connection never did.
    await f.gitlab.start();
    res = await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth });
    expect(res.status).toBe(200);
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${runtimeKey}` } })).status).toBe(200);
    expect(f.gitlab.requests.filter((r) => r.body.includes('grant_type=refresh_token'))).toHaveLength(3);
    const audit = (f.store as unknown as { audit?: Array<{ action: string }> }).audit ?? [];
    expect(audit.filter((a) => a.action === 'session_revoked')).toHaveLength(0);
  });

  it('a 401 from the GitLab API on a token the hub still trusts triggers one locked refresh + retry; a rejected refresh revokes', async () => {
    const f = await fx({ gitlab: { accessTokenTtlS: 7200 } });
    const { controlKey, runtimeKey } = await loginViaHttp(f, ALICE.id);
    const auth = { authorization: `Bearer ${controlKey}` };
    expect((await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth })).status).toBe(200);
    const refreshes = () => f.gitlab.requests.filter((r) => r.body.includes('grant_type=refresh_token')).length;
    expect(refreshes()).toBe(0);

    // GitLab revokes the access token server-side while access_expires_at is still in the future.
    f.gitlab.expireAccessTokens();
    f.hub.directory.invalidate('101');
    f.gitlab.groups.get(2000)!.full_name = 'Platform Renamed';
    const responses = await Promise.all([
      fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth }),
      fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(refreshes()).toBe(1);
    // The retry actually fetched from GitLab with the new token: the rename is visible, not the stale mirror.
    const { items } = await responses[0]!.json() as { items: Array<{ workspaceId: string; workspaceName: string }> };
    expect(items.find((i) => i.workspaceId === 'g2000')?.workspaceName).toBe('Platform Renamed');
    // The retry hit /api/v4 with the rotated token, never the rejected one again.
    const groupCalls = f.gitlab.requests.filter((r) => r.path.startsWith('/api/v4/groups?'));
    expect(new Set(groupCalls.map((r) => r.auth)).size).toBe(2);

    // Same situation but the refresh is rejected -> keys revoked, 401 invalid_api_key.
    f.gitlab.expireAccessTokens();
    f.gitlab.failRefresh = true;
    f.hub.directory.invalidate('101');
    const res = await fetch(`${f.hubUrl}/api/v1/workspaces`, { headers: auth });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_api_key' });
    expect(refreshes()).toBe(2);
    expect(await f.store.getOAuthGrant('101')).toBeNull();
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${runtimeKey}` } })).status).toBe(401);
  });
});

describe('od-vela login (in-process)', () => {
  it('prints the exact activation block, polls through pending/slow_down, writes config.json, and prints the success line', async () => {
    const f = await fx({ env: { HUB_PUBLIC_URL: 'https://hub.example.test' } });
    const home = tmpHome();
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      profiles: { prod: { controlKey: 'keep-me', apiUrl: 'https://amr-api.open-design.ai' } },
      somethingElse: true,
    }));
    const chunks: string[] = [];
    let opened: string | null = null;
    let polls = 0;
    const sleep = async () => {
      polls += 1;
      if (polls === 1) f.gitlab.slowDown(f.gitlab.latestUserCode(), 1);
      if (polls === 3) f.gitlab.approve(f.gitlab.latestUserCode(), ALICE.id);
      f.clock.now = new Date(f.clock.now.getTime() + 10_000);
    };
    const result = await runCli(['login'], { AMR_HOME: home, VELA_API_URL: f.hubUrl, VELA_PROFILE: 'selfhost' }, {
      io: { stdout: (t) => chunks.push(t), openBrowser: async (url) => { opened = url; }, sleep },
    });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const stdout = chunks.join('');
    const userCode = f.gitlab.latestUserCode();
    // First chunk is the whole activation block, emitted before any polling.
    expect(chunks[0]).toBe(`Open this URL to continue:\n${f.gitlab.url}/-/oauth/device?user_code=${userCode}\n\nCode: ${userCode}\n\n`);
    expect(chunks[chunks.length - 1]).toBe('Login successful for alice@example.test.\n');
    // apps/daemon/src/integrations/vela.ts:343-358
    const activation = parseVelaLoginActivation(stdout, result.stderr);
    expect(activation).toEqual({
      activationUrl: `${f.gitlab.url}/-/oauth/device?user_code=${userCode}`,
      userCode,
      browserOpenFailed: false,
    });
    expect(opened).toBe(activation.activationUrl);
    expect(polls).toBeGreaterThanOrEqual(3);

    const config = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as {
      profiles: Record<string, Record<string, unknown>>; somethingElse: boolean;
    };
    expect(config.somethingElse).toBe(true);
    expect(config.profiles.prod).toEqual({ controlKey: 'keep-me', apiUrl: 'https://amr-api.open-design.ai' });
    // vela.ts:393-399 VelaProfileShape; daemon flips loggedIn on runtimeKey (vela.ts:537-540)
    expect(config.profiles.selfhost).toEqual({
      controlKey: expect.stringMatching(/^odc_/),
      runtimeKey: expect.stringMatching(/^odr_/),
      apiUrl: 'https://hub.example.test',
      linkUrl: 'https://hub.example.test',
      user: { id: '101', email: 'alice@example.test', name: 'Alice Liddell', image: 'https://gitlab.example.test/alice.png', plan: 'team' },
    });
    expect(existsSync(path.join(home, 'config.json.tmp'))).toBe(false);
  });

  it('reports a browser-open failure on stderr in the daemon-recognised form and still succeeds', async () => {
    const f = await fx();
    const home = tmpHome();
    const err: string[] = [];
    const result = await runCli(['login'], { AMR_HOME: home, VELA_API_URL: f.hubUrl, VELA_PROFILE: 'selfhost' }, {
      io: {
        stdout: () => {},
        stderr: (t) => err.push(t),
        openBrowser: async () => { throw new Error('xdg-open: not found'); },
        sleep: async () => { f.gitlab.approve(f.gitlab.latestUserCode(), ALICE.id); f.clock.now = new Date(f.clock.now.getTime() + 5_000); },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(err.join('')).toBe('could not open browser automatically: xdg-open: not found\n');
    expect(parseVelaLoginActivation('', err.join('')).browserOpenFailed).toBe(true);
  });

  it('OD_VELA_OPEN_BROWSER=0 skips the launcher and prints the same daemon-recognised stderr line', async () => {
    const f = await fx();
    const home = tmpHome();
    const err: string[] = [];
    let opened = false;
    const result = await runCli(['login'], { AMR_HOME: home, VELA_API_URL: f.hubUrl, VELA_PROFILE: 'selfhost', OD_VELA_OPEN_BROWSER: '0' }, {
      io: {
        stdout: () => {},
        stderr: (t) => err.push(t),
        openBrowser: async () => { opened = true; },
        sleep: async () => { f.gitlab.approve(f.gitlab.latestUserCode(), ALICE.id); f.clock.now = new Date(f.clock.now.getTime() + 5_000); },
      },
    });
    expect(result.exitCode).toBe(0);
    expect(opened).toBe(false);
    expect(err.join('')).toBe('could not open browser automatically: disabled by OD_VELA_OPEN_BROWSER=0\n');
    expect(parseVelaLoginActivation('', err.join('')).browserOpenFailed).toBe(true);
  });

  it('denied approval -> exit 1 with the typed stderr line; nothing written to config.json', async () => {
    const f = await fx();
    const home = tmpHome();
    const result = await runCli(['login'], { AMR_HOME: home, VELA_API_URL: f.hubUrl, VELA_PROFILE: 'selfhost' }, {
      io: {
        openBrowser: async () => {},
        sleep: async () => { f.gitlab.deny(f.gitlab.latestUserCode()); f.clock.now = new Date(f.clock.now.getTime() + 5_000); },
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Error: login: API request failed with status 400: access_denied\n');
    expect(existsSync(path.join(home, 'config.json'))).toBe(false);
  });

  it('logout revokes the hub key and strips credentials from the profile but keeps endpoints', async () => {
    const f = await fx();
    const home = tmpHome();
    const { controlKey, runtimeKey } = await loginViaHttp(f, ALICE.id);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      profiles: { selfhost: { controlKey, runtimeKey, apiUrl: f.hubUrl, linkUrl: f.hubUrl, user: { id: '101', email: 'alice@example.test' } } },
    }));
    const result = await runCli(['logout'], { AMR_HOME: home, VELA_PROFILE: 'selfhost' }, { io: { openBrowser: async () => {} } });
    expect(result).toEqual({ stdout: 'Logged out.\n', stderr: '', exitCode: 0 });
    const config = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as { profiles: Record<string, unknown> };
    expect(config.profiles.selfhost).toEqual({ apiUrl: f.hubUrl, linkUrl: f.hubUrl });
    expect((await fetch(`${f.hubUrl}/api/v1/me`, { headers: { authorization: `Bearer ${controlKey}` } })).status).toBe(401);
  });

  it('ShimError shapes used by login stay on the daemon-safe grammar', () => {
    expect(ShimError.http('login', 400, 'access_denied').stderrLine).toBe('Error: login: API request failed with status 400: access_denied');
  });
});

describe('od-vela login (real process, as the daemon spawns it)', () => {
  const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'od-vela.mjs');
  const distPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'od-vela.mjs');
  const tsxEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'main.ts');

  /** Prefer the built bin (what VELA_BIN points at); fall back to tsx on source so the suite runs pre-build. */
  function spawnLogin(env: Record<string, string>) {
    const useDist = existsSync(distPath);
    const command = process.execPath;
    const args = useDist ? [binPath, 'login'] : ['--import', 'tsx', tsxEntry, 'login'];
    // stdin=ignore mirrors vela.ts:1329 (`stdio: ['ignore', 'pipe', 'pipe']`)
    return spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, PATH: '/nonexistent' /* no browser opener available */ },
    });
  }

  it('prints the URL within 10s, stays alive past 250ms, approves, writes AMR_HOME/config.json and exits 0', async () => {
    const f = await fx({ gitlab: { interval: 1 } });
    const home = tmpHome();
    // Real wall clock for this run: the hub's fake clock must not rewind poll pacing.
    f.clock.now = new Date();
    const tick = setInterval(() => { f.clock.now = new Date(); }, 20);
    try {
      const child = spawnLogin({ AMR_HOME: `${home}`, VELA_API_URL: f.hubUrl, VELA_PROFILE: 'selfhost' });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      const startedAt = Date.now();
      let exited: { code: number | null; at: number } | null = null;
      const closed = new Promise<void>((resolve) => child.once('close', (code) => { exited = { code, at: Date.now() }; resolve(); }));

      // URL within 10s
      const deadline = Date.now() + 10_000;
      while (!/Code:/.test(stdout) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      const activation = parseVelaLoginActivation(stdout, stderr);
      expect(activation.activationUrl).toBe(`${f.gitlab.url}/-/oauth/device?user_code=${f.gitlab.latestUserCode()}`);
      expect(activation.userCode).toBe(f.gitlab.latestUserCode());
      expect(exited).toBeNull();
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      // Process must not exit within 250ms of spawn (vela.ts waitForImmediateLoginFailure)
      if (Date.now() - startedAt < 260) await new Promise((r) => setTimeout(r, 260 - (Date.now() - startedAt)));
      expect(exited).toBeNull();

      f.gitlab.approve(f.gitlab.latestUserCode(), ALICE.id);
      await closed;
      expect(exited!.code).toBe(0);
      expect(stdout.trimEnd().split('\n').at(-1)).toBe('Login successful for alice@example.test.');
      // xdg-open is unavailable in this PATH: the only stderr is the daemon-recognised warning.
      expect(stderr).toMatch(/^could not open browser automatically: /);
      expect(stderr.split('\n').filter(Boolean)).toHaveLength(1);
      const config = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as { profiles: Record<string, { runtimeKey?: string }> };
      expect(config.profiles.selfhost?.runtimeKey).toMatch(/^odr_/);
    } finally {
      clearInterval(tick);
    }
  }, 30_000);

  it('honours a ~-prefixed AMR_HOME the way the daemon resolves it (vela.ts:415-421)', async () => {
    const f = await fx({ gitlab: { interval: 1 } });
    f.clock.now = new Date();
    const tick = setInterval(() => { f.clock.now = new Date(); }, 20);
    const fakeHomeRoot = tmpHome();
    const relative = `.od-hub-test-${process.pid}`;
    try {
      const child = spawnLogin({ HOME: fakeHomeRoot, AMR_HOME: `~/${relative}`, VELA_API_URL: f.hubUrl, VELA_PROFILE: 'selfhost' });
      let stdout = '';
      child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr!.on('data', () => {});
      const deadline = Date.now() + 10_000;
      while (!/Code:/.test(stdout) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      f.gitlab.approve(f.gitlab.latestUserCode(), ALICE.id);
      const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
      expect(code).toBe(0);
      expect(existsSync(path.join(fakeHomeRoot, relative, 'config.json'))).toBe(true);
    } finally {
      clearInterval(tick);
    }
  }, 30_000);
});

