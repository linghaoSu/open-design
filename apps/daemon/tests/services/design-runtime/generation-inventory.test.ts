import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { captureGenerationInventory, generationInventoryChanges, generationInventoryIO } from '../../../src/services/design-runtime/generation-inventory.js';

const roots: string[] = [];
async function root() { const value = await realpath(await mkdtemp(path.join(os.tmpdir(), 'od-generation-inventory-'))); roots.push(value); return value; }
afterEach(async () => { for (const value of roots.splice(0)) await rm(value, { recursive: true, force: true }); });

describe('complete generation source inventory', () => {
  it('hashes Vue and hidden source bytes and detects same-size same-mtime rewrites', async () => {
    const dir = await root(); await mkdir(path.join(dir, '.pages')); const file = path.join(dir, '.pages', 'View.vue');
    await writeFile(file, '<template>first</template>'); await utimes(file, 1000, 1000);
    const before = await captureGenerationInventory(dir);
    await writeFile(file, '<template>later</template>'); await utimes(file, 1000, 1000);
    const after = await captureGenerationInventory(dir);
    expect(before.inventory.complete).toBe(true); expect(after.inventory.complete).toBe(true);
    expect(after.sources[0]).toMatchObject({ sourcePath: '.pages/View.vue', language: 'vue', sourceText: '<template>later</template>' });
    expect(generationInventoryChanges(before.inventory, after.inventory)).toEqual({ changed: ['.pages/View.vue'], deleted: [] });
    expect((await captureGenerationInventory(dir)).inventory).toEqual(after.inventory);
  });
  it('excludes daemon-owned historical HTML without excluding ordinary hidden source', async () => {
    const dir = await root(); await mkdir(path.join(dir, '.file-versions')); await mkdir(path.join(dir, '.pages')); await mkdir(path.join(dir, '.pages', '.file-versions'));
    await writeFile(path.join(dir, '.pages', '.file-versions', 'nested.html'), '<main>Application source</main>');
    await writeFile(path.join(dir, '.file-versions', 'original.html'), '<main style="color:red">Old</main>');
    await writeFile(path.join(dir, '.pages', 'current.html'), '<main>Current</main>');
    const captured = await captureGenerationInventory(dir);
    expect(captured.inventory.complete).toBe(true);
    expect(captured.sources.map((source) => source.sourcePath)).toEqual(['.pages/.file-versions/nested.html', '.pages/current.html']);
  });
  it('keeps attempt-zero edits and deleted required source in the logical baseline diff', async () => {
    const dir = await root(); await writeFile(path.join(dir, 'index.html'), '<main>original</main>');
    const baseline = await captureGenerationInventory(dir);
    await writeFile(path.join(dir, 'extra.tsx'), 'export function Extra(){return <button/>}');
    await rm(path.join(dir, 'index.html'));
    const first = await captureGenerationInventory(dir); const second = await captureGenerationInventory(dir);
    expect(generationInventoryChanges(baseline.inventory, second.inventory)).toEqual({ changed: ['extra.tsx'], deleted: ['index.html'] });
    expect(first.inventory).toEqual(second.inventory);
  });
  it('reports limits, unsupported style language, and symbolic paths instead of skipping evidence', async () => {
    const dir = await root(); await writeFile(path.join(dir, 'a.css'), 'main{color:red}'); await writeFile(path.join(dir, 'b.scss'), '$c:red');
    await symlink(path.join(dir, 'a.css'), path.join(dir, 'alias.css'));
    const captured = await captureGenerationInventory(dir, { maxFileBytes: 3 });
    expect(captured.inventory.complete).toBe(false);
    expect(captured.inventory.diagnostics.map((issue) => issue.location?.sourcePath)).toEqual(expect.arrayContaining(['a.css', 'b.scss', 'alias.css']));
    expect((await captureGenerationInventory(dir, { maxEntries: 1 })).inventory.complete).toBe(false);
  });
  it('rejects a directory replaced by an outside symlink after its parent dirent was read', async () => {
    const dir = await root(); const outside = await root(); await mkdir(path.join(dir, 'pages')); await writeFile(path.join(outside, 'Secret.tsx'), 'outside bytes');
    let swapped = false; const opened: string[] = [];
    const result = await captureGenerationInventory(dir, {}, { ...generationInventoryIO,
      readdir: async (target) => {
        const entries = await generationInventoryIO.readdir(target);
        if (target === dir && !swapped) { swapped = true; await rename(path.join(dir, 'pages'), path.join(dir, 'old')); await symlink(outside, path.join(dir, 'pages')); }
        return entries;
      },
      open: async (target) => { opened.push(target); return generationInventoryIO.open(target); },
    });
    expect(swapped).toBe(true); expect(result.inventory.complete).toBe(false); expect(result.sources).toEqual([]); expect(opened).toEqual([]);
    expect(result.inventory.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ location: { sourcePath: 'pages', line: 1, column: 1 } })]));
  });
  it('bounds the actual handle read when source grows between pre-stat and open', async () => {
    const dir = await root(); const file = path.join(dir, 'index.html'); await writeFile(file, 'small');
    const reads: number[] = [];
    const result = await captureGenerationInventory(dir, { maxFileBytes: 32, maxSourceBytes: 32 }, { ...generationInventoryIO,
      open: async (target) => {
        await writeFile(target, 'x'.repeat(1_000_000));
        const handle = await generationInventoryIO.open(target);
        const read = handle.read.bind(handle);
        handle.read = ((buffer: Buffer, offset: number, length: number, position: number | null) => { reads.push(length); return read(buffer, offset, length, position); }) as typeof handle.read;
        return handle;
      },
    });
    expect(result.inventory.complete).toBe(false); expect(result.sources).toEqual([]);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(33);
  });
  it('reports an unreadable directory and never treats its missing files as complete', async () => {
    const dir = await root(); await mkdir(path.join(dir, 'pages'));
    const result = await captureGenerationInventory(dir, {}, { ...generationInventoryIO, readdir: async (target) => {
      if (target.endsWith('/pages')) throw new Error('EACCES'); return generationInventoryIO.readdir(target);
    } });
    expect(result.inventory.complete).toBe(false); expect(result.inventory.diagnostics[0]?.location?.sourcePath).toBe('pages');
  });
  it('does not certify a directory when another source appears after its entries were listed', async () => {
    const dir = await root(); await writeFile(path.join(dir, 'index.html'), '<main>Known</main>');
    let created = false;
    const result = await captureGenerationInventory(dir, {}, { ...generationInventoryIO, open: async (target) => {
      if (!created) { created = true; await writeFile(path.join(dir, 'unlisted.html'), '<button style="color:red">Hidden</button>'); }
      return generationInventoryIO.open(target);
    } });
    expect(created).toBe(true); expect(result.inventory.complete).toBe(false);
    expect(result.inventory.diagnostics.some((issue) => issue.message.includes('directory'))).toBe(true);
  });
  it.skipIf(process.platform === 'win32')('does not block when a regular source becomes a FIFO before open', async () => {
    const dir = await root(); const file = path.join(dir, 'index.html'); await writeFile(file, '<main/>');
    const result = await captureGenerationInventory(dir, {}, { ...generationInventoryIO, open: async (target) => {
      await rm(target); execFileSync('mkfifo', [target]); return generationInventoryIO.open(target);
    } });
    expect(result.inventory.complete).toBe(false); expect(result.sources).toEqual([]);
    expect(result.inventory.diagnostics.some((issue) => issue.location?.sourcePath === 'index.html')).toBe(true);
  });

});
