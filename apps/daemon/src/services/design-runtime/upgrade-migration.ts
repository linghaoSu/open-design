import type {
  ComponentPropDefinition, DesignSystemMigrationPlan, JsonScalar, JsonValue,
  ProjectComponentDefinition, ProjectComponentRegistry, UIIRDocument, UIIRNode, ValidationDiagnostic,
} from '@open-design/contracts';
import { compareDesignRuntimeKeys, resolveRuntimeLimits, type DesignRuntimeLimits } from './reference-graph.js';
import { canonicalDesignSystemJson } from './design-system-version.js';

type Values = { from: JsonScalar; to: JsonScalar }[];
export interface UpgradePropTransform { to: string | null; values?: Values }
export interface UpgradeMigrationResult {
  projectComponents: ProjectComponentRegistry; document: UIIRDocument | null; diagnostics: ValidationDiagnostic[];
  props: Map<string, Map<string, UpgradePropTransform>>;
  slots: Map<string, Map<string, string | null>>;
  replacements: Map<string, string>;
}
export function mapUpgradeValue(value: JsonValue, values?: Values): JsonValue {
  return values?.find((entry) => entry.from === value)?.to ?? (values?.some((entry) => entry.from === value && entry.to === null) ? null : value);
}

/** Transform authored state only. Public local mappings are the sole route for inheritance propagation. */
export function migrateUpgradeSource(registry: ProjectComponentRegistry, document: UIIRDocument | null, plan: DesignSystemMigrationPlan, options: DesignRuntimeLimits = {}): UpgradeMigrationResult {
  const limits = resolveRuntimeLimits(options);
  const diagnostics: ValidationDiagnostic[] = [];
  const props = new Map<string, Map<string, UpgradePropTransform>>();
  const slots = new Map<string, Map<string, string | null>>();
  const replacements = new Map<string, string>();
  const diagnostic = (message: string, nodeId?: string) => diagnostics.push({ schemaVersion: 1, code: 'ODDS5002', severity: 'error', message, ...(nodeId === undefined ? {} : { nodeId }) });
  for (const rule of plan.rules) {
    if (rule.type === 'replace-component') { replacements.set(rule.fromRef, rule.toRef); continue; }
    if (rule.type === 'transform-prop' || rule.type === 'drop-prop') {
      const map = props.get(rule.componentRef) ?? new Map<string, UpgradePropTransform>();
      map.set(rule.type === 'transform-prop' ? rule.fromProp : rule.prop, rule.type === 'drop-prop' ? { to: null } : { to: rule.toProp, ...(rule.valueMap ? { values: rule.valueMap } : {}) });
      props.set(rule.componentRef, map);
    } else {
      const map = slots.get(rule.componentRef) ?? new Map<string, string | null>();
      map.set(rule.type === 'rename-slot' ? rule.fromSlot : rule.slot, rule.type === 'drop-slot' ? null : rule.toSlot);
      slots.set(rule.componentRef, map);
    }
  }
  const definitions = new Map(registry.components.map((definition) => [definition.id, definition]));
  const prepared = new Map<string, ProjectComponentDefinition>();
  const active = new Set<string>();
  let visited = 0;
  function traverse(node: UIIRNode, callback: (node: UIIRNode, deleted: boolean) => void, deleted = false, depth = 0): void {
    if (++visited > limits.maxNodes || depth > limits.maxDepth) throw new Error('Migration traversal exceeds its explicit safety limit.');
    callback(node, deleted);
    if (node.type === 'component') for (const [name, children] of Object.entries(node.slots ?? {})) {
      for (const child of children) traverse(child, callback, deleted || slots.get(node.ref)?.get(name) === null, depth + 1);
    }
  }
  function publicProp(source: ComponentPropDefinition, maps: (UpgradePropTransform | undefined)[], nodeId: string): { definition: ComponentPropDefinition; transform?: UpgradePropTransform } {
    const hasValues = maps.some((map) => map?.values?.length);
    if (!hasValues) return { definition: source };
    const domain = source.type === 'enum' ? source.values : source.type === 'boolean' ? [false, true] : null;
    if (!domain) { diagnostic('A finite public property domain is required to migrate values through a local component mapping.', nodeId); return { definition: source }; }
    const transformed = maps.map((map) => domain.map((value) => mapUpgradeValue(value, map?.values) as JsonScalar));
    if (transformed.some((values) => canonicalDesignSystemJson(values) !== canonicalDesignSystemJson(transformed[0]))) {
      diagnostic('Local property fan-out requires incompatible value transformations; supply an explicit local definition repair.', nodeId);
      return { definition: source };
    }
    const values = [...new Set(transformed[0]!)];
    const valueMap = domain.map((from, index) => ({ from, to: transformed[0]![index]! }));
    const next: ComponentPropDefinition = { type: 'enum', required: source.required, values,
      ...(source.source === undefined ? {} : { source: source.source }),
      ...(source.default === undefined ? {} : { default: mapUpgradeValue(source.default, valueMap) as JsonScalar }),
    };
    return { definition: next, transform: { to: '', values: valueMap } };
  }
  function prepare(id: string, depth = 0): void {
    if (prepared.has(id)) return;
    if (active.has(id) || depth > limits.maxDepth) { diagnostic('Local component inheritance cycle or depth limit prevents deterministic migration.'); return; }
    const definition = definitions.get(id);
    if (!definition) return;
    active.add(id);
    const nodes = new Map<string, UIIRNode>(); const deleted = new Set<string>();
    traverse(definition.template, (node, removed) => {
      nodes.set(node.id, node); if (removed) deleted.add(node.id);
      if (node.type === 'instance' && node.ref.startsWith('local:')) prepare(node.ref.slice(6), depth + 1);
    });
    const mappings = definition.propMappings.flatMap((mapping) => {
      if (deleted.has(mapping.nodeId)) return [];
      const node = nodes.get(mapping.nodeId)!;
      const operation = mapping.path[0] === 'props' && node.type !== 'text' ? props.get(node.ref)?.get(mapping.path[1]) : undefined;
      if (operation?.to === null) return [];
      return [{ old: mapping, next: operation ? { ...mapping, path: ['props', operation.to!] as ['props', string] } : mapping, operation }];
    });
    const local = new Map<string, UpgradePropTransform>();
    const nextProps: [string, ComponentPropDefinition][] = [];
    for (const [name, definitionProp] of Object.entries(definition.props)) {
      const destinations = mappings.filter((entry) => entry.old.prop === name);
      if (!destinations.length) { local.set(name, { to: null }); continue; }
      const changed = publicProp(definitionProp, destinations.map((entry) => entry.operation), definition.template.id);
      nextProps.push([name, changed.definition]);
      if (changed.transform) local.set(name, { ...changed.transform, to: name });
    }
    props.set(`local:${id}`, local);
    prepared.set(id, { ...definition, props: Object.fromEntries(nextProps), propMappings: mappings.map((entry) => entry.next) });
    active.delete(id);
  }
  function entries<T>(source: [string, T][], ref: string, nodeId: string, member: 'props' | 'slots'): [string, T][] {
    const result: [string, T][] = []; const targets = new Set<string>();
    for (const [name, value] of source) {
      const transform = props.get(ref)?.get(name);
      const to = member === 'props' ? transform?.to === undefined ? name : transform.to : slots.get(ref)?.has(name) ? slots.get(ref)!.get(name)! : name;
      if (to === null) continue;
      if (targets.has(to)) { diagnostic(`Simultaneous ${member} migration collides at ${to}; no value was overwritten.`, nodeId); return source; }
      targets.add(to);
      result.push([to, member === 'props' ? mapUpgradeValue(value as JsonValue, transform?.values) as T : value]);
    }
    return result;
  }
  function rewrite(node: UIIRNode, depth = 0): UIIRNode {
    if (++visited > limits.maxNodes || depth > limits.maxDepth) throw new Error('Migration traversal exceeds its explicit safety limit.');
    if (node.type === 'text') return { ...node };
    const ref = replacements.get(node.ref) ?? node.ref;
    if (node.type === 'instance') {
      const transformed = entries(node.overrides.map((override) => [override.path[1], override.value]), node.ref, node.id, 'props');
      return { ...node, ref, overrides: transformed.map(([name, value]) => ({ schemaVersion: 1, path: ['props', name], value })) };
    }
    return { ...node, ref,
      ...(node.props === undefined ? {} : { props: Object.fromEntries(entries(Object.entries(node.props), node.ref, node.id, 'props')) }),
      ...(node.slots === undefined ? {} : { slots: Object.fromEntries(entries(Object.entries(node.slots), node.ref, node.id, 'slots').map(([name, children]) => [name, children.map((child) => rewrite(child, depth + 1))])) }),
    };
  }
  let projectComponents = registry; let nextDocument = document;
  try {
    for (const id of [...definitions.keys()].sort(compareDesignRuntimeKeys)) prepare(id);
    projectComponents = { ...registry, components: registry.components.map((definition) => prepared.get(definition.id) ?? definition).map((definition) => ({ ...definition, template: rewrite(definition.template) })) };
    nextDocument = document === null ? null : { ...document, screens: document.screens.map((screen) => ({ ...screen, children: screen.children.map((node) => rewrite(node)) })) };
  } catch (error) {
    diagnostics.push({ schemaVersion: 1, code: 'ODDS4007', severity: 'error', message: error instanceof Error ? error.message : 'Migration traversal failed.' });
  }
  return { projectComponents, document: nextDocument, diagnostics, props, slots, replacements };
}
