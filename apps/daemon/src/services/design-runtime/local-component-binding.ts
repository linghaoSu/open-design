import {
  CodeComponentIndexSchema, RegisterLocalComponentBindingRequestSchema, RegisterLocalComponentBindingResultSchema,
  type CodeComponentIndex, type ComponentBindingRegistry, type ComponentRegistry, type ProjectComponentRegistry,
  type RegisterLocalComponentBindingRequest, type RegisterLocalComponentBindingResult, type ValidationDiagnostic, type ProjectCodeSourceEvidence,
} from '@open-design/contracts';
import { extractSourceCodeComponent } from './source-compiler.js';
import { codeComponentContractSignature, reindexComponentBindings, revalidateComponentBinding, unbindComponent, upsertComponentBinding } from './code-component-index.js';

export interface LocalComponentBindingContext {
  registry: ComponentRegistry | null;
  projectComponents: ProjectComponentRegistry;
  /** Package-owned (or editable design-system) code only. Never includes project-owned entries. */
  baseCodeIndex: CodeComponentIndex;
  projectCodeIndex: CodeComponentIndex;
  bindings: ComponentBindingRegistry;
}
export class LocalComponentBindingError extends Error {
  constructor(public readonly diagnostics: ValidationDiagnostic[]) { super(diagnostics.map((diagnostic) => diagnostic.message).join(' ')); this.name = 'LocalComponentBindingError'; }
}
function diagnostic(message: string, code: ValidationDiagnostic['code'] = 'ODDS3001'): ValidationDiagnostic {
  return { schemaVersion: 1, code, severity: 'error', message };
}

/** Explicit ownership makes locked reads preserve project code without replacing immutable entries. */
export function composeProjectCodeIndex(base: CodeComponentIndex, project: CodeComponentIndex): CodeComponentIndex {
  const baseIndex = CodeComponentIndexSchema.parse(base); const projectIndex = CodeComponentIndexSchema.parse(project);
  const ids = new Set(baseIndex.components.map((component) => component.id));
  for (const component of projectIndex.components) if (ids.has(component.id)) throw new LocalComponentBindingError([diagnostic(`Project code identity ${component.id} collides with design-system-owned code.`)]);
  return CodeComponentIndexSchema.parse({ schemaVersion: 1, id: projectIndex.id,
    components: [...baseIndex.components, ...projectIndex.components].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) });
}

/** Explicit source proof + local revision verification commit as one immutable result. */
export function registerLocalComponentBinding(context: LocalComponentBindingContext, input: RegisterLocalComponentBindingRequest): RegisterLocalComponentBindingResult {
  const request = RegisterLocalComponentBindingRequestSchema.parse(input);
  try {
    const previousIndex = composeProjectCodeIndex(context.baseCodeIndex, context.projectCodeIndex);
    const code = extractSourceCodeComponent(request.source);
    const projectCodeIndex = CodeComponentIndexSchema.parse({ ...context.projectCodeIndex,
      components: [...context.projectCodeIndex.components.filter((component) => component.id !== code.id), code].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0) });
    const codeIndex = composeProjectCodeIndex(context.baseCodeIndex, projectCodeIndex);
    const refreshed = reindexComponentBindings(context.bindings, previousIndex, codeIndex, context.registry, context.projectComponents);
    const bound = upsertComponentBinding(refreshed, request.binding, context.registry, codeIndex, context.projectComponents);
    if (!bound.ok) return { schemaVersion: 1, ok: false, diagnostics: bound.diagnostics };
    return RegisterLocalComponentBindingResultSchema.parse({ schemaVersion: 1, ok: true, projectCodeIndex, codeIndex, bindings: bound.bindings, binding: bound.binding, diagnostics: [] });
  } catch (error) {
    return { schemaVersion: 1, ok: false, diagnostics: error instanceof LocalComponentBindingError ? error.diagnostics : [diagnostic(`Local code source cannot be verified: ${error instanceof Error ? error.message : String(error)}`)] };
  }
}

export function revalidateLocalComponentBinding(context: LocalComponentBindingContext, id: string) {
  const binding = context.bindings.bindings.find((candidate) => candidate.id === id);
  if (!binding?.componentRef.startsWith('local:')) return { ok: false as const, diagnostics: [diagnostic('Expected an existing project-local binding.')] };
  return revalidateComponentBinding(context.bindings, id, context.registry, composeProjectCodeIndex(context.baseCodeIndex, context.projectCodeIndex), context.projectComponents);
}

export function unbindLocalComponent(context: LocalComponentBindingContext, id: string) {
  const binding = context.bindings.bindings.find((candidate) => candidate.id === id);
  if (!binding?.componentRef.startsWith('local:')) return { ok: false as const, diagnostics: [diagnostic('Expected an existing project-local binding.')] };
  return unbindComponent(context.bindings, id);
}

/** Revision-only design edits still invalidate local implementations, without stamping them verified. */
export function synchronizeLocalComponentBindings(context: LocalComponentBindingContext): ComponentBindingRegistry {
  const index = composeProjectCodeIndex(context.baseCodeIndex, context.projectCodeIndex);
  return reindexComponentBindings(context.bindings, index, index, context.registry, context.projectComponents);
}

/** Checks supplied current source, never infers freshness from a previously registered index. */
export function verifyProjectCodeSources(index: CodeComponentIndex, evidence: readonly ProjectCodeSourceEvidence[]): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const sources = new Map<string, string>();
  for (const entry of evidence) {
    if (sources.has(entry.codeComponentId) || !index.components.some((code) => code.id === entry.codeComponentId)) {
      diagnostics.push(diagnostic(`Project source evidence must identify each registered code component uniquely: ${entry.codeComponentId}.`, 'ODDS7004'));
    }
    sources.set(entry.codeComponentId, entry.sourceText);
  }
  for (const code of [...index.components].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
    const sourceText = sources.get(code.id);
    if (sourceText === undefined) { diagnostics.push(diagnostic(`Current source evidence is missing for project code ${code.id} at ${code.sourcePath}.`, 'ODDS7004')); continue; }
    try {
      const extracted = extractSourceCodeComponent({ framework: code.framework, sourceText, sourcePath: code.sourcePath, exportName: code.exportName, codeComponentId: code.id,
        ...(code.packageName === undefined ? {} : { packageName: code.packageName }) });
      if (codeComponentContractSignature(extracted) !== codeComponentContractSignature(code)) diagnostics.push(diagnostic(`Project code ${code.id} no longer matches its registered public source contract. Reindex and revalidate its bindings.`, 'ODDS7004'));
    } catch (error) { diagnostics.push(diagnostic(`Project code ${code.id} source cannot be verified: ${error instanceof Error ? error.message : String(error)}`, 'ODDS7004')); }
  }
  return diagnostics;
}
