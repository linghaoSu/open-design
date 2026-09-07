// Snapshot materialization helpers shared by resource push / pull handlers.
//
// These are the only places the hub core touches the filesystem. A real hub
// would replace them with blob storage; the manifest digest algorithm is the
// part worth keeping identical because the daemon validates its shape.

import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export type SnapshotManifest = {
  /** `sha256:<64 hex>` over the sorted `path\0sha256\n` entries. */
  digest: string;
  entryCount: number;
};

/** Copy `sourceDir` into `snapshotDir`, replacing whatever was there. */
export async function materializeSnapshot(sourceDir: string, snapshotDir: string): Promise<void> {
  await rm(snapshotDir, { force: true, recursive: true });
  await cp(sourceDir, snapshotDir, { recursive: true });
}

/**
 * Replace `targetDir` with a copy of `snapshotDir`. The directory inode is
 * deliberately replaced: this is the production pull shape that used to orphan
 * an already-open member daemon's watcher, and the daemon's authorized pull
 * relies on the stage inode changing hands.
 */
export async function replaceDirectoryWithSnapshot(
  snapshotDir: string,
  targetDir: string,
): Promise<void> {
  await rm(targetDir, { force: true, recursive: true });
  await cp(snapshotDir, targetDir, { recursive: true });
}

export async function computeSnapshotManifest(snapshotDir: string): Promise<SnapshotManifest> {
  const entries = (await readdir(snapshotDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile());
  const lines: string[] = [];
  for (const entry of entries) {
    const absolute = join(entry.parentPath ?? entry.path, entry.name);
    const relativePath = relative(snapshotDir, absolute).split(sep).join('/');
    const fileHash = createHash('sha256').update(await readFile(absolute)).digest('hex');
    lines.push(`${relativePath}\0${fileHash}\n`);
  }
  lines.sort();
  const digest = createHash('sha256').update(lines.join('')).digest('hex');
  return { digest: `sha256:${digest}`, entryCount: entries.length };
}
