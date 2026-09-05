import {
  DesignMemberNameSchema, ProjectComponentDefinitionSchema,
  type ComponentPropDefinition, type JsonValue, type ProjectComponentDefinition,
  type ProjectComponentPropMapping, type UIIRDocument, type UIIRNode,
} from '@open-design/contracts';

export interface ScalarDraft { kind: 'string' | 'number' | 'boolean' | 'null'; input: string }
export interface PublicPropDraft {
  key: string;
  name: string;
  type: ComponentPropDefinition['type'];
  required: boolean;
  hasDefault: boolean;
  defaultValue: ScalarDraft;
  values: Array<ScalarDraft & { key: string }>;
}
export interface ComponentFormDraft {
  id: string;
  draftId: string;
  name: string;
  baseRevision: number;
  template: UIIRNode | null;
  props: PublicPropDraft[];
  mappings: Array<ProjectComponentPropMapping & { key: string }>;
}

export const freshId = (kind: string) => `${kind}-${crypto.randomUUID()}`;
export const scalarDraft = (value: JsonValue): ScalarDraft => ({
  kind: value === null ? 'null' : typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string',
  input: typeof value === 'string' ? value : JSON.stringify(value),
});
export function scalarValue(value: ScalarDraft): JsonValue {
  if (value.kind === 'null') return null;
  if (value.kind === 'boolean') return value.input === 'true';
  if (value.kind === 'number' && value.input.trim() !== '' && Number.isFinite(Number(value.input))) return Number(value.input);
  return value.input;
}

export function formForDefinition(definition: ProjectComponentDefinition, baseRevision: number, draftId = freshId('change')): ComponentFormDraft {
  return {
    id: definition.id, draftId, name: definition.name, baseRevision,
    template: structuredClone(definition.template),
    props: Object.entries(definition.props).map(([name, prop]) => ({
      key: freshId('property'), name, type: prop.type, required: prop.required,
      hasDefault: prop.default !== undefined,
      defaultValue: scalarDraft(prop.default !== undefined ? prop.default : prop.type === 'number' ? 0 : prop.type === 'boolean' ? false : ''),
      values: prop.type === 'enum' ? prop.values.map((value) => ({ key: freshId('value'), ...scalarDraft(value) })) : [],
    })),
    mappings: definition.propMappings.map((mapping) => ({ key: freshId('mapping'), ...structuredClone(mapping) })),
  };
}

/** Form rows retain invalid/duplicate names until the user repairs them. */
export function prepareDefinition(form: ComponentFormDraft):
  { success: true; definition: ProjectComponentDefinition; issues: [] }
  | { success: false; issues: string[] } {
  const issues: string[] = [];
  const names = new Set<string>();
  for (const row of form.props) {
    const name = DesignMemberNameSchema.safeParse(row.name);
    if (!name.success || names.has(row.name)) issues.push(`props.${row.name}: ${name.success ? 'Duplicate property name.' : name.error.issues[0]!.message}`);
    names.add(row.name);
    for (const value of [...(row.hasDefault ? [row.defaultValue] : []), ...(row.type === 'enum' ? row.values : [])]) {
      if (value.kind === 'number' && typeof scalarValue(value) !== 'number') issues.push(`props.${row.name}: Enter a finite number.`);
    }
  }
  const result = ProjectComponentDefinitionSchema.safeParse({
    schemaVersion: 1, id: form.id, name: form.name, revision: form.baseRevision + 1,
    template: form.template,
    props: Object.fromEntries(form.props.map((row) => [row.name, {
      type: row.type, required: row.required,
      ...(row.type === 'enum' ? { values: row.values.map(scalarValue) } : {}),
      ...(row.hasDefault ? { default: scalarValue(row.defaultValue) } : {}),
    }])),
    propMappings: form.mappings.map(({ key: _key, ...mapping }) => mapping),
  });
  if (!result.success) issues.push(...result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  return !issues.length && result.success ? { success: true, definition: result.data, issues: [] } : { success: false, issues };
}

export function allNodes(nodes: readonly UIIRNode[]): UIIRNode[] {
  return nodes.flatMap((node) => [node, ...(node.type === 'component' ? Object.values(node.slots ?? {}).flatMap(allNodes) : [])]);
}

function replaceNode(node: UIIRNode, id: string, replacement: UIIRNode): UIIRNode {
  if (node.id === id) return replacement;
  return node.type === 'component' && node.slots ? {
    ...node, slots: Object.fromEntries(Object.entries(node.slots).map(([slot, children]) => [slot, children.map((child) => replaceNode(child, id, replacement))])),
  } : node;
}

/** A read-derived subtree is adopted only while its source is still the reviewed value. */
export function adoptSubtree(document: UIIRDocument, source: UIIRNode, replacement: UIIRNode): UIIRDocument | null {
  const current = allNodes(document.screens.flatMap((screen) => screen.children)).find((node) => node.id === source.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(source)) return null;
  return { ...document, screens: document.screens.map((screen) => ({
    ...screen, children: screen.children.map((node) => replaceNode(node, source.id, { ...replacement, id: source.id })),
  })) };
}
