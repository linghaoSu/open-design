import {
  CompileComponentRegistryRequestSchema,
  CompileComponentRegistryResultSchema,
  type CompileComponentRegistryRequest,
  type CompileComponentRegistryResult,
} from '@open-design/contracts';
import { CompilerError } from './react-compiler.js';
import { compileSourceComponent } from './source-compiler.js';
import { compileStorybookMetadata } from './storybook-compiler.js';
import type { TypeScriptSourceFiles } from './typescript-source-graph.js';

type Selection = CompileComponentRegistryRequest['selections'][number];

/**
 * Compile explicit source selections into one independent registry snapshot.
 * All identities and source snapshots are checked before extraction. No result
 * escapes until every selection and the combined contract have been validated.
 * Source and Storybook support remain conservative, syntax-only compiler subsets.
 */
export function compileComponentRegistry(input: CompileComponentRegistryRequest, sourceFiles?: TypeScriptSourceFiles): CompileComponentRegistryResult {
  const request = CompileComponentRegistryRequestSchema.parse(input);
  const selections = request.selections.sort((left, right) => compareIds(left.componentId, right.componentId));
  validateSourceSnapshots(selections);

  const compiled = selections.map(({ storySources, framework, ...selection }) => {
    let result = compileSourceComponent({ ...selection, framework: framework ?? 'react', designSystemId: request.designSystemId }, sourceFiles);
    for (const source of (storySources ?? []).slice().sort((a, b) => compareIds(a.sourcePath, b.sourcePath))) {
      result = compileStorybookMetadata({ ...source, compiled: result });
    }
    return result;
  });

  return CompileComponentRegistryResultSchema.parse({
    schemaVersion: 1,
    registry: {
      schemaVersion: 1,
      id: request.designSystemId,
      components: compiled.flatMap((result) => result.registry.components),
    },
    codeIndex: {
      schemaVersion: 1,
      id: request.designSystemId,
      components: compiled.map((result) => result.codeComponent)
        .sort((left, right) => compareIds(left.id, right.id)),
    },
    bindings: compiled.map((result) => result.binding)
      .sort((left, right) => compareIds(left.id, right.id)),
  });
}

/** One source path names one source snapshot and package within a compilation. */
function validateSourceSnapshots(selections: readonly Selection[]): void {
  const sources = new Map<string, Selection>();
  const texts = new Map<string, string>();
  for (const selection of selections) {
    const previous = sources.get(selection.sourcePath);
    if (previous && (previous.sourceText !== selection.sourceText || previous.packageName !== selection.packageName || (previous.framework ?? 'react') !== (selection.framework ?? 'react'))) {
      throw new CompilerError(
        'Selections from the same source path must share identical source text and package metadata and framework',
        selection.sourcePath,
        selection.exportName,
      );
    }
    sources.set(selection.sourcePath, selection);
    for (const source of [selection, ...selection.storySources ?? []]) {
      if (texts.has(source.sourcePath) && texts.get(source.sourcePath) !== source.sourceText) throw new CompilerError('Every selected source path must identify one identical source snapshot', source.sourcePath, selection.exportName);
      texts.set(source.sourcePath, source.sourceText);
    }
  }
}

/** Code-unit ordering is stable across the host locale and input selection order. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
