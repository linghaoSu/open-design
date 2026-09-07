/**
 * Self-hosted Vela hub knobs.
 *
 * A self-hosted, Vela-compatible hub replaces the public AMR API and console.
 * The knobs that let the daemon point at such a hub live here so future
 * self-host configuration has one home instead of being scattered across the
 * proxy route, the profile allowlist, and the console-origin resolver.
 */

export const AMR_API_UPSTREAM_ORIGIN_ENV = 'OD_AMR_API_UPSTREAM_ORIGIN';
export const DEFAULT_AMR_API_UPSTREAM_ORIGIN = 'https://amr-api.open-design.ai';
export const AMR_API_PROXY_PREFIX = '/api/integrations/vela/api-proxy';

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Normalize a candidate upstream to a bare http(s) origin. Anything that is
 * not an absolute http(s) URL yields `undefined` so callers fall through to the
 * next source instead of proxying to an unusable target.
 */
export function normalizeHttpOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.origin;
}

/**
 * True when `apiUrl` points back at this daemon's own AMR API proxy. The
 * fallback login flow writes that proxy URL into `VELA_API_URL`, so deriving
 * an upstream from it would make the proxy forward to itself.
 */
export function isOwnAmrApiProxyUrl(apiUrl: string): boolean {
  try {
    const pathname = new URL(apiUrl.trim()).pathname.replace(/\/+$/, '');
    return pathname === AMR_API_PROXY_PREFIX || pathname.endsWith(AMR_API_PROXY_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Resolve the origin the `/api/integrations/vela/api-proxy` route forwards to.
 *
 * Precedence: `OD_AMR_API_UPSTREAM_ORIGIN` > the Vela API URL of the current
 * profile context (`config.json` `apiUrl` / `VELA_API_URL`) > the public AMR
 * API. Each source must be an http(s) origin; a self-referencing proxy URL is
 * never used as an upstream. With nothing configured the result is the
 * historical hardcoded default.
 */
export function resolveAmrApiUpstreamOrigin(
  env: EnvMap = process.env,
  apiUrl: string | null | undefined = undefined,
): string {
  const fromEnv = normalizeHttpOrigin(env[AMR_API_UPSTREAM_ORIGIN_ENV]);
  if (fromEnv) return fromEnv;
  if (typeof apiUrl === 'string' && apiUrl.trim() && !isOwnAmrApiProxyUrl(apiUrl)) {
    const fromApiUrl = normalizeHttpOrigin(apiUrl);
    if (fromApiUrl) return fromApiUrl;
  }
  return DEFAULT_AMR_API_UPSTREAM_ORIGIN;
}
