import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Fake GitLab over node:http covering exactly the surface od-hub touches:
 *   POST /oauth/authorize_device            RFC 8628 §3.2
 *   GET  /oauth/authorize                   authorization-code redirect (browser leg; PKCE S256)
 *   POST /oauth/token                       device_code + refresh_token + authorization_code grants
 *   GET  /api/v4/user
 *   GET  /api/v4/groups?min_access_level=&top_level_only=
 *   GET  /api/v4/groups/:id
 *   GET  /api/v4/groups/:id/members/all/:userId
 *   GET  /api/v4/groups/:id/members/all
 *   POST /api/v4/groups/:id/members         Group Access Token (PRIVATE-TOKEN)
 *   PUT  /api/v4/groups/:id/members/:userId Group Access Token
 *
 * Authorization state is driven by the test (`approve`, `deny`, `expire`), so the
 * pending -> success sequence the CLI must survive is deterministic.
 */
export interface FakeGitLabUser {
  id: number;
  username: string;
  name: string;
  email?: string | null;
  public_email?: string | null;
  avatar_url?: string | null;
}

export interface FakeGitLabGroup {
  id: number;
  name: string;
  full_name: string;
  full_path: string;
  path: string;
  parent_id: number | null;
  avatar_url?: string | null;
  marked_for_deletion_on?: string | null;
  archived?: boolean;
  /** user id -> access_level */
  members: Record<number, number>;
}

interface DeviceState {
  userCode: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  userId: number | null;
  polls: number;
  /** When >0 the next N polls answer slow_down. */
  slowDownPolls: number;
}

interface TokenState {
  userId: number;
  expiresIn: number;
}

export interface FakeGitLabOptions {
  clientId?: string;
  clientSecret?: string | null;
  interval?: number;
  expiresIn?: number;
  /** access_token lifetime reported to the hub (seconds). */
  accessTokenTtlS?: number;
}

export class FakeGitLab {
  readonly users = new Map<number, FakeGitLabUser>();
  readonly groups = new Map<number, FakeGitLabGroup>();
  readonly devices = new Map<string, DeviceState>();
  readonly accessTokens = new Map<string, TokenState>();
  readonly refreshTokens = new Map<string, number>(); // refresh -> userId
  readonly revokedRefreshTokens = new Set<string>();
  /** authorization-code grant: code -> {userId, redirectUri, codeChallenge, used}. */
  readonly authCodes = new Map<string, { userId: number; redirectUri: string; codeChallenge: string | null; used: boolean }>();
  /** Group Access Tokens accepted on member writes: token -> group id. */
  readonly groupTokens = new Map<string, number>();
  readonly requests: Array<{ method: string; path: string; auth: string | null; body: string }> = [];
  private server: Server | null = null;
  private counter = 0;
  url = '';
  /** Set to make the next refresh_token grant fail (user revoked the app in GitLab). */
  failRefresh = false;
  /** When set, every refresh_token grant answers this status with an opaque body (GitLab outage). */
  refreshOutageStatus: number | null = null;
  /**
   * Who the browser "is" when it lands on /oauth/authorize: the fake redirects
   * straight back with a code for this user (null = user denies -> error=access_denied).
   */
  browserUserId: number | null = null;
  private controlEndpoint = false;

  constructor(private readonly options: FakeGitLabOptions = {}) {}

  addUser(user: FakeGitLabUser): this {
    this.users.set(user.id, user);
    return this;
  }

  addGroup(group: FakeGitLabGroup): this {
    this.groups.set(group.id, group);
    return this;
  }

  /** Simulate the user approving in the browser. */
  approve(userCode: string, userId: number): void {
    const device = this.deviceByUserCode(userCode);
    device.status = 'approved';
    device.userId = userId;
  }

  deny(userCode: string): void {
    this.deviceByUserCode(userCode).status = 'denied';
  }

