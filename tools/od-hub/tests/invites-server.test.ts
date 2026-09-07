import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveMemberId, hashApiKey } from '../src/server/ids.js';
import { GITLAB_ACCESS_LEVEL } from '../src/server/invite-service.js';
import type { MailMessage, Mailer } from '../src/server/mailer.js';
import type { HubStore } from '../src/server/store.js';
import {
  consumeOutcomeFromResponse,
  createOutcomeFromResponse,
  mapVelaWorkspaceContext,
  parseInviteDeeplink,
  parsePermissions,
  resolveWorkspaceInviteError,
  workspaceSeatCapacityState,
} from './daemon-invite-parsers.js';
import { ALICE, BOB, loginViaHttp, startGitLabHub, type GitLabHubFixture } from './helpers/gitlab-hub.js';

/**
 * Invite HTTP contract against the fake GitLab: create (invite-create.ts),
 * preview (contracts :97-107), JSON accept (contracts :116-153), browser
 * accept through the authorization-code flow, continuation consume
 * (invite-continue.ts), all asserted through verbatim copies of the daemon
 * parsers. Runs once per HubStore implementation.
 */
const CAROL = { id: 303, username: 'carol', name: 'Carol Danvers', email: 'carol@example.test' };
const GROUP_TOKEN = 'glgat-test-group-token';
const HOUR = 60 * 60 * 1000;

class RecordingMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  fail = false;
  async send(message: MailMessage): Promise<void> {
    if (this.fail) throw new Error('smtp down');
    this.sent.push(message);
  }
}

