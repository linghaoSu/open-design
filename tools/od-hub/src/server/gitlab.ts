/**
 * Injectable GitLab HTTP client (PLAN §5.1). The server depends only on this
 * interface; tests supply a fake backed by `tests/helpers/fake-gitlab.ts`
 * (node:http) or an in-process stub. Response shapes follow GitLab 17.2+
 * OAuth Device Authorization Grant (RFC 8628) and REST v4.
 */

export interface GitLabDeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface GitLabTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  created_at?: number;
  scope?: string;
}

/** RFC 8628 §3.5 + RFC 6749 §5.2 error codes surfaced by the token endpoint. */
export type GitLabTokenErrorCode =
  | 'authorization_pending'
  | 'slow_down'
  | 'access_denied'
  | 'expired_token'
  | 'invalid_grant'
  | 'invalid_client'
  | 'invalid_request'
  | 'unsupported_grant_type'
  | (string & {});

export class GitLabTokenError extends Error {
  constructor(readonly code: GitLabTokenErrorCode, readonly status: number, description?: string) {
    super(description ?? code);
  }
}

export class GitLabHttpError extends Error {
  constructor(readonly status: number, readonly url: string, body?: string) {
    super(`GitLab ${url} -> ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  email?: string | null;
  public_email?: string | null;
  avatar_url?: string | null;
  state?: string;
}

export interface GitLabGroup {
  id: number;
  name: string;
  full_name: string;
  full_path: string;
  path: string;
  parent_id: number | null;
  avatar_url?: string | null;
  /** GitLab 15.x+ exposes `marked_for_deletion_on` (date string) and 17.x `archived`. */
  marked_for_deletion_on?: string | null;
  archived?: boolean;
}

export interface GitLabGroupMember {
  id: number;
  username: string;
  name: string;
  access_level: number;
  state?: string;
  avatar_url?: string | null;
}

export interface GitLabClient {
  authorizeDevice(input: { scope: string }): Promise<GitLabDeviceAuthorization>;
  /** Throws GitLabTokenError for every non-2xx token response. */
  pollDeviceToken(input: { deviceCode: string }): Promise<GitLabTokenResponse>;
  refreshToken(input: { refreshToken: string }): Promise<GitLabTokenResponse>;
  getCurrentUser(accessToken: string): Promise<GitLabUser>;
  /** GET /api/v4/groups?min_access_level=N (all pages); `topLevelOnly` adds top_level_only=true. */
  listGroups(accessToken: string, input: { minAccessLevel: number; topLevelOnly: boolean }): Promise<GitLabGroup[]>;
  /** GET /api/v4/groups/:id/members/all/:userId — the caller's effective membership; null when 404. */
  getGroupMember(accessToken: string, groupId: number, userId: number): Promise<GitLabGroupMember | null>;
  /** GET /api/v4/groups/:id — null when 404 (deleted or no longer visible). */
  getGroup(accessToken: string, groupId: number): Promise<GitLabGroup | null>;
}

export interface HttpGitLabClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Concrete client over `fetch`. All calls time out (default 8s) so a stalled GitLab never blocks the daemon. */
export function createHttpGitLabClient(options: HttpGitLabClientOptions): GitLabClient {
  const fetchImpl = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 8_000;

  async function request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function form<T>(path: string, fields: Record<string, string>): Promise<T> {
    const body = new URLSearchParams({ client_id: options.clientId, ...fields });
    if (options.clientSecret) body.set('client_secret', options.clientSecret);
    const res = await request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // handled below
    }
    if (!res.ok) {
      const code = typeof parsed.error === 'string' ? parsed.error : `http_${res.status}`;
      const description = typeof parsed.error_description === 'string' ? parsed.error_description : undefined;
      throw new GitLabTokenError(code, res.status, description);
    }
    return parsed as T;
  }

  async function api<T>(path: string, accessToken: string): Promise<T> {
    const res = await request(`/api/v4${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) throw new GitLabHttpError(res.status, path, await res.text().catch(() => ''));
    return (await res.json()) as T;
  }

  async function apiPaged<T>(path: string, accessToken: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await request(`/api/v4${path}${sep}per_page=100&page=${page}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
      if (!res.ok) throw new GitLabHttpError(res.status, path, await res.text().catch(() => ''));
      const items = (await res.json()) as T[];
      out.push(...items);
      const next = res.headers.get('x-next-page');
      if (!next || items.length === 0) break;
    }
    return out;
  }

  return {
    authorizeDevice: ({ scope }) => form('/oauth/authorize_device', { scope }),
    pollDeviceToken: ({ deviceCode }) =>
      form('/oauth/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode }),
    refreshToken: ({ refreshToken }) => form('/oauth/token', { grant_type: 'refresh_token', refresh_token: refreshToken }),
    getCurrentUser: (token) => api<GitLabUser>('/user', token),
    listGroups: (token, { minAccessLevel, topLevelOnly }) =>
      apiPaged<GitLabGroup>(`/groups?min_access_level=${minAccessLevel}${topLevelOnly ? '&top_level_only=true' : ''}`, token),
    async getGroupMember(token, groupId, userId) {
      try {
        return await api<GitLabGroupMember>(`/groups/${groupId}/members/all/${userId}`, token);
      } catch (error) {
        if (error instanceof GitLabHttpError && error.status === 404) return null;
        throw error;
      }
    },
    async getGroup(token, groupId) {
      try {
        return await api<GitLabGroup>(`/groups/${groupId}?with_projects=false`, token);
      } catch (error) {
        if (error instanceof GitLabHttpError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
