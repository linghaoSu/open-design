import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/server/blob-store.js';
import { createHubServer, type HubServer } from '../src/server/http.js';
import { deriveMemberId, MemoryHubStore } from '../src/server/memory-store.js';
import { PULL_RECEIPT_TTL_MS } from '../src/server/resource-service.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore } from '../src/server/store.js';
import { manifestDigest, versionIdFor, type ManifestEntry } from '../src/shared/manifest.js';
import { parseHubWorkspaceEvent } from './daemon-parsers.js';
import { authHeaders, CONTROL_KEY, OTHER_KEY, readSseEvents, SEED, TEAM_WORKSPACE } from './helpers.js';

/**
 * The whole HTTP resource contract runs once per HubStore implementation so
 * a SQL-only regression (transaction scope, JSON columns, NULL handling)
 * cannot hide behind the memory store the other suites default to.
 */
const implementations: Array<[string, (now: () => Date) => HubStore]> = [
  ['MemoryHubStore', (now) => new MemoryHubStore({}, { now })],
  ['SqliteHubStore(:memory:)', (now) => new SqliteHubStore(':memory:', { now })],
];

/** Seed `SEED` through the public HubStore API so every implementation starts identical. */
async function seedStore(store: HubStore): Promise<void> {
  for (const user of SEED.users ?? []) {
    await store.createUser({ id: user.id, email: user.email, name: user.name });
    await store.issueApiKey({ userId: user.id, kind: 'control', secret: user.controlKey });
  }
  for (const workspace of SEED.workspaces ?? []) {
    await store.createWorkspace({ id: workspace.id, name: workspace.name, kind: workspace.kind, iconKey: workspace.iconKey ?? null });
    for (const member of workspace.members) await store.upsertMember({ workspaceId: workspace.id, userId: member.userId, role: member.role });
  }
}

describe.each(implementations)('%s over HTTP', (_name, makeStore) => {
let hub: HubServer;
let url: string;
let store: HubStore;
let tmp: string;
let clock = new Date('2026-09-08T10:00:00.000Z');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const entry = (p: string, content: string, mode = 0o644): ManifestEntry => ({ path: p, sha256: sha(content), size: Buffer.byteLength(content), mode });
const ALICE = deriveMemberId('u1', TEAM_WORKSPACE);
const BOB = deriveMemberId('u2', TEAM_WORKSPACE);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'od-hub-res-http-'));
  // Same clock for store rows and receipts so timestamps in replies are predictable.
  store = makeStore(() => clock);
  await seedStore(store);
  hub = createHubServer({ store, blobs: new BlobStore(path.join(tmp, 'blobs')), heartbeatIntervalMs: 50, now: () => clock });
  url = (await hub.listen(0)).url;
});

afterAll(async () => {
  await hub.close();
  await store.close();
  rmSync(tmp, { recursive: true, force: true });
});

const audit = async () => store.listAudit();

