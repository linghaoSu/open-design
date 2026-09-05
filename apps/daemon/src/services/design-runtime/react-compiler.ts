import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import {
  CodeComponentDefinitionSchema,
  ComponentBindingSchema,
  ComponentRegistrySchema,
  type CodeComponentDefinition,
  type ComponentBinding,
  type ComponentPropDefinition,
  type ComponentRegistry,
  type SourceProvenance,
} from '@open-design/contracts';

export interface CompileReactComponentInput {
  sourceText: string;
  sourcePath: string;
  exportName: string;
  componentId: string;
  codeComponentId: string;
  designSystemId: string;
  packageName?: string;
}

export interface CompileReactComponentResult {
  registry: ComponentRegistry;
  codeComponent: CodeComponentDefinition;
  binding: Extract<ComponentBinding, { status: 'bound' }>;
}

export class CompilerError extends Error {
  constructor(
    message: string,
    public readonly sourcePath: string,
    public readonly exportName: string,
    public readonly line?: number,
    public readonly column?: number,
  ) {
    super(`${sourcePath}${line === undefined ? '' : `:${line}:${column ?? 1}`} (${exportName}): ${message}`);
    this.name = 'CompilerError';
  }
}

type TypeDeclaration = t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration;
type ComponentFunction = t.FunctionDeclaration | t.ArrowFunctionExpression;
type Scalar = string | number | boolean | null;

interface Context {
  input: CompileReactComponentInput;
  types: Map<string, TypeDeclaration[]>;
  fail(message: string, node?: t.Node): never;
}

/**
 * Compile one explicitly selected, directly named export without executing source.
 * This syntax-only spike deliberately rejects types it cannot fully represent.
 * Defaults are extracted only from literal assignments in the props parameter.
 */
