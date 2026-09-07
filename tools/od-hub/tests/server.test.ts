import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveMemberId } from '../src/server/memory-store.js';
import type { HubServer } from '../src/server/http.js';
import type { MemoryHubStore } from '../src/server/memory-store.js';
import { HUB_CAPABILITIES } from '../src/shared/wire.js';
import {
  CONTROL_KEY,
  OTHER_KEY,
  PERSONAL_WORKSPACE,
  TEAM_WORKSPACE,
  authHeaders,
  readSseEvents,
  startHub,
} from './helpers.js';

let hub: HubServer;
let url: string;
let store: MemoryHubStore;

beforeEach(async () => {
  ({ hub, url, store } = await startHub());
});

afterEach(async () => {
  await hub.close();
});

describe('health', () => {
  it('GET /healthz is public', async () => {
    const res = await fetch(`${url}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; listenerEpoch: string };
    expect(body.ok).toBe(true);
    expect(body.listenerEpoch).toMatch(/^odhub-/);
  });
});

describe('authentication', () => {
  // vela-workspace-context.ts:858-905 — 401/403 on the directory means reauth.
  it('rejects a missing bearer with 401 {error:"invalid_api_key"}', async () => {
    const res = await fetch(`${url}/api/v1/workspaces`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_api_key' });
  });

  it('rejects an unknown bearer with the same 401 shape', async () => {
    const res = await fetch(`${url}/api/v1/workspaces`, { headers: authHeaders('nope') });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_api_key' });
  });

  it('rejects a revoked key', async () => {
    store.revokeKey(CONTROL_KEY);
    const res = await fetch(`${url}/api/v1/workspaces`, { headers: authHeaders() });
    expect(res.status).toBe(401);
  });

  it('accepts a case-insensitive Bearer scheme', async () => {
    const res = await fetch(`${url}/api/v1/workspaces`, { headers: { authorization: `bearer ${CONTROL_KEY}` } });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/v1/me', () => {
  it('returns the bearer owner as {user:{id,email,name?,image?,plan,balanceUsd}}', async () => {
    const res = await fetch(`${url}/api/v1/me`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    // vela.ts:238-250 VelaUser: extra fields are additive; image omitted when unknown
    expect(await res.json()).toEqual({ user: { id: 'u1', email: 'alice@example.test', name: 'Alice', plan: 'team', balanceUsd: '999999.00' } });
  });

  it('requires a bearer', async () => {
    const res = await fetch(`${url}/api/v1/me`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/workspaces', () => {
  it('returns the caller membership directory in WorkspaceDirectoryItem shape', async () => {
    const res = await fetch(`${url}/api/v1/workspaces`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([
      {
        workspaceId: PERSONAL_WORKSPACE,
        workspaceName: "Alice's workspace",
        workspaceType: 'personal',
        workspaceMemberId: deriveMemberId('u1', PERSONAL_WORKSPACE),
        role: 'owner',
        memberStatus: 'active',
        lifecycleState: 'active',
      },
      {
        workspaceId: TEAM_WORKSPACE,
        workspaceName: 'Design Team',
        workspaceIconKey: 'https://gitlab.example.test/avatar.png',
        workspaceType: 'team',
        workspaceMemberId: deriveMemberId('u1', TEAM_WORKSPACE),
        role: 'owner',
        memberStatus: 'active',
        lifecycleState: 'active',
      },
    ]);
    // routes/vela.ts:75 workspace id grammar
    for (const item of body.items) expect(item.workspaceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  });

  it('is per-user: another member sees only their own rows', async () => {
    const res = await fetch(`${url}/api/v1/workspaces`, { headers: authHeaders(OTHER_KEY) });
    const body = await res.json() as { items: Array<{ workspaceId: string; role: string; workspaceMemberId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.workspaceId).toBe(TEAM_WORKSPACE);
    expect(body.items[0]!.role).toBe('member');
    expect(body.items[0]!.workspaceMemberId).not.toBe(deriveMemberId('u1', TEAM_WORKSPACE));
  });

  it('surfaces removed membership as memberStatus=removed', async () => {
    store.removeMember('u2', TEAM_WORKSPACE);
    const res = await fetch(`${url}/api/v1/workspaces`, { headers: authHeaders(OTHER_KEY) });
    const body = await res.json() as { items: Array<{ memberStatus: string }> };
    expect(body.items[0]!.memberStatus).toBe('removed');
  });
});

describe('GET /api/v1/collab/events (SSE)', () => {
  it('emits ready with the five capabilities and listener status, then a heartbeat', async () => {
    const events = await readSseEvents(`${url}/api/v1/collab/events`, authHeaders(CONTROL_KEY, TEAM_WORKSPACE), 2);
    expect(events[0]!.event).toBe('ready');
    const ready = events[0]!.data as Record<string, unknown>;
    expect(ready.workspaceId).toBe(TEAM_WORKSPACE);
    expect(ready.capabilities).toEqual([...HUB_CAPABILITIES]);
    expect(new Set(ready.capabilities as string[])).toEqual(new Set([
      'billing-revision-clocks-v1',
      'workspace-member-events-v1',
      'workspace-event-listener-status-v1',
      'authoritative-project-presence-v1',
      'workspace-directory-events-v1',
    ]));
    // hub-events-subscriber.ts parseHubListenerStatusRecord
    expect(typeof ready.listenerEpoch).toBe('string');
    expect((ready.listenerEpoch as string).length).toBeGreaterThan(0);
    expect(ready.listenerHealth).toBe('healthy');
    expect(ready.sourceGap).toBe(false);

    expect(events[1]!.event).toBe('heartbeat');
    expect(events[1]!.data).toEqual({
      listenerEpoch: ready.listenerEpoch,
      listenerHealth: 'healthy',
      sourceGap: false,
    });
  });

  it('keeps heartbeating on the configured interval', async () => {
    const events = await readSseEvents(`${url}/api/v1/collab/events`, authHeaders(CONTROL_KEY, TEAM_WORKSPACE), 4);
    expect(events.map((e) => e.event)).toEqual(['ready', 'heartbeat', 'heartbeat', 'heartbeat']);
  });

  it('sets SSE headers including x-accel-buffering: no', async () => {
    const controller = new AbortController();
    const res = await fetch(`${url}/api/v1/collab/events`, { headers: authHeaders(CONTROL_KEY, TEAM_WORKSPACE), signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    controller.abort();
  });

  it('requires a valid x-vela-workspace-id', async () => {
    const res = await fetch(`${url}/api/v1/collab/events`, { headers: authHeaders() });
    expect(res.status).toBe(400);
    const bad = await fetch(`${url}/api/v1/collab/events`, { headers: authHeaders(CONTROL_KEY, 'bad id!') });
    expect(bad.status).toBe(400);
  });

  it('returns 403 workspace_not_authorized for a non-member', async () => {
    const res = await fetch(`${url}/api/v1/collab/events`, { headers: authHeaders(OTHER_KEY, PERSONAL_WORKSPACE) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'workspace_not_authorized' });
  });

  it('returns 401 without credentials', async () => {
    const res = await fetch(`${url}/api/v1/collab/events`, { headers: { 'x-vela-workspace-id': TEAM_WORKSPACE } });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/collab/sync-digest', () => {
  it('returns four string tokens; billingToken may be empty (sync-digest.ts:88-101)', async () => {
    const res = await fetch(`${url}/api/v1/collab/sync-digest`, { headers: authHeaders(CONTROL_KEY, TEAM_WORKSPACE) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['billingToken', 'catalogToken', 'contextToken', 'membersToken']);
    for (const key of ['catalogToken', 'membersToken', 'contextToken']) {
      expect(typeof body[key]).toBe('string');
      expect((body[key] as string).length).toBeGreaterThan(0);
    }
    expect(typeof body.billingToken).toBe('string');
  });

  it('requires workspace header and membership', async () => {
    expect((await fetch(`${url}/api/v1/collab/sync-digest`, { headers: authHeaders() })).status).toBe(400);
    expect((await fetch(`${url}/api/v1/collab/sync-digest`, { headers: authHeaders(OTHER_KEY, PERSONAL_WORKSPACE) })).status).toBe(403);
  });
});

describe('billing stubs', () => {
  it('GET /api/v1/wallet/balance returns a string balance (vela-wallet.ts:137-154)', async () => {
    const res = await fetch(`${url}/api/v1/wallet/balance`, { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { balanceUsd: string; updatedAt: string };
    expect(body.balanceUsd).toBe('999999.00');
    expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
  });

  it('GET /api/v1/billing/workspace-snapshot uses the directory member id', async () => {
    const res = await fetch(`${url}/api/v1/billing/workspace-snapshot`, { headers: authHeaders(CONTROL_KEY, TEAM_WORKSPACE) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      schemaVersion: 1,
      billingScopeVersion: 2,
      workspaceId: TEAM_WORKSPACE,
      workspaceMemberId: deriveMemberId('u1', TEAM_WORKSPACE),
      billing: { billingState: 'active', planId: 'team_plus' },
      wallet: { balanceUsd: '999999', expiresAt: null },
      revisions: { billing: '1', wallet: '1' },
    });
  });
});

describe('sinks and message center', () => {
  it('POST /api/v1/open-design/telemetry -> 202 (langfuse-trace.ts:2585-2660)', async () => {
    const res = await fetch(`${url}/api/v1/open-design/telemetry`, {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, events: [] }),
    });
    expect(res.status).toBe(202);
  });

  it('POST /api/v1/analytics/events -> 204 without auth (vela.ts:1782-1799 sends none)', async () => {
    const res = await fetch(`${url}/api/v1/analytics/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(204);
  });

  it('message-center endpoints return empty payloads (routes/vela.ts:341-404 allowlist)', async () => {
    const list = await fetch(`${url}/api/v1/message-center/messages`, { headers: authHeaders() });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ messages: [], nextCursor: null, unreadCount: 0 });
    const readAll = await fetch(`${url}/api/v1/message-center/read-all`, { method: 'POST', headers: authHeaders() });
    expect(readAll.status).toBe(200);
    const readOne = await fetch(`${url}/api/v1/message-center/messages/m1/read`, { method: 'POST', headers: authHeaders() });
    expect(await readOne.json()).toMatchObject({ ok: true, id: 'm1' });
    const pub = await fetch(`${url}/api/v1/message-center-public/messages`);
    expect(pub.status).toBe(200);
  });
});

describe('unknown routes', () => {
  it('returns typed 501 not_supported for unimplemented /api/v1 paths (never a bare 404)', async () => {
    const res = await fetch(`${url}/api/v1/resources/x/versions`, { method: 'POST', headers: authHeaders() });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: 'not_supported' });
  });

  it('returns 405 for a wrong method on a known path', async () => {
    const res = await fetch(`${url}/api/v1/workspaces`, { method: 'POST', headers: authHeaders() });
    expect(res.status).toBe(405);
  });
});
