import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createExcludeMatcher,
  isSafeManifestPath,
  MANIFEST_DIGEST_PATTERN,
  manifestDigest,
  normalizeManifest,
  versionIdFor,
} from '../src/shared/manifest.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('manifestDigest (PLAN §3.4, e2e snapshots.ts computeSnapshotManifest)', () => {
  it('matches the reference algorithm: sha256 over sorted `path\\0sha256\\n` lines', () => {
    const entries = [
      { path: 'index.html', sha256: sha('a'), size: 1, mode: 0o644 },
      { path: 'assets/style.css', sha256: sha('b'), size: 1, mode: 0o644 },
    ];
    // Reference: e2e/lib/collab-hub-core/snapshots.ts:39-49 (lines sorted lexicographically).
    const lines = entries.map((e) => `${e.path}\0${e.sha256}\n`).sort();
    const expected = `sha256:${createHash('sha256').update(lines.join('')).digest('hex')}`;
    expect(manifestDigest(entries)).toBe(expected);
    expect(manifestDigest(entries)).toMatch(MANIFEST_DIGEST_PATTERN);
    // Order of input does not matter.
    expect(manifestDigest([...entries].reverse())).toBe(expected);
  });

  it('known vector', () => {
    const entries = [{ path: 'a.txt', sha256: sha('hello'), size: 5, mode: 0o644 }];
    const line = `a.txt\0${sha('hello')}\n`;
    expect(manifestDigest(entries)).toBe(`sha256:${createHash('sha256').update(line).digest('hex')}`);
    // Empty tree has a digest too (a resource can be published empty).
    expect(manifestDigest([])).toBe(`sha256:${createHash('sha256').update('').digest('hex')}`);
  });

  it('size and mode do not enter the digest (content identity only), path and sha do', () => {
    const base = { path: 'x', sha256: sha('x'), size: 1, mode: 0o644 };
    expect(manifestDigest([base])).toBe(manifestDigest([{ ...base, size: 99, mode: 0o755 }]));
    expect(manifestDigest([base])).not.toBe(manifestDigest([{ ...base, path: 'y' }]));
    expect(manifestDigest([base])).not.toBe(manifestDigest([{ ...base, sha256: sha('y') }]));
  });
});

describe('versionIdFor', () => {
  it('is v<version>-<digest[7:19]>', () => {
    const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;
    expect(versionIdFor(3, digest)).toBe('v3-0123456789ab');
    expect(() => versionIdFor(1, 'nope')).toThrow();
  });
});

describe('normalizeManifest', () => {
  it('sorts by path bytewise and validates fields', () => {
    const out = normalizeManifest([
      { path: 'b', sha256: sha('b'), size: 1, mode: 0o644 },
      { path: 'B', sha256: sha('B'), size: 1, mode: 0o644 },
      { path: 'a/b', sha256: sha('ab'), size: 2, mode: 0o755 },
    ]);
    expect(out.map((e) => e.path)).toEqual(['B', 'a/b', 'b']);
  });

  it.each([
    [[{ path: '../x', sha256: sha('a'), size: 1, mode: 0o644 }], /unsafe path/],
    [[{ path: '/abs', sha256: sha('a'), size: 1, mode: 0o644 }], /unsafe path/],
    [[{ path: 'a//b', sha256: sha('a'), size: 1, mode: 0o644 }], /unsafe path/],
    [[{ path: 'a\\b', sha256: sha('a'), size: 1, mode: 0o644 }], /unsafe path/],
    [[{ path: './a', sha256: sha('a'), size: 1, mode: 0o644 }], /unsafe path/],
    [[{ path: 'a', sha256: 'zz', size: 1, mode: 0o644 }], /invalid sha256/],
    [[{ path: 'a', sha256: sha('a'), size: -1, mode: 0o644 }], /invalid size/],
    [[{ path: 'a', sha256: sha('a'), size: 1, mode: 0o10000 }], /invalid mode/],
    [[{ path: 'a', sha256: sha('a'), size: 1, mode: 0o644 }, { path: 'a', sha256: sha('b'), size: 1, mode: 0o644 }], /duplicate path/],
    [[{ path: 'a', sha256: sha('a'), size: 1, mode: 0o644 }, { path: 'a/b', sha256: sha('b'), size: 1, mode: 0o644 }], /collides with a file prefix/],
    [[{ path: 'a/b/c', sha256: sha('a'), size: 1, mode: 0o644 }, { path: 'a-x', sha256: sha('c'), size: 1, mode: 0o644 }, { path: 'a', sha256: sha('b'), size: 1, mode: 0o644 }], /collides with a file prefix/],
    ['nope', /must be an array/],
  ])('rejects %j', (input, message) => {
    expect(() => normalizeManifest(input)).toThrow(message);
  });

  it('isSafeManifestPath', () => {
    expect(isSafeManifestPath('a/b/c.txt')).toBe(true);
    expect(isSafeManifestPath('.env')).toBe(true);
    expect(isSafeManifestPath('')).toBe(false);
    expect(isSafeManifestPath('a/../b')).toBe(false);
    expect(isSafeManifestPath('a\0b')).toBe(false);
  });
});

/**
 * Table copied from the contract in apps/daemon/src/collab/vela-cli-resource-adapter.ts:81-132:
 *   :103-106 bare name  -> any entry type, any depth
 *   :107-113 `name/`    -> directories only (a regular file `out` is kept)
 *   :84-86   `.env`     -> bare prefix, any type (.env.local file, .envrc dir)
 *   :88-91   `deriveddata-/` -> directory-only prefix
 *   :115-121 an unknown trailing-slash rule matches nothing on names (never contain '/')
 */
describe('createExcludeMatcher (vela-cli-resource-adapter.ts:81-132)', () => {
  const matcher = createExcludeMatcher({
    exclude: ['.git', 'node_modules', 'terraform.tfstate', 'dist/', 'out/', 'target/'],
    excludePrefix: ['.env', 'deriveddata-/'],
  });
  it.each<[string, boolean, boolean, string]>([
    ['.git', true, true, ':103 bare matches directory'],
    ['.git', false, true, ':103 bare matches file of the same name'],
    ['node_modules', true, true, 'bare, dir'],
    ['terraform.tfstate', false, true, 'bare, file'],
    ['dist', true, true, ':107 trailing slash matches directory'],
    ['dist', false, false, ':110 trailing slash keeps a regular file named dist'],
    ['out', false, false, ':110 regular file `out` survives'],
    ['out', true, true, 'directory `out` is dropped'],
    ['target', false, false, ':110 regular file `target` survives'],
    ['dist/', false, false, 'entry names never contain a slash'],
    ['.env', false, true, ':84 .env file'],
    ['.env.local', false, true, ':84 prefix .env matches .env.local'],
    ['.envrc', true, true, ':85 .envrc directory'],
    ['environment.ts', false, false, 'prefix is case-sensitive and anchored'],
    ['deriveddata-abc', true, true, ':88 directory-only prefix, dir'],
    ['deriveddata-abc', false, false, ':90 regular file starting with deriveddata- is content'],
    ['DerivedData-x', true, false, 'case-sensitive'],
    ['index.html', false, false, 'unrelated file'],
    ['src', true, false, 'unrelated dir'],
  ])('%s (dir=%s) -> %s  // %s', (name, isDir, expected) => {
    expect(matcher(name, isDir)).toBe(expected);
  });

  it('ignores empty rules and a bare slash', () => {
    const m = createExcludeMatcher({ exclude: ['', '/'], excludePrefix: ['', '/'] });
    expect(m('anything', true)).toBe(false);
    expect(m('anything', false)).toBe(false);
  });
});
