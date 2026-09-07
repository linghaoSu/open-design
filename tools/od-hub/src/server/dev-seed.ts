import { mintApiKeySecret } from './ids.js';
import type { HubStore } from './store.js';

export interface DevSeedOptions {
  /** Plaintext control key to issue. When omitted a fresh `odc_` secret is minted. */
  controlKey?: string;
  userId?: string;
  email?: string;
  name?: string;
  teamWorkspaceId?: string;
  teamWorkspaceName?: string;
}

export interface DevSeedResult {
  controlKey: string;
  userId: string;
  personalWorkspaceId: string;
  teamWorkspaceId: string;
  /** False when the key already existed (restart against a persistent store). */
  issuedNewKey: boolean;
}

/** Control keys must carry the `odc_` prefix so they are recognisable in logs. */
export function assertControlKeyShape(key: string): void {
  if (!/^odc_[A-Za-z0-9_-]{8,}$/.test(key)) {
    throw new Error('--control-key must look like odc_<at least 8 url-safe characters>');
  }
}

/**
 * Seed one user with a personal + one team workspace and a control key so a
 * dev daemon can point at the hub with zero login flow (PLAN §11.4.9 asks for
 * a test-only key issuance path; this is the local form of it). Idempotent:
 * re-running against a persistent store is a no-op apart from `upsertMember`.
 */
export async function seedDevIdentity(store: HubStore, options: DevSeedOptions = {}): Promise<DevSeedResult> {
  const userId = options.userId ?? 'u1';
  const email = options.email ?? 'dev@od-hub.local';
  const name = options.name ?? 'OD Hub Dev';
  const personalWorkspaceId = userId;
  const teamWorkspaceId = options.teamWorkspaceId ?? 'g1';
  const teamWorkspaceName = options.teamWorkspaceName ?? 'Self-hosted Team';
  const controlKey = options.controlKey ?? mintApiKeySecret('control');
  assertControlKeyShape(controlKey);

  if (!(await store.getUser(userId))) {
    await store.createUser({ id: userId, email, name });
  }
  if (!(await store.getWorkspace(personalWorkspaceId))) {
    await store.createWorkspace({ id: personalWorkspaceId, name: `${name}'s workspace`, kind: 'personal' });
  }
  if (!(await store.getWorkspace(teamWorkspaceId))) {
    await store.createWorkspace({ id: teamWorkspaceId, name: teamWorkspaceName, kind: 'team' });
  }
  await store.upsertMember({ workspaceId: personalWorkspaceId, userId, role: 'owner', displayName: name });
  await store.upsertMember({ workspaceId: teamWorkspaceId, userId, role: 'owner', displayName: name });
  const existed = (await store.authenticate(controlKey)) !== null;
  const { secret } = await store.issueApiKey({
    userId,
    kind: 'control',
    profile: 'selfhost',
    deviceLabel: 'dev-seed',
    secret: controlKey,
  });
  return { controlKey: secret, userId, personalWorkspaceId, teamWorkspaceId, issuedNewKey: !existed };
}
