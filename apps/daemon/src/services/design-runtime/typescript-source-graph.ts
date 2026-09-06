import { posix } from 'node:path';
import { parse } from '@babel/parser';
import { SourcePathSchema } from '@open-design/contracts';

export type TypeScriptSourceFiles = ReadonlyMap<string, string>;
const MAX_FILES = 64;
const MAX_BYTES = 16 * 1024 * 1024;

export class TypeScriptSourceGraphError extends Error {
  constructor(message: string, readonly sourcePath: string, readonly line?: number, readonly column?: number) {
    super(`${sourcePath}${line === undefined ? '' : `:${line}:${column ?? 1}`}: ${message}`);
    this.name = 'TypeScriptSourceGraphError';
  }
}

/** A fixed project-relative lookup order shared by collection and syntax proof. */
export function localTypeSourceCandidates(sourcePath: string, specifier: string): string[] {
  if (!specifier.startsWith('.') || specifier.includes('\\') || /[?#]/.test(specifier)) return [];
  const path = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  if (!SourcePathSchema.safeParse(path).success) return [];
  if (/\.[cm]?jsx?$/.test(path)) return [path, path.replace(/\.[cm]?jsx?$/, '.ts'), path.replace(/\.[cm]?jsx?$/, '.tsx')];
  if (posix.extname(path)) return /\.(?:tsx?|jsx?)$/.test(path) ? [path] : [];
  return ['.ts', '.tsx', '.d.ts', '/index.ts', '/index.tsx', '.js', '.jsx'].map((suffix) => path + suffix);
}

/** Read bounded local module bytes through the caller's authorized reader. No
 * project modules, configs, package managers or compiler plugins are executed. */
export async function readTypeScriptSourceGraph(initial: TypeScriptSourceFiles, readSource: (path: string) => Promise<string>): Promise<Map<string, string>> {
  const files = new Map(initial);
  const pending = [...files.keys()]; const attempted = new Map<string, Promise<string | undefined>>();
  let bytes = [...files.values()].reduce((total, text) => total + Buffer.byteLength(text), 0);
  const assertBudget = () => { if (files.size > MAX_FILES || bytes > MAX_BYTES || [...files.values()].some((text) => Buffer.byteLength(text) > 4 * 1024 * 1024)) throw new TypeScriptSourceGraphError('Local TypeScript source graph exceeds its bounded file or byte budget.', pending.at(-1) ?? 'source'); };
  assertBudget();
  for (let position = 0; position < pending.length; position++) {
    const path = pending[position]!;
    if (!/\.[jt]sx?$/.test(path)) continue;
    let program: ReturnType<typeof parse>['program'];
    try { program = parse(files.get(path)!, { sourceType: 'module', sourceFilename: path, plugins: ['typescript', 'jsx'] }).program; }
    catch (error) {
      const location = error && typeof error === 'object' && 'loc' in error ? error.loc as { line?: number; column?: number } : undefined;
      throw new TypeScriptSourceGraphError(`Invalid TypeScript source: ${error instanceof Error ? error.message : String(error)}`, path, location?.line, location?.column === undefined ? undefined : location.column + 1);
    }
    const imports = program.body.flatMap((statement) => statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportAllDeclaration' ? statement.source ? [statement.source.value] : [] : []);
    for (const specifier of imports) for (const candidate of localTypeSourceCandidates(path, specifier)) {
      if (files.has(candidate)) break;
      let read = attempted.get(candidate);
      if (!read) { read = readSource(candidate).catch(() => undefined); attempted.set(candidate, read); }
      const text = await read;
      if (text === undefined) continue;
      files.set(candidate, text); pending.push(candidate); bytes += Buffer.byteLength(text); assertBudget(); break;
    }
  }
  return files;
}
