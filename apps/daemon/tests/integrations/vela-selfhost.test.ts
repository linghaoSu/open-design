import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readVelaApiContext } from '../../src/integrations/vela.js';

import {
  DEFAULT_AMR_API_UPSTREAM_ORIGIN,
  isOwnAmrApiProxyUrl,
  normalizeHttpOrigin,
  resolveAmrApiUpstreamOrigin,
} from '../../src/integrations/vela-selfhost.js';

describe('resolveAmrApiUpstreamOrigin', () => {
  it('keeps the public AMR API when nothing is configured', () => {
    expect(resolveAmrApiUpstreamOrigin({})).toBe(DEFAULT_AMR_API_UPSTREAM_ORIGIN);
    expect(resolveAmrApiUpstreamOrigin({}, undefined)).toBe(DEFAULT_AMR_API_UPSTREAM_ORIGIN);
    expect(resolveAmrApiUpstreamOrigin({}, '   ')).toBe(DEFAULT_AMR_API_UPSTREAM_ORIGIN);
  });

  it('prefers OD_AMR_API_UPSTREAM_ORIGIN over the profile apiUrl', () => {
    expect(
      resolveAmrApiUpstreamOrigin(
        { OD_AMR_API_UPSTREAM_ORIGIN: 'https://hub.example.invalid/' },
        'https://other.example.invalid',
      ),
    ).toBe('https://hub.example.invalid');
  });

  it('derives the upstream from the profile apiUrl when the env knob is unset', () => {
    expect(resolveAmrApiUpstreamOrigin({}, 'http://hub.local:8080/api/'))
      .toBe('http://hub.local:8080');
  });

  it('rejects non-http(s) values at every level and falls through', () => {
    expect(
      resolveAmrApiUpstreamOrigin(
        { OD_AMR_API_UPSTREAM_ORIGIN: 'ftp://hub' },
        'https://hub.example.invalid',
      ),
    ).toBe('https://hub.example.invalid');
    expect(
      resolveAmrApiUpstreamOrigin({ OD_AMR_API_UPSTREAM_ORIGIN: 'not a url' }, 'file:///tmp/hub'),
    ).toBe(DEFAULT_AMR_API_UPSTREAM_ORIGIN);
  });

  it('never proxies back to its own api-proxy route', () => {
    expect(
      resolveAmrApiUpstreamOrigin(
        {},
        'https://open-design.example.com/api/integrations/vela/api-proxy',
      ),
    ).toBe(DEFAULT_AMR_API_UPSTREAM_ORIGIN);
    expect(isOwnAmrApiProxyUrl('http://localhost:7456/api/integrations/vela/api-proxy/')).toBe(true);
    expect(isOwnAmrApiProxyUrl('https://hub.example.invalid')).toBe(false);
  });
});

describe('normalizeHttpOrigin', () => {
  it('reduces a URL to its http(s) origin', () => {
    expect(normalizeHttpOrigin(' https://Hub.Example.invalid/path?q=1 ')).toBe(
      'https://hub.example.invalid',
    );
    expect(normalizeHttpOrigin('ws://hub')).toBeUndefined();
    expect(normalizeHttpOrigin(42)).toBeUndefined();
    expect(normalizeHttpOrigin('')).toBeUndefined();
  });
});

// The route feeds the resolver from readVelaApiContext, so the real wiring is
// config.json apiUrl (per profile) > VELA_API_URL > default. Exercise that
// chain end to end against a scratch AMR_HOME so the user's own file stays out.
describe('resolveAmrApiUpstreamOrigin via readVelaApiContext', () => {
  let amrHome: string;
  let previousAmrHome: string | undefined;

  beforeEach(() => {
    previousAmrHome = process.env.AMR_HOME;
    amrHome = mkdtempSync(path.join(tmpdir(), 'od-amr-proxy-upstream-'));
    process.env.AMR_HOME = amrHome;
  });

  afterEach(() => {
    if (previousAmrHome === undefined) delete process.env.AMR_HOME;
    else process.env.AMR_HOME = previousAmrHome;
    rmSync(amrHome, { recursive: true, force: true });
  });

  function writeProfileApiUrl(profile: string, apiUrl: string): void {
    writeFileSync(
      path.join(amrHome, 'config.json'),
      JSON.stringify({ profiles: { [profile]: { apiUrl, controlKey: 'ck' } } }),
      'utf8',
    );
  }

  function resolveFor(env: Record<string, string>, configuredEnv: Record<string, string> = {}): string {
    return resolveAmrApiUpstreamOrigin(env, readVelaApiContext(env, configuredEnv).apiUrl);
  }

  it('keeps the public default when nothing is configured', () => {
    expect(resolveFor({})).toBe(DEFAULT_AMR_API_UPSTREAM_ORIGIN);
  });

  it('derives the upstream from the active profile apiUrl', () => {
    writeProfileApiUrl('selfhost', 'https://hub.example.invalid/');
    expect(resolveFor({ OPEN_DESIGN_AMR_PROFILE: 'selfhost' })).toBe('https://hub.example.invalid');
    // The runtime-selected profile (app config) wins over the packaged one.
    expect(resolveFor({}, { OPEN_DESIGN_AMR_PROFILE: 'selfhost' })).toBe('https://hub.example.invalid');
    // A different profile without a stored apiUrl stays on the public hub.
    expect(resolveFor({ OPEN_DESIGN_AMR_PROFILE: 'prod' })).toBe(DEFAULT_AMR_API_UPSTREAM_ORIGIN);
  });

  it('prefers OD_AMR_API_UPSTREAM_ORIGIN over the stored profile apiUrl', () => {
    writeProfileApiUrl('selfhost', 'https://hub.example.invalid');
    expect(
      resolveFor({
        OPEN_DESIGN_AMR_PROFILE: 'selfhost',
        OD_AMR_API_UPSTREAM_ORIGIN: 'http://127.0.0.1:8080/ignored/path/',
      }),
    ).toBe('http://127.0.0.1:8080');
  });

  it('honors VELA_API_URL when the profile config has no apiUrl', () => {
    expect(resolveFor({ VELA_API_URL: 'https://env-hub.example.invalid' })).toBe(
      'https://env-hub.example.invalid',
    );
  });
});
