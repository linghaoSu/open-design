import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  compareManifestPaths,
  createExcludeMatcher,
  manifestDigest,
  type ExcludeRules,
  type ManifestEntry,
} from '../shared/manifest.js';

/**
 * Local filesystem side of content addressing for the od-vela shim: snapshot
 * a directory into a manifest, materialize a manifest into a directory, and
 * swap directories atomically. Pure Node built-ins, no hub knowledge.
 */

export interface LocalEntry extends ManifestEntry {
  absolutePath: string;
}

export const DEFAULT_CONCURRENCY = 8;

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield;
    }
  });
  return hash.digest('hex');
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order of results. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Walk `root` applying the exclude rules to every entry NAME (never the path),
 * returning regular files only. Symbolic links and special files are skipped:
 * a manifest entry is (path, sha256, size, mode) and cannot represent them,
 * and following a link could pull content from outside the tree.
 */
export async function snapshotTree(root: string, rules: ExcludeRules): Promise<LocalEntry[]> {
  const excluded = createExcludeMatcher(rules);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`${root} is not a directory`);
  const files: Array<{ absolutePath: string; relativePath: string; mode: number; size: number }> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (excluded(entry.name, true)) continue;
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (excluded(entry.name, false)) continue;
      const info = await lstat(absolutePath);
      if (!info.isFile()) continue;
      files.push({ absolutePath, relativePath, mode: info.mode & 0o777, size: info.size });
    }
  };
  await walk(root, '');
  const hashed = await mapLimit(files, DEFAULT_CONCURRENCY, async (file): Promise<LocalEntry> => ({
    path: file.relativePath,
    sha256: await sha256File(file.absolutePath),
    size: file.size,
    mode: file.mode,
    absolutePath: file.absolutePath,
  }));
  hashed.sort((a, b) => compareManifestPaths(a.path, b.path));
  return hashed;
}

export type BlobFetcher = (sha256: string) => Promise<Readable>;

export interface MaterializeOptions {
  /** Directory whose files may be reused (hard-linked) when path+sha256+size match. */
  reuseFrom?: string | null;
  fetchBlob: BlobFetcher;
  concurrency?: number;
}

export interface MaterializeReport {
  reused: number;
  downloaded: number;
}

/**
 * Write `manifest` under `targetDir` (which must exist and be empty). Every
 * file is verified against its sha256 as it lands — a reused file is hashed
 * before linking, a downloaded stream is hashed on the way to disk and the
 * partial file removed on mismatch — then the digest over the written tree is
 * compared with `expectedDigest`. Any mismatch throws before the caller can
 * swap the directory into place.
 */
export async function materializeManifest(
  targetDir: string,
  manifest: readonly ManifestEntry[],
  expectedDigest: string,
  options: MaterializeOptions,
): Promise<MaterializeReport> {
  const computed = manifestDigest(manifest);
  if (computed !== expectedDigest) throw new Error(`manifest digest mismatch: hub says ${expectedDigest}, entries hash to ${computed}`);
  const report: MaterializeReport = { reused: 0, downloaded: 0 };
  const dirs = new Set<string>();
  for (const entry of manifest) {
    const dir = path.dirname(path.join(targetDir, entry.path));
    if (!dirs.has(dir)) {
      dirs.add(dir);
      await mkdir(dir, { recursive: true });
    }
  }
  await mapLimit(manifest, options.concurrency ?? DEFAULT_CONCURRENCY, async (entry) => {
    const target = path.join(targetDir, entry.path);
    if (options.reuseFrom && (await tryReuse(path.join(options.reuseFrom, entry.path), target, entry))) {
      report.reused += 1;
      return;
    }
    await downloadVerified(target, entry, options.fetchBlob);
    report.downloaded += 1;
  });
  // Belt and braces: re-derive the digest from what is now on disk.
  const onDisk = await snapshotTree(targetDir, { exclude: [], excludePrefix: [] });
  const diskDigest = manifestDigest(onDisk);
  if (diskDigest !== expectedDigest || onDisk.length !== manifest.length) {
    throw new Error(`materialized tree digest ${diskDigest} does not match ${expectedDigest}`);
  }
  return report;
}

