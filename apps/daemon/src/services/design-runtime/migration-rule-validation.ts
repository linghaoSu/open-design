import type { ComponentPropDefinition, ComponentRegistry, DesignSystemMigrationRule, ValidationDiagnostic } from '@open-design/contracts';

const failure = (message: string): ValidationDiagnostic => ({ schemaVersion: 1, code: 'ODDS5002', severity: 'error', message });

/** Publication can verify target facts; instantiation and upgrade verify both exact registries. */
export function validateDesignSystemMigrationRules(from: ComponentRegistry | undefined, to: ComponentRegistry, rules: readonly DesignSystemMigrationRule[]): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const replacements = new Map(rules.flatMap((rule) => rule.type === 'replace-component' ? [[rule.fromRef, rule.toRef] as const] : []));
  const admits = (prop: ComponentPropDefinition, value: unknown) => prop.type === 'enum' ? prop.values.includes(value as never) : typeof value === prop.type;
  for (const rule of rules) {
    const oldRef = rule.type === 'replace-component' ? rule.fromRef : rule.componentRef;
    const old = from?.components.find((entry) => oldRef === `ds:${from.id}/${entry.id}`);
    const targetRef = replacements.get(oldRef) ?? oldRef;
    const target = to.components.find((entry) => targetRef === `ds:${to.id}/${entry.id}`);
    if (from && !old) diagnostics.push(failure(`Migration rule ${rule.id} has no source component in the active package.`));
    if (!target) diagnostics.push(failure(`Migration rule ${rule.id} has no component target in the selected package.`));
    if (rule.type === 'transform-prop' || rule.type === 'drop-prop') {
      const sourceName = rule.type === 'transform-prop' ? rule.fromProp : rule.prop;
      const source = old && Object.hasOwn(old.props, sourceName) ? old.props[sourceName] : undefined;
      if (from && !source) diagnostics.push(failure(`Migration rule ${rule.id} has no source property ${sourceName}.`));
      if (rule.type === 'transform-prop') {
        const output = target && Object.hasOwn(target.props, rule.toProp) ? target.props[rule.toProp] : undefined;
        if (!output) diagnostics.push(failure(`Migration rule ${rule.id} has no target property ${rule.toProp}.`));
        for (const entry of rule.valueMap ?? []) {
          if (source && !admits(source, entry.from)) diagnostics.push(failure(`Migration rule ${rule.id} maps an impossible source property value.`));
          if (output && !admits(output, entry.to)) diagnostics.push(failure(`Migration rule ${rule.id} maps to a value outside the target property domain.`));
        }
      }
    } else if (rule.type === 'rename-slot' || rule.type === 'drop-slot') {
      const sourceName = rule.type === 'rename-slot' ? rule.fromSlot : rule.slot;
      if (from && (!old || !Object.hasOwn(old.slots ?? {}, sourceName))) diagnostics.push(failure(`Migration rule ${rule.id} has no source slot ${sourceName}.`));
      if (rule.type === 'rename-slot' && (!target || !Object.hasOwn(target.slots ?? {}, rule.toSlot))) diagnostics.push(failure(`Migration rule ${rule.id} has no target slot ${rule.toSlot}.`));
    }
  }
  return diagnostics;
}
