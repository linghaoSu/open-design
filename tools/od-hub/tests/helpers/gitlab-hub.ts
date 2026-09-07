import { parseHubConfig, type HubConfig } from '../../src/server/config.js';
import { createHttpGitLabClient } from '../../src/server/gitlab.js';
import { createHubServer, type HubServer } from '../../src/server/http.js';
import { MemoryHubStore } from '../../src/server/memory-store.js';
import { SqliteHubStore } from '../../src/server/sqlite-store.js';
import type { HubStore } from '../../src/server/store.js';
import { FakeGitLab, type FakeGitLabOptions } from './fake-gitlab.js';

export const GITLAB_CLIENT_ID = 'od-hub-test-client';
export const GITLAB_CLIENT_SECRET = 'od-hub-test-secret';

export const ALICE = { id: 101, username: 'alice', name: 'Alice Liddell', email: 'alice@example.test', avatar_url: 'https://gitlab.example.test/alice.png' };
export const BOB = { id: 202, username: 'bob', name: 'Bob Builder', email: null, public_email: null };

export interface GitLabHubFixture {
  gitlab: FakeGitLab;
  hub: HubServer;
  hubUrl: string;
  store: HubStore;
  config: HubConfig;
  clock: { now: Date };
  close(): Promise<void>;
}

export interface GitLabHubFixtureOptions {
  store?: 'memory' | 'sqlite';
  env?: NodeJS.ProcessEnv;
  gitlab?: FakeGitLabOptions;
  now?: Date;
  heartbeatIntervalMs?: number;
}

/**
 * Hub wired to a fake GitLab through the real `createHttpGitLabClient`, with a
 * controllable clock so key expiry and directory cache ageing are deterministic.
 * Default data: Alice (owner of g1000, maintainer of g2000, guest in g3000),
 * Bob (developer in g1000).
 */
export async function startGitLabHub(options: GitLabHubFixtureOptions = {}): Promise<GitLabHubFixture> {
  const gitlab = new FakeGitLab({ clientId: GITLAB_CLIENT_ID, clientSecret: GITLAB_CLIENT_SECRET, interval: 1, ...options.gitlab });
  gitlab.addUser(ALICE).addUser(BOB);
  gitlab.addGroup({ id: 1000, name: 'design', full_name: 'Design Team', full_path: 'design', path: 'design', parent_id: null, avatar_url: 'https://gitlab.example.test/design.png', members: { [ALICE.id]: 50, [BOB.id]: 30 } });
  gitlab.addGroup({ id: 2000, name: 'platform', full_name: 'Platform', full_path: 'platform', path: 'platform', parent_id: null, avatar_url: null, members: { [ALICE.id]: 40 } });
  gitlab.addGroup({ id: 3000, name: 'guests', full_name: 'Guests Only', full_path: 'guests', path: 'guests', parent_id: null, members: { [ALICE.id]: 10 } });
  gitlab.addGroup({ id: 1001, name: 'sub', full_name: 'Design Team / Sub', full_path: 'design/sub', path: 'sub', parent_id: 1000, members: { [ALICE.id]: 30 } });
  const gitlabUrl = await gitlab.start();

  const clock = { now: options.now ?? new Date('2026-09-08T00:00:00.000Z') };
  const now = () => clock.now;
  const config = parseHubConfig({
    GITLAB_URL: gitlabUrl,
    GITLAB_OAUTH_CLIENT_ID: GITLAB_CLIENT_ID,
    GITLAB_OAUTH_CLIENT_SECRET: GITLAB_CLIENT_SECRET,
    TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
    ...options.env,
  });
  const store: HubStore = options.store === 'sqlite' ? new SqliteHubStore(':memory:', { now }) : new MemoryHubStore({}, { now });
  const hub = createHubServer({
    store,
    config,
    gitlab: createHttpGitLabClient({ baseUrl: gitlabUrl, clientId: GITLAB_CLIENT_ID, clientSecret: GITLAB_CLIENT_SECRET }),
    now,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 50,
  });
  const { url: hubUrl } = await hub.listen(0);
  return {
    gitlab,
    hub,
    hubUrl,
    store,
    config,
    clock,
    async close() {
      await hub.close();
      await store.close();
      await gitlab.stop();
    },
  };
}

export interface DeviceStartBody {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface LoginBody {
  controlKey: string;
  runtimeKey: string;
  apiUrl: string;
  linkUrl: string;
  user: { id: string; email: string; name: string; image: string | null; plan: string };
}

/** Drive the HTTP device flow to completion for one GitLab user (no CLI). */
export async function loginViaHttp(fx: GitLabHubFixture, gitlabUserId: number, profile = 'selfhost'): Promise<LoginBody & { deviceCode: string }> {
  const start = await fetch(`${fx.hubUrl}/api/v1/auth/device`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile }),
  });
  if (start.status !== 200) throw new Error(`device start ${start.status}`);
  const started = (await start.json()) as DeviceStartBody;
  fx.gitlab.approve(started.userCode, gitlabUserId);
  const poll = await fetch(`${fx.hubUrl}/api/v1/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode: started.deviceCode }),
  });
  if (poll.status !== 200) throw new Error(`device token ${poll.status}: ${await poll.text()}`);
  return { ...((await poll.json()) as LoginBody), deviceCode: started.deviceCode };
}
