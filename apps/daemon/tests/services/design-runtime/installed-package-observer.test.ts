import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeImportPackageName } from '@open-design/contracts';
import { isObservablePackageName, observeInstalledTargetPackages } from '../../../src/services/design-runtime/installed-package-observer.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function fixture() { const directory = await mkdtemp(join(tmpdir(), 'od-installed-package-')); directories.push(directory); return directory; }
async function json(path: string, value: unknown) { await writeFile(path, JSON.stringify(value)); }

describe('installed target package observations', () => {
  it('observes exact scoped installation through pnpm links despite package exports without executing package source', async () => {
    const directory = await fixture(); const project = join(directory, 'project'); const installed = join(directory, 'store', 'ui');
    await mkdir(join(project, 'node_modules', '@acme'), { recursive: true }); await mkdir(installed, { recursive: true });
    await json(join(project, 'package.json'), { dependencies: { '@acme/ui': '^1.0.0' } });
    await json(join(installed, 'package.json'), { name: '@acme/ui', version: '1.2.3', exports: { './button': './button.js' } });
    const sentinel = join(directory, 'executed');
    await writeFile(join(installed, 'button.js'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
    await symlink(installed, join(project, 'node_modules', '@acme', 'ui'), 'dir');
    expect(await observeInstalledTargetPackages(project, ['@acme/ui', '@acme/ui'])).toEqual([{ name: '@acme/ui', declaredRange: '^1.0.0', installation: { status: 'observed', version: '1.2.3' } }]);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps declarations, malformed manifests and unavailable installations unknown', async () => {
    const project = await fixture(); await mkdir(join(project, 'node_modules', 'ui'), { recursive: true });
    await json(join(project, 'package.json'), { dependencies: { missing: 'latest', ui: '^1.0.0' } });
    await json(join(project, 'node_modules', 'ui', 'package.json'), { name: 'ui', version: '^1.0.0' });
    expect(await observeInstalledTargetPackages(project, ['missing', 'ui'])).toEqual([
      { name: 'missing', declaredRange: 'latest', installation: { status: 'unknown' } },
      { name: 'ui', declaredRange: '^1.0.0', installation: { status: 'unknown' } },
    ]);
    await json(join(project, 'node_modules', 'ui', 'package.json'), { name: 'different', version: '1.2.3' });
    expect((await observeInstalledTargetPackages(project, ['ui']))[0]!.installation.status).toBe('unknown');
  });

  it('uses project ancestry while refusing to substitute a farther valid package for a nearer malformed one', async () => {
    const directory = await fixture(); const project = join(directory, 'workspace', 'app');
    await mkdir(join(directory, 'node_modules', 'ui'), { recursive: true }); await mkdir(project, { recursive: true });
    await json(join(directory, 'node_modules', 'ui', 'package.json'), { name: 'ui', version: '2.0.0' });
    expect((await observeInstalledTargetPackages(project, ['ui']))[0]!.installation).toEqual({ status: 'observed', version: '2.0.0' });
    await mkdir(join(project, 'node_modules', 'ui'), { recursive: true }); await writeFile(join(project, 'node_modules', 'ui', 'package.json'), 'broken');
    expect((await observeInstalledTargetPackages(project, ['ui']))[0]!.installation).toEqual({ status: 'unknown' });
  });

  it('derives npm roots from supported subpath imports and rejects path/URL injection before lookup', async () => {
    expect(codeImportPackageName('@acme/ui/button')).toBe('@acme/ui'); expect(codeImportPackageName('ui/button.js')).toBe('ui');
    for (const value of ['../secret', '/secret', '@acme/ui/../secret', '@acme/ui//button', 'file:secret', 'https://host/ui', 'ui?query', 'ui#hash', 'ui\\secret', 'ui/%2e%2e/secret']) expect(codeImportPackageName(value)).toBeNull();
    expect(isObservablePackageName('@acme/ui/button')).toBe(false);
    const directory = await fixture();
    expect(await observeInstalledTargetPackages(directory, ['../secret'])).toEqual([{ name: '../secret', installation: { status: 'unknown' } }]);
  });
});
