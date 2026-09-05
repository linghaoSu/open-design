import { parse } from '@babel/parser';
import {
  type CodeComponentIndex, type ComponentBinding, type ProjectCodeSourceEvidence,
  type ProjectDesignRuntimeState, type ValidationDiagnostic,
} from '@open-design/contracts';
import { composeProjectCodeIndex } from './local-component-binding.js';
import { reindexComponentBindings } from './code-component-index.js';
import { extractSourceCodeComponent } from './source-compiler.js';

export const effectiveProjectCodeIndex = (state: ProjectDesignRuntimeState) => composeProjectCodeIndex(state.codeIndex, state.projectCodeIndex);

/** Missing files remain missing evidence; registered metadata never stands in for current bytes. */
export async function readProjectCodeEvidence(index: CodeComponentIndex, readSource: (sourcePath: string) => Promise<string>): Promise<ProjectCodeSourceEvidence[]> {
  const files = new Map<string, Promise<string | undefined>>();
  for (const code of index.components) if (!files.has(code.sourcePath)) files.set(code.sourcePath, readSource(code.sourcePath).catch(() => undefined));
  const entries = await Promise.all(index.components.map(async (code) => {
    const sourceText = await files.get(code.sourcePath)!;
    return sourceText === undefined ? [] : [{ codeComponentId: code.id, sourceText }];
  }));
  return entries.flat().sort((left, right) => left.codeComponentId < right.codeComponentId ? -1 : left.codeComponentId > right.codeComponentId ? 1 : 0);
}

function missingReactExport(sourceText: string, exportName: string): boolean {
  try {
    const ast = parse(sourceText, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    return !ast.program.body.some((node) => {
      if (node.type === 'ExportDefaultDeclaration') return exportName === 'default';
      if (node.type === 'ExportAllDeclaration') return true; // Re-export coverage is unknown, not a proved absence.
      if (node.type !== 'ExportNamedDeclaration') return false;
      if (node.specifiers.some((specifier) => ('name' in specifier.exported ? specifier.exported.name : specifier.exported.value) === exportName)) return true;
      const declaration = node.declaration;
      if (declaration?.type === 'VariableDeclaration') return declaration.declarations.some((entry) => entry.id.type === 'Identifier' && entry.id.name === exportName);
      return declaration && 'id' in declaration && declaration.id?.type === 'Identifier' && declaration.id.name === exportName;
    });
  } catch { return false; }
}

/** Refresh preserves a failed source selection so a later explicit repair can find it again. */
export function refreshProjectCode(state: ProjectDesignRuntimeState, codeId: string, sourceText: string | undefined): { state: ProjectDesignRuntimeState; diagnostics: ValidationDiagnostic[] } {
  const previous = state.projectCodeIndex.components.find((component) => component.id === codeId);
  if (!previous) throw new Error('Registered project code component not found.');
  try {
    if (sourceText === undefined) throw new Error('The registered source path is unavailable.');
    const code = extractSourceCodeComponent({ framework: previous.framework, sourcePath: previous.sourcePath, exportName: previous.exportName, codeComponentId: previous.id, sourceText,
      ...(previous.packageName === undefined ? {} : { packageName: previous.packageName }) });
    const next = { ...state, projectCodeIndex: { ...state.projectCodeIndex, components: state.projectCodeIndex.components.map((entry) => entry.id === codeId ? code : entry) } };
    return { state: { ...next, bindings: reindexComponentBindings(state.bindings, effectiveProjectCodeIndex(state), effectiveProjectCodeIndex(next), state.registry, state.projectComponents) }, diagnostics: [] };
  } catch (error) {
    const status = sourceText === undefined || previous.framework === 'react' && missingReactExport(sourceText, previous.exportName) ? 'broken' : 'stale';
    const diagnostics: ValidationDiagnostic[] = [{ schemaVersion: 1, code: 'ODDS7004', severity: 'error', message: `Registered source ${previous.sourcePath} cannot be refreshed: ${error instanceof Error ? error.message : String(error)}` }];
    const bindings = state.bindings.bindings.map((binding): ComponentBinding => binding.status !== 'unbound' && binding.codeComponentId === codeId ? { ...binding, status, verified: false } : binding);
    return { state: { ...state, bindings: { ...state.bindings, bindings } }, diagnostics };
  }
}
