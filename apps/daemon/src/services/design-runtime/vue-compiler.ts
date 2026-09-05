import { parse as parseTypeScript } from '@babel/parser';
import type * as t from '@babel/types';
import { compileScript, parse as parseSfc, type SFCBlock, type SFCDescriptor } from '@vue/compiler-sfc';
import {
  CodeComponentDefinitionSchema, ComponentBindingSchema, ComponentRegistrySchema,
  type CodeComponentDefinition, type CodeComponentSlotDefinition, type ComponentPropDefinition,
  type CompileSourceComponentRequest, type CompileSourceComponentResult, type ExtractSourceCodeComponentRequest, type SourceProvenance,
} from '@open-design/contracts';
import { resolveComponentBinding } from './binding-resolver.js';
import { CompilerError } from './react-compiler.js';
import { readExplicitSlotMetadata } from './source-slot-metadata.js';
import { metadataLiteral, metadataObject, unwrapMetadata } from './static-source-metadata.js';
import { compilePropType, literalValue, propertyName, resolveMembers, type TypeScriptSourceContext } from './typescript-source.js';

type VueSourceInput = Omit<ExtractSourceCodeComponentRequest, 'framework'>;
type VueCompileInput = Omit<CompileSourceComponentRequest, 'framework'>;
interface Context extends TypeScriptSourceContext { input: VueSourceInput }
interface Macro { call: t.CallExpression; variable?: t.VariableDeclarator; defaults?: t.ObjectExpression }
const macroNames = new Set(['defineProps', 'withDefaults', 'defineSlots', 'defineEmits', 'defineModel', 'defineOptions', 'defineExpose']);

/** SFC and TypeScript parsing only: neither application code nor imported modules execute. */
export function extractVueCodeComponent(input: VueSourceInput): CodeComponentDefinition {
  return readVueComponent(input).codeComponent;
}

