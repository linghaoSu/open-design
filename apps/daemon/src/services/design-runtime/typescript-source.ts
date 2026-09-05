import type * as t from '@babel/types';

export type TypeDeclaration = t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration;
type Scalar = string | number | boolean | null;
export interface TypeScriptSourceContext {
  types: Map<string, TypeDeclaration[]>;
  fail(message: string, node?: t.Node): never;
}

/** Shared syntax-only scalar vocabulary; never loads imported type declarations. */
export function propertyName(node: t.Node, ctx: TypeScriptSourceContext): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  ctx.fail('Only identifier or string-literal prop names are supported', node);
}

export function resolveReference(node: t.TSTypeReference, ctx: TypeScriptSourceContext, seen: Set<string>): TypeDeclaration {
  if (node.typeName.type !== 'Identifier' || node.typeParameters) {
    ctx.fail('Qualified and generic type references are unsupported', node);
  }
  const name = node.typeName.name;
  if (seen.has(name)) ctx.fail(`Cyclic type reference: ${name}`, node);
  seen.add(name);
  const declarations = ctx.types.get(name);
  if (!declarations?.length) ctx.fail(`Type ${name} must be declared in the same source; imported types are unsupported`, node);
  if (declarations.length !== 1) ctx.fail(`Merged or ambiguous type declarations are unsupported: ${name}`, node);
  const declaration = declarations[0]!;
  if (declaration.typeParameters) ctx.fail(`Generic type declaration is unsupported: ${name}`, declaration);
  return declaration;
}

export function resolveMembers(node: t.TSType, ctx: TypeScriptSourceContext, seen: Set<string>): t.TSTypeElement[] {
  if (node.type === 'TSParenthesizedType') return resolveMembers(node.typeAnnotation, ctx, seen);
  if (node.type === 'TSTypeLiteral') return node.members;
  if (node.type === 'TSTypeReference') {
    const declaration = resolveReference(node, ctx, seen);
    if (declaration.type === 'TSTypeAliasDeclaration') return resolveMembers(declaration.typeAnnotation, ctx, seen);
    if (declaration.extends?.length) ctx.fail('Interface inheritance is unsupported', declaration);
    return declaration.body.body;
  }
  ctx.fail(`Unsupported props type ${node.type}; expected a local interface or type literal`, node);
}

type PropShape =
  | { type: 'enum'; values: Scalar[] }
  | { type: 'boolean' | 'string' | 'number' };

export function compilePropType(node: t.TSType, ctx: TypeScriptSourceContext, seen: Set<string>): PropShape {
  switch (node.type) {
    case 'TSStringKeyword': return { type: 'string' };
    case 'TSNumberKeyword': return { type: 'number' };
    case 'TSBooleanKeyword': return { type: 'boolean' };
    case 'TSNullKeyword': return { type: 'enum', values: [null] };
    case 'TSLiteralType': return { type: 'enum', values: [literalValue(node.literal, ctx)] };
    case 'TSParenthesizedType': return compilePropType(node.typeAnnotation, ctx, seen);
    case 'TSTypeReference': {
      const declaration = resolveReference(node, ctx, seen);
      if (declaration.type !== 'TSTypeAliasDeclaration') ctx.fail('Object props are unsupported', node);
      return compilePropType(declaration.typeAnnotation, ctx, seen);
    }
    case 'TSUnionType': {
      const values: Scalar[] = [];
      for (const member of node.types) {
        const shape = compilePropType(member, ctx, new Set(seen));
        if (shape.type !== 'enum') ctx.fail('Only unions of scalar literals are supported', member);
        for (const value of shape.values) if (!values.includes(value)) values.push(value);
      }
      return { type: 'enum', values };
    }
    default: ctx.fail(`Unsupported prop type ${node.type}`, node);
  }
}

export function literalValue(node: t.Node, ctx: TypeScriptSourceContext): Scalar {
  if (node.type === 'StringLiteral' || node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'NumericLiteral' && Number.isFinite(node.value)) return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral'
    && Number.isFinite(node.argument.value)) return -node.argument.value;
  ctx.fail('Only finite scalar literal values are supported; computed defaults are unsupported', node);
}
