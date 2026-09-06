import { createHash } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { SourcePathSchema, type DesignGenerationInventory, type DesignValidationSource, type ValidationDiagnostic } from '@open-design/contracts';

export interface GenerationInventoryEntry { path: string; digest: string | null; size: number; language: DesignValidationSource['language'] | null }
export type GenerationInventory = DesignGenerationInventory;
export interface CapturedGenerationInventory { inventory: GenerationInventory; sources: DesignValidationSource[] }
export interface GenerationInventoryLimits { maxEntries?: number; maxSourceBytes?: number; maxFileBytes?: number }
export interface GenerationInventoryIO {
  realpath(target: string): Promise<string>; lstat(target: string): Promise<Stats>;
  readdir(target: string): Promise<Dirent[]>; open(target: string): Promise<FileHandle>;
}
export const generationInventoryIO: GenerationInventoryIO = { realpath, lstat,
  readdir: (target) => readdir(target, { withFileTypes: true }),
  open: (target) => open(target, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)) };
// The daemon's immutable HTML history is evidence of earlier bytes, not live
// application source. An output/import into it remains unavailable to analysis.
const excluded = new Set(['.git', 'node_modules']);
const unsupported = new Set(['.scss', '.sass', '.less', '.styl', '.svelte', '.astro', '.mdx']);
export const generationDigest = (value: string | Uint8Array): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export function generationSourceLanguage(file: string): DesignValidationSource['language'] | null {
  const extension = path.posix.extname(file).toLowerCase();
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(extension)) return 'tsx';
  if (extension === '.vue') return 'vue';
  if (extension === '.html' || extension === '.htm') return 'html';
  return extension === '.css' ? 'css' : null;
}
export function generationInventoryDiagnostic(message: string, sourcePath?: string): ValidationDiagnostic {
  return { schemaVersion: 1, code: 'ODDS6005', severity: 'error', message,
    ...(sourcePath && SourcePathSchema.safeParse(sourcePath).success ? { location: { sourcePath, line: 1, column: 1 } } : {}) };
}