export function compileReactComponent(input: CompileReactComponentInput): CompileReactComponentResult {
  const ctx: Context = {
    input,
    types: new Map(),
    fail(message, node) {
      throw new CompilerError(message, input.sourcePath, input.exportName,
        node?.loc?.start.line, node?.loc ? node.loc.start.column + 1 : undefined);
    },
  };
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(input.sourceText, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (error) {
    ctx.fail(`Invalid TypeScript source: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const statement of ast.program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'TSInterfaceDeclaration' && declaration?.type !== 'TSTypeAliasDeclaration') continue;
    const declarations = ctx.types.get(declaration.id.name) ?? [];
    declarations.push(declaration);
    ctx.types.set(declaration.id.name, declarations);
  }

  const component = findComponent(ast.program, ctx);
  if (component.typeParameters || component.async || component.generator) {
    ctx.fail('Generic, async, and generator components are unsupported', component);
  }
  if (component.params.length > 1) ctx.fail('Expected at most one props parameter', component);
  const parameter = component.params[0];
  const props: Record<string, ComponentPropDefinition> = Object.create(null);
  if (parameter) {
    if (parameter.type === 'Identifier' && parameter.name === 'this') {
      ctx.fail('TypeScript receiver annotations are unsupported; this is not a props parameter', parameter);
    }
    if ((parameter.type !== 'Identifier' && parameter.type !== 'ObjectPattern') || parameter.optional) {
      ctx.fail('Expected a required identifier or object props parameter with an explicit type', parameter);
    }
    if (parameter.typeAnnotation?.type !== 'TSTypeAnnotation') {
      ctx.fail('The props parameter must have an explicit TypeScript type', parameter);
    }
    const members = resolveMembers(parameter.typeAnnotation.typeAnnotation, ctx, new Set());
    for (const member of members) {
      if (member.type !== 'TSPropertySignature' || member.computed) {
        ctx.fail('Only named prop declarations are supported; methods and index signatures are unsupported', member);
      }
      const name = propertyName(member.key, ctx);
      if (Object.hasOwn(props, name)) ctx.fail(`Duplicate prop declaration: ${name}`, member);
      if (!member.typeAnnotation) ctx.fail(`Prop ${name} must have an explicit type`, member);
      props[name] = {
        ...compilePropType(member.typeAnnotation.typeAnnotation, ctx, new Set()),
        required: !member.optional,
        source: provenance(member, input),
      };
    }
    if (parameter.type === 'ObjectPattern') applyDefaults(parameter, props, ctx);
  }

  const source = provenance(component, input);
  const componentRef = `ds:${input.designSystemId}/${input.componentId}`;
  // Encoding each explicit ID keeps delimiters unambiguous and display renames stable.
  const bindingId = ['react', input.designSystemId, input.componentId, input.codeComponentId]
    .map(encodeURIComponent).join(':');
  try {
    const binding = ComponentBindingSchema.parse({
      schemaVersion: 1,
      id: bindingId,
      componentRef,
      framework: 'react',
      status: 'bound',
      codeComponentId: input.codeComponentId,
      verified: true,
      source,
    });
    if (binding.status !== 'bound') ctx.fail('Expected a bound compiler result', component);
    return {
      registry: ComponentRegistrySchema.parse({
        schemaVersion: 1,
        id: input.designSystemId,
        components: [{ schemaVersion: 1, id: input.componentId, name: input.exportName, props, source }],
      }),
      codeComponent: CodeComponentDefinitionSchema.parse({
        schemaVersion: 1,
        id: input.codeComponentId,
        framework: 'react',
        name: input.exportName,
        exportName: input.exportName,
        sourcePath: input.sourcePath,
        ...(input.packageName === undefined ? {} : { packageName: input.packageName }),
        props,
        source,
      }),
      binding,
    };
  } catch (error) {
    ctx.fail(`Invalid component metadata: ${error instanceof Error ? error.message : String(error)}`, component);
  }
}

function findComponent(program: t.Program, ctx: Context): ComponentFunction {
  const matches: ComponentFunction[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'TSDeclareFunction' && declaration.id?.name === ctx.input.exportName) {
      ctx.fail('Overloaded and declared-only components are unsupported', declaration);
    }
    if (statement.type !== 'ExportNamedDeclaration') continue;
    for (const specifier of statement.specifiers) {
      const exportedName = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value;
      if (exportedName === ctx.input.exportName) {
        ctx.fail('Export specifiers and re-exports are unsupported; use a directly named function or const arrow export', specifier);
      }
    }
    if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === ctx.input.exportName) {
      matches.push(declaration);
    } else if (declaration?.type === 'VariableDeclaration') {
      for (const variable of declaration.declarations) {
        if (variable.id.type !== 'Identifier' || variable.id.name !== ctx.input.exportName) continue;
        if (declaration.kind !== 'const' || variable.init?.type !== 'ArrowFunctionExpression' || variable.id.typeAnnotation) {
          ctx.fail('Expected a const arrow component with its type on the props parameter', variable);
        }
        matches.push(variable.init);
      }
    }
  }
  if (matches.length !== 1) {
    ctx.fail(`Expected exactly one directly named function or const arrow export ${JSON.stringify(ctx.input.exportName)}; found ${matches.length}`);
  }
  return matches[0]!;
}

function provenance(node: t.Node, input: CompileReactComponentInput): SourceProvenance {
  return {
    kind: 'typescript',
    sourcePath: input.sourcePath,
    exportName: input.exportName,
    ...(node.loc ? { line: node.loc.start.line } : {}),
    confidence: 1,
  };
}

function propertyName(node: t.Node, ctx: Context): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  ctx.fail('Only identifier or string-literal prop names are supported', node);
}

function resolveReference(node: t.TSTypeReference, ctx: Context, seen: Set<string>): TypeDeclaration {
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

function resolveMembers(node: t.TSType, ctx: Context, seen: Set<string>): t.TSTypeElement[] {
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

function compilePropType(node: t.TSType, ctx: Context, seen: Set<string>): PropShape {
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

function literalValue(node: t.Node, ctx: Context): Scalar {
  if (node.type === 'StringLiteral' || node.type === 'BooleanLiteral') return node.value;
  if (node.type === 'NullLiteral') return null;
  if (node.type === 'NumericLiteral' && Number.isFinite(node.value)) return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral'
    && Number.isFinite(node.argument.value)) return -node.argument.value;
  ctx.fail('Only finite scalar literal values are supported; computed defaults are unsupported', node);
}

function applyDefaults(parameter: t.ObjectPattern, props: Record<string, ComponentPropDefinition>, ctx: Context): void {
  const seen = new Set<string>();
  for (const property of parameter.properties) {
    if (property.type === 'RestElement') continue;
    if (property.type !== 'ObjectProperty' || property.computed) {
      ctx.fail('Computed or method props destructuring is unsupported', property);
    }
    const name = propertyName(property.key, ctx);
    if (seen.has(name)) ctx.fail(`Duplicate props destructuring: ${name}`, property);
    seen.add(name);
    const prop = props[name];
    if (!prop) ctx.fail(`Destructured prop ${name} is absent from the declared props type`, property);
    if (property.value.type === 'Identifier') continue;
    if (property.value.type !== 'AssignmentPattern' || property.value.left.type !== 'Identifier') {
      ctx.fail('Nested props destructuring is unsupported', property);
    }
    const value = literalValue(property.value.right, ctx);
    if (prop.type === 'enum') {
      if (!prop.values.includes(value)) ctx.fail(`Default for ${name} is outside its declared enum values`, property);
      prop.default = value;
    } else if (prop.type === 'string' && typeof value === 'string') {
      prop.default = value;
    } else if (prop.type === 'number' && typeof value === 'number') {
      prop.default = value;
    } else if (prop.type === 'boolean' && typeof value === 'boolean') {
      prop.default = value;
    } else {
      ctx.fail(`Default for ${name} does not match its declared ${prop.type} type`, property);
    }
  }
}
