import { describe, expect, it } from 'vitest';
import { assertDesignLoomPackagedIdentity, designLoomUserDataRoot, isolateDesignLoomEnvironment, resolveDesignLoomLaunchNamespace } from '../src/product-isolation.js';
import { resolvePackagedNamespacePaths } from '../src/paths.js';
import { buildPackagedDaemonSpawnEnv } from '../src/sidecars.js';

describe('Design Loom installed runtime isolation', () => {
  it('cannot inherit upstream data, migration, telemetry, or updater inputs', () => {
    const env = {
      HOME: '/users/test', OPENAI_API_KEY: 'provider-fixture',
      OD_DATA_DIR: '/upstream/data', OD_LEGACY_DATA_DIR: '/upstream/legacy',
      OD_PACKAGED_NAMESPACE_BASE_ROOT: '/upstream/namespaces', OD_MEDIA_CONFIG_DIR: '/upstream/media',
      OD_UPDATE_METADATA_URL: 'https://releases.open-design.ai/stable/latest/metadata.json', OD_UPDATE_ENABLED: '1',
      OD_WHATS_NEW_URL: 'https://upstream/changes', POSTHOG_KEY: 'upstream-key', LANGFUSE_SECRET_KEY: 'upstream-key',
      OPEN_DESIGN_TELEMETRY_RELAY_URL: 'https://upstream/telemetry', OPEN_DESIGN_VELA_TELEMETRY: '1',
    };
    isolateDesignLoomEnvironment(env);
    expect(env).toEqual({ HOME: '/users/test', OPENAI_API_KEY: 'provider-fixture', OD_UPDATE_ENABLED: '0', OD_UPDATE_AUTO_CHECK: '0', OPEN_DESIGN_VELA_TELEMETRY: '0' });
    const base = designLoomUserDataRoot('/user/app-support');
    const paths = resolvePackagedNamespacePaths({ namespace: 'design-loom', namespaceBaseRoot: `${base}/namespaces`, resourceRoot: '/bundle/resources',
      appVersion: '0.1.0-beta.1', amrProfile: null, daemonCliEntry: null, daemonSidecarEntry: null, nodeCommand: null,
      telemetryRelayUrl: null, updateMetadataUrl: null, posthogKey: null, posthogHost: null, velaWebUrl: null,
      webSidecarEntry: null, webStandaloneRoot: null, webOutputMode: 'server',
    }, 'design-loom', env);
    expect(paths.dataRoot).toBe('/user/app-support/Design Loom/namespaces/design-loom/data');
    expect(paths.electronUserDataRoot).not.toContain('Open Design');
    const daemon = buildPackagedDaemonSpawnEnv(paths, { appVersion: '0.1.0-beta.1', daemonCliEntry: null, requireDesktopAuth: true });
    expect(daemon.OD_DATA_DIR).toBe(paths.dataRoot);
    expect(daemon.OD_PORT).toBe('0');
    expect(daemon.OD_LEGACY_DATA_DIR).toBeUndefined();
    expect(daemon.OPEN_DESIGN_VELA_TELEMETRY).toBe('0');
  });
  it.each(['default', 'open-design', 'release-beta', 'release-stable', 'design-loom-/../open-design'])('rejects a foreign process namespace %s before discovery', (namespace) => {
    expect(() => assertDesignLoomPackagedIdentity({ productId: 'design-loom' }, namespace)).toThrow();
  });
  it('rejects a config from the upstream app and accepts an explicit fork acceptance config', () => {
    expect(() => assertDesignLoomPackagedIdentity({ namespace: 'design-loom' }, 'design-loom')).toThrow(/Design Loom packaged/);
    expect(() => assertDesignLoomPackagedIdentity({ productId: 'design-loom' }, 'design-loom-acceptance')).not.toThrow();
  });
  it('fences recovered desktop and headless stamps before deriving paths or invoking sidecars', () => {
    expect(() => resolveDesignLoomLaunchNamespace('design-loom', 'default')).toThrow();
    expect(() => resolveDesignLoomLaunchNamespace('design-loom', 'release-stable')).toThrow();
    expect(resolveDesignLoomLaunchNamespace('design-loom', 'design-loom-acceptance')).toBe('design-loom-acceptance');
  });
});
