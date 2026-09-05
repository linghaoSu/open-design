import type {
  CodeComponentDefinition,
  ComponentBinding,
  ComponentDefinition,
  ProjectComponentRegistry,
  JsonValue,
  ComponentRegistry,
  ValidationDiagnostic,
} from '@open-design/contracts';
import { validateBindingProps, materializeBindingProps as applyResolvedBindingProps } from './binding-props.js';

export type ComponentBindingResolution =
  | { ok: true; component: ComponentDefinition; codeComponent: CodeComponentDefinition }
  | { ok: false; diagnostics: ValidationDiagnostic[] };

/**
 * Resolves an explicit, already schema-validated binding against supplied metadata.
 * Public props use the same transformation plan as materializeBindingProps.
 * Source-file freshness remains the caller's responsibility.
 */
export function resolveComponentBinding(
  binding: ComponentBinding,
  registry: ComponentRegistry | null,
  codeComponents: readonly CodeComponentDefinition[],
  projectComponents?: ProjectComponentRegistry,
): ComponentBindingResolution {
  const failure = (
    code: ValidationDiagnostic['code'],
    message: string,
    path: (string | number)[],
  ): ComponentBindingResolution => ({
    ok: false,
    diagnostics: [{
      schemaVersion: 1,
      code,
      severity: 'error',
      message,
      componentRef: binding.componentRef,
      path,
    }],
  });

  if (binding.status === 'stale') {
    return failure('ODDS3002', `Binding ${binding.id} is stale.`, ['status']);
  }
  if (binding.status === 'broken') {
    return failure('ODDS3001', `Binding ${binding.id} is broken.`, ['status']);
  }
  if (binding.status !== 'bound' || !binding.verified) {
    return failure('ODDS3004', `Binding ${binding.id} must be bound and verified.`, ['status']);
  }

  const local = binding.componentRef.startsWith('local:');
  const matches = local
    ? projectComponents?.components.filter((component) => binding.componentRef === `local:${component.id}`) ?? []
    : registry?.components.filter((component) => binding.componentRef === `ds:${registry.id}/${component.id}`) ?? [];
  const definition = matches.length === 1 ? matches[0] : undefined;
  if (!definition) return failure('ODDS3001', `Design reference ${binding.componentRef} does not resolve uniquely.`, ['componentRef']);
  if (local && (!('revision' in definition) || binding.definitionRevision !== definition.revision)) {
    return failure('ODDS3002', `Binding ${binding.id} must be verified against the current local definition revision.`, ['definitionRevision']);
  }
  if (!local && binding.definitionRevision !== undefined) return failure('ODDS3001', 'Design-system bindings cannot declare a local definition revision.', ['definitionRevision']);
  const component: ComponentDefinition = local
    ? { schemaVersion: 1, id: definition.id, name: definition.name, props: definition.props }
    : definition;
  const codeMatches = codeComponents.filter((candidate) => candidate.id === binding.codeComponentId);
  const codeComponent = codeMatches.length === 1 ? codeMatches[0] : undefined;
  if (!codeComponent) {
    return failure('ODDS3001', `Code component ${binding.codeComponentId ?? '(missing)'} does not resolve uniquely.`, ['codeComponentId']);
  }
  if (codeComponent.framework !== binding.framework) {
    return failure('ODDS3001', 'Binding and code component frameworks differ.', ['framework']);
  }
  if (!codeComponent.exportName.trim() || !codeComponent.sourcePath.trim()) {
    return failure('ODDS3001', 'Code component export metadata is incomplete.', ['codeComponentId']);
  }

  const designSlots = component.slots ?? {};
  const codeSlots = codeComponent.slots ?? {};
  if (Object.keys(designSlots).length && !Object.keys(codeSlots).length) {
    return failure('ODDS3001', 'Slot bindings are unsupported without a code slot contract.', ['slots']);
  }
  const mappedDesignSlots = new Set<string>();
  const mappedCodeSlots = new Set<string>();
  for (const [index, mapping] of (binding.slotMappings ?? []).entries()) {
    const path = ['slotMappings', index];
    const design = Object.hasOwn(designSlots, mapping.designSlot) ? designSlots[mapping.designSlot] : undefined;
    const code = Object.hasOwn(codeSlots, mapping.codeSlot) ? codeSlots[mapping.codeSlot] : undefined;
    if (!design || !code || mappedDesignSlots.has(mapping.designSlot) || mappedCodeSlots.has(mapping.codeSlot)) {
      return failure('ODDS3001', 'Slot mappings must identify unique declared design and code slots.', path);
    }
    if (code.kind !== (binding.framework === 'react' ? 'react-node' : 'vue-slot')
      || (design.multiple && !code.multiple) || (code.required && !design.required)) {
      return failure('ODDS3001', `Design slot ${mapping.designSlot} cannot satisfy code slot ${mapping.codeSlot}.`, path);
    }
    mappedDesignSlots.add(mapping.designSlot); mappedCodeSlots.add(mapping.codeSlot);
  }
  for (const name of Object.keys(designSlots)) {
    if (!mappedDesignSlots.has(name)) return failure('ODDS3001', `Design slot ${name} requires an explicit code slot mapping.`, ['slotMappings']);
  }
  for (const [name, slot] of Object.entries(codeSlots)) {
    if (slot.required && !mappedCodeSlots.has(name)) return failure('ODDS3001', `Required code slot ${name} has no design slot mapping.`, ['slotMappings']);
  }

  const diagnostics = validateBindingProps(binding, component, codeComponent);
  if (diagnostics.length) return { ok: false, diagnostics };

  return { ok: true, component, codeComponent };
}

/** Resolve the relationship before applying its single canonical prop/default transformation plan. */
export function materializeBindingProps(
  binding: ComponentBinding,
  registry: ComponentRegistry | null,
  codeComponents: readonly CodeComponentDefinition[],
  props: Record<string, JsonValue>,
  projectComponents?: ProjectComponentRegistry,
) {
  const resolution = resolveComponentBinding(binding, registry, codeComponents, projectComponents);
  return resolution.ok ? applyResolvedBindingProps(binding, resolution.component, resolution.codeComponent, props) : resolution;
}
