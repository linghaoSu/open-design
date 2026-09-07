import { randomBytes } from 'node:crypto';

import type { HubConfig } from './config.js';
import { GitLabHttpError, GitLabTokenError, type GitLabClient, type GitLabUser } from './gitlab.js';
import { hashApiKey } from './ids.js';
import type { TokenCipher } from './token-cipher.js';
import type { DeviceAuthRow, HubStore, UserRow } from './store.js';

export const DEVICE_SCOPE = 'read_user read_api';
const DEFAULT_DEVICE_INTERVAL_S = 5;
const DEFAULT_DEVICE_EXPIRES_S = 600;
/** Hub device codes are 32 random bytes as base64url (43 chars); anything else is rejected before the store is consulted. */
const DEVICE_CODE_BYTES = 32;
export const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Refresh a little before GitLab's own deadline so an in-flight request never races expiry. */
const ACCESS_TOKEN_SKEW_MS = 30_000;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  interval: number;
  expiresIn: number;
}

/** Wire shape written by the CLI into `$AMR_HOME/config.json.profiles[p]` (vela.ts:393-399 VelaProfileShape). */
export interface LoginResult {
  controlKey: string;
  runtimeKey: string;
  apiUrl: string;
  linkUrl: string;
  user: { id: string; email: string; name: string; image: string | null; plan: 'team' };
}

export type DevicePollOutcome =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'unknown_device' }
  | { kind: 'success'; result: LoginResult };

/** Thrown by `ensureGitLabAccess` when the refresh token no longer works; the caller has already been revoked. */
export class GitLabSessionRevokedError extends Error {
  constructor(readonly userId: string, cause: unknown) {
    super(`GitLab session for ${userId} could not be refreshed`, { cause });
  }
}

/**
 * Thrown when GitLab could not be reached (or answered 5xx) while a token had
 * to be refreshed. The user's keys and grant are untouched; the request should
 * fail transiently (503) and the next one retries the refresh.
 */