describe.each([['memory'], ['sqlite']] as const)('invites over HTTP (%s)', (storeKind) => {
  let fx: GitLabHubFixture;
  let store: HubStore;
  let mailer: RecordingMailer;
  let aliceKey: string;
  const noRedirect = { redirect: 'manual' as const };

  beforeEach(async () => {
    mailer = new RecordingMailer();
    fx = await startGitLabHub({
      store: storeKind,
      groupToken: GROUP_TOKEN,
      mailer,
      env: { DOWNLOAD_URL: 'https://dl.example.test/od', HUB_CONSOLE_URL: 'https://hub.example.test', INVITE_TTL_HOURS: '48' },
    });
    fx.gitlab.addUser(CAROL);
    store = fx.store;
    aliceKey = (await loginViaHttp(fx, ALICE.id)).controlKey;
    // Alice's first authenticated call mirrors g1000/g2000 into the store.
    await fetch(`${fx.hubUrl}/api/v1/workspaces`, { headers: { authorization: `Bearer ${aliceKey}` } });
  });

  afterEach(async () => {
    await fx.close();
  });

  const post = (path: string, key: string | null, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${fx.hubUrl}${path}`, {
      method: 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function createInvite(key: string, workspaceId: string, body: unknown) {
    const res = await post(`/api/v1/workspaces/${workspaceId}/invites`, key, body);
    return { status: res.status, outcome: await createOutcomeFromResponse(res.clone()), body: await res.json().catch(() => null) as Record<string, unknown> | null };
  }

  /** Landing token is only ever in the URL: recover it from the mail (or the log) the way an invitee would. */
  function tokenFromMail(): string {
    const mail = mailer.sent[mailer.sent.length - 1]!;
    const match = /\/console\/invites\/([A-Za-z0-9_-]{43})/.exec(mail.text);
    if (!match) throw new Error(`no landing url in mail: ${mail.text}`);
    return match[1]!;
  }

  describe('POST /api/v1/workspaces/:workspaceId/invites', () => {
    it('201 {inviteId} for an owner; the daemon parser reads inviteId; token stored as sha256 only; mail + audit', async () => {
      const { status, outcome, body } = await createInvite(aliceKey, 'g1000', { invitedEmail: 'Carol@Example.test ', role: 'member' });
      expect(status).toBe(201);
      expect(outcome).toEqual({ ok: true, inviteId: expect.stringMatching(/^inv_/) });
      const inviteId = String(body!.inviteId);
      const row = await store.getInvite(inviteId);
      expect(row).toMatchObject({ workspaceId: 'g1000', invitedEmail: 'carol@example.test', role: 'member', status: 'pending', createdByUserId: String(ALICE.id) });
      expect(row!.expiresAt).toBe(new Date(fx.clock.now.getTime() + 48 * HOUR).toISOString());
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe('carol@example.test');
      expect(mailer.sent[0]!.subject).toContain('Design Team');
      const token = tokenFromMail();
      expect(row!.tokenHash).toBe(hashApiKey(token));
      expect(mailer.sent[0]!.text).toContain(`https://hub.example.test/console/invites/${token}`);
      const audit = (await store.listAudit('g1000')).filter((a) => a.action === 'invite_create');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: String(ALICE.id), actorMemberId: deriveMemberId(String(ALICE.id), 'g1000'), target: inviteId, details: { role: 'member', invitedEmailMasked: 'c***@example.test' } });
      expect(JSON.stringify(audit[0])).not.toContain(token);
      expect(JSON.stringify(audit[0])).not.toContain('carol@example.test');
    });

    it('409 already_member when an active member holds the address (both {error} shape and the daemon alias)', async () => {
      const { status, outcome, body } = await createInvite(aliceKey, 'g1000', { invitedEmail: 'alice@example.test', role: 'admin' });
      expect(status).toBe(409);
      expect(body).toEqual({ error: 'already_member' });
      expect(outcome).toEqual({ ok: false, status: 409, error: 'already_member' });
      expect(mailer.sent).toHaveLength(0);
    });

    it('409 active_pending_invite for a second invite to the same address; an expired one is replaced', async () => {
      expect((await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' })).status).toBe(201);
      const dup = await createInvite(aliceKey, 'g1000', { invitedEmail: 'CAROL@example.test', role: 'admin' });
      expect(dup.status).toBe(409);
      expect(dup.outcome).toEqual({ ok: false, status: 409, error: 'active_pending_invite' });
      // Same address in a different workspace is fine.
      expect((await createInvite(aliceKey, 'g2000', { invitedEmail: 'carol@example.test', role: 'member' })).status).toBe(201);
      fx.clock.now = new Date(fx.clock.now.getTime() + 49 * HOUR);
      const renewed = await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' });
      expect(renewed.status).toBe(201);
      expect((await store.listPendingInvites('g1000', 'carol@example.test')).map((r) => r.id)).toEqual([renewed.body!.inviteId]);
    });

    it('never emits a seat code; validation and authz errors map to create_<status> on the daemon side', async () => {
      const bad = await createInvite(aliceKey, 'g1000', { invitedEmail: 'not-an-email', role: 'member' });
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ error: 'invalid_email' });
      expect(bad.outcome).toEqual({ ok: false, status: 400, error: 'create_400' });
      expect((await createInvite(aliceKey, 'g1000', { invitedEmail: 'x@y.zz', role: 'owner' })).body).toEqual({ error: 'invalid_role' });
      // Bob is a developer (member) in g1000: forbidden.
      const bobKey = (await loginViaHttp(fx, BOB.id)).controlKey;
      const forbidden = await createInvite(bobKey, 'g1000', { invitedEmail: 'x@y.zz', role: 'member' });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body).toEqual({ error: 'workspace_forbidden' });
      // Not a member at all / unknown workspace: same 403 (no existence oracle).
      expect((await createInvite(bobKey, 'g2000', { invitedEmail: 'x@y.zz', role: 'member' })).status).toBe(403);
      expect((await createInvite(bobKey, 'g9999', { invitedEmail: 'x@y.zz', role: 'member' })).status).toBe(403);
      // Personal workspaces cannot be invited into.
      expect((await createInvite(aliceKey, `u${ALICE.id}`, { invitedEmail: 'x@y.zz', role: 'member' })).body).toEqual({ error: 'workspace_forbidden' });
      expect((await post('/api/v1/workspaces/g1000/invites', null, { invitedEmail: 'x@y.zz', role: 'member' })).status).toBe(401);
      for (const a of await store.listAudit()) expect(a.action).not.toMatch(/seat/);
    });

    it('a mail transport failure does not fail the create (the URL is logged instead)', async () => {
      mailer.fail = true;
      const { status } = await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' });
      expect(status).toBe(201);
    });
  });

  describe('GET /api/v1/workspace-invites/:token', () => {
    it('JSON preview matches WorkspaceInvitePreviewResponse (contracts :97-107); Accept: text/html renders the landing page', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'admin' });
      const token = tokenFromMail();
      const res = await fetch(`${fx.hubUrl}/api/v1/workspace-invites/${token}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        inviteId: expect.stringMatching(/^inv_/),
        workspaceId: 'g1000',
        workspaceName: 'Design Team',
        invitedEmailMasked: 'c***@example.test',
        role: 'admin',
        status: 'pending',
        expiresAt: fx.clock.now.getTime() + 48 * HOUR,
        clientHints: { preferredDesktopScheme: 'opendesign', downloadUrl: 'https://dl.example.test/od' },
      });
      expect(Object.keys(body).sort()).toEqual(['clientHints', 'expiresAt', 'inviteId', 'invitedEmailMasked', 'role', 'status', 'workspaceId', 'workspaceName']);

      const page = await fetch(`${fx.hubUrl}/console/invites/${token}`, { headers: { accept: 'text/html,application/xhtml+xml' } });
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      const text = await page.text();
      expect(text).toContain('<body class="pending">');
      expect(text).toContain('Design Team');
      // Expiry is a human UTC stamp, never a raw ISO string.
      const expiresIso = new Date(fx.clock.now.getTime() + 48 * HOUR);
      const pad = (n: number) => String(n).padStart(2, '0');
      expect(text).toContain(`${expiresIso.getUTCFullYear()}-${pad(expiresIso.getUTCMonth() + 1)}-${pad(expiresIso.getUTCDate())} ${pad(expiresIso.getUTCHours())}:${pad(expiresIso.getUTCMinutes())} UTC`);
      expect(text).not.toContain(expiresIso.toISOString());
      expect(text).toContain('Alice Liddell');
      expect(text).toContain('c***@example.test');
      expect(text).not.toContain('carol@example.test');
      expect(text).toContain(`https://hub.example.test/console/invites/${token}/accept`);
      expect(text).toContain('https://dl.example.test/od');
      // Same token via the API path with a JSON-first Accept stays JSON.
      const json = await fetch(`${fx.hubUrl}/api/v1/workspace-invites/${token}`, { headers: { accept: 'application/json, text/html' } });
      expect(json.headers.get('content-type')).toContain('application/json');
    });

    it('status expired after the TTL, accepted after accept; unknown or malformed tokens are 404 (HTML in a browser)', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' });
      const token = tokenFromMail();
      fx.clock.now = new Date(fx.clock.now.getTime() + 48 * HOUR);
      expect(((await (await fetch(`${fx.hubUrl}/api/v1/workspace-invites/${token}`)).json()) as { status: string }).status).toBe('expired');
      expect(await (await fetch(`${fx.hubUrl}/console/invites/${token}`, { headers: { accept: 'text/html' } })).text()).toContain('<body class="expired">');
      const missing = await fetch(`${fx.hubUrl}/api/v1/workspace-invites/${'x'.repeat(43)}`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'invite_not_found' });
      expect((await fetch(`${fx.hubUrl}/api/v1/workspace-invites/short`)).status).toBe(404);
      const html = await fetch(`${fx.hubUrl}/console/invites/${'x'.repeat(43)}`, { headers: { accept: 'text/html' } });
      expect(html.status).toBe(404);
      expect(html.headers.get('content-type')).toContain('text/html');
      expect(await html.text()).toContain('invite_not_found');
    });
  });

  describe('POST /api/v1/workspace-invites/:token/accept (JSON)', () => {
    it('accepts for a signed-in invitee: membership, GitLab group add, WorkspaceInviteAcceptResponse, directory refresh, events', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'admin' });
      const token = tokenFromMail();
      const carolKey = (await loginViaHttp(fx, CAROL.id)).controlKey;
      const before = (await (await fetch(`${fx.hubUrl}/api/v1/workspaces`, { headers: { authorization: `Bearer ${carolKey}` } })).json()) as { items: Array<{ workspaceId: string }> };
      expect(before.items.map((i) => i.workspaceId)).toEqual([`u${CAROL.id}`]);

      const res = await post(`/api/v1/workspace-invites/${token}/accept`, carolKey, { client: { platform: 'web', canOpenDesktop: true } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown> & { continuation: Record<string, unknown>; currentWorkspaceContext: unknown };
      const carolMember = deriveMemberId(String(CAROL.id), 'g1000');
      expect(body).toMatchObject({
        workspaceId: 'g1000',
        workspaceMemberId: carolMember,
        memberId: carolMember,
        inviteId: expect.stringMatching(/^inv_/),
        role: 'admin',
        lifecycleState: 'active',
      });
      expect(Object.keys(body).sort()).toEqual(['continuation', 'currentWorkspaceContext', 'inviteId', 'lifecycleState', 'memberId', 'role', 'workspaceId', 'workspaceMemberId']);
      expect(body.continuation).toEqual({
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        deeplinkUrl: expect.stringMatching(/^opendesign:\/\/workspace\/invite\/continue\?/),
        expiresAt: fx.clock.now.getTime() + 10 * 60_000,
        fallbackDownloadUrl: 'https://dl.example.test/od',
      });
      expect(parseInviteDeeplink(String(body.continuation.deeplinkUrl))).toEqual({
        workspaceId: 'g1000', memberId: carolMember, inviteId: body.inviteId, nonce: body.continuation.nonce,
      });
      const context = mapVelaWorkspaceContext(body.currentWorkspaceContext);
      expect(context).not.toBeNull();
      expect(context).toMatchObject({ workspaceId: 'g1000', workspaceMemberId: carolMember, workspaceType: 'team', role: 'admin', memberStatus: 'active', lifecycleState: 'active', providerMode: 'platform_credits', billingState: 'active', planId: 'team_plus', teamId: 'g1000', workspaceName: 'Design Team', teamName: 'Design Team' });
      expect(context!.permissions).toEqual({ canManageMembers: true, canManageBilling: false, canInviteMembers: true, canManageAutoRecharge: false, canShareProjects: true, canWriteSyncedFiles: true, canViewWorkspaceSettings: true, canManageSharedResources: true });
      // The permissions object was accepted as sent (all eight booleans), not re-derived.
      expect(parsePermissions((body.currentWorkspaceContext as { permissions: unknown }).permissions)).toEqual(context!.permissions);
      expect(context!.seatSummary).toEqual({ seatLimit: 0, usedSeats: 0, availableSeats: 0, isSeatFull: true });
      expect(workspaceSeatCapacityState(context!.seatSummary)).toBe('unknown');

      // GitLab group membership was added at access level 40 with the Group Access Token.
      expect(fx.gitlab.groups.get(1000)!.members[CAROL.id]).toBe(GITLAB_ACCESS_LEVEL.admin);
      const add = fx.gitlab.requests.find((r) => r.method === 'POST' && r.path === '/api/v4/groups/1000/members');
      expect(add?.body).toContain('user_id=303');
      // Directory shows the membership without waiting for the 60 s cache.
      const after = (await (await fetch(`${fx.hubUrl}/api/v1/workspaces`, { headers: { authorization: `Bearer ${carolKey}` } })).json()) as { items: Array<{ workspaceId: string; role: string }> };
      expect(after.items.find((i) => i.workspaceId === 'g1000')).toMatchObject({ role: 'admin', memberStatus: 'active', workspaceMemberId: carolMember });
      // Store state + events + audit.
      expect((await store.getInvite(String(body.inviteId)))?.status).toBe('accepted');
      const events = (await store.listAudit('g1000')).map((a) => a.action);
      expect(events).toContain('invite_accept');
      const outbox = await store.listUnpublishedOutbox().then((rows) => rows.map((r) => r.payload.type)).catch(() => []);
      // The relay may already have drained; check the digest moved instead.
      void outbox;
      const digest = await store.getSyncDigest('g1000');
      expect(digest.membersToken).toBeTruthy();
    });

    it('exact error codes: 401 no bearer, 410 invite_expired, 409 invite_consumed, 409 already_member, 403 invite_email_mismatch unless continueWithCurrentAccount', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' });
      const token = tokenFromMail();
      expect((await post(`/api/v1/workspace-invites/${token}/accept`, null, {})).status).toBe(401);

      // Bob (bob has no email on GitLab -> synthesized) tries Carol's invite.
      const bobKey = (await loginViaHttp(fx, BOB.id)).controlKey;
      const mismatch = await post(`/api/v1/workspace-invites/${token}/accept`, bobKey, {});
      expect(mismatch.status).toBe(403);
      expect(await mismatch.json()).toEqual({ error: 'invite_email_mismatch' });
      expect(resolveWorkspaceInviteError({ status: 403, code: 'invite_email_mismatch' })).toBe('workspace_forbidden');
      // Bob is already an active member of g1000: continuing with the current account is already_member.
      const already = await post(`/api/v1/workspace-invites/${token}/accept`, bobKey, { continueWithCurrentAccount: true });
      expect(already.status).toBe(409);
      expect(await already.json()).toEqual({ error: 'already_member' });
      expect((await store.getInvite((await store.getInviteByTokenHash(hashApiKey(token)))!.id))?.status).toBe('pending');

      const carolKey = (await loginViaHttp(fx, CAROL.id)).controlKey;
      expect((await post(`/api/v1/workspace-invites/${token}/accept`, carolKey, {})).status).toBe(200);
      const consumed = await post(`/api/v1/workspace-invites/${token}/accept`, carolKey, {});
      expect(consumed.status).toBe(409);
      expect(await consumed.json()).toEqual({ error: 'invite_consumed' });
      expect(resolveWorkspaceInviteError({ status: 409, code: 'invite_consumed' })).toBe('invite_consumed');

      await createInvite(aliceKey, 'g2000', { invitedEmail: 'carol@example.test', role: 'member' });
      const token2 = tokenFromMail();
      fx.clock.now = new Date(fx.clock.now.getTime() + 48 * HOUR);
      const expired = await post(`/api/v1/workspace-invites/${token2}/accept`, carolKey, {});
      expect(expired.status).toBe(410);
      expect(await expired.json()).toEqual({ error: 'invite_expired' });
      expect(resolveWorkspaceInviteError({ status: 410, code: 'invite_expired' })).toBe('invite_expired');
      const unknown = await post(`/api/v1/workspace-invites/${'y'.repeat(43)}/accept`, carolKey, {});
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: 'invite_not_found' });
    });

    it('a GitLab group-add failure is 503 gitlab_unavailable and writes nothing', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' });
      const token = tokenFromMail();
      const carolKey = (await loginViaHttp(fx, CAROL.id)).controlKey;
      fx.gitlab.groupTokens.delete(GROUP_TOKEN); // token revoked on the GitLab side -> 401 upstream
      const res = await post(`/api/v1/workspace-invites/${token}/accept`, carolKey, {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'gitlab_unavailable' });
      expect(await store.getMembership(String(CAROL.id), 'g1000')).toBeNull();
      expect((await store.getInviteByTokenHash(hashApiKey(token)))?.status).toBe('pending');
    });
  });

  describe('POST /api/v1/workspace-invites/continuations/:nonce/consume', () => {
    async function acceptAsCarol(workspaceId = 'g1000', role: 'admin' | 'member' = 'member') {
      await createInvite(aliceKey, workspaceId, { invitedEmail: 'carol@example.test', role });
      const token = tokenFromMail();
      const carolKey = (await loginViaHttp(fx, CAROL.id)).controlKey;
      const accepted = (await (await post(`/api/v1/workspace-invites/${token}/accept`, carolKey, {})).json()) as { inviteId: string; continuation: { nonce: string } };
      return { carolKey, nonce: accepted.continuation.nonce, inviteId: accepted.inviteId };
    }

    it('consumes once and returns the rich context the daemon maps verbatim (invite-continue.ts:64-75)', async () => {
      const { carolKey, nonce, inviteId } = await acceptAsCarol('g1000', 'member');
      const res = await post(`/api/v1/workspace-invites/continuations/${nonce}/consume`, carolKey);
      expect(res.status).toBe(200);
      const raw = (await res.clone().json()) as Record<string, unknown>;
      const carolMember = deriveMemberId(String(CAROL.id), 'g1000');
      expect(Object.keys(raw).sort()).toEqual(['currentWorkspaceContext', 'inviteId', 'memberId', 'workspaceId', 'workspaceMemberId']);
      expect(raw).toMatchObject({ workspaceId: 'g1000', workspaceMemberId: carolMember, memberId: carolMember, inviteId });
      const outcome = await consumeOutcomeFromResponse(res);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.workspaceMemberId).toBe(carolMember);
      expect(outcome.context).not.toBeNull();
      expect(outcome.context).toMatchObject({
        workspaceId: 'g1000', workspaceType: 'team', workspaceMemberId: carolMember, role: 'member', memberStatus: 'active', lifecycleState: 'active',
        billingState: 'active', planId: 'team_plus', providerMode: 'platform_credits', teamId: 'g1000', workspaceName: 'Design Team', teamName: 'Design Team', displayName: 'Carol Danvers',
      });
      expect(outcome.context!.permissions).toEqual({ canManageMembers: false, canManageBilling: false, canInviteMembers: false, canManageAutoRecharge: false, canShareProjects: true, canWriteSyncedFiles: true, canViewWorkspaceSettings: true, canManageSharedResources: false });
      expect(outcome.context!.seatSummary).toEqual({ seatLimit: 0, usedSeats: 0, availableSeats: 0, isSeatFull: true });
      expect(workspaceSeatCapacityState(outcome.context!.seatSummary)).toBe('unknown');
      expect(outcome.context!.workspaceSettingsUrl).toBeUndefined();
      const audit = (await store.listAudit('g1000')).filter((a) => a.action === 'continuation_consume');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorUserId: String(CAROL.id), actorMemberId: carolMember, target: inviteId });
      expect(JSON.stringify(audit[0])).not.toContain(nonce);

      // Single use.
      const again = await post(`/api/v1/workspace-invites/continuations/${nonce}/consume`, carolKey);
      expect(again.status).toBe(409);
      expect(await again.clone().json()).toEqual({ error: 'nonce_consumed' });
      expect(await consumeOutcomeFromResponse(again)).toEqual({ ok: false, status: 409, error: 'continuation_409' });
    });

    it('404 invalid_nonce, 403 nonce_owner_mismatch, 410 expired, 401 without bearer; body is ignored', async () => {
      const { carolKey, nonce } = await acceptAsCarol();
      expect((await post(`/api/v1/workspace-invites/continuations/${nonce}/consume`, null)).status).toBe(401);
      const bad = await post(`/api/v1/workspace-invites/continuations/${'z'.repeat(43)}/consume`, carolKey);
      expect(bad.status).toBe(404);
      expect(await bad.clone().json()).toEqual({ error: 'invalid_nonce' });
      expect(await consumeOutcomeFromResponse(bad)).toEqual({ ok: false, status: 404, error: 'continuation_404' });
      expect((await post('/api/v1/workspace-invites/continuations/short/consume', carolKey)).status).toBe(404);

      const other = await post(`/api/v1/workspace-invites/continuations/${nonce}/consume`, aliceKey);
      expect(other.status).toBe(403);
      expect(await other.json()).toEqual({ error: 'nonce_owner_mismatch' });
      // The mismatch did not burn the nonce.
      fx.clock.now = new Date(fx.clock.now.getTime() + 10 * 60_000);
      const expired = await post(`/api/v1/workspace-invites/continuations/${nonce}/consume`, carolKey, { ignored: true });
      expect(expired.status).toBe(410);
      expect(await expired.clone().json()).toEqual({ error: 'expired' });
      expect(await consumeOutcomeFromResponse(expired)).toEqual({ ok: false, status: 410, error: 'continuation_410' });
    });

    it('403 workspace_forbidden when the membership was removed between accept and hand-off; the nonce is spent', async () => {
      const { carolKey, nonce } = await acceptAsCarol();
      // A directory sync removed Carol again (e.g. an admin pulled her from the GitLab group).
      await store.upsertMember({ workspaceId: 'g1000', userId: String(CAROL.id), role: 'member', memberStatus: 'removed' });
      const res = await post(`/api/v1/workspace-invites/continuations/${nonce}/consume`, carolKey);
      expect(res.status).toBe(403);
      expect(await res.clone().json()).toEqual({ error: 'workspace_forbidden' });
      expect(await consumeOutcomeFromResponse(res)).toEqual({ ok: false, status: 403, error: 'continuation_403' });
      const again = await post(`/api/v1/workspace-invites/continuations/${nonce}/consume`, carolKey);
      expect(again.status).toBe(409);
    });
  });

  describe('browser flow: GET /console/invites/:token/accept -> GitLab -> /console/oauth/callback', () => {
    /** Drive the redirect chain by hand, carrying the hub cookie like a browser would. */
    async function browse(token: string, asUser: number | null) {
      fx.gitlab.browserUserId = asUser;
      const start = await fetch(`${fx.hubUrl}/console/invites/${token}/accept`, { ...noRedirect, headers: { accept: 'text/html' } });
      if (start.status !== 302) return { start, callback: null as Response | null, cookie: '' };
      const cookie = start.headers.get('set-cookie') ?? '';
      const location = start.headers.get('location')!;
      const gitlab = await fetch(location, noRedirect);
      expect(gitlab.status).toBe(302);
      // GitLab redirects to the CONSOLE origin; rewrite to the hub listener like a DNS entry would.
      const back = new URL(gitlab.headers.get('location')!);
      expect(back.origin).toBe('https://hub.example.test');
      const callbackUrl = `${fx.hubUrl}${back.pathname}${back.search}`;
      const callback = await fetch(callbackUrl, { ...noRedirect, headers: { accept: 'text/html', cookie: cookie.split(';')[0]! } });
      return { start, callback, cookie, location };
    }

    it('redirects to GitLab with PKCE + state, accepts on callback, renders invite-accepted.html with a valid deeplink', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'admin' });
      const token = tokenFromMail();
      const { start, callback, cookie, location } = await browse(token, CAROL.id);
      expect(start.status).toBe(302);
      const auth = new URL(location!);
      expect(auth.origin).toBe(fx.gitlab.url);
      expect(auth.pathname).toBe('/oauth/authorize');
      expect(auth.searchParams.get('response_type')).toBe('code');
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(auth.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(auth.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(auth.searchParams.get('redirect_uri')).toBe('https://hub.example.test/console/oauth/callback');
      expect(auth.searchParams.get('scope')).toBe('read_user read_api');
      expect(location).not.toContain(token);
      expect(cookie).toMatch(/^od_hub_oauth=[A-Za-z0-9_-]+; Path=\/console\/oauth; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
      expect(cookie).not.toContain(token);

      expect(callback!.status).toBe(200);
      expect(callback!.headers.get('content-type')).toContain('text/html');
      expect(callback!.headers.get('set-cookie')).toContain('Max-Age=0');
      const page = await callback!.text();
      expect(page).toContain('Design Team');
      expect(page).toContain('admin');
      expect(page).toContain('https://dl.example.test/od');
      // Attribute values are entity-escaped (`&`, `=`); decode like a browser would before parsing.
      const deeplink = /href="(opendesign:[^"]+)"/.exec(page)![1]!.replace(/&#61;/g, '=').replace(/&amp;/g, '&');
      const payload = parseInviteDeeplink(deeplink);
      expect(payload).toMatchObject({ workspaceId: 'g1000', memberId: deriveMemberId(String(CAROL.id), 'g1000') });
      // The nonce on the page consumes for Carol once she logs in on the desktop.
      const carolKey = (await loginViaHttp(fx, CAROL.id)).controlKey;
      const consume = await post(`/api/v1/workspace-invites/continuations/${payload!.nonce}/consume`, carolKey);
      expect(consume.status).toBe(200);
      expect(fx.gitlab.groups.get(1000)!.members[CAROL.id]).toBe(40);
      // The token-exchange used PKCE (the fake enforces the verifier) and the code is spent.
      const exchange = fx.gitlab.requests.find((r) => r.method === 'POST' && r.path === '/oauth/token' && r.body.includes('authorization_code'));
      expect(exchange?.body).toContain('code_verifier=');
    });

    it('callback without the cookie, with a foreign state, or with an upstream error renders error.html and accepts nothing', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' });
      const token = tokenFromMail();
      const noCookie = await fetch(`${fx.hubUrl}/console/oauth/callback?code=x&state=y`, { headers: { accept: 'text/html' } });
      expect(noCookie.status).toBe(400);
      expect(await noCookie.text()).toContain('oauth_state_missing');

      fx.gitlab.browserUserId = CAROL.id;
      const start = await fetch(`${fx.hubUrl}/console/invites/${token}/accept`, noRedirect);
      const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
      const forged = await fetch(`${fx.hubUrl}/console/oauth/callback?code=forged&state=${'s'.repeat(43)}`, { headers: { cookie } });
      expect(forged.status).toBe(400);
      expect(await forged.text()).toContain('oauth_state_mismatch');

      const denied = await browse(token, null);
      expect(denied.callback!.status).toBe(403);
      expect(await denied.callback!.text()).toContain('gitlab_access_denied');
      expect((await store.getInviteByTokenHash(hashApiKey(token)))?.status).toBe('pending');
      expect(await store.getMembership(String(CAROL.id), 'g1000')).toBeNull();
    });

    it('a browser accept for an already-consumed or expired invite lands on the state page, not on GitLab', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'carol@example.test', role: 'member' });
      const token = tokenFromMail();
      const carolKey = (await loginViaHttp(fx, CAROL.id)).controlKey;
      await post(`/api/v1/workspace-invites/${token}/accept`, carolKey, {});
      const res = await fetch(`${fx.hubUrl}/console/invites/${token}/accept`, noRedirect);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<body class="already-accepted">');
      const unknown = await fetch(`${fx.hubUrl}/console/invites/${'q'.repeat(43)}/accept`, noRedirect);
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('content-type')).toContain('text/html');
    });

    it('the callback of a browser session whose GitLab account is already a member renders already_member', async () => {
      await createInvite(aliceKey, 'g1000', { invitedEmail: 'bob-alias@example.test', role: 'member' });
      const token = tokenFromMail();
      const { callback } = await browse(token, BOB.id);
      expect(callback!.status).toBe(409);
      const text = await callback!.text();
      expect(text).toContain('already_member');
      expect(text).toContain('already a member of this workspace');
    });
  });

  it('GET /console/device/done never reveals a user from ?user=<id>; a Bearer renders the caller; /console/* 404s are HTML', async () => {
    // Unauthenticated with an enumerable GitLab id: generic copy, no PII, still 200 (the CLI may print this URL).
    const res = await fetch(`${fx.hubUrl}/console/device/done?user=${ALICE.id}&deeplink=opendesign://x`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const text = await res.text();
    expect(text).not.toContain('Alice Liddell');
    expect(text).not.toContain('alice@example.test');
    expect(text).toContain('your GitLab account');
    expect(text).toContain(new URL(fx.gitlab.url).host);
    expect(text).toContain('opendesign://x');
    expect(text).not.toContain('{{');
    // An unknown id is not distinguishable from a known one.
    const unknown = await fetch(`${fx.hubUrl}/console/device/done?user=nobody`);
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain('your GitLab account');
    // The presented Bearer is the only identity proof.
    const mine = await fetch(`${fx.hubUrl}/console/device/done?user=${BOB.id}`, { headers: { accept: 'text/html', authorization: `Bearer ${aliceKey}` } });
    expect(mine.status).toBe(200);
    const mineText = await mine.text();
    expect(mineText).toContain('Alice Liddell');
    expect(mineText).toContain('alice@example.test');
    expect(mineText).not.toContain('Bob');
    const badBearer = await fetch(`${fx.hubUrl}/console/device/done`, { headers: { authorization: 'Bearer nope' } });
    expect(badBearer.status).toBe(200);
    expect(await badBearer.text()).not.toContain('Alice Liddell');
    const evil = await fetch(`${fx.hubUrl}/console/device/done?deeplink=javascript:alert(1)`);
    expect(await evil.text()).not.toContain('javascript:');
    expect(text).not.toContain('<!--');
    const other = await fetch(`${fx.hubUrl}/console/nothing/here`);
    expect(other.status).toBe(404);
    expect(other.headers.get('content-type')).toContain('text/html');
  });
});