export function compileVueComponent(input: VueCompileInput): CompileSourceComponentResult {
  const { ctx, program, codeComponent } = readVueComponent(input);
  const metadata = readExplicitSlotMetadata(program, { ...input, framework: 'vue' }, ctx.fail);
  try {
    const registry = ComponentRegistrySchema.parse({ schemaVersion: 1, id: input.designSystemId, components: [{
      schemaVersion: 1, id: input.componentId, name: codeComponent.name, props: codeComponent.props,
      ...(metadata ? { slots: metadata.slots } : {}), source: codeComponent.source,
    }] });
    const binding = ComponentBindingSchema.parse({
      schemaVersion: 1, id: ['vue', input.designSystemId, input.componentId, input.codeComponentId].map(encodeURIComponent).join(':'),
      componentRef: `ds:${input.designSystemId}/${input.componentId}`, framework: 'vue',
      status: 'bound', codeComponentId: input.codeComponentId, verified: true, source: codeComponent.source,
      ...(metadata ? { slotMappings: metadata.mappings } : {}),
    });
    if (binding.status !== 'bound') return ctx.fail('Expected a bound compiler result');
    const resolution = resolveComponentBinding(binding, registry, [codeComponent]);
    if (!resolution.ok) ctx.fail(resolution.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
    return { schemaVersion: 1, registry, codeComponent, binding };
  } catch (error) {
    if (error instanceof CompilerError) throw error;
    return ctx.fail(`Invalid component metadata: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readVueComponent(input: VueSourceInput) {
  const ctx: Context = { input, types: new Map(), fail(message, node) {
    throw new CompilerError(message, input.sourcePath, input.exportName, node?.loc?.start.line,
      node?.loc ? node.loc.start.column + 1 : undefined);
  } };
  if (input.exportName !== 'default') ctx.fail('Vue SFC compilation requires the explicitly selected default export');
  const { descriptor, errors } = parseSfc(input.sourceText, { filename: input.sourcePath });
  if (errors.length) ctx.fail(`Invalid Vue SFC: ${errors.map((error) => typeof error === 'string' ? error : error.message).join(' ')}`);
  const setup = descriptor.scriptSetup;
  if (!setup || setup.lang !== 'ts' || Object.hasOwn(setup.attrs, 'src') || Object.hasOwn(setup.attrs, 'generic')) ctx.fail('Expected a literal <script setup lang="ts"> without src or generic attributes');
  if (descriptor.script && (descriptor.script.lang !== 'ts' || descriptor.script.src)) ctx.fail('Normal script must use literal TypeScript without src');
  if (descriptor.template?.src || descriptor.template?.lang || descriptor.customBlocks.length) ctx.fail('External/preprocessed templates and custom SFC blocks are unsupported');
  const setupProgram = parseBlock(setup, ctx);
  const normalProgram = descriptor.script ? parseBlock(descriptor.script, ctx) : undefined;
  if (normalProgram) validateNormalScript(normalProgram, ctx);
  const program = { ...setupProgram, body: [...(normalProgram?.body ?? []), ...setupProgram.body] };
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type !== 'TSInterfaceDeclaration' && declaration?.type !== 'TSTypeAliasDeclaration') continue;
    const declarations = ctx.types.get(declaration.id.name) ?? [];
    declarations.push(declaration); ctx.types.set(declaration.id.name, declarations);
  }
  const macros = readMacros(setupProgram, program, ctx);
  const props: Record<string, ComponentPropDefinition> = Object.create(null);
  const slots: Record<string, CodeComponentSlotDefinition> = Object.create(null);
  if (macros.props) {
    for (const member of resolveMembers(macroType(macros.props.call, ctx), ctx, new Set())) {
      if (member.type !== 'TSPropertySignature' || member.computed || !member.typeAnnotation) ctx.fail('Only named, explicitly typed scalar props are supported', member);
      const name = propertyName(member.key, ctx);
      if (Object.hasOwn(props, name)) ctx.fail(`Duplicate prop declaration: ${name}`, member);
      props[name] = { ...compilePropType(member.typeAnnotation.typeAnnotation, ctx, new Set()), required: !member.optional, source: provenance(member, input) };
    }
    applyDefaults(macros.props, props, ctx);
    for (const [name, prop] of Object.entries(props)) {
      // Vue casts an absent optional Boolean prop to false, including literal Boolean unions.
      // Required props retain their caller obligation; explicit defaults take precedence.
      if (prop.required || prop.default !== undefined) continue;
      if (prop.type === 'boolean') prop.default = false;
      else if (prop.type === 'enum' && prop.values.some((value) => typeof value === 'boolean')) {
        if (!prop.values.includes(false)) ctx.fail(`Optional Boolean prop ${name} implicitly defaults to false outside its enum; declare a compatible literal default`, macros.props.call);
        prop.default = false;
      }
    }
  }
  if (macros.slots) {
    for (const member of resolveMembers(macroType(macros.slots.call, ctx), ctx, new Set())) {
      if ((member.type !== 'TSMethodSignature' && member.type !== 'TSPropertySignature') || member.computed) ctx.fail('Slots require named zero-argument function signatures', member);
      const signature = member.type === 'TSMethodSignature' ? member : member.typeAnnotation?.typeAnnotation;
      if (!signature || (signature.type !== 'TSMethodSignature' && signature.type !== 'TSFunctionType') || signature.parameters.length || signature.typeParameters) ctx.fail('Scoped or generic slots are unsupported; use a zero-argument slot function', member);
      const name = propertyName(member.key, ctx);
      if (Object.hasOwn(slots, name) || Object.hasOwn(props, name)) ctx.fail(`Duplicate or overlapping slot declaration: ${name}`, member);
      slots[name] = { kind: 'vue-slot', required: !member.optional, multiple: true, source: provenance(member, input) };
    }
  }
  validateTemplateSlots(descriptor, slots, ctx);
  // Vue itself verifies macro placement/hoisting and defaults. Imported type I/O is explicitly disabled.
  try { compileScript(descriptor, { id: input.codeComponentId, sourceMap: false, fs: { fileExists: () => false, readFile: () => undefined } }); }
  catch (error) { ctx.fail(`Invalid Vue script setup: ${error instanceof Error ? error.message : String(error)}`); }
  const fileName = input.sourcePath.split('/').at(-1) ?? '';
  const extension = fileName.lastIndexOf('.');
  const name = (extension > 0 ? fileName.slice(0, extension) : fileName) || 'default';
  const source = provenance(setupProgram, input);
  try {
    const codeComponent = CodeComponentDefinitionSchema.parse({ schemaVersion: 1, id: input.codeComponentId,
      framework: 'vue', name, exportName: 'default', sourcePath: input.sourcePath,
      ...(input.packageName === undefined ? {} : { packageName: input.packageName }), props,
      ...(Object.keys(slots).length ? { slots } : {}), source });
    return { ctx, program, codeComponent };
  } catch (error) { ctx.fail(`Invalid component metadata: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseBlock(block: SFCBlock, ctx: Context): t.Program {
  try { return parseTypeScript(block.content, { sourceType: 'module', plugins: ['typescript'],
    startLine: block.loc.start.line, startColumn: block.loc.start.column - 1, startIndex: block.loc.start.offset }).program; }
  catch (error) { return ctx.fail(`Invalid TypeScript source: ${error instanceof Error ? error.message : String(error)}`); }
}

function validateNormalScript(program: t.Program, ctx: Context): void {
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration' && (statement.importKind === 'type' || statement.specifiers.length > 0 && statement.specifiers.every((specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'))) continue;
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'TSInterfaceDeclaration' || declaration?.type === 'TSTypeAliasDeclaration') continue;
    if (statement.type === 'ExportNamedDeclaration' && declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
      for (const variable of declaration.declarations) {
        if (variable.id.type !== 'Identifier' || !variable.init) ctx.fail('Normal-script metadata requires a directly exported const identifier', variable);
        metadataLiteral(variable.init, ctx.fail);
      }
      continue;
    }
    ctx.fail('Normal script supports type declarations/imports and static metadata const exports only; default/options exports are unsupported', statement);
  }
}

