import {
  ComponentBindingRegistrySchema,
  ComponentBindingSchema,
  type CodeComponentDefinition,
  type CodeComponentIndex,
  type ComponentBinding,
  type ComponentBindingRegistry,
  type ComponentFramework,
  type ComponentRegistry,
  type ProjectComponentRegistry,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { resolveComponentBinding } from './binding-resolver.js';

export type BindComponentInput = Omit<Extract<ComponentBinding, { status: 'bound' }>, 'schemaVersion' | 'status' | 'verified'>;
export type ComponentBindingMutationResult =
  | { ok: true; bindings: ComponentBindingRegistry; binding: ComponentBinding }
  | { ok: false; diagnostics: ValidationDiagnostic[] };

function failure(message: string, path: string[], componentRef?: string): ComponentBindingMutationResult {
  return {
    ok: false,
    diagnostics: [{
      schemaVersion: 1,
      code: 'ODDS3001',
      severity: 'error',
      message,
      path,
      ...(componentRef === undefined ? {} : { componentRef }),
    }],
  };
}

function compareIds(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function getCodeComponent(index: CodeComponentIndex, id: string): CodeComponentDefinition | undefined {
  return index.components.find((component) => component.id === id);
}

/** Case-insensitive token matching against declared metadata, with stable ID order. */
export function searchCodeComponents(
  index: CodeComponentIndex,
  query: string,
  framework?: ComponentFramework,
): CodeComponentDefinition[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return index.components.filter((component) => {
    if (framework !== undefined && component.framework !== framework) return false;
    const text = [component.id, component.name, component.exportName, component.sourcePath, component.packageName ?? ''].join('\n').toLowerCase();
    return terms.every((term) => text.includes(term));
  }).sort(compareIds);
}

export function getComponentBinding(
  bindings: ComponentBindingRegistry,
  componentRef: string,
  framework: ComponentFramework,
): ComponentBinding | undefined {
  return bindings.bindings.find((binding) => binding.componentRef === componentRef && binding.framework === framework);
}

function replaceBinding(bindings: ComponentBindingRegistry, binding: ComponentBinding): ComponentBindingMutationResult {
  const existing = bindings.bindings.find((candidate) => candidate.id === binding.id);
  if (existing && (existing.componentRef !== binding.componentRef || existing.framework !== binding.framework)) {
    return failure(`Binding identity ${binding.id} belongs to a different component/framework relationship.`, ['id'], binding.componentRef);
  }
  const collision = bindings.bindings.find((existing) => existing.id !== binding.id
    && existing.componentRef === binding.componentRef && existing.framework === binding.framework);
  if (collision) {
    return failure(`Component already has binding ${collision.id}; update that stable binding ID.`, ['id'], binding.componentRef);
  }
  const next = ComponentBindingRegistrySchema.parse({
    ...bindings,
    bindings: [...bindings.bindings.filter((existing) => existing.id !== binding.id), binding].sort(compareIds),
  });
  return { ok: true, bindings: next, binding: next.bindings.find((existing) => existing.id === binding.id)! };
}

/** Bound records are accepted only after their declared contracts resolve. */
export function upsertComponentBinding(
  bindings: ComponentBindingRegistry,
  binding: ComponentBinding,
  registry: ComponentRegistry | null,
  index: CodeComponentIndex,
  projectComponents?: ProjectComponentRegistry,
): ComponentBindingMutationResult {
  const parsed = ComponentBindingSchema.parse(binding);
  if (parsed.status === 'bound') {
    const resolution = resolveComponentBinding(parsed, registry, index.components, projectComponents);
    if (!resolution.ok) return resolution;
  }
  return replaceBinding(bindings, parsed);
}

export function bindComponent(
  bindings: ComponentBindingRegistry,
  input: BindComponentInput,
  registry: ComponentRegistry | null,
  index: CodeComponentIndex,
  projectComponents?: ProjectComponentRegistry,
): ComponentBindingMutationResult {
  const binding = ComponentBindingSchema.parse({ ...input, schemaVersion: 1, status: 'bound', verified: true });
  return upsertComponentBinding(bindings, binding, registry, index, projectComponents);
}

export function unbindComponent(bindings: ComponentBindingRegistry, id: string): ComponentBindingMutationResult {
  const existing = bindings.bindings.find((binding) => binding.id === id);
  if (!existing) return failure(`Binding ${id} does not exist.`, ['id']);
  // A reset retains the binding identity but removes the implementation and its mappings.
  return replaceBinding(bindings, {
    schemaVersion: 1,
    id: existing.id,
    componentRef: existing.componentRef,
    framework: existing.framework,
    status: 'unbound',
    verified: false,
    ...(existing.source === undefined ? {} : { source: existing.source }),
  });
}

export function removeComponentBinding(bindings: ComponentBindingRegistry, id: string): ComponentBindingRegistry {
  return ComponentBindingRegistrySchema.parse({ ...bindings, bindings: bindings.bindings.filter((binding) => binding.id !== id) });
}

/** Explicit verification is the only operation that promotes a stale/candidate binding. */
export function revalidateComponentBinding(
  bindings: ComponentBindingRegistry,
  id: string,
  registry: ComponentRegistry | null,
  index: CodeComponentIndex,
  projectComponents?: ProjectComponentRegistry,
): ComponentBindingMutationResult {
  const existing = bindings.bindings.find((binding) => binding.id === id);
  if (!existing) return failure(`Binding ${id} does not exist.`, ['id']);
  if (existing.status === 'unbound') return failure(`Binding ${id} has no code component to verify.`, ['codeComponentId'], existing.componentRef);
  return upsertComponentBinding(bindings, { ...existing, status: 'bound', verified: true, ...(existing.componentRef.startsWith('local:') ? { definitionRevision: projectComponents?.components.find((component) => existing.componentRef === `local:${component.id}`)?.revision } : {}) }, registry, index, projectComponents);
}

export function codeComponentContractSignature(component: CodeComponentDefinition): string {
  const props = Object.keys(component.props).sort().map((name) => {
    const prop = component.props[name]!;
    return [name, {
      type: prop.type,
      required: prop.required,
      default: prop.default,
      ...(prop.type === 'enum' ? { values: prop.values.map((value) => JSON.stringify(value)).sort() } : {}),
    }];
  });
  const slots = Object.entries(component.slots ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, { kind, required, multiple }]) => [name, { kind, required, multiple }]);
  return JSON.stringify({
    id: component.id,
    framework: component.framework,
    exportName: component.exportName,
    sourcePath: component.sourcePath,
    packageName: component.packageName,
    props,
    slots,
  });
}

