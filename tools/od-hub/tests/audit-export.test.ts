import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditEventWire } from '../src/cli/admin.js';
import { runCli } from '../src/cli/shim.js';
import { createHubServer, type HubServer } from '../src/server/http.js';
import { MemoryHubStore } from '../src/server/memory-store.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore } from '../src/server/store.js';
import { authHeaders, CONTROL_KEY, OTHER_KEY, SEED, TEAM_WORKSPACE } from './helpers.js';

/**
 * `GET /api/v1/admin/audit` and the `od-vela admin audit export` shim: who may
 * read, what they see, filters, cursor paging. Per HubStore implementation.
 */
const implementations: Array<[string, (now: () => Date) => HubStore]> = [
  ['MemoryHubStore', (now) => new MemoryHubStore({}, { now })],
  ['SqliteHubStore(:memory:)', (now) => new SqliteHubStore(':memory:', { now })],
];

const CAROL_KEY = 'odc_test_key_carol';

async function seedStore(store: HubStore): Promise<void> {
  for (const user of SEED.users ?? []) {
    await store.createUser({ id: user.id, email: user.email, name: user.name });
    await store.issueApiKey({ userId: user.id, kind: 'control', secret: user.controlKey });
  }
  // Carol: member of nothing but her own actions.
  await store.createUser({ id: 'u3', email: 'carol@example.test', name: 'Carol' });
  await store.issueApiKey({ userId: 'u3', kind: 'control', secret: CAROL_KEY });
  for (const workspace of SEED.workspaces ?? []) {
    await store.createWorkspace({ id: workspace.id, name: workspace.name, kind: workspace.kind, iconKey: workspace.iconKey ?? null });
    for (const member of workspace.members) await store.upsertMember({ workspaceId: workspace.id, userId: member.userId, role: member.role });
  }
  await store.createWorkspace({ id: 'g77', name: 'Elsewhere', kind: 'team' });
  await store.upsertMember({ workspaceId: 'g77', userId: 'u2', role: 'owner' });
}

