import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBoundedPreviewSource, readBoundedProjectSourceBytes } from '../../../src/services/design-runtime/preview-source.js';
import { decodeDesignRuntimeSource } from '../../../src/services/design-runtime/source-text.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe('bounded authorized preview source reads', () => {
  it('reads UTF-8 regular files and rejects oversized files before allocating their contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-preview-source-')); directories.push(root); const path = join(root, 'Component.tsx');
    await writeFile(path, 'export const label = "组件";'); expect(await readBoundedPreviewSource(path, root)).toContain('组件');
    await truncate(path, 128 * 1024 * 1024); await expect(readBoundedPreviewSource(path, root)).rejects.toThrow(/bounded/);
  });
  it('rejects outside-root paths and symlink escapes and does not accept directories as source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-preview-source-')); const outside = await mkdtemp(join(tmpdir(), 'od-preview-outside-')); directories.push(root, outside);
    const path = join(outside, 'Secret.ts'); await writeFile(path, 'secret'); await symlink(path, join(root, 'Link.ts'));
    await expect(readBoundedPreviewSource(path, root)).rejects.toThrow(/escapes/);
    await expect(readBoundedPreviewSource(join(root, 'Link.ts'), root)).rejects.toThrow(/escapes/);
    await expect(readBoundedPreviewSource(root, root)).rejects.toThrow(/escapes/);
  });
  it('preserves opaque binary assets and BOM/CRLF source bytes for immutable migration bundles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-migration-bytes-')); directories.push(root);
    const image = Buffer.from([137, 80, 78, 71, 0, 255, 254, 1]); const text = Buffer.from('\ufeff# Source\r\n');
    await writeFile(join(root, 'logo.png'), image); await writeFile(join(root, 'DESIGN.md'), text);
    expect(await readBoundedProjectSourceBytes(join(root, 'logo.png'), root)).toEqual(image);
    expect(Buffer.from(decodeDesignRuntimeSource(await readBoundedProjectSourceBytes(join(root, 'DESIGN.md'), root)), 'utf8')).toEqual(text);
  });
});
