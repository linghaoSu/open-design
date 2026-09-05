import type {
  CodeComponentDefinition,
  ComponentBinding,
  ComponentDefinition,
  ComponentPropDefinition,
  ComponentRegistry,
  ValidationDiagnostic,
} from '@open-design/contracts';

export type ComponentBindingResolution =
  | { ok: true; component: ComponentDefinition; codeComponent: CodeComponentDefinition }
  | { ok: false; diagnostics: ValidationDiagnostic[] };

function acceptsDesignDomain(design: ComponentPropDefinition, code: ComponentPropDefinition): boolean {
  if (design.type === 'enum') {
    return design.values.every((value) => code.type === 'enum'
      ? code.values.some((allowed) => allowed === value)
      : typeof value === code.type);
  }
  return code.type === design.type;
}

/**
 * Resolves an explicit, already schema-validated binding against supplied metadata.
 * This syntax-only spike does not inspect source files, implement slots/value transforms,
 * or materialize design defaults. Omittable mapped props must share the code default.
 */
export function resolveComponentBinding(
  binding: ComponentBinding,
  registry: ComponentRegistry,
  codeComponents: readonly CodeComponentDefinition[],
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

  const matches = registry.components.filter(
    (component) => binding.componentRef === `ds:${registry.id}/${component.id}`,
  );
  const component = matches.length === 1 ? matches[0] : undefined;
  if (!component) {
    return failure('ODDS3001', `Design reference ${binding.componentRef} does not resolve uniquely.`, ['componentRef']);
  }
  if (Object.keys(component.slots ?? {}).length > 0) {
    return failure('ODDS3001', 'Slot bindings are unsupported without a code slot contract.', ['slots']);
  }
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

  const mappings = new Map<string, string>();
  for (const [index, mapping] of (binding.propMappings ?? []).entries()) {
    const path = ['propMappings', index];
    if (!Object.hasOwn(component.props, mapping.designProp) || !Object.hasOwn(codeComponent.props, mapping.codeProp)) {
      return failure('ODDS3001', 'Property mapping references an undeclared property.', path);
    }
    if (mappings.has(mapping.designProp)) {
      return failure('ODDS3001', 'A design property cannot have multiple mappings.', path);
    }
    if (mapping.values !== undefined) {
      return failure('ODDS3001', 'Value-transform mappings are unsupported by the compiler spike.', path);
    }
    mappings.set(mapping.designProp, mapping.codeProp);
  }

  const mappedCodeProps = new Set<string>();
  for (const designProp of Object.keys(component.props).sort()) {
    const designDefinition = component.props[designProp];
    const codeProp = mappings.get(designProp) ?? designProp;
    const codeDefinition = Object.hasOwn(codeComponent.props, codeProp) ? codeComponent.props[codeProp] : undefined;
    if (!designDefinition || !codeDefinition || !acceptsDesignDomain(designDefinition, codeDefinition)) {
      return failure('ODDS3001', `Property ${designProp} is incompatible with code property ${codeProp}.`, ['propMappings']);
    }
    if (mappedCodeProps.has(codeProp)) {
      return failure('ODDS3001', `Multiple design properties map to code property ${codeProp}.`, ['propMappings']);
    }
    if ((!designDefinition.required || designDefinition.default !== undefined)
      && designDefinition.default !== codeDefinition.default) {
      return failure('ODDS3001', `Omittable design property ${designProp} must share the default of code property ${codeProp}.`, ['props', designProp, 'default']);
    }
    if (codeDefinition.required && codeDefinition.default === undefined
      && !designDefinition.required && designDefinition.default === undefined) {
      return failure('ODDS3001', `Optional design property ${designProp} cannot supply required code property ${codeProp}.`, ['propMappings']);
    }
    mappedCodeProps.add(codeProp);
  }
  for (const codeProp of Object.keys(codeComponent.props).sort()) {
    const definition = codeComponent.props[codeProp];
    if (definition?.required && definition.default === undefined && !mappedCodeProps.has(codeProp)) {
      return failure('ODDS3001', `Required code property ${codeProp} has no design property mapping.`, ['propMappings']);
    }
  }

  return { ok: true, component, codeComponent };
}
