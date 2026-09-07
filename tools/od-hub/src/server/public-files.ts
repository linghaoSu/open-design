import { isSafeManifestPath } from '../shared/manifest.js';

/**
 * Anonymous public-file serving helpers for
 * `GET /api/v1/public/snapshots/:slug/files/*` (collab-sync.ts:563-565 builds
 * the URL by encoding each path segment separately).
 */

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  zip: 'application/zip',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json',
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Turn the raw (still percent-encoded) wildcard tail of the request path into
 * a manifest path, or null when it cannot be one: bad encoding, encoded or
 * literal traversal, absolute, backslash, NUL, or a path the manifest rules
 * (shared/manifest.ts isSafeManifestPath) would have rejected at publish.
 */
export function normalizePublicFilePath(rawTail: string): string | null {
  if (!rawTail) return null;
  let decoded: string;
  try {
    decoded = rawTail.split('/').map((segment) => decodeURIComponent(segment)).join('/');
  } catch {
    return null;
  }
  // A decoded segment containing "/" (from %2F) would alias another entry; reject.
  if (rawTail.split('/').some((segment) => { try { return decodeURIComponent(segment).includes('/'); } catch { return true; } })) return null;
  if (decoded.includes('\0') || decoded.includes('\\') || decoded.startsWith('/')) return null;
  if (!isSafeManifestPath(decoded)) return null;
  return decoded;
}