/**
 * Compare code contracts, not implementation text or provenance. Missing targets become
 * broken; changed APIs become stale and require explicit re-verification. Recovery never
 * silently restores a previously stale/broken binding to the verified state.
 */
export function reindexComponentBindings(
  bindings: ComponentBindingRegistry,
  previousIndex: CodeComponentIndex,
  nextIndex: CodeComponentIndex,
  registry: ComponentRegistry | null,
  projectComponents?: ProjectComponentRegistry,
): ComponentBindingRegistry {
  const nextBindings = bindings.bindings.map((binding): ComponentBinding => {
    if (binding.status === 'unbound') return binding;
    const code = getCodeComponent(nextIndex, binding.codeComponentId);
    const designExists = binding.componentRef.startsWith('local:')
      ? projectComponents?.components.some((component) => binding.componentRef === `local:${component.id}`)
      : registry?.components.some((component) => binding.componentRef === `ds:${registry.id}/${component.id}`);
    if (!designExists || !code || code.framework !== binding.framework || !code.exportName.trim() || !code.sourcePath.trim()) {
      return { ...binding, status: 'broken', verified: false };
    }
    const resolution = resolveComponentBinding({ ...binding, status: 'bound', verified: true }, registry, nextIndex.components, projectComponents);
    if (!resolution.ok) return { ...binding, status: 'stale', verified: false };
    const previous = getCodeComponent(previousIndex, binding.codeComponentId);
    if (binding.status === 'bound' && (!previous || codeComponentContractSignature(previous) !== codeComponentContractSignature(resolution.codeComponent))) {
      return { ...binding, status: 'stale', verified: false };
    }
    return binding;
  });
  return ComponentBindingRegistrySchema.parse({ ...bindings, bindings: nextBindings });
}
