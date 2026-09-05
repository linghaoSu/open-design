import type { ComponentDefinition, ComponentPropDefinition, ComponentPropMapping, ComponentBinding, CodeComponentDefinition, JsonScalar, JsonValue, ValidationDiagnostic } from '@open-design/contracts';
import { validateComponentProperties } from './component-validator.js';

interface PropPlan { designProp: string; codeProp: string; definition: ComponentPropDefinition; transform?: Map<string, JsonScalar> }
type PlanResult = { ok: true; plan: PropPlan[] } | { ok: false; diagnostics: ValidationDiagnostic[] };
function accepts(value: JsonScalar, definition: ComponentPropDefinition): boolean {
  return definition.type === 'enum' ? definition.values.includes(value) : typeof value === definition.type;
}

/** The exact plan used for both domain proof and value application. */
function bindingPropPlan(binding: ComponentBinding, component: ComponentDefinition, code: CodeComponentDefinition): PlanResult {
  const fail = (message: string, path: (string | number)[]): PlanResult => ({ ok: false, diagnostics: [{ schemaVersion: 1, code: 'ODDS3001', severity: 'error', message, componentRef: binding.componentRef, path }] });
  const mappings = new Map<string, { mapping: ComponentPropMapping; index: number }>();
  for (const [index, mapping] of (binding.propMappings ?? []).entries()) {
    if (!Object.hasOwn(component.props, mapping.designProp) || !Object.hasOwn(code.props, mapping.codeProp)) return fail('Property mapping references an undeclared property.', ['propMappings', index]);
    if (mappings.has(mapping.designProp)) return fail('A design property cannot have multiple mappings.', ['propMappings', index]);
    mappings.set(mapping.designProp, { mapping, index });
  }
  const targets = new Set<string>(); const plan: PropPlan[] = [];
  for (const designProp of Object.keys(component.props).sort()) {
    const definition = component.props[designProp]!;
    const selected = mappings.get(designProp); const mapping = selected?.mapping;
    const path = selected ? ['propMappings', selected.index] : ['propMappings'];
    const codeProp = mapping?.codeProp ?? designProp;
    const target = Object.hasOwn(code.props, codeProp) ? code.props[codeProp] : undefined;
    if (!target) return fail(`Property ${designProp} is incompatible with code property ${codeProp}.`, path);
    if (targets.has(codeProp)) return fail(`Multiple design properties map to code property ${codeProp}.`, path);
    targets.add(codeProp);
    let transform: Map<string, JsonScalar> | undefined;
    const domain: JsonScalar[] | undefined = definition.type === 'enum' ? definition.values : definition.type === 'boolean' ? [false, true] : undefined;
    if (mapping?.values !== undefined || mapping?.valueTransform !== undefined) {
      if (!domain || mapping.values !== undefined && mapping.valueTransform !== undefined) return fail('A value transform requires one complete finite enum or Boolean domain.', path);
      transform = new Map();
      if (mapping.valueTransform) {
        for (const { from, to } of mapping.valueTransform.entries) {
          const key = JSON.stringify(from);
          if (transform.has(key) || !domain.includes(from)) return fail('Value transform sources must uniquely match the declared domain.', path);
          transform.set(key, to);
        }
      } else {
        const names = domain.map(String);
        if (new Set(names).size !== domain.length || Object.keys(mapping.values!).length !== domain.length) return fail('Legacy value keys must match an unambiguous, complete source domain.', path);
        for (const value of domain) {
          if (!Object.hasOwn(mapping.values!, String(value))) return fail('Value transform does not cover every source value.', path);
          transform.set(JSON.stringify(value), mapping.values![String(value)]!);
        }
      }
      if (transform.size !== domain.length || [...transform.values()].some((value) => !accepts(value, target))) return fail('Value transform must cover every source value with compatible code values.', path);
    } else if (domain ? !domain.every((value) => accepts(value, target)) : definition.type !== target.type) {
      return fail(`Property ${designProp} is incompatible with code property ${codeProp}.`, path);
    }
    if (!definition.required && definition.default === undefined) {
      if (target.default !== undefined) return fail(`Omittable design property ${designProp} without a default must preserve code omission.`, ['props', designProp, 'default']);
      if (target.required) return fail(`Optional design property ${designProp} cannot supply required code property ${codeProp}.`, path);
    }
    plan.push({ designProp, codeProp, definition, ...(transform ? { transform } : {}) });
  }
  for (const [name, definition] of Object.entries(code.props)) {
    if (definition.required && definition.default === undefined && !targets.has(name)) return fail(`Required code property ${name} has no design property mapping.`, ['propMappings']);
  }
  return { ok: true, plan };
}

export function validateBindingProps(binding: ComponentBinding, component: ComponentDefinition, code: CodeComponentDefinition): ValidationDiagnostic[] {
  const result = bindingPropPlan(binding, component, code);
  return result.ok ? [] : result.diagnostics;
}

/** Materializes design defaults before mapping. Omitted defaultless props remain absent. */
export function materializeBindingProps(binding: ComponentBinding, component: ComponentDefinition, code: CodeComponentDefinition, props: Record<string, JsonValue>):
  { ok: true; props: Record<string, JsonScalar> } | { ok: false; diagnostics: ValidationDiagnostic[] } {
  const result = bindingPropPlan(binding, component, code);
  if (!result.ok) return result;
  const diagnostics = validateComponentProperties(component, { component: binding.componentRef, props });
  if (diagnostics.length) return { ok: false, diagnostics };
  const output: Record<string, JsonScalar> = Object.create(null);
  for (const entry of result.plan) {
    const value = Object.hasOwn(props, entry.designProp) ? props[entry.designProp] as JsonScalar : entry.definition.default;
    if (value === undefined) continue;
    output[entry.codeProp] = entry.transform ? entry.transform.get(JSON.stringify(value))! : value;
  }
  return { ok: true, props: output };
}