/** Complete within explicit bounds. Errors are evidence, never an analytics-style skipped file. */
export async function captureGenerationInventory(projectRoot: string, limits: GenerationInventoryLimits = {}, io: GenerationInventoryIO = generationInventoryIO): Promise<CapturedGenerationInventory> {
  const maxEntries = limits.maxEntries ?? 20_000;
  const maxSourceBytes = limits.maxSourceBytes ?? 64 * 1024 * 1024;
  const maxFileBytes = limits.maxFileBytes ?? 2 * 1024 * 1024;
  const files: GenerationInventoryEntry[] = []; const sources: DesignValidationSource[] = []; const diagnostics: ValidationDiagnostic[] = [];
  let root: string; let entriesSeen = 0; let bytesRead = 0; let capped = false;
  try { root = await io.realpath(projectRoot); }
  catch { diagnostics.push(generationInventoryDiagnostic('The authorized project root could not be inventoried.')); return finish(); }
  async function visit(directory: string, relative: string): Promise<void> {
    let entries: Dirent[];
    let directoryIdentity: Stats;
    try {
      await contained(directory); directoryIdentity = await io.lstat(directory);
      if (!directoryIdentity.isDirectory()) throw new Error('Directory changed.');
      entries = await io.readdir(directory);
      await contained(directory); const after = await io.lstat(directory);
      if (!after.isDirectory() || !sameIdentity(directoryIdentity, after)) throw new Error('Directory changed.');
    }
    catch { diagnostics.push(generationInventoryDiagnostic('A project directory could not be read completely.', relative)); return; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isDirectory() && (excluded.has(entry.name) || relative === '' && entry.name === '.file-versions')) continue;
      if (++entriesSeen > maxEntries) {
        if (!capped) diagnostics.push(generationInventoryDiagnostic('Project source inventory exceeded its entry limit.'));
        capped = true; return;
      }
      const sourcePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (!SourcePathSchema.safeParse(sourcePath).success) { diagnostics.push(generationInventoryDiagnostic('A project path cannot be represented by the canonical source-path contract.')); continue; }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { diagnostics.push(generationInventoryDiagnostic('A project symlink cannot establish a complete source inventory.', sourcePath)); continue; }
      if (entry.isDirectory()) { await visit(absolute, sourcePath); if (capped) return; continue; }
      if (!entry.isFile()) { diagnostics.push(generationInventoryDiagnostic('A project entry is not a regular source file.', sourcePath)); continue; }
      const language = generationSourceLanguage(sourcePath);
      let before;
      try { await contained(absolute); before = await io.lstat(absolute); }
      catch { diagnostics.push(generationInventoryDiagnostic('A project file disappeared or became unreadable during inventory.', sourcePath)); continue; }
      if (!before.isFile()) { diagnostics.push(generationInventoryDiagnostic('A project file changed identity during inventory.', sourcePath)); continue; }
      if (!language && !unsupported.has(path.extname(sourcePath).toLowerCase())) {
        files.push({ path: sourcePath, digest: null, size: before.size, language: null });
        continue;
      }
      if (!language) diagnostics.push(generationInventoryDiagnostic('This UI or style source language is outside deterministic validation coverage.', sourcePath));
      if (before.size > maxFileBytes || bytesRead + before.size > maxSourceBytes) {
        diagnostics.push(generationInventoryDiagnostic('A project source exceeded the validation byte limit.', sourcePath));
        files.push({ path: sourcePath, digest: null, size: before.size, language }); continue;
      }
      try {
        await contained(absolute);
        const handle = await io.open(absolute);
        let bytes: Buffer;
        try {
          const identity = await handle.stat();
          if (!identity.isFile() || !sameIdentity(identity, before)) throw new Error('Source identity changed.');
          // The read itself is bounded, including when the file grows after pre-stat.
          const capacity = Math.min(before.size + 1, maxFileBytes + 1, maxSourceBytes - bytesRead + 1);
          const buffer = Buffer.alloc(capacity); let offset = 0;
          while (offset < capacity) {
            const read = await handle.read(buffer, offset, capacity - offset, null);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          bytes = buffer.subarray(0, offset);
        } finally { await handle.close(); }
        bytesRead += bytes.length;
        await contained(absolute); const after = await io.lstat(absolute);
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.size !== before.size || bytes.length !== before.size) {
          diagnostics.push(generationInventoryDiagnostic('A project source changed while its bytes were being read.', sourcePath)); continue;
        }
        // An invalid UTF-8 replacement is not the source the author wrote.
        const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        files.push({ path: sourcePath, digest: generationDigest(bytes), size: bytes.length, language });
        if (language) sources.push({ sourcePath, language, sourceText });
      } catch { diagnostics.push(generationInventoryDiagnostic('A project source could not be read as stable UTF-8 bytes.', sourcePath)); }
    }
    try {
      await contained(directory);
      const after = await io.lstat(directory);
      const currentEntries = await io.readdir(directory);
      if (!after.isDirectory() || !sameIdentity(directoryIdentity, after)
        || after.mtimeMs !== directoryIdentity.mtimeMs || after.ctimeMs !== directoryIdentity.ctimeMs
        || currentEntries.map((entry) => entry.name).sort().join('\0') !== entries.map((entry) => entry.name).sort().join('\0')) {
        throw new Error('Directory entries or timestamps changed.');
      }
    } catch (error) { diagnostics.push(generationInventoryDiagnostic(`A project directory changed during source inventory: ${error instanceof Error ? error.message : String(error)}`, relative)); }
  }
  await visit(root, '');
  return finish();
  function finish(): CapturedGenerationInventory {
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    diagnostics.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
    return { inventory: { schemaVersion: 1, digest: generationDigest(JSON.stringify(files)), complete: diagnostics.length === 0, files, diagnostics }, sources };
  }
  async function contained(target: string): Promise<void> {
    const actual = await io.realpath(target);
    // No parent-directory symlink may redirect this snapshot, even to another in-root path.
    if (actual !== target || actual !== root && !actual.startsWith(`${root}${path.sep}`)) throw new Error('Source path left its authorized identity.');
  }
}

function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Always compare to the logical execution's initial baseline, including after a repair. */
export function generationInventoryChanges(before: GenerationInventory, after: GenerationInventory): { changed: string[]; deleted: string[] } {
  const previous = new Map(before.files.map((file) => [file.path, file])); const current = new Map(after.files.map((file) => [file.path, file]));
  return { changed: after.files.filter((file) => (file.language !== null || unsupported.has(path.posix.extname(file.path).toLowerCase())) && (!previous.has(file.path) || previous.get(file.path)!.digest !== file.digest || file.digest === null)).map((file) => file.path),
    deleted: before.files.filter((file) => (file.language !== null || unsupported.has(path.posix.extname(file.path).toLowerCase())) && !current.has(file.path)).map((file) => file.path) };
}
