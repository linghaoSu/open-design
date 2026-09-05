import {
  CompileComponentRegistryRequestSchema,
  CompileComponentRegistryResultSchema,
  type CompileComponentRegistryRequest,
  type CompileComponentRegistryResult,
} from '@open-design/contracts';
import { compileReactComponent, CompilerError } from './react-compiler.js';

type Selection = CompileComponentRegistryRequest['selections'][number];

/**
 * Compile explicit source selections into one independent registry snapshot.
 * All identities and source snapshots are checked before extraction. No result
 * escapes until every selection and the combined contract have been validated.
 * Source support is the conservative syntax-only compileReactComponent subset.
 */
export function compileComponentRegistry(input: CompileComponentRegistryRequest): CompileComponentRegistryResult {
  const request = CompileComponentRegistryRequestSchema.parse(input);
  const selections = request.selections.sort((left, right) => compareIds(left.componentId, right.componentId));
  validateSourceSnapshots(selections);

  const compiled = selections.map(({ packageName, ...selection }) => compileReactComponent({
    ...selection,
    designSystemId: request.designSystemId,
    ...(packageName === undefined ? {} : { packageName }),
  }));

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
  for (const selection of selections) {
    const previous = sources.get(selection.sourcePath);
    if (previous && (previous.sourceText !== selection.sourceText || previous.packageName !== selection.packageName)) {
      throw new CompilerError(
        'Selections from the same source path must share identical source text and package metadata',
        selection.sourcePath,
        selection.exportName,
      );
    }
    sources.set(selection.sourcePath, selection);
  }
}

/** Code-unit ordering is stable across the host locale and input selection order. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
