import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { DesignPreviewError } from './preview-preparation.js';

/** The caller first applies the project's path visibility rules. Physical roots never come from preview DTOs. */
export async function readBoundedPreviewSource(filePath: string, authorizedRoot: string): Promise<string> {
  const root = await realpath(authorizedRoot); const path = await realpath(filePath);
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) throw new DesignPreviewError('INVALID_REQUEST', 'Preview source escapes its authorized project root.');
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await file.stat();
    const located = await stat(path);
    if (!initial.isFile() || initial.size > 4 * 1024 * 1024 || initial.dev !== located.dev || initial.ino !== located.ino || await realpath(path) !== path) throw new DesignPreviewError('INVALID_REQUEST', 'Preview source must be a bounded, stable regular file.');
    const buffer = Buffer.alloc(initial.size + 1); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const final = await file.stat();
    if (offset !== initial.size || final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw new DesignPreviewError('CONFLICT', 'Preview source changed while being read.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally { await file.close(); }
}
