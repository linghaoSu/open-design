import type * as t from '@babel/types';
import type { JsonValue } from '@open-design/contracts';

export type MetadataFailure = (message: string, node?: t.Node) => never;

export function unwrapMetadata(node: t.Node): t.Node {
  while (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSTypeAssertion') node = node.expression;
  return node;
}

/** Read syntax only; identifiers, calls, spreads, accessors and computed keys are not evaluated. */
export function metadataObject(raw: t.Node, fail: MetadataFailure): Map<string, t.ObjectProperty> {
  const node = unwrapMetadata(raw);
  if (node.type !== 'ObjectExpression') fail('Expected a static metadata object literal', node);
  const properties = new Map<string, t.ObjectProperty>();
  for (const property of node.properties) {
    if (property.type !== 'ObjectProperty' || property.computed || property.shorthand) fail('Metadata spreads, methods, computed keys and shorthand properties are unsupported', property);
    const name = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : fail('Metadata keys must be named identifiers or string literals', property.key);
    if (properties.has(name)) fail(`Duplicate metadata field ${name}`, property);
    properties.set(name, property);
  }
  return properties;
}

export function metadataFields(properties: Map<string, t.ObjectProperty>, allowed: readonly string[], fail: MetadataFailure): void {
  for (const [name, property] of properties) if (!allowed.includes(name)) fail(`Unsupported metadata field ${name}`, property);
}

export function metadataLiteral(raw: t.Node, fail: MetadataFailure): JsonValue {
  const node = unwrapMetadata(raw);
  if (node.type === 'StringLiteral' || node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'NumericLiteral' && Number.isFinite(node.value)) return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral' && Number.isFinite(node.argument.value)) return -node.argument.value;
  if (node.type === 'ArrayExpression') return node.elements.map((entry) => entry ? metadataLiteral(entry, fail) : fail('Sparse metadata arrays are unsupported', node));
  if (node.type === 'ObjectExpression') return Object.fromEntries([...metadataObject(node, fail)].map(([name, property]) => [name, metadataLiteral(property.value, fail)]));
  fail(`Unsupported computed metadata value ${node.type}`, node);
}

export function selectedMetadataExport(program: t.Program, name: string, fail: MetadataFailure): t.Node {
  const matches: t.Node[] = [];
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    for (const specifier of statement.specifiers) {
      if ((specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value) === name) fail('Metadata export specifiers and re-exports are unsupported', specifier);
    }
    if (statement.declaration?.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declaration.declarations) {
      if (declaration.id.type !== 'Identifier' || declaration.id.name !== name) continue;
      if (statement.declaration.kind !== 'const' || !declaration.init) fail('Selected metadata must be a directly exported const object', declaration);
      matches.push(declaration.init);
    }
  }
  if (matches.length !== 1) fail(`Expected exactly one directly exported metadata const ${JSON.stringify(name)}; found ${matches.length}`);
  return matches[0]!;
}

/** Mutable aliases/escapes would make a literal snapshot incomplete. Type-only references are harmless. */
export function assertStaticMetadataUses(program: t.Program, names: ReadonlySet<string>, fail: MetadataFailure): void {
  function visit(node: t.Node, parent?: t.Node, key?: string): void {
    const expression = unwrapMetadata(node);
    if (expression !== node) { visit(expression, node, 'expression'); return; }
    if (['TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSDeclareFunction'].includes(node.type)) return;
    if (node.type === 'Identifier' && names.has(node.name)) {
      const declaration = parent?.type === 'VariableDeclarator' && key === 'id';
      const defaultExport = parent?.type === 'ExportDefaultDeclaration' && key === 'declaration';
      const propertyName = ((parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod') && key === 'key' && !parent.computed)
        || ((parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed);
      if (!declaration && !defaultExport && !propertyName) fail(`Selected metadata ${node.name} cannot be mutated, aliased or passed to executable code`, node);
    }
    for (const [field, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(field)) continue;
      const children: unknown[] = Array.isArray(value) ? value : [value];
      for (const child of children) if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string') visit(child as t.Node, node, field);
    }
  }
  visit(program);
}
