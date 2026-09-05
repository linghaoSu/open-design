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
  type CodeComponentSlotDefinition,
  type ExtractSourceCodeComponentRequest,
  type SourceProvenance,
} from '@open-design/contracts';
import { resolveComponentBinding } from './binding-resolver.js';
import { readExplicitSlotMetadata } from './source-slot-metadata.js';
import { compilePropType, literalValue, propertyName, resolveMembers, resolveReference, type TypeDeclaration } from './typescript-source.js';

type ReactSourceInput = Omit<ExtractSourceCodeComponentRequest, 'framework'>;

export interface CompileReactComponentInput extends ReactSourceInput {
  componentId: string;
  designSystemId: string;
  metadataExportName?: string | undefined;
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

type ComponentFunction = t.FunctionDeclaration | t.ArrowFunctionExpression;

interface Context {
  input: ReactSourceInput;
  reactNodeNames: Set<string>;
  reactNamespaces: Set<string>;
  localNamespaces: Set<string>;
  types: Map<string, TypeDeclaration[]>;
  fail(message: string, node?: t.Node): never;
}

/**
 * Compile one explicitly selected, directly named export without executing source.
 * This syntax-only spike deliberately rejects types it cannot fully represent.
 * Defaults are extracted only from literal assignments in the props parameter.
 */
export function extractReactCodeComponent(input: ReactSourceInput): CodeComponentDefinition {
  return readReactComponent(input).codeComponent;
}

export function compileReactComponent(input: CompileReactComponentInput): CompileReactComponentResult {
  const { ast, ctx, component, codeComponent } = readReactComponent(input);
  const source = provenance(component, input);
  const metadata = readExplicitSlotMetadata(ast.program, input, ctx.fail);
  const bindingId = ['react', input.designSystemId, input.componentId, input.codeComponentId].map(encodeURIComponent).join(':');
  try {
    const registry = ComponentRegistrySchema.parse({
      schemaVersion: 1, id: input.designSystemId,
      components: [{ schemaVersion: 1, id: input.componentId, name: input.exportName, props: codeComponent.props,
        ...(metadata ? { slots: metadata.slots } : {}), source }],
    });
    const binding = ComponentBindingSchema.parse({
      schemaVersion: 1, id: bindingId, componentRef: `ds:${input.designSystemId}/${input.componentId}`,
      framework: 'react', status: 'bound', codeComponentId: input.codeComponentId, verified: true, source,
      ...(metadata ? { slotMappings: metadata.mappings } : {}),
    });
    if (binding.status !== 'bound') return ctx.fail('Expected a bound compiler result', component);
    const resolved = resolveComponentBinding(binding, registry, [codeComponent]);
    if (!resolved.ok) ctx.fail(resolved.diagnostics.map((diagnostic) => diagnostic.message).join(' '), component);
    return { registry, codeComponent, binding };
  } catch (error) {
    if (error instanceof CompilerError) throw error;
    return ctx.fail(`Invalid component metadata: ${error instanceof Error ? error.message : String(error)}`, component);
  }
}

function readReactComponent(input: ReactSourceInput) {
  const ctx: Context = {
    input,
    types: new Map(),
    reactNodeNames: new Set(),
    reactNamespaces: new Set(),
    localNamespaces: new Set(),
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
    if (statement.type === 'ImportDeclaration' && statement.source.value === 'react') {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier' && (specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value) === 'ReactNode') ctx.reactNodeNames.add(specifier.local.name);
        if (specifier.type === 'ImportNamespaceSpecifier' || specifier.type === 'ImportDefaultSpecifier') ctx.reactNamespaces.add(specifier.local.name);
      }
    }
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'TSModuleDeclaration' && declaration.id.type === 'Identifier') ctx.localNamespaces.add(declaration.id.name);
    if (declaration?.type !== 'TSInterfaceDeclaration' && declaration?.type !== 'TSTypeAliasDeclaration') continue;
    const declarations = ctx.types.get(declaration.id.name) ?? [];
    declarations.push(declaration);
    ctx.types.set(declaration.id.name, declarations);
  }

  const component = findComponent(ast.program, ctx);
  assertStableComponentExport(ast.program, ctx);
  if (component.typeParameters || component.async || component.generator) {
    ctx.fail('Generic, async, and generator components are unsupported', component);
  }
  if (component.params.length > 1) ctx.fail('Expected at most one props parameter', component);
  const parameter = component.params[0];
  const props: Record<string, ComponentPropDefinition> = Object.create(null);
  const slots: Record<string, CodeComponentSlotDefinition> = Object.create(null);
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
      if (Object.hasOwn(props, name) || Object.hasOwn(slots, name)) ctx.fail(`Duplicate prop declaration: ${name}`, member);
      if (!member.typeAnnotation) ctx.fail(`Prop ${name} must have an explicit type`, member);
      if (isReactNodeType(member.typeAnnotation.typeAnnotation, ctx, new Set())) {
        slots[name] = { kind: 'react-node', required: !member.optional, multiple: true, source: provenance(member, input) };
        continue;
      }
      props[name] = {
        ...compilePropType(member.typeAnnotation.typeAnnotation, ctx, new Set()),
        required: !member.optional,
        source: provenance(member, input),
      };
    }
    if (parameter.type === 'ObjectPattern') applyDefaults(parameter, props, slots, ctx);
  }

  const source = provenance(component, input);
  try {
    const codeComponent = CodeComponentDefinitionSchema.parse({
      schemaVersion: 1, id: input.codeComponentId, framework: 'react', name: input.exportName,
      exportName: input.exportName, sourcePath: input.sourcePath,
      ...(input.packageName === undefined ? {} : { packageName: input.packageName }),
      props, ...(Object.keys(slots).length ? { slots } : {}), source,
    });
    return { ast, ctx, component, codeComponent };
  } catch (error) {
    ctx.fail(`Invalid component metadata: ${error instanceof Error ? error.message : String(error)}`, component);
  }
}

