import { describe, expect, it, vi } from 'vitest';
import { createDesignSystemVersion, createProjectDesignSystemLock, resolveLockedDesignSystems, resolveLockedDesignSystemsSync } from '../../../src/services/design-runtime/design-system-version.js';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';

describe('shared sync and async exact-lock evaluation', () => {
  it('gives identical verification results for exact, missing, tampered and substituted packages', async () => {
    const version = createDesignSystemVersion(packageFixture());
    const lock = createProjectDesignSystemLock('project', [version]);
    const declared = { schemaVersion: 1 as const, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] };
    const tampered = structuredClone(version); tampered.package.source.files[0]!.content += 'tampered';
    for (const loaded of [version, null, tampered, createDesignSystemVersion(packageFixture('1.1.0'))]) {
      expect(resolveLockedDesignSystemsSync(declared, lock, () => loaded)).toEqual(await resolveLockedDesignSystems(declared, lock, async () => loaded));
    }
    const invalid = { ...declared, dependencies: [{ designSystemId: 'acme', version: '^2.0.0' }] };
    const loader = vi.fn(() => version);
    expect(resolveLockedDesignSystemsSync(invalid, lock, loader)).toEqual(await resolveLockedDesignSystems(invalid, lock, loader));
    expect(loader).not.toHaveBeenCalled();
  });
});