describe.each(implementations)('%s audit export', (_name, makeStore) => {
  let hub: HubServer;
  let url: string;
  let store: HubStore;
  let tmp: string;
  const clock = { now: new Date('2026-09-08T10:00:00.000Z') };
  const HOUR = 60 * 60 * 1000;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'od-hub-audit-'));
    store = makeStore(() => clock.now);
    await seedStore(store);
    hub = createHubServer({ store, heartbeatIntervalMs: 50, now: () => clock.now });
    url = (await hub.listen(0)).url;
    const at = (h: number) => { clock.now = new Date(Date.parse('2026-09-08T10:00:00.000Z') + h * HOUR); };
    at(0); await store.appendAudit({ actorUserId: 'u1', workspaceId: TEAM_WORKSPACE, action: 'resource_publish', target: 'r1' });   // 1
    at(1); await store.appendAudit({ actorUserId: 'u2', workspaceId: TEAM_WORKSPACE, action: 'comment_create', target: 'c1' });     // 2
    at(2); await store.appendAudit({ actorUserId: 'u2', workspaceId: 'g77', action: 'resource_publish', target: 'r2' });            // 3
    at(3); await store.appendAudit({ actorUserId: 'u1', workspaceId: null, action: 'login', target: 'key_1' });                      // 4
    at(4); await store.appendAudit({ actorUserId: 'u3', workspaceId: null, action: 'login', target: 'key_3' });                      // 5
    at(5); await store.appendAudit({ actorUserId: 'u2', workspaceId: TEAM_WORKSPACE, action: 'resource_publish', target: 'r3', details: { version: 2 } }); // 6
    at(6);
  });

  afterAll(async () => {
    await hub.close();
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function get(query: string, key = CONTROL_KEY) {
    const res = await fetch(`${url}/api/v1/admin/audit${query}`, { headers: authHeaders(key) });
    return { status: res.status, body: (await res.json()) as { events?: AuditEventWire[]; nextCursor?: string | null; error?: string } };
  }
  const ids = (body: { events?: AuditEventWire[] }) => (body.events ?? []).map((e) => e.id);

  it('owner sees administered-workspace rows plus own actions; a plain member is 403 admin_required; anonymous 401', async () => {
    const alice = await get('');
    expect(alice.status).toBe(200);
    expect(ids(alice.body)).toEqual([1, 2, 4, 6]);
    expect(alice.body.nextCursor).toBeNull();
    expect(alice.body.events![0]).toEqual({ id: 1, at: '2026-09-08T10:00:00.000Z', actorUserId: 'u1', actorMemberId: null, workspaceId: TEAM_WORKSPACE, action: 'resource_publish', target: 'r1', details: null });
    expect(alice.body.events![3]!.details).toEqual({ version: 2 });
    // Bob administers g77 only (member in g42): g77 rows + his own actions anywhere.
    const bob = await get('', OTHER_KEY);
    expect(ids(bob.body)).toEqual([2, 3, 6]);
    const carol = await get('', CAROL_KEY);
    expect(carol.status).toBe(403);
    expect(carol.body).toEqual({ error: 'admin_required' });
    expect((await fetch(`${url}/api/v1/admin/audit`)).status).toBe(401);
  });

  it('filters compose (since, actor, action) and validation errors are typed', async () => {
    expect(ids((await get('?action=resource_publish')).body)).toEqual([1, 6]);
    expect(ids((await get('?actor=u2')).body)).toEqual([2, 6]);
    expect(ids((await get('?since=2026-09-08T13:00:00.000Z')).body)).toEqual([4, 6]);
    expect(ids((await get('?since=2026-09-08T13:00:00Z&action=login')).body)).toEqual([4]);
    expect((await get('?since=yesterday')).body).toEqual({ error: 'invalid_since' });
    expect((await get('?limit=0')).body).toEqual({ error: 'invalid_limit' });
    expect((await get('?limit=1001')).body).toEqual({ error: 'invalid_limit' });
    expect((await get('?cursor=!!!')).body).toEqual({ error: 'invalid_cursor' });
  });

  it('cursor paging is stable and terminates', async () => {
    const page1 = await get('?limit=3');
    expect(ids(page1.body)).toEqual([1, 2, 4]);
    expect(page1.body.nextCursor).toEqual(expect.any(String));
    const page2 = await get(`?limit=3&cursor=${encodeURIComponent(page1.body.nextCursor!)}`);
    expect(ids(page2.body)).toEqual([6]);
    expect(page2.body.nextCursor).toBeNull();
    // Exactly `limit` rows left: no phantom next page.
    const exact = await get('?limit=4');
    expect(ids(exact.body)).toEqual([1, 2, 4, 6]);
    expect(exact.body.nextCursor).toBeNull();
  });

  describe('od-vela admin audit export', () => {
    const envFor = (key = CONTROL_KEY) => ({ VELA_API_URL: url, VELA_CONTROL_KEY: key, AMR_HOME: path.join(tmp, 'amr') });

    it('--json pages through every row and prints one {events, count} object; no workspace header needed', async () => {
      const result = await runCli(['admin', 'audit', 'export', '--limit', '2', '--json'], envFor());
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as { events: AuditEventWire[]; count: number };
      expect(parsed.count).toBe(4);
      expect(parsed.events.map((e) => e.id)).toEqual([1, 2, 4, 6]);
    });

    it('--since/--action forward as query filters; plain output is one line per event', async () => {
      const result = await runCli(['admin', 'audit', 'export', '--since', '2026-09-08T13:00:00Z', '--action', 'login'], envFor());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('2026-09-08T13:00:00.000Z login u1 - key_1\n');
      const bad = await runCli(['admin', 'audit', 'export', '--since', 'nope'], envFor());
      expect(bad.exitCode).toBe(2);
      expect(bad.stderr).toBe('Error: admin audit export: --since must be an ISO-8601 timestamp\n');
    });

    it('a non-admin gets the typed 403 line; unknown admin verbs are typed 501', async () => {
      const result = await runCli(['admin', 'audit', 'export', '--json'], envFor(CAROL_KEY));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('Error: admin audit export: API request failed with status 403: admin_required\n');
      const other = await runCli(['admin', 'users', 'list'], envFor());
      expect(other.stderr).toBe('Error: admin users list: API request failed with status 501: not_supported\n');
    });
  });
});
