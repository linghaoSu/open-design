import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Credential + endpoint resolution for the od-vela shim. Precedence mirrors
 * apps/daemon/src/integrations/vela.ts:751-795 (`readRawVelaControlApiContext`):
 *   1. VELA_CONTROL_KEY set  -> use it; apiUrl = VELA_API_URL || default.
 *   2. otherwise             -> $AMR_HOME/config.json profiles[<profile>].controlKey;
 *                               apiUrl = stored.apiUrl || VELA_API_URL || default.
 * Profile resolution follows vela-profile.ts: OPEN_DESIGN_AMR_PROFILE, then
 * VELA_PROFILE, then `prod`. The shim does not enforce the daemon allowlist —
 * a self-hosted hub may name profiles freely (config.json fields are all optional).
 */

export const DEFAULT_API_URL = 'https://amr-api.open-design.ai';

export type Env = Record<string, string | undefined>;

export interface ShimContext {
  profile: string;
  apiUrl: string;
  controlKey: string | null;
  workspaceId: string | null;
  invocationSource: string;
  configPath: string;
}

interface ProfileConfig {
  controlKey?: unknown;
  runtimeKey?: unknown;
  apiUrl?: unknown;
  linkUrl?: unknown;
  user?: unknown;
}

interface ConfigFile {
  profiles?: Record<string, ProfileConfig | undefined>;
  [extra: string]: unknown;
}

/** Fields written by `od-vela login` (vela.ts:393-399 VelaProfileShape). */
export interface StoredProfile {
  controlKey: string;
  runtimeKey: string;
  apiUrl: string;
  linkUrl: string;
  user: { id: string; email: string; name?: string; image?: string | null; plan?: string };
}

function readConfigFile(file: string): ConfigFile {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ConfigFile) : {};
  } catch {
    // A corrupt file must not block login; other profiles are lost only if unreadable anyway.
    return {};
  }
}

/**
 * Atomically merge one profile into `$AMR_HOME/config.json` (write temp file,
 * rename over). Other profiles and unknown top-level keys are preserved; the
 * daemon watches this file's mtime/contents (vela.ts:500-560) so the write
 * must be all-or-nothing.
 */
export function writeProfile(env: Env, profile: string, update: Partial<StoredProfile> | null): string {
  const file = amrConfigPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const current = readConfigFile(file);
  const profiles = { ...(current.profiles ?? {}) };
  if (update === null) {
    // logout: drop credentials + identity, keep endpoints so the next login knows where to go.
    const existing = { ...(profiles[profile] ?? {}) };
    delete existing.controlKey;
    delete existing.runtimeKey;
    delete existing.user;
    profiles[profile] = existing;
  } else {
    profiles[profile] = { ...(profiles[profile] ?? {}), ...update };
  }
  const next = { ...current, profiles };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function resolveProfile(env: Env): string {
  const raw = (env.OPEN_DESIGN_AMR_PROFILE || env.VELA_PROFILE || '').trim();
  return raw || 'prod';
}

export function amrConfigDir(env: Env): string {
  const amrHome = env.AMR_HOME?.trim();
  if (amrHome === '~') return homedir();
  if (amrHome?.startsWith('~/')) return path.join(homedir(), amrHome.slice(2));
  if (amrHome) return amrHome;
  return path.join(homedir(), '.amr');
}

export function amrConfigPath(env: Env): string {
  return path.join(amrConfigDir(env), 'config.json');
}

function readStoredProfile(env: Env, profile: string): ProfileConfig | null {
  const file = amrConfigPath(env);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ConfigFile;
    const stored = parsed?.profiles?.[profile];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveShimContext(env: Env): ShimContext {
  const profile = resolveProfile(env);
  const envControlKey = str(env.VELA_CONTROL_KEY);
  const envApiUrl = str(env.VELA_API_URL);
  const workspaceId = str(env.VELA_WORKSPACE_ID) || str(env.OPEN_DESIGN_WORKSPACE_ID) || null;
  const invocationSource = str(env.VELA_INVOCATION_SOURCE) || 'open-design';
  const configPath = amrConfigPath(env);
  if (envControlKey) {
    return {
      profile,
      apiUrl: envApiUrl || DEFAULT_API_URL,
      controlKey: envControlKey,
      workspaceId,
      invocationSource,
      configPath,
    };
  }
  const stored = readStoredProfile(env, profile);
  return {
    profile,
    apiUrl: str(stored?.apiUrl) || envApiUrl || DEFAULT_API_URL,
    controlKey: str(stored?.controlKey) || null,
    workspaceId,
    invocationSource,
    configPath,
  };
}