  expire(userCode: string): void {
    this.deviceByUserCode(userCode).status = 'expired';
  }

  slowDown(userCode: string, polls: number): void {
    this.deviceByUserCode(userCode).slowDownPolls = polls;
  }

  pollCount(userCode: string): number {
    return this.deviceByUserCode(userCode).polls;
  }

  /** Make every access token issued so far expire immediately (hub must refresh). */
  expireAccessTokens(): void {
    for (const state of this.accessTokens.values()) state.expiresIn = 0;
  }

  /**
   * Expose `POST /__fake/approve {userCode,userId}` so an out-of-process driver
   * (the smoke script) can play the user approving in the browser. Off by
   * default: the in-process tests call `approve()` directly.
   */
  enableControlEndpoint(): void {
    this.controlEndpoint = true;
  }

  latestUserCode(): string {
    const codes = [...this.devices.values()];
    if (codes.length === 0) throw new Error('no device authorization yet');
    return codes[codes.length - 1]!.userCode;
  }

  private deviceByUserCode(userCode: string): DeviceState {
    for (const device of this.devices.values()) if (device.userCode === userCode) return device;
    throw new Error(`unknown user_code ${userCode}`);
  }

  /** Listens on an ephemeral port the first time; a restart after `stop()` reuses the same port so a hub keeps reaching it. */
  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'fake_gitlab_crash', message: String(error) }));
      });
    });
    const preferredPort = this.url ? Number(new URL(this.url).port) : 0;
    await new Promise<void>((resolve) => this.server!.listen(preferredPort, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => this.server!.close((e) => (e ? reject(e) : resolve())));
    this.server = null;
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private userForToken(req: IncomingMessage): FakeGitLabUser | null {
    const header = req.headers.authorization ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? '';
    const state = this.accessTokens.get(token);
    if (!state || state.expiresIn <= 0) return null;
    return this.users.get(state.userId) ?? null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake-gitlab');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    this.requests.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, auth: req.headers.authorization ?? null, body });

    if (this.controlEndpoint && req.method === 'POST' && url.pathname === '/__fake/approve') {
      const input = JSON.parse(body || '{}') as { userCode?: string; userId?: number };
      const userCode = input.userCode ?? this.latestUserCode();
      if (!this.users.has(input.userId ?? -1)) return this.json(res, 400, { error: 'unknown_user' });
      this.approve(userCode, input.userId!);
      return this.json(res, 200, { ok: true, userCode });
    }

    if (req.method === 'POST' && url.pathname === '/oauth/authorize_device') {
      const form = new URLSearchParams(body);
      if (this.options.clientId && form.get('client_id') !== this.options.clientId) {
        return this.json(res, 401, { error: 'invalid_client' });
      }
      if (this.options.clientSecret && form.get('client_secret') !== this.options.clientSecret) {
        return this.json(res, 401, { error: 'invalid_client' });
      }
      if (form.get('scope') !== 'read_user read_api') {
        return this.json(res, 400, { error: 'invalid_scope' });
      }
      this.counter += 1;
      const deviceCode = `gl-device-${this.counter}-${Math.random().toString(36).slice(2, 10)}`;
      const userCode = `ABCD-${String(this.counter).padStart(4, '0')}`;
      this.devices.set(deviceCode, { userCode, status: 'pending', userId: null, polls: 0, slowDownPolls: 0 });
      return this.json(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${this.url}/-/oauth/device`,
        verification_uri_complete: `${this.url}/-/oauth/device?user_code=${userCode}`,
        expires_in: this.options.expiresIn ?? 600,
        interval: this.options.interval ?? 5,
      });
    }

    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      // Browser leg of the authorization-code grant: validate the request, then
      // bounce back to redirect_uri with a code (or an error) exactly as GitLab would.
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (this.options.clientId && url.searchParams.get('client_id') !== this.options.clientId) return this.json(res, 401, { error: 'invalid_client' });
      if (url.searchParams.get('response_type') !== 'code' || !redirectUri) return this.json(res, 400, { error: 'invalid_request' });
      const target = new URL(redirectUri);
      if (state) target.searchParams.set('state', state);
      if (this.browserUserId === null || !this.users.has(this.browserUserId)) {
        target.searchParams.set('error', 'access_denied');
      } else {
        this.counter += 1;
        const code = `gl-code-${this.counter}-${Math.random().toString(36).slice(2, 10)}`;
        this.authCodes.set(code, { userId: this.browserUserId, redirectUri, codeChallenge: url.searchParams.get('code_challenge'), used: false });
        target.searchParams.set('code', code);
      }
      res.writeHead(302, { location: target.toString() });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const form = new URLSearchParams(body);
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        if (this.options.clientId && form.get('client_id') !== this.options.clientId) return this.json(res, 401, { error: 'invalid_client' });
        const record = this.authCodes.get(form.get('code') ?? '');
        if (!record || record.used) return this.json(res, 400, { error: 'invalid_grant' });
        if (record.redirectUri !== form.get('redirect_uri')) return this.json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (record.codeChallenge) {
          const verifier = form.get('code_verifier') ?? '';
          const expected = createHash('sha256').update(verifier).digest('base64url');
          if (expected !== record.codeChallenge) return this.json(res, 400, { error: 'invalid_grant', error_description: 'code_verifier mismatch' });
        }
        record.used = true;
        return this.json(res, 200, this.issueTokens(record.userId));
      }
      if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
        const device = this.devices.get(form.get('device_code') ?? '');
        if (!device) return this.json(res, 400, { error: 'invalid_grant' });
        device.polls += 1;
        if (device.slowDownPolls > 0) {
          device.slowDownPolls -= 1;
          return this.json(res, 400, { error: 'slow_down' });
        }
        if (device.status === 'pending') return this.json(res, 400, { error: 'authorization_pending' });
        if (device.status === 'denied') return this.json(res, 400, { error: 'access_denied' });
        if (device.status === 'expired') return this.json(res, 400, { error: 'expired_token' });
        return this.json(res, 200, this.issueTokens(device.userId!));
      }
      if (grant === 'refresh_token') {
        if (this.refreshOutageStatus !== null) {
          res.writeHead(this.refreshOutageStatus, { 'content-type': 'text/html' });
          res.end('<html>502 Bad Gateway</html>');
          return;
        }
        const refresh = form.get('refresh_token') ?? '';
        const userId = this.refreshTokens.get(refresh);
        if (this.failRefresh || userId === undefined || this.revokedRefreshTokens.has(refresh)) {
          return this.json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        }
        // GitLab rotates refresh tokens: the old one dies with the exchange.
        this.refreshTokens.delete(refresh);
        this.revokedRefreshTokens.add(refresh);
        return this.json(res, 200, this.issueTokens(userId));
      }
      return this.json(res, 400, { error: 'unsupported_grant_type' });
    }

    // Group Access Token writes (PRIVATE-TOKEN): POST adds, PUT changes level, GET reads one direct member.
    const memberWrite = /^\/api\/v4\/groups\/(\d+)\/members(?:\/(\d+))?$/.exec(url.pathname);
    if (memberWrite && (req.method === 'POST' || req.method === 'PUT' || (req.method === 'GET' && req.headers['private-token']))) {
      const groupId = Number(memberWrite[1]);
      const privateToken = typeof req.headers['private-token'] === 'string' ? req.headers['private-token'] : '';
      if (!privateToken || this.groupTokens.get(privateToken) !== groupId) return this.json(res, 401, { message: '401 Unauthorized' });
      const group = this.groups.get(groupId);
      if (!group) return this.json(res, 404, { message: '404 Group Not Found' });
      const form = new URLSearchParams(body);
      if (req.method === 'POST') {
        const userId = Number(form.get('user_id'));
        const level = Number(form.get('access_level'));
        if (!this.users.has(userId) || !Number.isInteger(level)) return this.json(res, 400, { message: '400 Bad request' });
        if (group.members[userId] !== undefined) return this.json(res, 409, { message: 'Member already exists' });
        group.members[userId] = level;
        return this.json(res, 201, { id: userId, username: this.users.get(userId)!.username, name: this.users.get(userId)!.name, access_level: level, state: 'active' });
      }
      const userId = Number(memberWrite[2]);
      const current = group.members[userId];
      if (current === undefined) return this.json(res, 404, { message: '404 Not found' });
      if (req.method === 'PUT') {
        const level = Number(form.get('access_level'));
        if (!Number.isInteger(level)) return this.json(res, 400, { message: '400 Bad request' });
        group.members[userId] = level;
      }
      const member = this.users.get(userId);
      return this.json(res, 200, { id: userId, username: member?.username ?? `u${userId}`, name: member?.name ?? '', access_level: group.members[userId], state: 'active' });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/v4/')) {
      const user = this.userForToken(req);
      if (!user) return this.json(res, 401, { message: '401 Unauthorized' });
      if (url.pathname === '/api/v4/user') {
        return this.json(res, 200, { ...user, state: 'active' });
      }
      if (url.pathname === '/api/v4/groups') {
        const min = Number.parseInt(url.searchParams.get('min_access_level') ?? '0', 10);
        const topOnly = url.searchParams.get('top_level_only') === 'true';
        const items = [...this.groups.values()]
          .filter((g) => (g.members[user.id] ?? 0) >= min)
          .filter((g) => !topOnly || g.parent_id === null)
          .map(({ members: _members, ...rest }) => rest);
        return this.json(res, 200, items, { 'x-next-page': '', 'x-total': String(items.length) });
      }
      const memberOne = /^\/api\/v4\/groups\/(\d+)\/members\/all\/(\d+)$/.exec(url.pathname);
      if (memberOne) {
        const group = this.groups.get(Number(memberOne[1]));
        const target = Number(memberOne[2]);
        const level = group?.members[target];
        if (!group || level === undefined) return this.json(res, 404, { message: '404 Not found' });
        const member = this.users.get(target);
        return this.json(res, 200, { id: target, username: member?.username ?? `u${target}`, name: member?.name ?? '', access_level: level, state: 'active' });
      }
      const memberAll = /^\/api\/v4\/groups\/(\d+)\/members\/all$/.exec(url.pathname);
      if (memberAll) {
        const group = this.groups.get(Number(memberAll[1]));
        if (!group) return this.json(res, 404, { message: '404 Not found' });
        return this.json(res, 200, Object.entries(group.members).map(([id, level]) => ({ id: Number(id), access_level: level })));
      }
      const groupOne = /^\/api\/v4\/groups\/(\d+)$/.exec(url.pathname);
      if (groupOne) {
        const group = this.groups.get(Number(groupOne[1]));
        if (!group || (group.members[user.id] ?? 0) <= 0) return this.json(res, 404, { message: '404 Group Not Found' });
        const { members: _members, ...rest } = group;
        return this.json(res, 200, rest);
      }
    }
    this.json(res, 404, { message: '404 Not Found' });
  }

  private issueTokens(userId: number): Record<string, unknown> {
    this.counter += 1;
    const access = `gl-access-${this.counter}-${Math.random().toString(36).slice(2, 12)}`;
    const refresh = `gl-refresh-${this.counter}-${Math.random().toString(36).slice(2, 12)}`;
    const expiresIn = this.options.accessTokenTtlS ?? 7200;
    this.accessTokens.set(access, { userId, expiresIn });
    this.refreshTokens.set(refresh, userId);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
      scope: 'read_user read_api',
      created_at: Math.floor(Date.now() / 1000),
    };
  }
}