function readMacros(setup: t.Program, combined: t.Program, ctx: Context): { props?: Macro; slots?: Macro } {
  const found: { props?: Macro; slots?: Macro } = {};
  const allowed = new Set<t.Identifier>();
  for (const statement of setup.body) {
    const candidates = statement.type === 'VariableDeclaration'
      ? statement.declarations.map((variable) => ({ expression: variable.init, variable }))
      : statement.type === 'ExpressionStatement' ? [{ expression: statement.expression, variable: undefined }] : [];
    for (const { expression, variable } of candidates) {
      if (expression?.type !== 'CallExpression' || expression.callee.type !== 'Identifier' || !macroNames.has(expression.callee.name)) continue;
      let call = expression;
      let defaults: t.ObjectExpression | undefined;
      if (call.callee.type === 'Identifier' && call.callee.name === 'withDefaults') {
        allowed.add(call.callee);
        const inner = call.arguments[0]; const value = call.arguments[1];
        if (call.arguments.length !== 2 || call.typeParameters || inner?.type !== 'CallExpression' || inner.callee.type !== 'Identifier' || inner.callee.name !== 'defineProps' || !value || value.type === 'SpreadElement' || value.type === 'ArgumentPlaceholder') ctx.fail('withDefaults requires defineProps<T>() and a literal defaults object', call);
        const unwrapped = unwrapMetadata(value);
        if (unwrapped.type !== 'ObjectExpression') ctx.fail('withDefaults requires a literal defaults object', value);
        defaults = unwrapped; call = inner;
      }
      if (call.callee.type !== 'Identifier' || (call.callee.name !== 'defineProps' && call.callee.name !== 'defineSlots')) ctx.fail('Emits, model, expose, and options macros are unsupported', call);
      allowed.add(call.callee);
      const key = call.callee.name === 'defineProps' ? 'props' : 'slots';
      if (found[key]) ctx.fail(`Duplicate ${call.callee.name} macro`, call);
      if (variable && (statement.type !== 'VariableDeclaration' || statement.kind !== 'const' || variable.id.type !== 'Identifier' && (key !== 'props' || variable.id.type !== 'ObjectPattern'))) ctx.fail('Macro results require a const identifier or props destructuring', variable);
      found[key] = { call, ...(variable ? { variable } : {}), ...(defaults ? { defaults } : {}) };
    }
  }
  walk(combined, (node, parent, key) => {
    if (node.type !== 'Identifier' || !macroNames.has(node.name) || allowed.has(node)) return;
    // Static member names do not introduce a binding or invoke a macro.
    if (key === 'key' && parent && ['TSPropertySignature', 'TSMethodSignature', 'ObjectProperty'].includes(parent.type) && !('computed' in parent && parent.computed) && !(parent.type === 'ObjectProperty' && parent.shorthand)) return;
    ctx.fail(`Vue macro ${node.name} must be an unshadowed direct top-level compiler macro; aliases, imports, and nested uses are unsupported`, node);
  });
  return found;
}

