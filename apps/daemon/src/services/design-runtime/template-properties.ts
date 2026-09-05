import type { ComponentDefinition, JsonValue, ProjectComponentPropMapping, UIIRNode } from '@open-design/contracts';

/** Shared default semantics for local inheritance and configured package patterns. */
export function materializeComponentProperties(definition: Pick<ComponentDefinition, 'props'>, explicit: Record<string, JsonValue>): Record<string, JsonValue> {
  const props: Record<string, JsonValue> = {};
  for (const name of Object.keys(definition.props).sort()) {
    const value = definition.props[name]!.default;
    if (value !== undefined) props[name] = value;
  }
  return { ...props, ...explicit };
}

/** Applies canonical explicit mappings to a copy; instance targets remain sparse overrides. */
export function materializeTemplateProperties(template: UIIRNode, propMappings: readonly ProjectComponentPropMapping[], props: Record<string, JsonValue>): UIIRNode {
  const result = structuredClone(template);
  const nodes = new Map<string, UIIRNode>();
  const walk = (node: UIIRNode): void => {
    nodes.set(node.id, node);
    if (node.type === 'component') for (const name of Object.keys(node.slots ?? {}).sort()) for (const child of node.slots![name]!) walk(child);
  };
  walk(result);
  for (const mapping of propMappings) {
    if (!Object.hasOwn(props, mapping.prop)) continue;
    const node = nodes.get(mapping.nodeId)!;
    const value = props[mapping.prop]!;
    if (mapping.path[0] === 'text' && node.type === 'text') node.text = value as string;
    else if (mapping.path[0] === 'props' && node.type === 'component') node.props = { ...node.props, [mapping.path[1]]: value };
    else if (mapping.path[0] === 'props' && node.type === 'instance') node.overrides.push({ schemaVersion: 1, path: ['props', mapping.path[1]], value });
  }
  return result;
}
