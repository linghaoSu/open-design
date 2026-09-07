const AMR_PROFILE_ENV = 'OPEN_DESIGN_AMR_PROFILE';
const VELA_PROFILE_ENV = 'VELA_PROFILE';
const DEFAULT_PROFILE = 'prod';
// `selfhost` targets a self-hosted Vela-compatible hub; it has no public
// defaults, so its console/API origins must be supplied through the
// OD_VELA_WEB_URL(S) / OD_AMR_API_UPSTREAM_ORIGIN knobs.
const ALLOWED_PROFILES = new Set(['prod', 'test', 'feature-test', 'local', 'selfhost']);

export type AmrProfile = 'prod' | 'test' | 'feature-test' | 'local' | 'selfhost';

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function resolveAmrProfile(env: EnvMap = process.env): AmrProfile {
  const source = (env[AMR_PROFILE_ENV] || '').trim() ? AMR_PROFILE_ENV : VELA_PROFILE_ENV;
  const raw = (env[AMR_PROFILE_ENV] || env[VELA_PROFILE_ENV] || '').trim();
  if (!raw) return DEFAULT_PROFILE;
  if (ALLOWED_PROFILES.has(raw)) return raw as AmrProfile;
  console.warn(
    `[amr] invalid ${source}="${raw}"; expected prod, test, feature-test, local, or selfhost; falling back to ${DEFAULT_PROFILE}`,
  );
  return DEFAULT_PROFILE;
}

export function amrVelaProfileEnv(env: EnvMap = process.env): { VELA_PROFILE: AmrProfile } {
  return { VELA_PROFILE: resolveAmrProfile(env) };
}