function macroType(call: t.CallExpression, ctx: Context): t.TSType {
  if (call.arguments.length || call.typeParameters?.type !== 'TSTypeParameterInstantiation' || call.typeParameters.params.length !== 1) ctx.fail('Expected a type-only macro with exactly one explicit local type argument', call);
  return call.typeParameters.params[0]!;
}

function applyDefaults(macro: Macro, props: Record<string, ComponentPropDefinition>, ctx: Context): void {
  const set = (name: string, expression: t.Node): void => {
    const prop = Object.hasOwn(props, name) ? props[name]! : ctx.fail(`Default references undeclared prop ${name}`, expression);
    const value = literalValue(expression, ctx);
    if (prop.type === 'enum') { if (!prop.values.includes(value)) ctx.fail(`Default for ${name} is outside its declared enum values`, expression); prop.default = value; }
    else if (prop.type === 'string' && typeof value === 'string') prop.default = value;
    else if (prop.type === 'number' && typeof value === 'number') prop.default = value;
    else if (prop.type === 'boolean' && typeof value === 'boolean') prop.default = value;
    else ctx.fail(`Default for ${name} does not match its declared ${prop.type} type`, expression);
  };
  if (macro.defaults) for (const [name, property] of metadataObject(macro.defaults, ctx.fail)) set(name, property.value);
  const pattern = macro.variable?.id;
  if (pattern?.type !== 'ObjectPattern') return;
  if (macro.defaults) ctx.fail('Combining withDefaults with props destructuring is unsupported', pattern);
  const seen = new Set<string>();
  for (const property of pattern.properties) {
    if (property.type === 'RestElement') continue;
    if (property.computed) ctx.fail('Computed props destructuring is unsupported', property);
    const name = propertyName(property.key, ctx);
    if (seen.has(name)) ctx.fail(`Duplicate props destructuring: ${name}`, property);
    seen.add(name);
    if (!Object.hasOwn(props, name)) ctx.fail(`Destructured prop ${name} is absent from the declared props type`, property);
    if (property.value.type === 'Identifier') continue;
    if (property.value.type !== 'AssignmentPattern' || property.value.left.type !== 'Identifier') ctx.fail('Nested props destructuring is unsupported', property);
    set(name, property.value.right);
  }
}

function validateTemplateSlots(descriptor: SFCDescriptor, slots: Record<string, CodeComponentSlotDefinition>, ctx: Context): void {
  const root = descriptor.template?.ast;
  if (!root) return;
  const visit = (nodes: typeof root.children): void => {
    for (const node of nodes) {
      if (node.type !== 1) continue; // Vue ElementNode, before transform.
      if (node.tag === 'slot') {
        let name = 'default';
        for (const property of node.props) {
          if (property.type === 6 && property.name === 'name' && property.value) name = property.value.content;
          else if (property.type !== 7 || !['if', 'else-if', 'else', 'for'].includes(property.name)) ctx.fail('Scoped slot props and dynamic slot names are unsupported');
        }
        if (!Object.hasOwn(slots, name)) ctx.fail(`Template slot ${name} requires a matching defineSlots declaration`);
      }
      visit(node.children);
    }
  };
  visit(root.children);
}

function walk(node: t.Node, visit: (node: t.Node, parent?: t.Node, key?: string) => void, parent?: t.Node, key?: string): void {
  visit(node, parent, key);
  for (const [childKey, value] of Object.entries(node)) {
    if (childKey === 'loc' || childKey === 'extra' || childKey.endsWith('Comments')) continue;
    for (const child of Array.isArray(value) ? value : [value]) if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string') walk(child as t.Node, visit, node, childKey);
  }
}

function provenance(node: t.Node, input: VueSourceInput): SourceProvenance {
  return { kind: 'vue', sourcePath: input.sourcePath, exportName: 'default', ...(node.loc ? { line: node.loc.start.line } : {}), confidence: 1 };
}
