import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { resourcesRoot } from './index.js';

/** Reproduce the checked-in mac assets from this tool's authored SVG, without launching an app. */
export async function generateDesignLoomIcons(): Promise<void> {
  const resourceRoot = join(resourcesRoot, 'design-loom');
  const scratch = await mkdtemp(join(tmpdir(), 'design-loom-icons-'));
  const iconset = join(scratch, 'DesignLoom.iconset');
  await mkdir(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        await sharp(join(resourceRoot, 'icon.svg'), { density: 144 })
          .resize(size * scale, size * scale)
          .png()
          .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
      }
    }
    await sharp(join(resourceRoot, 'icon.svg'), { density: 144 }).resize(1024, 1024).png().toFile(join(resourceRoot, 'icon.png'));
    await promisify(execFile)('iconutil', ['-c', 'icns', iconset, '-o', join(resourceRoot, 'icon.icns')]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await generateDesignLoomIcons();
