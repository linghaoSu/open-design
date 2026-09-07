import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsConfigResponse } from '@open-design/contracts/analytics';

import { readAppConfig, writeAppConfig } from '../src/app-config.js';
import { registerTelemetryRoutes } from '../src/routes/telemetry.js';
import { readVelaControlApiContext } from '../src/integrations/vela.js';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../src/analytics.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/analytics.js')>(),
  createAnalyticsService: () => ({
    capture, captureSafety: capture, identify: capture, groupIdentify: capture,
    shutdown: async () => {},
  }),
}));
vi.mock('../src/app-version.js', () => ({
  UNKNOWN_APP_VERSION: 'unknown',
  readCurrentAppVersionInfo: async () => { throw new Error('not part of this read-only request'); },
}));

let dataDir: string;
let amrHome: string;
const environmentKeys = [
  'POSTHOG_KEY', 'POSTHOG_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY',
  'LANGFUSE_BASE_URL', 'OPEN_DESIGN_TELEMETRY_RELAY_URL', 'OPEN_DESIGN_VELA_TELEMETRY',
  'VELA_CONTROL_KEY', 'VELA_RUNTIME_KEY', 'VELA_LINK_URL', 'VELA_API_URL',
  'OPEN_DESIGN_AMR_PROFILE', 'VELA_PROFILE',
];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'od-telemetry-configuration-'));
  amrHome = path.join(dataDir, 'amr');
  await mkdir(amrHome);
  environmentKeys.forEach((key) => vi.stubEnv(key, undefined));
  vi.stubEnv('AMR_HOME', amrHome);
  vi.stubEnv('OD_INSTALLATION_DIR', path.join(dataDir, 'installation'));
  capture.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

async function saveConfig(value: unknown) {
  await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify(value));
}

