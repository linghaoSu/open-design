import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { SHA256_HEX_PATTERN } from '../shared/manifest.js';

/**
 * Content-addressed blob store on local disk (PLAN §3.2 `blobs/<sha256>`).
 * Layout: `<root>/<aa>/<sha256>` where `aa` is the first two hex chars, so a
 * directory never holds millions of entries.
 *
 * Integrity invariants:
 *   - a blob file only ever appears under its own digest: the body is hashed
 *     while streaming to `<root>/tmp/<random>` and the temp file is renamed
 *     into place only after the digest matched (`put` rejects with
 *     `BlobDigestMismatchError` otherwise and removes the temp file);
 *   - `rename` is atomic on the same filesystem, so a reader never observes a
 *     partially written blob;
 *   - dedupe: if the final path already exists the temp file is discarded.
 */
export class BlobDigestMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`blob digest mismatch: expected ${expected}, got ${actual}`);
  }
}

export class BlobTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`blob exceeds ${limit} bytes`);
  }
}

export interface BlobStoreOptions {
  /** Upper bound on one blob body; default 512 MiB. */
  maxBytes?: number;
}

export class BlobStore {
  readonly root: string;
  private readonly maxBytes: number;
  private readonly tmpDir: string;
  private counter = 0;

  constructor(root: string, options: BlobStoreOptions = {}) {
    this.root = path.resolve(root);
    this.tmpDir = path.join(this.root, 'tmp');
    this.maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  }

  pathFor(sha256: string): string {
    if (!SHA256_HEX_PATTERN.test(sha256)) throw new Error('invalid sha256');
    return path.join(this.root, sha256.slice(0, 2), sha256);
  }

  async has(sha256: string): Promise<boolean> {
    if (!SHA256_HEX_PATTERN.test(sha256)) return false;
    try {
      return (await stat(this.pathFor(sha256))).isFile();
    } catch {
      return false;
    }
  }

  async size(sha256: string): Promise<number | null> {
    try {
      return (await stat(this.pathFor(sha256))).size;
    } catch {
      return null;
    }
  }

  /** Subset of `digests` that is not yet stored, in input order, de-duplicated. */
  async missing(digests: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const digest of digests) {
      if (seen.has(digest)) continue;
      seen.add(digest);
      if (!(await this.has(digest))) out.push(digest);
    }
    return out;
  }

  /**
   * Stream `body` to disk, verifying it hashes to `expectedSha256`. Returns the
   * byte size. Safe under concurrent puts of the same digest: each writer has
   * its own temp file and the final rename is idempotent.
   */
  async put(expectedSha256: string, body: Readable): Promise<{ size: number; created: boolean }> {
    const finalPath = this.pathFor(expectedSha256);
    const existing = await this.size(expectedSha256);
    if (existing !== null) {
      // Already stored under its own digest: nothing to verify, nothing to
      // write. Drain the body so the socket stays reusable, then dedupe.
      await drain(body);
      return { size: existing, created: false };
    }
    await mkdir(this.tmpDir, { recursive: true });
    this.counter += 1;
    const tmpPath = path.join(this.tmpDir, `${process.pid}-${Date.now()}-${this.counter}-${expectedSha256.slice(0, 8)}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const limit = this.maxBytes;
    const meter = async function* (source: AsyncIterable<Buffer | string>) {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > limit) throw new BlobTooLargeError(limit);
        hash.update(buffer);
        yield buffer;
      }
    };
    try {
      await pipeline(body, meter, createWriteStream(tmpPath, { flags: 'wx', mode: 0o600 }));
      const actual = hash.digest('hex');
      if (actual !== expectedSha256) throw new BlobDigestMismatchError(expectedSha256, actual);
      await mkdir(path.dirname(finalPath), { recursive: true });
      if (await this.has(expectedSha256)) {
        await rm(tmpPath, { force: true });
        return { size, created: false };
      }
      await rename(tmpPath, finalPath);
      return { size, created: true };
    } catch (error) {
      await rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Read stream for one blob; the caller must have checked `has()` (or handle
   * ENOENT). Blobs are never hard-linked out of the store: a consumer editing
   * a linked file in place would silently corrupt every version that shares it.
   */
  open(sha256: string): Readable {
    return createReadStream(this.pathFor(sha256));
  }
}

/** Consume and discard a readable (used to keep a keep-alive socket usable after a short-circuited PUT). */
async function drain(body: Readable): Promise<void> {
  if (body.readableEnded || body.destroyed) return;
  await new Promise<void>((resolve) => {
    body.once('end', resolve).once('close', resolve).once('error', () => resolve());
    body.resume();
  });
}