async function call(method: string, pathname: string, options: { key?: string; workspace?: string | null; body?: unknown; raw?: Buffer } = {}) {
  const headers: Record<string, string> = authHeaders(options.key ?? CONTROL_KEY, options.workspace === null ? undefined : (options.workspace ?? TEAM_WORKSPACE));
  let body: string | Buffer | undefined;
  if (options.raw) {
    body = options.raw;
    headers['content-type'] = 'application/octet-stream';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${url}${pathname}`, { method, headers, body });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, text };
}

async function putBlob(content: string, key = CONTROL_KEY) {
  return call('PUT', `/api/v1/blobs/${sha(content)}`, { raw: Buffer.from(content), key });
}

async function publish(kind: string, id: string, manifest: ManifestEntry[], extra: Record<string, unknown> = {}, key = CONTROL_KEY) {
  return call('POST', `/api/v1/resources/${kind}/${id}/versions`, { body: { manifest, ...extra }, key });
}

describe('blob endpoints', () => {
  it('require Bearer + active workspace membership', async () => {
    expect((await call('POST', '/api/v1/blobs/missing', { key: 'odc_bad', body: { sha256: [] } })).status).toBe(401);
    expect((await call('POST', '/api/v1/blobs/missing', { workspace: null, body: { sha256: [] } })).status).toBe(400);
    expect((await call('POST', '/api/v1/blobs/missing', { workspace: 'g999', body: { sha256: [] } })).body).toEqual({ error: 'workspace_not_authorized' });
    expect((await call('PUT', `/api/v1/blobs/${sha('x')}`, { raw: Buffer.from('x'), workspace: 'g999' })).status).toBe(403);
    expect((await call('GET', `/api/v1/blobs/${sha('x')}`, { workspace: 'g999' })).status).toBe(403);
  });

  it('missing -> put (digest verified) -> get round-trip, dedupe on second put', async () => {
    const digest = sha('blob body');
    expect((await call('POST', '/api/v1/blobs/missing', { body: { sha256: [digest] } })).body).toEqual({ missing: [digest] });
    expect((await call('POST', '/api/v1/blobs/missing', { body: { sha256: ['zz'] } })).body).toEqual({ error: 'invalid_sha256' });
    const bad = await call('PUT', `/api/v1/blobs/${digest}`, { raw: Buffer.from('other body') });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'blob_digest_mismatch' });
    expect((await call('POST', '/api/v1/blobs/missing', { body: { sha256: [digest] } })).body).toEqual({ missing: [digest] });
    const put = await putBlob('blob body');
    expect(put.status).toBe(201);
    expect(put.body).toEqual({ sha256: digest, size: 9 });
    expect((await putBlob('blob body')).status).toBe(200);
    expect((await call('POST', '/api/v1/blobs/missing', { body: { sha256: [digest] } })).body).toEqual({ missing: [] });
    const got = await fetch(`${url}/api/v1/blobs/${digest}`, { headers: authHeaders(OTHER_KEY, TEAM_WORKSPACE) });
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(await got.text()).toBe('blob body');
    expect((await call('GET', `/api/v1/blobs/${sha('never')}`)).body).toEqual({ error: 'blob_not_found' });
    expect((await call('PUT', '/api/v1/blobs/not-a-digest', { raw: Buffer.from('x') })).body).toEqual({ error: 'invalid_sha256' });
  });

  it('accepts a body larger than 8 MiB', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024, 1);
    const digest = createHash('sha256').update(big).digest('hex');
    const put = await call('PUT', `/api/v1/blobs/${digest}`, { raw: big });
    expect(put.status).toBe(201);
    expect(put.body).toEqual({ sha256: digest, size: big.length });
  });
});

describe('POST /api/v1/resources/:kind/:id/versions', () => {
  it('rejects a manifest referencing blobs the hub does not hold (409 blobs_missing) without creating a version', async () => {
    const result = await publish('plugin', 'pl-missing', [entry('a.txt', 'never uploaded 1')]);
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'blobs_missing' });
    expect((await call('GET', '/api/v1/resources/pl-missing/head?ref=published')).body).toEqual({ version: null, versionId: null });
    expect(await store.getResource(TEAM_WORKSPACE, 'pl-missing')).toBeNull();
  });

  it('validates kind, id, manifest, expectedVersion, metadata', async () => {
    expect((await publish('bogus', 'x', [])).body).toEqual({ error: 'invalid_resource_kind' });
    expect((await publish('plugin', 'has:colon', [])).body).toEqual({ error: 'invalid_resource_id' });
    expect((await call('POST', '/api/v1/resources/plugin/x/versions', { body: { manifest: 'nope' } })).body).toEqual({ error: 'invalid_manifest' });
    expect((await publish('plugin', 'x', [entry('../evil', 'e')])).body).toEqual({ error: 'invalid_manifest' });
    expect((await publish('plugin', 'x', [], { expectedVersion: -1 })).body).toEqual({ error: 'invalid_expected_version' });
    expect((await publish('plugin', 'x', [], { expectedVersion: 'one' })).body).toEqual({ error: 'invalid_expected_version' });
    expect((await publish('plugin', 'x', [], { metadata: [1] })).body).toEqual({ error: 'invalid_metadata' });
    expect((await publish('plugin', 'x', [], { manifestDigest: 'sha256:' + 'f'.repeat(64) })).body).toEqual({ error: 'manifest_digest_mismatch' });
  });

  it('publishes version 1 with CAS expectedVersion 0, computes digest + versionId, emits team-resources-changed and bumps catalogToken', async () => {
    await putBlob('css body');
    await putBlob('js body');
    const manifest = [entry('b/main.js', 'js body', 0o755), entry('a.css', 'css body')];
    const digestBefore = (await call('GET', '/api/v1/collab/sync-digest')).body!;
    const events = readSseEvents(`${url}/api/v1/collab/events`, authHeaders(OTHER_KEY, TEAM_WORKSPACE), 3);
    await new Promise((r) => setTimeout(r, 30));
    const result = await publish('plugin', 'pl-1', manifest, { expectedVersion: 0, metadata: { localId: 'x', title: 'X' } });
    expect(result.status).toBe(201);
    const digest = manifestDigest(manifest);
    expect(result.body).toEqual({
      version: 1,
      versionId: versionIdFor(1, digest),
      manifestDigest: digest,
      entryCount: 2,
      ownerMemberId: ALICE,
    });
    const frames = await events;
    const workspaceEvent = frames.find((f) => f.event === 'workspace-event');
    expect(workspaceEvent?.data).toMatchObject({ type: 'team-resources-changed', workspaceId: TEAM_WORKSPACE, resourceId: 'pl-1', resourceKind: 'plugin', resourceStatus: 'shared' });
    expect(parseHubWorkspaceEvent(JSON.stringify(workspaceEvent!.data))).not.toBeNull();
    const digestAfter = (await call('GET', '/api/v1/collab/sync-digest')).body!;
    expect(digestAfter.catalogToken).not.toBe(digestBefore.catalogToken);
    expect(digestAfter.membersToken).toBe(digestBefore.membersToken);
    expect((await audit()).some((a) => a.action === 'resource_publish' && a.target === 'pl-1')).toBe(true);

    const head = await call('GET', '/api/v1/resources/pl-1/head?ref=published', { key: OTHER_KEY });
    expect(head.body).toEqual({ version: 1, versionId: versionIdFor(1, digest) });
    expect((await call('GET', '/api/v1/resources/pl-1/head?ref=latest')).body).toEqual({ error: 'ref_not_found' });
    const manifestWire = await call('GET', `/api/v1/resources/pl-1/versions/${versionIdFor(1, digest)}/manifest`, { key: OTHER_KEY });
    expect(manifestWire.body).toMatchObject({ resourceId: 'pl-1', version: 1, manifestDigest: digest, entryCount: 2 });
    // Sorted by path: a.css before b/main.js; mode preserved.
    expect((manifestWire.body!.manifest as ManifestEntry[]).map((e) => [e.path, e.mode])).toEqual([['a.css', 0o644], ['b/main.js', 0o755]]);
    expect((await call('GET', '/api/v1/resources/pl-1/versions/published/manifest')).body).toMatchObject({ version: 1 });
    expect((await call('GET', '/api/v1/resources/pl-1/versions/v9-nope/manifest')).body).toEqual({ error: 'version_not_found' });
  });

  it('two-writer CAS: a stale expectedVersion answers 409 resource_version_conflict and leaves the published ref untouched', async () => {
    await putBlob('w1');
    await putBlob('w2');
    expect((await publish('skill', 'sk-cas', [entry('f', 'w1')], { expectedVersion: 0 })).status).toBe(201);
    // Both writers observed head = 1.
    const writerA = await publish('skill', 'sk-cas', [entry('f', 'w2')], { expectedVersion: 1 });
    expect(writerA.status).toBe(201);
    expect(writerA.body!.version).toBe(2);
    const writerB = await publish('skill', 'sk-cas', [entry('f', 'w1')], { expectedVersion: 1 });
    expect(writerB.status).toBe(409);
    expect(writerB.body).toEqual({ error: 'resource_version_conflict' });
    const head = await call('GET', '/api/v1/resources/sk-cas/head?ref=published');
    expect(head.body).toEqual({ version: 2, versionId: writerA.body!.versionId });
    expect(await store.getResourceVersion(TEAM_WORKSPACE, 'sk-cas', 3)).toBeNull();
    // Without expectedVersion the write is unconditional.
    expect((await publish('skill', 'sk-cas', [entry('f', 'w1')])).body).toMatchObject({ version: 3 });
  });

  it('a member cannot publish over another member\'s resource; the workspace owner can', async () => {
    await putBlob('m1');
    expect((await publish('plugin', 'pl-bob', [entry('f', 'm1')], {}, OTHER_KEY)).body).toMatchObject({ ownerMemberId: BOB });
    expect((await publish('plugin', 'pl-bob', [entry('f', 'm1')], {}, CONTROL_KEY)).body).toMatchObject({ version: 2, ownerMemberId: BOB });
    expect((await publish('plugin', 'pl-alice', [entry('f', 'm1')], {}, CONTROL_KEY)).status).toBe(201);
    expect((await publish('plugin', 'pl-alice', [entry('f', 'm1')], {}, OTHER_KEY)).body).toEqual({ error: 'resource_forbidden' });
    expect((await publish('skill', 'pl-alice', [entry('f', 'm1')], {}, CONTROL_KEY)).body).toEqual({ error: 'resource_kind_conflict' });
  });

  it('non-member / removed member -> 403 workspace_not_authorized', async () => {
    expect((await publish('plugin', 'x', [], {}, 'odc_unknown')).status).toBe(401);
    await store.createUser({ id: 'u3', email: 'c@example.test', name: 'Carol' });
    await store.issueApiKey({ userId: 'u3', kind: 'control', secret: 'odc_test_key_carol' });
    expect((await publish('plugin', 'x', [], {}, 'odc_test_key_carol')).body).toEqual({ error: 'workspace_not_authorized' });
    expect((await call('GET', '/api/v1/resources/shared', { key: 'odc_test_key_carol' })).body).toEqual({ error: 'workspace_not_authorized' });
    expect((await call('GET', '/api/v1/team-projects', { key: 'odc_test_key_carol' })).body).toEqual({ error: 'workspace_not_authorized' });
  });
});

describe('DELETE /api/v1/resources/:id (tombstone)', () => {
  it('is idempotent (second call {ok:true}, no event), gates every later call with 404, emits retracted for non-project kinds', async () => {
    await putBlob('t1');
    await publish('design_system', 'ds-1', [entry('DESIGN.md', 't1')]);
    const events = readSseEvents(`${url}/api/v1/collab/events`, authHeaders(OTHER_KEY, TEAM_WORKSPACE), 3);
    await new Promise((r) => setTimeout(r, 30));
    expect((await call('DELETE', '/api/v1/resources/ds-1')).body).toEqual({ ok: true });
    const frames = await events;
    expect(frames.find((f) => f.event === 'workspace-event')?.data).toMatchObject({ type: 'team-resources-changed', resourceId: 'ds-1', resourceKind: 'design_system', resourceStatus: 'retracted' });
    const again = await call('DELETE', '/api/v1/resources/ds-1');
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });
    // Only the first removal wrote an audit row / event.
    expect((await audit()).filter((a) => a.action === 'resource_remove' && a.target === 'ds-1')).toHaveLength(1);
    // PLAN §3.4 tombstone gate: head is resource-scoped, so it answers 404 (an unknown id still reads null/null).
    const head = await call('GET', '/api/v1/resources/ds-1/head?ref=published');
    expect(head.status).toBe(404);
    expect(head.body).toEqual({ error: 'resource_not_found' });
    expect((await call('GET', '/api/v1/resources/never-existed/head?ref=published')).body).toEqual({ version: null, versionId: null });
    expect((await call('GET', '/api/v1/resources/ds-1/versions/published/manifest')).body).toEqual({ error: 'resource_not_found' });
    expect((await publish('design_system', 'ds-1', [entry('DESIGN.md', 't1')])).body).toEqual({ error: 'resource_not_found' });
    expect(((await call('GET', '/api/v1/resources/shared')).body!.resources as Array<{ id: string }>).some((r) => r.id === 'ds-1')).toBe(false);
    expect((await call('DELETE', '/api/v1/resources/never-existed')).status).toBe(404);
    expect((await call('DELETE', '/api/v1/resources/never-existed')).body).toEqual({ error: 'resource_not_found' });
  });

  it('only the owner or a workspace admin may remove', async () => {
    await putBlob('t2');
    await publish('plugin', 'pl-bob-2', [entry('f', 't2')], {}, OTHER_KEY);
    await publish('plugin', 'pl-alice-2', [entry('f', 't2')], {}, CONTROL_KEY);
    expect((await call('DELETE', '/api/v1/resources/pl-alice-2', { key: OTHER_KEY })).body).toEqual({ error: 'resource_forbidden' });
    expect((await call('DELETE', '/api/v1/resources/pl-bob-2', { key: CONTROL_KEY })).body).toEqual({ ok: true });
  });
});

describe('GET /api/v1/resources/shared', () => {
  it('lists live resources of the workspace in the shape team-resource-share.ts parses', async () => {
    await putBlob('s1');
    const pub = await publish('skill', 'skill-g42-brief', [entry('SKILL.md', 's1')], { metadata: { localId: 'brief', title: 'Brief' } });
    const shared = await call('GET', '/api/v1/resources/shared', { key: OTHER_KEY });
    const row = (shared.body!.resources as Array<Record<string, unknown>>).find((r) => r.id === 'skill-g42-brief');
    expect(row).toEqual({
      id: 'skill-g42-brief',
      teamId: TEAM_WORKSPACE,
      kind: 'skill',
      ownerMemberId: ALICE,
      metadata: { localId: 'brief', title: 'Brief' },
      createdAt: clock.toISOString(),
      deletedAt: null,
      publishedVersion: { id: pub.body!.versionId, version: 1 },
    });
    // Personal workspace of u1 has nothing.
    expect((await call('GET', '/api/v1/resources/shared', { workspace: 'u1' })).body).toEqual({ resources: [] });
  });
});

describe('team-projects catalog', () => {
  it('upsert (owner fixed on first write) -> get/list -> events -> remove', async () => {
    await putBlob('p1');
    const pub = await publish('project', 'project-p1', [entry('index.html', 'p1')], { metadata: { projectId: 'p1' } });
    expect((await call('GET', '/api/v1/team-projects/p1')).body).toEqual({ error: 'team_project_not_found' });
    expect((await call('PUT', '/api/v1/team-projects/p1', { body: {} })).body).toEqual({ error: 'resource_id_required' });
    expect((await call('PUT', '/api/v1/team-projects/p1', { body: { resourceId: 'project-p1', syncState: 'weird' } })).body).toEqual({ error: 'invalid_sync_state' });

    const events = readSseEvents(`${url}/api/v1/collab/events`, authHeaders(OTHER_KEY, TEAM_WORKSPACE), 4);
    await new Promise((r) => setTimeout(r, 30));
    const created = await call('PUT', '/api/v1/team-projects/p1', {
      body: { resourceId: 'project-p1', displayName: 'Project One', syncState: 'synced', lastSyncedVersionId: pub.body!.versionId, metadata: { name: 'Project One', updatedAt: 1700000000000 } },
    });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({
      id: expect.stringMatching(/^tp_[0-9a-f]{24}$/),
      workspaceId: TEAM_WORKSPACE,
      projectId: 'p1',
      resourceId: 'project-p1',
      ownerMemberId: ALICE,
      displayName: 'Project One',
      syncState: 'synced',
      lastSyncedVersionId: pub.body!.versionId,
      publishedVersionId: pub.body!.versionId,
      metadata: { name: 'Project One', updatedAt: 1700000000000 },
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
      access: { canView: true, canComment: true, canEdit: true, frozen: false },
    });
    const updated = await call('PUT', '/api/v1/team-projects/p1', { body: { resourceId: 'project-p1', syncState: 'syncing' } });
    expect(updated.body).toMatchObject({ ownerMemberId: ALICE, displayName: 'Project One', syncState: 'syncing', id: created.body!.id });
    const frames = await events;
    const types = frames.filter((f) => f.event === 'workspace-event').map((f) => (f.data as { type: string; projectId?: string }));
    expect(types).toEqual([
      { type: 'team-projects-changed', workspaceId: TEAM_WORKSPACE, projectId: 'p1', at: clock.toISOString() },
      { type: 'project-metadata-changed', workspaceId: TEAM_WORKSPACE, projectId: 'p1', at: clock.toISOString() },
    ]);

    // Bob sees the row with canEdit false; Bob may not re-catalog Alice's project.
    const bobGet = await call('GET', '/api/v1/team-projects/p1', { key: OTHER_KEY });
    expect(bobGet.body).toMatchObject({ projectId: 'p1', access: { canEdit: false } });
    expect((await call('PUT', '/api/v1/team-projects/p1', { key: OTHER_KEY, body: { resourceId: 'project-p1' } })).body).toEqual({ error: 'team_project_forbidden' });
    const list = await call('GET', '/api/v1/team-projects', { key: OTHER_KEY });
    expect(list.body!.workspaceId).toBe(TEAM_WORKSPACE);
    expect((list.body!.projects as Array<{ projectId: string }>).map((p) => p.projectId)).toEqual(['p1']);

    // A later project publish routes to project-content-changed{projectId, version}.
    await putBlob('p1v2');
    const contentEvents = readSseEvents(`${url}/api/v1/collab/events`, authHeaders(OTHER_KEY, TEAM_WORKSPACE), 3);
    await new Promise((r) => setTimeout(r, 30));
    const v2 = await publish('project', 'project-p1', [entry('index.html', 'p1v2')], { expectedVersion: 1 });
    expect(v2.body).toMatchObject({ version: 2 });
    expect((await contentEvents).find((f) => f.event === 'workspace-event')?.data).toEqual({ type: 'project-content-changed', workspaceId: TEAM_WORKSPACE, projectId: 'p1', version: 2, at: clock.toISOString() });
    expect((await call('GET', '/api/v1/team-projects/p1')).body).toMatchObject({ publishedVersionId: v2.body!.versionId });

    expect((await call('DELETE', '/api/v1/team-projects/p1', { key: OTHER_KEY })).body).toEqual({ error: 'team_project_forbidden' });
    expect((await call('DELETE', '/api/v1/team-projects/p1')).body).toEqual({ ok: true });
    // Idempotent: the daemon's unshare path retries DELETE after a lost response and expects {ok:true} (vela-cli-team-projects.ts remove).
    // 5 frames = ready + ~4 heartbeats at 50 ms: enough of a window for a stray event to show up in.
    const removeEvents = readSseEvents(`${url}/api/v1/collab/events`, authHeaders(OTHER_KEY, TEAM_WORKSPACE), 5);
    await new Promise((r) => setTimeout(r, 30));
    const repeat = await call('DELETE', '/api/v1/team-projects/p1');
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual({ ok: true });
    const never = await call('DELETE', '/api/v1/team-projects/never-catalogued');
    expect(never.status).toBe(200);
    expect(never.body).toEqual({ ok: true });
    expect((await removeEvents).filter((f) => f.event === 'workspace-event')).toEqual([]);
    expect((await call('GET', '/api/v1/team-projects/p1')).body).toEqual({ error: 'team_project_not_found' });
    expect((await audit()).filter((a) => a.target === 'p1').map((a) => a.action)).toEqual(['team_project_create', 'team_project_update', 'team_project_remove']);
  });

  it('a catalog row whose resource is tombstoned reports publishedVersionId null (daemon hides it)', async () => {
    await putBlob('half');
    await publish('project', 'project-half', [entry('a', 'half')]);
    const defaulted = await call('PUT', '/api/v1/team-projects/half', { body: { resourceId: 'project-half' } });
    // e2e/lib/collab-hub-core/commands.ts: an omitted syncState is 'synced', not 'pending_upload'.
    expect(defaulted.body).toMatchObject({ syncState: 'synced' });
    await call('DELETE', '/api/v1/resources/project-half');
    expect((await call('GET', '/api/v1/team-projects/half')).body).toMatchObject({ projectId: 'half', publishedVersionId: null });
  });
});

describe('POST /api/v1/team-projects/:projectId/pull-authorization', () => {
  it('issues a 2000 ms single-use receipt for an active non-owner at the exact published version', async () => {
    await putBlob('recv');
    const pub = await publish('project', 'project-recv', [entry('index.html', 'recv'), entry('a/b.css', 'recv')], { metadata: { projectId: 'recv' } });
    await call('PUT', '/api/v1/team-projects/recv', { body: { resourceId: 'project-recv', syncState: 'synced', lastSyncedVersionId: pub.body!.versionId } });

    const owner = await call('POST', '/api/v1/team-projects/recv/pull-authorization', { body: { ref: 'published', expectedVersion: 1 } });
    expect(owner.status).toBe(409);
    expect(owner.body).toEqual({ error: 'authorized_team_project_pull_rejected' });
    expect((await call('POST', '/api/v1/team-projects/recv/pull-authorization', { key: OTHER_KEY, body: { ref: 'published', expectedVersion: 2 } })).body).toEqual({ error: 'authorized_team_project_pull_rejected' });
    expect((await call('POST', '/api/v1/team-projects/recv/pull-authorization', { key: OTHER_KEY, body: { ref: 'latest', expectedVersion: 1 } })).body).toEqual({ error: 'ref_not_found' });
    expect((await call('POST', '/api/v1/team-projects/recv/pull-authorization', { key: OTHER_KEY, body: { expectedVersion: 'x' } })).body).toEqual({ error: 'invalid_expected_version' });
    expect((await call('POST', '/api/v1/team-projects/nope/pull-authorization', { key: OTHER_KEY, body: { expectedVersion: 1 } })).body).toEqual({ error: 'team_project_not_found' });

    const result = await call('POST', '/api/v1/team-projects/recv/pull-authorization', { key: OTHER_KEY, body: { ref: 'published', expectedVersion: 1 } });
    expect(result.status).toBe(200);
    const receipt = result.body!;
    expect(receipt).toEqual({
      schemaVersion: 1,
      workspaceId: TEAM_WORKSPACE,
      resourceTeamId: TEAM_WORKSPACE,
      viewerMemberId: BOB,
      ownerMemberId: ALICE,
      projectId: 'recv',
      resourceId: 'project-recv',
      ref: 'published',
      version: 1,
      versionId: pub.body!.versionId,
      manifestDigest: pub.body!.manifestDigest,
      manifestEntryCount: 2,
      lifecycleState: 'active',
      authorizedAt: clock.toISOString(),
      expiresAt: new Date(clock.getTime() + PULL_RECEIPT_TTL_MS).toISOString(),
      nonce: expect.any(String),
    });
    expect(Date.parse(receipt.expiresAt as string) - Date.parse(receipt.authorizedAt as string)).toBe(2000);
    const stored = await store.getPullReceipt(receipt.nonce as string);
    expect(stored).toMatchObject({ viewerMemberId: BOB, ownerMemberId: ALICE, version: 1, consumedAt: null });
    expect(await store.consumePullReceipt(receipt.nonce as string)).toBe(true);
    expect(await store.consumePullReceipt(receipt.nonce as string)).toBe(false);
    expect((await audit()).some((a) => a.action === 'team_project_pull_authorize' && a.target === 'recv')).toBe(true);

    // Removed member: 403, never 401.
    await store.upsertMember({ workspaceId: TEAM_WORKSPACE, userId: 'u2', role: 'member', memberStatus: 'removed' });
    const removed = await call('POST', '/api/v1/team-projects/recv/pull-authorization', { key: OTHER_KEY, body: { expectedVersion: 1 } });
    expect(removed.status).toBe(403);
    expect(removed.body).toEqual({ error: 'workspace_not_authorized' });
    await store.upsertMember({ workspaceId: TEAM_WORKSPACE, userId: 'u2', role: 'member', memberStatus: 'active' });

    // After the resource moved on, the old version can no longer be authorized.
    await putBlob('recv2');
    await publish('project', 'project-recv', [entry('index.html', 'recv2')], { expectedVersion: 1 });
    expect((await call('POST', '/api/v1/team-projects/recv/pull-authorization', { key: OTHER_KEY, body: { expectedVersion: 1 } })).body).toEqual({ error: 'authorized_team_project_pull_rejected' });
    expect((await call('POST', '/api/v1/team-projects/recv/pull-authorization', { key: OTHER_KEY, body: { expectedVersion: 2 } })).status).toBe(200);
  });

  it('a tombstoned resource behind a catalog row answers resource_not_found', async () => {
    await putBlob('gone');
    await publish('project', 'project-gone', [entry('a', 'gone')]);
    await call('PUT', '/api/v1/team-projects/gone', { body: { resourceId: 'project-gone' } });
    await call('DELETE', '/api/v1/resources/project-gone');
    expect((await call('POST', '/api/v1/team-projects/gone/pull-authorization', { key: OTHER_KEY, body: { expectedVersion: 1 } })).body).toEqual({ error: 'resource_not_found' });
  });

  it('clock moves the receipt window', async () => {
    clock = new Date('2026-09-08T11:00:00.000Z');
    await putBlob('clk');
    await publish('project', 'project-clk', [entry('a', 'clk')]);
    await call('PUT', '/api/v1/team-projects/clk', { body: { resourceId: 'project-clk' } });
    const r = await call('POST', '/api/v1/team-projects/clk/pull-authorization', { key: OTHER_KEY, body: { expectedVersion: 1 } });
    expect(r.body).toMatchObject({ authorizedAt: '2026-09-08T11:00:00.000Z', expiresAt: '2026-09-08T11:00:02.000Z' });
  });
});
});