async function getConfig(reader: typeof readAppConfig = readAppConfig) {
  const app = express();
  const write = vi.fn(writeAppConfig);
  const telemetry = registerTelemetryRoutes(app, { dataDir, readAppConfig: reader, writeAppConfig: write });
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local test address');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/analytics/config`);
    expect(response.status).toBe(200);
    const body = await response.json() as AnalyticsConfigResponse;
    expect(write).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    return body;
  } finally {
    telemetry.disposeFatalHandlers();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('analytics configuration facts', () => {
  it('proves absent sinks even when consent defaults on, without creating preferences', async () => {
    expect(await getConfig()).toMatchObject({ enabled: false, telemetryConfiguration: { metrics: false, content: false } });
    await expect(readFile(path.join(dataDir, 'app-config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('reads a legacy installation identity without migration writes, with PostHog=%s', async (hasPosthog) => {
    if (hasPosthog) vi.stubEnv('POSTHOG_KEY', 'public-test-key');
    await saveConfig({ installationId: 'legacy-fixture-installation', telemetry: { metrics: false, content: false } });
    const configBefore = await readFile(path.join(dataDir, 'app-config.json'));
    const installationFile = path.join(dataDir, 'installation', 'installation.json');

    expect(await getConfig()).toMatchObject({
      enabled: false,
      telemetryConfiguration: { metrics: hasPosthog, content: false },
    });
    await expect(readFile(installationFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(dataDir, 'app-config.json'))).toEqual(configBefore);

    // The ordinary reader still performs its existing identity migration.
    expect(await readAppConfig(dataDir)).toMatchObject({ installationId: 'legacy-fixture-installation' });
    expect(JSON.parse(await readFile(installationFile, 'utf8'))).toEqual({ installationId: 'legacy-fixture-installation' });
    expect(await readFile(path.join(dataDir, 'app-config.json'))).toEqual(configBefore);
  });

  it.each([false, true])('reports a configured metrics sink independently of consent=%s', async (consent) => {
    vi.stubEnv('POSTHOG_KEY', 'public-test-key');
    await saveConfig({ telemetry: { metrics: consent, content: false } });
    const before = await readFile(path.join(dataDir, 'app-config.json'));
    expect(await getConfig()).toMatchObject({ enabled: consent, telemetryConfiguration: { metrics: true, content: false } });
    expect(await readFile(path.join(dataDir, 'app-config.json'))).toEqual(before);
  });

  it.each(['relay', 'langfuse', 'vela-environment', 'vela-preferences', 'vela-profile'])('finds %s content configuration without PostHog or consent', async (sink) => {
    const secret = 'fixture-only-content-secret';
    const privateUrl = 'https://private-fixture.example/ingest';
    await saveConfig({ telemetry: { metrics: false, content: false } });
    if (sink === 'relay') vi.stubEnv('OPEN_DESIGN_TELEMETRY_RELAY_URL', privateUrl);
    if (sink === 'langfuse') {
      vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'public-test');
      vi.stubEnv('LANGFUSE_SECRET_KEY', secret);
      vi.stubEnv('LANGFUSE_BASE_URL', privateUrl);
    }
    if (sink === 'vela-environment') {
      vi.stubEnv('VELA_CONTROL_KEY', secret);
      vi.stubEnv('VELA_API_URL', privateUrl);
    }
    if (sink === 'vela-preferences') {
      await saveConfig({
        telemetry: { metrics: false, content: false },
        agentCliEnv: { amr: { OPEN_DESIGN_AMR_PROFILE: 'local', VELA_API_URL: privateUrl } },
      });
      await writeFile(path.join(amrHome, 'config.json'), JSON.stringify({
        profiles: { local: { controlKey: secret } },
      }));
    }
    if (sink === 'vela-profile') await writeFile(path.join(amrHome, 'config.json'), JSON.stringify({
      profiles: { prod: { controlKey: secret, apiUrl: privateUrl } },
    }));
    const body = await getConfig();
    expect(body).toMatchObject({ enabled: false, telemetryConfiguration: { metrics: false, content: true } });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain(privateUrl);
  });

  it('uses the selected AMR profile and respects Vela telemetry being disabled, retaining a task relay', async () => {
    await writeFile(path.join(amrHome, 'config.json'), JSON.stringify({
      profiles: { prod: { controlKey: 'fixture-key' } },
    }));
    vi.stubEnv('VELA_PROFILE', 'test');
    expect((await getConfig()).telemetryConfiguration).toEqual({ metrics: false, content: false });
    vi.stubEnv('VELA_PROFILE', 'prod');
    vi.stubEnv('OPEN_DESIGN_VELA_TELEMETRY', 'off');
    expect((await getConfig()).telemetryConfiguration).toEqual({ metrics: false, content: false });
    vi.stubEnv('OPEN_DESIGN_TELEMETRY_RELAY_URL', 'https://fixture.example/relay');
    expect((await getConfig()).telemetryConfiguration).toEqual({ metrics: false, content: true });
  });

  it('requires both direct Langfuse credentials and does not infer telemetry from a Vela runtime key', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'public-without-secret');
    vi.stubEnv('VELA_RUNTIME_KEY', 'fixture-runtime-only');
    vi.stubEnv('VELA_LINK_URL', 'https://fixture.example/runtime');
    expect((await getConfig()).telemetryConfiguration).toEqual({ metrics: false, content: false });
  });

  it.each(['app-json', 'app-shape', 'vela-json', 'vela-shape', 'vela-unreadable'])('reports unknown for %s rather than claiming nothing is configured', async (failure) => {
    if (failure === 'app-json') await writeFile(path.join(dataDir, 'app-config.json'), '{bad');
    if (failure === 'app-shape') await saveConfig([]);
    if (failure === 'vela-json') await writeFile(path.join(amrHome, 'config.json'), '{bad');
    if (failure === 'vela-shape') await writeFile(path.join(amrHome, 'config.json'), '[]');
    if (failure === 'vela-unreadable') await mkdir(path.join(amrHome, 'config.json'));
    expect((await getConfig()).telemetryConfiguration).toBeNull();
  });

  it('reports unknown after a configuration-reader failure while leaving metrics disabled', async () => {
    vi.stubEnv('POSTHOG_KEY', 'public-test-key');
    const reader = vi.fn(async () => { throw new Error('fixture read failure'); });
    expect(await getConfig(reader)).toMatchObject({ enabled: false, telemetryConfiguration: null });
  });

  it('keeps existing tolerant readers unchanged outside the configuration diagnostic', async () => {
    await writeFile(path.join(dataDir, 'app-config.json'), '[]');
    await writeFile(path.join(amrHome, 'config.json'), '{bad');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readAppConfig(dataDir)).toMatchObject({ telemetry: { metrics: true, content: true } });
      expect(readVelaControlApiContext({})).toBeNull();
      expect((await getConfig()).telemetryConfiguration).toBeNull();
    } finally {
      warning.mockRestore();
    }
  });
});