function isReactNodeType(node: t.TSType, ctx: Context, seen: Set<string>): boolean {
  if (node.type === 'TSParenthesizedType') return isReactNodeType(node.typeAnnotation, ctx, seen);
  if (node.type !== 'TSTypeReference' || node.typeParameters) return false;
  if (node.typeName.type === 'TSQualifiedName') {
    return node.typeName.left.type === 'Identifier' && ctx.reactNamespaces.has(node.typeName.left.name)
      && node.typeName.right.name === 'ReactNode' && !ctx.types.has(node.typeName.left.name) && !ctx.localNamespaces.has(node.typeName.left.name);
  }
  const name = node.typeName.name;
  if (ctx.reactNodeNames.has(name)) {
    if (ctx.types.has(name) || ctx.localNamespaces.has(name)) ctx.fail('ReactNode import is shadowed by a local declaration', node);
    return true;
  }
  if (!ctx.types.has(name) || seen.has(name)) return false;
  const declaration = resolveReference(node, ctx, seen);
  return declaration.type === 'TSTypeAliasDeclaration' && isReactNodeType(declaration.typeAnnotation, ctx, seen);
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

/** Bounded syntax proof: writes and namespace augmentation invalidate the selected export API. */
function assertStableComponentExport(program: t.Program, ctx: Context): void {
  const targetsExport = (node: t.Node | null | undefined): boolean => {
    if (!node) return false;
    if (node.type === 'Identifier') return node.name === ctx.input.exportName;
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') return targetsExport(node.object);
    if (node.type === 'ObjectPattern') return node.properties.some((property) => targetsExport(property.type === 'RestElement' ? property.argument : property.value));
    if (node.type === 'ArrayPattern') return node.elements.some(targetsExport);
    if (node.type === 'RestElement') return targetsExport(node.argument);
    if (node.type === 'AssignmentPattern') return targetsExport(node.left);
    if (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion' || node.type === 'TSNonNullExpression') return targetsExport(node.expression);
    return false;
  };
  const visit = (node: t.Node): void => {
    if (['TSTypeAliasDeclaration', 'TSInterfaceDeclaration', 'TSTypeAnnotation', 'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation'].includes(node.type)) return;
    const written = node.type === 'AssignmentExpression' ? node.left
      : node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete') ? node.argument
        : node.type === 'ForInStatement' || node.type === 'ForOfStatement' ? node.left : undefined;
    if (targetsExport(written) || (node.type === 'TSModuleDeclaration' && node.id.type === 'Identifier' && node.id.name === ctx.input.exportName)) {
      ctx.fail('Selected component export mutations and namespace augmentation are unsupported', node);
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string') visit(child as t.Node);
      }
    }
  };
  visit(program);
}

function provenance(node: t.Node, input: ReactSourceInput): SourceProvenance {
  return {
    kind: 'typescript',
    sourcePath: input.sourcePath,
    exportName: input.exportName,
    ...(node.loc ? { line: node.loc.start.line } : {}),
    confidence: 1,
  };
}

function applyDefaults(parameter: t.ObjectPattern, props: Record<string, ComponentPropDefinition>, slots: Record<string, CodeComponentSlotDefinition>, ctx: Context): void {
  const seen = new Set<string>();
  for (const property of parameter.properties) {
    if (property.type === 'RestElement') continue;
    if (property.type !== 'ObjectProperty' || property.computed) {
      ctx.fail('Computed or method props destructuring is unsupported', property);
    }
    const name = propertyName(property.key, ctx);
    if (seen.has(name)) ctx.fail(`Duplicate props destructuring: ${name}`, property);
    seen.add(name);
    if (Object.hasOwn(slots, name)) {
      if (property.value.type !== 'Identifier') ctx.fail('Defaults and nested destructuring for ReactNode slots are unsupported', property);
      continue;
    }
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
