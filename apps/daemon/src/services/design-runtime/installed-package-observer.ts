import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { codeImportPackageName, DesignSystemSemVerSchema, type HandoffTargetPackage } from '@open-design/contracts';

/** Package names are lookup identities, never caller-controlled paths or import subpaths. */
export function isObservablePackageName(name: string): boolean {
  return codeImportPackageName(name) === name;
}

async function readManifest(path: string): Promise<Record<string, unknown> | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    // Package metadata is bounded; do not read devices, FIFOs, or unbounded growing files.
    if (!info.isFile() || info.size > 1024 * 1024) return;
    const bytes = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > info.size) return;
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return; }
  finally { await file?.close(); }
}

/** Observes installed manifests using Node's project lookup order without importing package code.
 * Direct metadata reads support export-restricted packages and pnpm-linked installations.
 */
export async function observeInstalledTargetPackages(projectRoot: string, names: readonly string[]): Promise<HandoffTargetPackage[]> {
  const root = resolve(projectRoot); const declared = await readManifest(join(root, 'package.json'));
  const require = createRequire(join(root, 'package.json'));
  const projectLookups = new Set<string>();
  for (let parent = root; ; parent = dirname(parent)) {
    projectLookups.add(join(parent, 'node_modules'));
    if (dirname(parent) === parent) break;
  }
  return Promise.all([...new Set(names)].sort().map(async (name): Promise<HandoffTargetPackage> => {
    const result: HandoffTargetPackage = { name, installation: { status: 'unknown' } };
    if (!isObservablePackageName(name)) return result;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const entries = declared?.[field];
      if (entries && typeof entries === 'object' && !Array.isArray(entries) && Object.hasOwn(entries, name)) {
        const range = (entries as Record<string, unknown>)[name];
        if (typeof range === 'string' && range.length) { result.declaredRange = range; break; }
      }
    }
    for (const lookup of require.resolve.paths(name) ?? []) {
      if (!projectLookups.has(lookup)) continue;
      const directory = join(lookup, name);
      try { if (!(await stat(directory)).isDirectory()) continue; } catch { continue; }
      const installed = await readManifest(join(directory, 'package.json'));
      const version = DesignSystemSemVerSchema.safeParse(installed?.version);
      if (installed?.name === name && version.success) result.installation = { status: 'observed', version: version.data };
      // A nearer malformed installation cannot be replaced by a different ancestor's version.
      break;
    }
    return result;
  }));
}
