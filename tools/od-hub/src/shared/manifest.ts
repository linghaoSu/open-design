import { createHash } from 'node:crypto';

/**
 * Content-addressed manifest model shared by the hub server and the od-vela
 * shim (PLAN §3.4). Both sides compute the same digest from the same entries so
 * a pull can prove the bytes it materialized are the bytes the author published.
 */

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
/** authorized-team-project-pull.ts:14 — shape the daemon requires of `manifestDigest`. */
export const MANIFEST_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** e2e/lib/collab-hub-core/commands.ts:1.1 (extract-2.md §1.1) — every hub resource kind. */
export const RESOURCE_KINDS = ['project', 'design_system', 'plugin', 'skill'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const PUBLISHED_REF = 'published';
/** Path-safe id: the hub routes resource ids as one path segment (team-resource-share.ts:169-171). */
export const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;

export interface ManifestEntry {
  /** POSIX-style relative path, no leading `./`, no `..` segment. */
  path: string;
  sha256: string;
  size: number;
  /** POSIX permission bits (e.g. 0o644 / 0o755). */
  mode: number;
}

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Reject paths that could escape the target directory or alias another entry:
 * absolute, `..`, `.` segments, empty segments, backslashes, and NUL (the
 * digest separator).
 */
export function isSafeManifestPath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/')) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Byte-wise ordering (not locale) so every implementation sorts identically. */
export function compareManifestPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort entries by path and validate every field. Throws on the first defect so
 * a malformed manifest never reaches the digest or the database.
 */
export function normalizeManifest(input: unknown): ManifestEntry[] {
  if (!Array.isArray(input)) throw new Error('manifest must be an array');
  if (input.length > 200_000) throw new Error('manifest has too many entries');
  const seen = new Set<string>();
  const entries: ManifestEntry[] = input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`manifest[${index}] must be an object`);
    const { path, sha256, size, mode } = raw as Record<string, unknown>;
    if (typeof path !== 'string' || !isSafeManifestPath(path)) throw new Error(`manifest[${index}] has an unsafe path`);
    if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) throw new Error(`manifest[${index}] has an invalid sha256`);
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Error(`manifest[${index}] has an invalid size`);
    if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new Error(`manifest[${index}] has an invalid mode`);
    if (seen.has(path)) throw new Error(`manifest has a duplicate path: ${path}`);
    seen.add(path);
    return { path, sha256, size, mode };
  });
  entries.sort((a, b) => compareManifestPaths(a.path, b.path));
  // File/directory prefix collision (`a` and `a/b`): the tree cannot be
  // materialized because one name must be both a file and a directory, so the
  // version would be unpullable. `seen` holds every file path; each entry's
  // ancestor directories must not be among them. (An adjacent-pair walk is
  // not enough: `a-x` sorts between `a` and `a/b` because '-' < '/'.)
  for (const entry of entries) {
    let cut = entry.path.indexOf('/');
    while (cut !== -1) {
      const ancestor = entry.path.slice(0, cut);
      if (seen.has(ancestor)) throw new Error(`manifest path collides with a file prefix: ${ancestor} and ${entry.path}`);
      cut = entry.path.indexOf('/', cut + 1);
    }
  }
  return entries;
}

/**
 * `'sha256:' + sha256(concat(path + '\0' + sha256 + '\n'))` over the sorted
 * entries — identical to e2e/lib/collab-hub-core/snapshots.ts computeSnapshotManifest
 * so a daemon sees the same digest for the same tree on both hubs.
 */
export function manifestDigest(entries: readonly ManifestEntry[]): string {
  const sorted = [...entries].sort((a, b) => compareManifestPaths(a.path, b.path));
  const hash = createHash('sha256');
  for (const entry of sorted) hash.update(`${entry.path}\0${entry.sha256}\n`);
  return `sha256:${hash.digest('hex')}`;
}

/** PLAN §3.4: `v<version>-<manifestDigest[7:19]>` — the 12 hex chars after `sha256:`. */
export function versionIdFor(version: number, digest: string): string {
  if (!MANIFEST_DIGEST_PATTERN.test(digest)) throw new Error('invalid manifest digest');
  return `v${version}-${digest.slice(7, 19)}`;
}

/**
 * Exclude semantics, reimplemented from apps/daemon/src/collab/vela-cli-resource-adapter.ts:81-132:
 *
 * - `--exclude <name>` (bare): matches an entry of that NAME at any depth,
 *   whatever its type (file, directory, symlink). vela-cli-resource-adapter.ts:103-106.
 * - `--exclude <name>/` (trailing slash): matches DIRECTORIES only. A regular
 *   file called `out` is kept. vela-cli-resource-adapter.ts:107-113.
 * - `--exclude-prefix <prefix>` (bare): entry name starts with prefix, any type
 *   (`.env` catches `.env.local` and an `.envrc` directory). :84-86.
 * - `--exclude-prefix <prefix>/` (trailing slash): directory-only prefix
 *   (`deriveddata-/`). :88-91.
 *
 * Matching is case-sensitive on the entry name only; paths never enter the rule.
 */
export interface ExcludeRules {
  exclude: readonly string[];
  excludePrefix: readonly string[];
}

export function createExcludeMatcher(rules: ExcludeRules): (name: string, isDirectory: boolean) => boolean {
  const anyType = new Set<string>();
  const dirOnly = new Set<string>();
  for (const raw of rules.exclude) {
    if (!raw) continue;
    if (raw.endsWith('/')) {
      const name = raw.slice(0, -1);
      if (name) dirOnly.add(name);
    } else {
      anyType.add(raw);
    }
  }
  const anyPrefix: string[] = [];
  const dirPrefix: string[] = [];
  for (const raw of rules.excludePrefix) {
    if (!raw) continue;
    if (raw.endsWith('/')) {
      const prefix = raw.slice(0, -1);
      if (prefix) dirPrefix.push(prefix);
    } else {
      anyPrefix.push(raw);
    }
  }
  return (name, isDirectory) => {
    if (anyType.has(name)) return true;
    if (isDirectory && dirOnly.has(name)) return true;
    if (anyPrefix.some((prefix) => name.startsWith(prefix))) return true;
    if (isDirectory && dirPrefix.some((prefix) => name.startsWith(prefix))) return true;
    return false;
  };
}