export class GitLabUnavailableError extends Error {
  constructor(readonly userId: string, cause: unknown) {
    super(`GitLab refresh for ${userId} failed transiently: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * A refresh is *rejected* only when GitLab itself says the grant is dead:
 * an OAuth error response (HTTP 400/401 — invalid_grant, invalid_token,
 * invalid_client, ...). Timeouts, connection errors, and 5xx are transient.
 */
export function isRefreshRejected(error: unknown): boolean {
  if (error instanceof GitLabTokenError) return error.status === 400 || error.status === 401;
  if (error instanceof GitLabHttpError) return error.status === 400 || error.status === 401;
  return false;
}

export class GitLabNotConfiguredError extends Error {
  constructor() {
    super('GitLab OAuth is not configured (GITLAB_URL / GITLAB_OAUTH_CLIENT_ID)');
  }
}

export interface AuthServiceOptions {
  store: HubStore;
  gitlab: GitLabClient | null;
  cipher: TokenCipher;
  config: HubConfig;
  now?: () => Date;
  log?: (line: string) => void;
}

/**
 * Login/token lifecycle (PLAN §5.1, §5.3): hub-minted device codes mapped to
 * GitLab device codes, encrypted GitLab grants, `odc_`/`odr_` key issuance, and
 * silent refresh serialized per user.
 */
export class AuthService {
  private readonly store: HubStore;
  private readonly gitlab: GitLabClient | null;
  private readonly cipher: TokenCipher;
  private readonly config: HubConfig;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  /** Per-user refresh lock: the SQLite/memory stores are single-process, so an in-process mutex is the `SELECT ... FOR UPDATE` equivalent. */
  private readonly refreshLocks = new Map<string, Promise<string>>();

  constructor(options: AuthServiceOptions) {
    this.store = options.store;
    this.gitlab = options.gitlab;
    this.cipher = options.cipher;
    this.config = options.config;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.gitlab !== null;
  }

  private requireGitLab(): GitLabClient {
    if (!this.gitlab) throw new GitLabNotConfiguredError();
    return this.gitlab;
  }

  // ---- device flow ---------------------------------------------------------------

  async startDevice(profile: string | null): Promise<DeviceStart> {
    const gitlab = this.requireGitLab();
    const upstream = await gitlab.authorizeDevice({ scope: DEVICE_SCOPE });
    const now = this.now();
    const interval = Number.isInteger(upstream.interval) && upstream.interval! > 0 ? upstream.interval! : DEFAULT_DEVICE_INTERVAL_S;
    const expiresIn = Number.isInteger(upstream.expires_in) && upstream.expires_in > 0 ? upstream.expires_in : DEFAULT_DEVICE_EXPIRES_S;
    // 32 random bytes (256-bit): the CLI holds this, the store only its hash,
    // and GitLab's own device_code is sealed with the token cipher.
    const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url');
    const row: DeviceAuthRow = {
      deviceCodeHash: hashApiKey(deviceCode),
      userCode: upstream.user_code,
      gitlabDeviceCodeEnc: this.cipher.encrypt(upstream.device_code),
      keyId: this.cipher.keyId,
      verificationUri: upstream.verification_uri,
      verificationUriComplete: upstream.verification_uri_complete ?? null,
      intervalS: interval,
      status: 'pending',
      userId: null,
      profile,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      lastPolledAt: null,
    };
    await this.store.createDeviceAuth(row);
    return {
      deviceCode,
      userCode: row.userCode,
      verificationUri: row.verificationUri,
      verificationUriComplete: row.verificationUriComplete,
      interval,
      expiresIn,
    };
  }

  async pollDevice(deviceCode: string, request: { apiUrl: string; ip?: string | null; userAgent?: string | null }): Promise<DevicePollOutcome> {
    const gitlab = this.requireGitLab();
    if (!DEVICE_CODE_PATTERN.test(deviceCode)) return { kind: 'unknown_device' };
    const hash = hashApiKey(deviceCode);
    const row = await this.store.getDeviceAuth(hash);
    if (!row) return { kind: 'unknown_device' };
    const now = this.now();
    if (row.status === 'denied') return { kind: 'denied' };
    if (row.status === 'expired' || row.status === 'complete' || Date.parse(row.expiresAt) <= now.getTime()) {
      // A completed code is single-use: replaying it after success is treated like expiry.
      if (row.status !== 'expired') await this.store.updateDeviceAuth(hash, { status: 'expired' });
      return { kind: 'expired' };
    }
    // Hub-side pacing (RFC 8628 §3.5): a client polling faster than half the
    // interval is told to slow down before GitLab has to.
    if (row.lastPolledAt && now.getTime() - Date.parse(row.lastPolledAt) < (row.intervalS * 1000) / 2) {
      return { kind: 'slow_down' };
    }
    await this.store.updateDeviceAuth(hash, { lastPolledAt: now.toISOString() });

    let gitlabDeviceCode: string;
    try {
      gitlabDeviceCode = this.cipher.decrypt(row.gitlabDeviceCodeEnc, row.keyId);
    } catch {
      // Cipher key rotated or ephemeral key lost mid-login: the pending row is unusable.
      await this.store.updateDeviceAuth(hash, { status: 'expired' });
      return { kind: 'expired' };
    }
    let token;
    try {
      token = await gitlab.pollDeviceToken({ deviceCode: gitlabDeviceCode });
    } catch (error) {
      if (error instanceof GitLabTokenError) {
        switch (error.code) {
          case 'authorization_pending':
            return { kind: 'pending' };
          case 'slow_down':
            await this.store.updateDeviceAuth(hash, { intervalS: row.intervalS + 5 });
            return { kind: 'slow_down' };
          case 'access_denied':
            await this.store.updateDeviceAuth(hash, { status: 'denied' });
            return { kind: 'denied' };
          case 'expired_token':
            await this.store.updateDeviceAuth(hash, { status: 'expired' });
            return { kind: 'expired' };
          default:
            throw error;
        }
      }
      throw error;
    }

    const gitlabUser = await gitlab.getCurrentUser(token.access_token);
    const user = await this.upsertGitLabUser(gitlabUser);
    await this.storeGrant(user.id, token.access_token, token.refresh_token ?? null, token.expires_in);
    const expiresAt = new Date(now.getTime() + this.config.controlKeyTtlMs).toISOString();
    const deviceLabel = request.userAgent ?? null;
    const control = await this.store.issueApiKey({ userId: user.id, kind: 'control', profile: row.profile, deviceLabel, expiresAt });
    const runtime = await this.store.issueApiKey({ userId: user.id, kind: 'runtime', profile: row.profile, deviceLabel, expiresAt });
    await this.store.updateDeviceAuth(hash, { status: 'complete', userId: user.id });
    await this.store.appendAudit({
      actorUserId: user.id,
      action: 'login',
      target: control.apiKey.id,
      ip: request.ip ?? null,
      userAgent: request.userAgent ?? null,
      details: { profile: row.profile, runtimeKeyId: runtime.apiKey.id },
    });
    const apiUrl = this.config.publicUrl ?? request.apiUrl;
    return {
      kind: 'success',
      result: {
        controlKey: control.secret,
        runtimeKey: runtime.secret,
        apiUrl,
        linkUrl: this.config.llmGatewayUrl ?? apiUrl,
        user: { id: user.id, email: user.email, name: user.name, image: user.avatarUrl, plan: 'team' },
      },
    };
  }

  // ---- browser authorization-code flow (invite accept) ----------------------------------

  /** `authorizationUrl` for the invite-accept redirect; scope is the same as device login. */
  browserAuthorizationUrl(input: { redirectUri: string; state: string; codeChallenge: string }): string {
    return this.requireGitLab().authorizationUrl({ ...input, scope: DEVICE_SCOPE });
  }

  /**
   * Finish a browser login: exchange the code, upsert the GitLab user, store
   * the grant. No API keys are minted — the browser session ends with the
   * invite page; the desktop client logs in through the device flow.
   */
  async completeBrowserLogin(input: { code: string; redirectUri: string; codeVerifier: string }): Promise<UserRow> {
    const gitlab = this.requireGitLab();
    const token = await gitlab.exchangeAuthorizationCode(input);
    const gitlabUser = await gitlab.getCurrentUser(token.access_token);
    const user = await this.upsertGitLabUser(gitlabUser);
    await this.storeGrant(user.id, token.access_token, token.refresh_token ?? null, token.expires_in);
    return user;
  }

  /** PLAN §3.1: private email falls back to public_email, then `<username>@<gitlab-host>`. */
  emailFor(gitlabUser: GitLabUser): string {
    const direct = gitlabUser.email?.trim();
    if (direct) return direct;
    const pub = gitlabUser.public_email?.trim();
    if (pub) return pub;
    const host = this.config.gitlabUrl ? new URL(this.config.gitlabUrl).hostname : 'gitlab.local';
    return `${gitlabUser.username}@${host}`;
  }

  private async upsertGitLabUser(gitlabUser: GitLabUser): Promise<UserRow> {
    return this.store.upsertUser({
      id: String(gitlabUser.id),
      gitlabId: gitlabUser.id,
      email: this.emailFor(gitlabUser),
      name: gitlabUser.name?.trim() || gitlabUser.username,
      avatarUrl: gitlabUser.avatar_url?.trim() || null,
    });
  }

  private async storeGrant(userId: string, accessToken: string, refreshToken: string | null, expiresIn: number | undefined): Promise<void> {
    const now = this.now();
    await this.store.putOAuthGrant({
      userId,
      accessTokenEnc: this.cipher.encrypt(accessToken),
      refreshTokenEnc: refreshToken ? this.cipher.encrypt(refreshToken) : null,
      keyId: this.cipher.keyId,
      accessExpiresAt: typeof expiresIn === 'number' && expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
      updatedAt: now.toISOString(),
    });
  }

  // ---- token lifecycle ----------------------------------------------------------------

  /**
   * Return a usable GitLab access token for the user, refreshing if expired.
   * Serialized per user so concurrent daemon requests trigger one refresh.
   * Returns null when the user has no GitLab grant at all (dev-seed accounts).
   * Throws GitLabSessionRevokedError after revoking every key of the user when
   * GitLab rejects the refresh (PLAN §5.3), and GitLabUnavailableError — keys
   * intact — when GitLab could not be reached.
   */
  async ensureGitLabAccess(user: UserRow): Promise<string | null> {
    const grant = await this.store.getOAuthGrant(user.id);
    if (!grant) return null;
    const now = this.now().getTime();
    const fresh = !grant.accessExpiresAt || Date.parse(grant.accessExpiresAt) - ACCESS_TOKEN_SKEW_MS > now;
    if (fresh) {
      try {
        return this.cipher.decrypt(grant.accessTokenEnc, grant.keyId);
      } catch (error) {
        // Key rotated or ephemeral key lost on restart: the grant is unusable.
        await this.revokeUserSession(user.id, error);
        throw new GitLabSessionRevokedError(user.id, error);
      }
    }
    return this.lockedRefresh(user.id, { force: false });
  }

  /**
   * GitLab answered 401 to an API call made with `rejectedToken` although the
   * hub still considered it valid (revoked server-side, clock skew, ...).
   * Refresh once under the per-user lock and return the new token; when the
   * refresh itself is rejected the user is revoked (GitLabSessionRevokedError).
   * A concurrent refresh that already replaced the token is reused, not repeated.
   */
  async handleRejectedToken(user: UserRow, rejectedToken: string): Promise<string> {
    const grant = await this.store.getOAuthGrant(user.id);
    if (!grant) throw new GitLabSessionRevokedError(user.id, new Error('grant vanished'));
    return this.lockedRefresh(user.id, { force: true, unless: rejectedToken });
  }

  private lockedRefresh(userId: string, mode: { force: boolean; unless?: string }): Promise<string> {
    const inFlight = this.refreshLocks.get(userId);
    if (inFlight) return inFlight;
    const task = this.refresh(userId, mode).finally(() => {
      this.refreshLocks.delete(userId);
    });
    this.refreshLocks.set(userId, task);
    return task;
  }

  private async refresh(userId: string, mode: { force: boolean; unless?: string }): Promise<string> {
    const gitlab = this.requireGitLab();
    // Re-read under the lock: a previous holder may have refreshed already.
    const grant = await this.store.getOAuthGrant(userId);
    if (!grant) throw new GitLabSessionRevokedError(userId, new Error('grant vanished'));
    const now = this.now().getTime();
    const stillFresh = !!grant.accessExpiresAt && Date.parse(grant.accessExpiresAt) - ACCESS_TOKEN_SKEW_MS > now;
    if (stillFresh || mode.force) {
      let current: string | null = null;
      try {
        current = this.cipher.decrypt(grant.accessTokenEnc, grant.keyId);
      } catch (error) {
        await this.revokeUserSession(userId, error);
        throw new GitLabSessionRevokedError(userId, error);
      }
      // Forced (token rejected upstream): skip the refresh only if someone else already rotated it.
      if (!mode.force || (mode.unless !== undefined && current !== mode.unless)) return current;
    }
    let refreshToken: string;
    try {
      if (!grant.refreshTokenEnc) throw new Error('no refresh token');
      refreshToken = this.cipher.decrypt(grant.refreshTokenEnc, grant.keyId);
    } catch (error) {
      await this.revokeUserSession(userId, error);
      throw new GitLabSessionRevokedError(userId, error);
    }
    let token;
    try {
      token = await gitlab.refreshToken({ refreshToken });
    } catch (error) {
      if (isRefreshRejected(error)) {
        await this.revokeUserSession(userId, error);
        throw new GitLabSessionRevokedError(userId, error);
      }
      // Transport error, timeout, or GitLab 5xx: keep the keys and the grant;
      // the caller fails this request transiently and the next one retries.
      this.log(`[od-hub] GitLab refresh for user ${userId} failed transiently: ${error instanceof Error ? error.message : String(error)}`);
      throw new GitLabUnavailableError(userId, error);
    }
    await this.storeGrant(userId, token.access_token, token.refresh_token ?? refreshToken, token.expires_in);
    return token.access_token;
  }

  private async revokeUserSession(userId: string, cause: unknown): Promise<void> {
    const revoked = await this.store.revokeAllUserKeys(userId, this.now());
    await this.store.deleteOAuthGrant(userId);
    await this.store.appendAudit({
      actorUserId: userId,
      action: 'session_revoked',
      details: { reason: 'gitlab_refresh_failed', revokedKeys: revoked, cause: cause instanceof Error ? cause.message : String(cause) },
    });
    this.log(`[od-hub] revoked ${revoked} key(s) for user ${userId}: GitLab refresh failed`);
  }

  async revokeKey(secret: string, actorUserId: string): Promise<void> {
    await this.store.revokeApiKey(secret, this.now());
    await this.store.appendAudit({ actorUserId, action: 'logout' });
  }
}
