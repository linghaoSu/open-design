import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBoundedPreviewSource } from '../../../src/services/design-runtime/preview-source.js';

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
});
