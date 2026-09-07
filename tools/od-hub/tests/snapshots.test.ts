import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCli, type CliResult } from '../src/cli/shim.js';
import { BlobStore } from '../src/server/blob-store.js';
import { createHubServer, type HubServer } from '../src/server/http.js';
import { deriveMemberId, MemoryHubStore } from '../src/server/memory-store.js';
import { contentTypeFor, normalizePublicFilePath } from '../src/server/public-files.js';
import { SqliteHubStore } from '../src/server/sqlite-store.js';
import type { HubStore } from '../src/server/store.js';
import type { ManifestEntry } from '../src/shared/manifest.js';
import { API_FAILURE_LINE } from './daemon-parsers.js';
import { parseVelaResourceSnapshot, publicSnapshotFileUrl } from './daemon-invite-parsers.js';
import { authHeaders, CONTROL_KEY, OTHER_KEY, SEED, TEAM_WORKSPACE } from './helpers.js';

/**
 * Public snapshots end to end (collab-sync.ts:1237-1424 publish-public /
 * unpublish): `od-vela resource snapshot|snapshot-redact` argv and stdout as the
 * daemon parses them, the anonymous file route with its traversal / redact /
 * header guarantees, and the audit trail. Runs per HubStore implementation.
 */
const implementations: Array<[string, (now: () => Date) => HubStore]> = [
  ['MemoryHubStore', (now) => new MemoryHubStore({}, { now })],
  ['SqliteHubStore(:memory:)', (now) => new SqliteHubStore(':memory:', { now })],
];

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

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const entry = (p: string, content: string): ManifestEntry => ({ path: p, sha256: sha(content), size: Buffer.byteLength(content), mode: 0o644 });
const HTML = '<!doctype html><h1>Hello</h1><script>alert(1)</script>';
const CSS = 'body{color:red}';
const NESTED = 'nested text';

