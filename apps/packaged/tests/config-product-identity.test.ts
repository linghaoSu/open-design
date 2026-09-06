import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ appData: '', name: '', paths: new Map<string, string>() }));
vi.mock('electron', async () => {
  const fs = await import('node:fs');
  return { app: {
    getPath: (key: string) => key === 'appData' ? electronState.appData : electronState.paths.get(key),
    setName: (name: string) => { electronState.name = name; },
    setPath: (key: string, path: string) => {
      // Match Electron's documented cold-start behavior, not a permissive mock.
      if (!fs.existsSync(path)) throw new Error('setPath requires an existing directory');
      electronState.paths.set(key, path);
    },
  } };
});
import { readPackagedConfig } from '../src/config.js';

const initialEnvironment = { ...process.env };
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
const roots: string[] = [];
afterEach(async () => {
  process.env = { ...initialEnvironment };
  if (originalResources) Object.defineProperty(process, 'resourcesPath', originalResources);
  else Reflect.deleteProperty(process, 'resourcesPath');
  electronState.paths.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('packaged configuration on a clean Design Loom installation', () => {
  it('creates only its new userData directory before calling Electron setPath and ignores upstream inherited settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'design-loom-config-'));
    roots.push(root);
    electronState.appData = join(root, 'app-support');
    const resources = join(root, 'resources');
    await mkdir(resources);
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources });
    const configPath = join(resources, 'open-design-config.json');
    await writeFile(configPath, JSON.stringify({ productId: 'design-loom', namespace: 'design-loom', appVersion: '0.1.0-beta.1',
      updateMetadataUrl: 'https://upstream/update', posthogKey: 'upstream-key', telemetryRelayUrl: 'https://upstream/trace' }));
    process.env.OD_PACKAGED_CONFIG_PATH = configPath;
    process.env.OD_DATA_DIR = join(root, 'upstream', 'data');
    process.env.OD_LEGACY_DATA_DIR = join(root, 'upstream', 'legacy');
    process.env.OD_PACKAGED_NAMESPACE_BASE_ROOT = join(root, 'upstream', 'namespaces');
    expect(existsSync(join(electronState.appData, 'Design Loom'))).toBe(false);
    const config = await readPackagedConfig();
    expect(electronState.name).toBe('Design Loom');
    expect(electronState.paths.get('userData')).toBe(join(electronState.appData, 'Design Loom'));
    expect(config.namespaceBaseRoot).toBe(join(electronState.appData, 'Design Loom', 'namespaces'));
    expect(config).toMatchObject({ namespace: 'design-loom', updateMetadataUrl: null, posthogKey: null, telemetryRelayUrl: null });
    expect(existsSync(join(root, 'upstream'))).toBe(false);
    expect(process.env.OD_LEGACY_DATA_DIR).toBeUndefined();
  });
});