async function tryReuse(candidate: string, target: string, entry: ManifestEntry): Promise<boolean> {
  let info;
  try {
    info = await lstat(candidate);
  } catch {
    return false;
  }
  if (!info.isFile() || info.size !== entry.size) return false;
  if ((await sha256File(candidate)) !== entry.sha256) return false;
  try {
    await link(candidate, target);
  } catch {
    // Cross-device or unsupported: fall back to a verified copy.
    await copyVerified(candidate, target, entry);
    return true;
  }
  if ((info.mode & 0o777) !== entry.mode) {
    // A hard link shares its mode with the live file; do not chmod the live
    // file from under its owner — copy instead.
    await rm(target, { force: true });
    await copyVerified(candidate, target, entry);
  }
  return true;
}

async function copyVerified(source: string, target: string, entry: ManifestEntry): Promise<void> {
  await writeVerified(target, createReadStream(source), entry);
}

async function downloadVerified(target: string, entry: ManifestEntry, fetchBlob: BlobFetcher): Promise<void> {
  await writeVerified(target, await fetchBlob(entry.sha256), entry);
}

async function writeVerified(target: string, source: Readable, entry: ManifestEntry): Promise<void> {
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      source,
      async function* (chunks) {
        for await (const chunk of chunks) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += buffer.length;
          hash.update(buffer);
          yield buffer;
        }
      },
      createWriteStream(target, { flags: 'wx', mode: entry.mode || 0o644 }),
    );
    const actual = hash.digest('hex');
    if (actual !== entry.sha256 || size !== entry.size) {
      throw new Error(`blob ${entry.sha256} for ${entry.path} failed verification (got ${actual}, ${size} bytes)`);
    }
    await chmod(target, entry.mode || 0o644);
  } catch (error) {
    await rm(target, { force: true }).catch(() => {});
    throw error;
  }
}

/** Fresh empty sibling directory of `dir` (same filesystem, so the final rename is atomic). */
export async function createSiblingStage(dir: string, label: string): Promise<string> {
  const parent = path.dirname(path.resolve(dir));
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, `.${path.basename(dir)}.${label}-`));
}

/**
 * Replace `dir` with `stage` so readers see either the complete old tree or the
 * complete new one, never a mix: `dir -> dir.old`, `stage -> dir`, then delete
 * `dir.old`. Returns the path the old tree was parked at (already removed on
 * success) so a caller can roll back if a later step fails. `dir` must not be
 * a symlink: renaming through one would replace the link target's parent entry.
 */
export async function swapDirectory(stage: string, dir: string): Promise<{ rollback(): Promise<void>; commit(): Promise<void> }> {
  const resolved = path.resolve(dir);
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing?.isSymbolicLink()) throw new Error(`${dir} is a symbolic link; refusing to replace it`);
  if (existing && !existing.isDirectory()) throw new Error(`${dir} exists and is not a directory`);
  const parked = `${resolved}.od-old-${process.pid}-${Date.now()}`;
  if (existing) await rename(resolved, parked);
  try {
    await rename(stage, resolved);
  } catch (error) {
    if (existing) await rename(parked, resolved).catch(() => {});
    throw error;
  }
  return {
    async commit() {
      if (existing) await rm(parked, { recursive: true, force: true });
    },
    async rollback() {
      const discard = `${resolved}.od-discard-${process.pid}-${Date.now()}`;
      await rename(resolved, discard);
      if (existing) await rename(parked, resolved);
      await rm(discard, { recursive: true, force: true });
    },
  };
}

export async function isEmptyDirectory(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return false;
  }
}

export function readableFromWeb(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>);
}