describe.each(implementations)('%s public snapshots', (_name, makeStore) => {
  let hub: HubServer;
  let url: string;
  let store: HubStore;
  let tmp: string;
  const clock = { now: new Date('2026-09-08T10:00:00.000Z') };
  const BOB = deriveMemberId('u2', TEAM_WORKSPACE);

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'od-hub-snap-'));
    store = makeStore(() => clock.now);
    await seedStore(store);
    hub = createHubServer({ store, blobs: new BlobStore(path.join(tmp, 'blobs')), heartbeatIntervalMs: 50, now: () => clock.now });
    url = (await hub.listen(0)).url;
  });

  afterAll(async () => {
    await hub.close();
    await store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const envFor = (key = CONTROL_KEY, workspace: string | null = TEAM_WORKSPACE) => ({
    VELA_API_URL: url,
    VELA_CONTROL_KEY: key,
    VELA_WORKSPACE_ID: workspace ?? undefined,
    AMR_HOME: path.join(tmp, 'amr'),
  });
  const run = (argv: string[], key = CONTROL_KEY, workspace: string | null = TEAM_WORKSPACE) => runCli(argv, envFor(key, workspace));

  function expectHttpError(result: CliResult, scope: string, status: number, code: string): void {
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(`Error: ${scope}: API request failed with status ${status}: ${code}\n`);
    expect(result.stderr.trim()).toMatch(API_FAILURE_LINE);
  }

  async function call(method: string, pathname: string, options: { key?: string; workspace?: string; body?: unknown; raw?: Buffer } = {}) {
    const headers: Record<string, string> = authHeaders(options.key ?? CONTROL_KEY, options.workspace ?? TEAM_WORKSPACE);
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
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function publishTree(resourceId: string, key = CONTROL_KEY): Promise<{ versionId: string }> {
    for (const content of [HTML, CSS, NESTED]) await call('PUT', `/api/v1/blobs/${sha(content)}`, { raw: Buffer.from(content), key });
    const manifest = [entry('index.html', HTML), entry('assets/site.css', CSS), entry('deep/er/file with space.txt', NESTED)];
    const res = await call('POST', `/api/v1/resources/project/${resourceId}/versions`, { body: { manifest, metadata: { source: 'open-design', projectId: 'p1', fileName: 'index.html' } }, key });
    expect(res.status).toBe(201);
    return { versionId: String(res.body!.versionId) };
  }

  const anon = (slug: string, filePath: string, headers: Record<string, string> = {}) =>
    fetch(publicSnapshotFileUrl(url, slug, filePath), { headers });

  it('resource snapshot: argv from collab-sync.ts:1312-1322 -> stdout parseVelaResourceSnapshot accepts; pins the published versionId', async () => {
    const { versionId } = await publishTree('pub-1');
    const result = await run(['resource', 'snapshot', 'pub-1', '--ref', 'published', '--name', 'index.html', '--json']);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const record = parseVelaResourceSnapshot(result.stdout);
    expect(record).toEqual({ slug: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), name: 'index.html', kind: 'project', versionId, createdAt: clock.now.toISOString() });
    const row = await store.getPublicSnapshot(record!.slug);
    expect(row).toMatchObject({ workspaceId: TEAM_WORKSPACE, resourceId: 'pub-1', versionId, name: 'index.html', kind: 'project', redactedAt: null });
    const audit = (await store.listAudit(TEAM_WORKSPACE)).filter((a) => a.action === 'snapshot_create');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: 'u1', target: record!.slug, details: { resourceId: 'pub-1', versionId } });

    // A later publish does not move the pin: the link still serves the old bytes.
    const v2Html = '<h1>v2</h1>';
    await call('PUT', `/api/v1/blobs/${sha(v2Html)}`, { raw: Buffer.from(v2Html) });
    expect((await call('POST', '/api/v1/resources/project/pub-1/versions', { body: { manifest: [entry('index.html', v2Html)], expectedVersion: 1 } })).status).toBe(201);
    const served = await anon(record!.slug, 'index.html');
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(HTML);
  });

  it('anonymous file route: content-type by extension, public cache, nosniff, ETag/304, nested + encoded paths', async () => {
    await publishTree('pub-2');
    const { slug } = parseVelaResourceSnapshot((await run(['resource', 'snapshot', 'pub-2', '--ref', 'published', '--name', 'n', '--json'])).stdout)!;
    const html = await anon(slug, 'index.html');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('cache-control')).toBe('public, max-age=300');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    expect(html.headers.get('content-length')).toBe(String(Buffer.byteLength(HTML)));
    expect(html.headers.get('etag')).toBe(`"${sha(HTML)}"`);
    expect(await html.text()).toBe(HTML);
    const css = await anon(slug, 'assets/site.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await css.text()).toBe(CSS);
    const nested = await anon(slug, 'deep/er/file with space.txt');
    expect(nested.status).toBe(200);
    expect(nested.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await nested.text()).toBe(NESTED);
    const cached = await anon(slug, 'index.html', { 'if-none-match': `"${sha(HTML)}"` });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('etag')).toBe(`"${sha(HTML)}"`);
    // No bearer, no workspace header: truly anonymous.
    expect(html.headers.get('www-authenticate')).toBeNull();
  });

  it('rejects traversal in every encoding, absolute paths, and unknown files; unknown slug is 404 not_found', async () => {
    await publishTree('pub-3');
    const { slug } = parseVelaResourceSnapshot((await run(['resource', 'snapshot', 'pub-3', '--ref', 'published', '--name', 'n', '--json'])).stdout)!;
    // `fetch` would normalise `..` and `%2e%2e` away client-side; send the exact bytes on a raw socket so the HUB is judged.
    const rawStatus = (tail: string) => new Promise<number>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(url).port) }, () => {
        socket.write(`GET /api/v1/public/snapshots/${slug}/files/${tail} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
      socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
      socket.on('error', reject);
    });
    // Every probe answers exactly like an unknown file (404 not_found): the
    // public tree never distinguishes "blocked" from "absent".
    for (const tail of ['../index.html', '..%2Findex.html', '%2e%2e/index.html', '%2e%2e%2findex.html', 'assets/../index.html', 'assets%2F..%2Findex.html', '%2Fetc/passwd', 'a%5Cb', 'index.html%00', '%zz', './index.html', 'assets//site.css', '']) {
      const status = await rawStatus(tail);
      expect(status, `tail=${tail}`).toBe(404);
    }
    const raw = (tail: string) => fetch(`${url}/api/v1/public/snapshots/${slug}/files/${tail}`);
    expect((await raw('missing.html')).status).toBe(404);
    expect(await (await raw('missing.html')).json()).toEqual({ error: 'not_found' });
    expect((await anon('x'.repeat(43), 'index.html')).status).toBe(404);
    expect((await anon('short', 'index.html')).status).toBe(404);
    // A directory prefix is not a file.
    expect((await anon(slug, 'assets')).status).toBe(404);
  });

  it('snapshot-redact: {ok:true}, idempotent, 404 after redact, cross-scope slugs are 404 snapshot_not_found', async () => {
    await publishTree('pub-4');
    await publishTree('pub-5');
    const { slug } = parseVelaResourceSnapshot((await run(['resource', 'snapshot', 'pub-4', '--ref', 'published', '--name', 'n', '--json'])).stdout)!;
    expect((await anon(slug, 'index.html')).status).toBe(200);
    // Wrong resource id for this slug: refused, still live.
    expectHttpError(await run(['resource', 'snapshot-redact', 'pub-5', slug, '--json']), 'resource snapshot-redact', 404, 'snapshot_not_found');
    expect((await anon(slug, 'index.html')).status).toBe(200);
    const redact = await run(['resource', 'snapshot-redact', 'pub-4', slug, '--json']);
    expect(redact.exitCode).toBe(0);
    expect(JSON.parse(redact.stdout)).toEqual({ ok: true });
    const gone = await anon(slug, 'index.html');
    expect(gone.status).toBe(404);
    expect(gone.headers.get('cache-control')).toBe('no-store');
    // Idempotent: second redact and an unknown slug are both ok (collab-sync.ts:1335 compensation).
    expect(JSON.parse((await run(['resource', 'snapshot-redact', 'pub-4', slug, '--json'])).stdout)).toEqual({ ok: true });
    expect(JSON.parse((await run(['resource', 'snapshot-redact', 'pub-4', 'w'.repeat(43), '--json'])).stdout)).toEqual({ ok: true });
    const audit = (await store.listAudit(TEAM_WORKSPACE)).filter((a) => a.action === 'snapshot_redact');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: 'u1', target: slug });
  });

  it('authorization: plain members snapshot only their own resources; owner/admin may snapshot anyone\'s; validation errors', async () => {
    await publishTree('pub-6');
    // Bob (member) cannot snapshot Alice's resource but can snapshot his own; Alice can redact Bob's.
    expectHttpError(await run(['resource', 'snapshot', 'pub-6', '--ref', 'published', '--name', 'n', '--json'], OTHER_KEY), 'resource snapshot', 403, 'resource_forbidden');
    await publishTree('bob-1', OTHER_KEY);
    const bobSnap = parseVelaResourceSnapshot((await run(['resource', 'snapshot', 'bob-1', '--ref', 'published', '--name', 'n', '--json'], OTHER_KEY)).stdout)!;
    expect((await store.listAudit(TEAM_WORKSPACE)).find((a) => a.target === bobSnap.slug)).toMatchObject({ actorMemberId: BOB });
    expect(JSON.parse((await run(['resource', 'snapshot-redact', 'bob-1', bobSnap.slug, '--json'])).stdout)).toEqual({ ok: true });
    // Unpublished / unknown / tombstoned resource, other ref, missing scope.
    expectHttpError(await run(['resource', 'snapshot', 'never-published', '--ref', 'published', '--name', 'n', '--json']), 'resource snapshot', 404, 'resource_not_found');
    expectHttpError(await run(['resource', 'snapshot', 'pub-6', '--ref', 'draft', '--name', 'n', '--json']), 'resource snapshot', 404, 'ref_not_found');
    const noScope = await run(['resource', 'snapshot', 'pub-6', '--ref', 'published', '--name', 'n', '--json'], CONTROL_KEY, null);
    expect(noScope.exitCode).toBe(2);
    expect(noScope.stderr).toContain('VELA_WORKSPACE_ID');
    const usage = await run(['resource', 'snapshot-redact', 'pub-6', '--json']);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toMatch(/^Error: resource snapshot-redact: usage/);
    // Direct HTTP: other workspace member cannot see the slug via redact, and a foreign workspace 403s.
    const snap = parseVelaResourceSnapshot((await run(['resource', 'snapshot', 'pub-6', '--ref', 'published', '--name', 'n', '--json'])).stdout)!;
    expect((await call('DELETE', `/api/v1/resources/pub-6/snapshots/${snap.slug}`, { workspace: 'g999' })).status).toBe(403);
    expect((await call('POST', '/api/v1/resources/pub-6/snapshots', { body: { ref: 'published', name: 'x' }, key: 'odc_bad' })).status).toBe(401);
  });
});

describe('public-files helpers', () => {
  it('contentTypeFor maps common extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('a/b.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('x.woff2')).toBe('font/woff2');
    expect(contentTypeFor('x.unknownext')).toBe('application/octet-stream');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });

  it('normalizePublicFilePath decodes per segment and rejects traversal / aliasing', () => {
    expect(normalizePublicFilePath('a/b%20c.txt')).toBe('a/b c.txt');
    expect(normalizePublicFilePath('%E4%BD%A0%E5%A5%BD.html')).toBe('你好.html');
    for (const bad of ['', '/a', 'a/../b', '%2e%2e/b', 'a%2Fb', 'a//b', './a', 'a\\b', 'a%5Cb', 'a%00', '%zz', '..']) {
      expect(normalizePublicFilePath(bad), bad).toBeNull();
    }
  });
});
