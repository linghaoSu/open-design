import { parse, parseExpression } from '@babel/parser';
import type * as t from '@babel/types';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { load } from 'cheerio';
import postcss from 'postcss';
import { posix } from 'node:path';
import type { CodeComponentDefinition, DesignValidationOutput, DesignValidationSource, JsonScalar, ValidationDiagnostic } from '@open-design/contracts';

export interface SourceLocation { sourcePath: string; line: number; column: number }
export type AnalyzedDesignNode = { type: 'text'; text: string; location: SourceLocation }
  | { type: 'element'; tag: string; code?: CodeComponentDefinition; props: Record<string, JsonScalar>; slots: Record<string, AnalyzedDesignNode[]>; location: SourceLocation };
export interface DesignSourceAnalysis {
  outputs: Array<{ output: DesignValidationOutput; nodes: AnalyzedDesignNode[] }>;
  diagnostics: ValidationDiagnostic[]; complete: boolean; importsComplete: boolean;
  visited: string[]; styles: Array<{ sourcePath: string; content: string; inline: boolean }>;
  audits: AnalyzedDesignNode[][];
  implementations: Array<{ codeId: string; props: Record<string, JsonScalar>; nodes: AnalyzedDesignNode[] }>;
}
export interface SourceAnalysisContext {
  sources: readonly DesignValidationSource[];
  codes: readonly CodeComponentDefinition[];
  /** Byte values are supplied only after the caller re-verifies package/source evidence. */
  provenCodeSources: ReadonlyMap<string, string>;
  frozenSources: ReadonlyMap<string, string>;
  /** Internal host inventory paths; omitted public validation audits every supplied source. */
  auditPaths?: readonly string[];
}
interface Imported { path: string; exported: string; code?: CodeComponentDefinition; runtime?: boolean }
interface Module { source: DesignValidationSource; program: t.Program; imports: Map<string, Imported>; exports: Map<string, t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression> }
const nativeTags = new Set('html head body title meta link style script main header footer nav section article aside div span p pre code blockquote ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col form fieldset legend label button input select option optgroup textarea a img picture source video audio canvas svg path circle rect line polyline polygon g defs use symbol h1 h2 h3 h4 h5 h6 br hr strong em b i small s u details summary dialog progress meter output time abbr figure figcaption'.split(' '));
const canonical = (value: unknown): string => JSON.stringify(value);

/** A closed static subset. Unknown source never masquerades as an empty, valid tree. */
export function analyzeDesignSources(context: SourceAnalysisContext, outputs: readonly DesignValidationOutput[]): DesignSourceAnalysis {
  const result: DesignSourceAnalysis = { outputs: [], diagnostics: [], complete: true, importsComplete: true, visited: [], styles: [], implementations: [], audits: [] };
  const implementationIds = new Set<string>(); const renderedJsx = new WeakSet<t.Node>(); const renderedFunctions = new Set<string>(); const renderedVue = new Set<string>();
  const environments: Array<Map<string, JsonScalar | Record<string, JsonScalar>>> = [];
  const sources = new Map(context.sources.map((source) => [source.sourcePath, source]));
  // Registered project source evidence is an explicit byte input too, not an exemption.
  for (const code of context.codes) {
    const sourceText = context.provenCodeSources.get(code.id);
    if (sourceText !== undefined && !sources.has(code.sourcePath) && !context.frozenSources.has(code.sourcePath)) sources.set(code.sourcePath, { sourcePath: code.sourcePath, language: code.framework === 'react' ? 'tsx' : 'vue', sourceText });
  }
  const modules = new Map<string, Module>(); const visiting = new Set<string>(); const activeCalls = new Set<string>();
  const location = (sourcePath: string, node?: { loc?: { start: { line: number; column: number } } | null } | null): SourceLocation => ({ sourcePath, line: node?.loc?.start.line ?? 1, column: (node?.loc?.start.column ?? 0) + 1 });
  function fail(code: ValidationDiagnostic['code'], message: string, at: SourceLocation): void {
    if (code === 'ODDS6003') result.importsComplete = false;
    result.complete = false;
    result.diagnostics.push({ schemaVersion: 1, code, severity: 'error', message, location: at });
  }
  function pathFor(owner: string, specifier: string): string | undefined {
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined;
    const path = posix.normalize(posix.join(posix.dirname(owner), specifier));
    if (path.startsWith('../') || path.startsWith('/')) return undefined;
    const candidates = posix.extname(path) ? [path] : [path, `${path}.tsx`, `${path}.ts`, `${path}.vue`, `${path}.css`];
    const existing = candidates.filter((candidate) => sources.has(candidate) || context.frozenSources.has(candidate));
    return existing.length === 1 ? existing[0] : undefined;
  }
  function resolveImport(owner: DesignValidationSource, specifier: string, exported: string, at: SourceLocation): Imported | undefined {
    if (specifier === 'react' || specifier === 'vue' || specifier === 'react/jsx-runtime') return { path: specifier, exported, runtime: true };
    const relative = specifier.startsWith('.'); const path = relative ? pathFor(owner.sourcePath, specifier) : undefined;
    const codes = context.codes.filter((code) => code.framework === (owner.language === 'vue' ? 'vue' : 'react') && code.exportName === exported
      && (relative ? code.sourcePath === path : code.packageName === specifier));
    if (codes.length === 1) {
      const code = codes[0]!; const proof = context.provenCodeSources.get(code.id);
      const supplied = sources.get(code.sourcePath);
      if (proof === undefined || (relative && (!supplied && !context.frozenSources.has(code.sourcePath))) || (supplied && supplied.sourceText !== proof)) {
        fail('ODDS6005', `Imported production source ${code.id} does not match verified bytes.`, at); return undefined;
      }
      if (supplied && !context.frozenSources.has(code.sourcePath)) {
        visitFile(code.sourcePath);
      }
      return { path: code.sourcePath, exported, code };
    }
    if (relative && path && sources.has(path)) { visitFile(path); return { path, exported }; }
    fail('ODDS6003', `Import ${specifier}:${exported} does not resolve uniquely to supplied source or a verified production export.`, at);
    return undefined;
  }
  function recordFunction(module: Module, exported: string, node: t.Node | null | undefined): void {
    if (node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression') {
      if (module.exports.has(exported)) fail('ODDS6002', `Ambiguous export ${exported}.`, location(module.source.sourcePath, node));
      module.exports.set(exported, node);
    } else fail('ODDS6002', `Export ${exported} requires a direct static function.`, location(module.source.sourcePath, node));
  }
  function readProgram(source: DesignValidationSource, content: string): Module | undefined {
    let program: t.Program;
    try { program = parse(content, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program; }
    catch (error) { fail('ODDS6001', `Source could not be parsed: ${error instanceof Error ? error.message : String(error)}`, location(source.sourcePath)); return undefined; }
    const module: Module = { source, program, imports: new Map(), exports: new Map() }; modules.set(source.sourcePath, module);
    const provenVue = source.language === 'vue' && context.codes.some((code) => code.sourcePath === source.sourcePath && context.provenCodeSources.get(code.id) === source.sourceText);
    const macro = (node: t.Node | null | undefined): boolean => node?.type === 'CallExpression' && node.callee.type === 'Identifier' && ['defineProps', 'withDefaults', 'defineSlots'].includes(node.callee.name);
    for (const statement of program.body) {
      if (statement.type === 'ImportDeclaration') {
        if (statement.importKind === 'type') continue;
        if (!statement.specifiers.length) { const path = pathFor(source.sourcePath, statement.source.value); if (path) visitFile(path); else fail('ODDS6003', `Side-effect import ${statement.source.value} needs supplied local source.`, location(source.sourcePath, statement)); }
        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue;
          const exported = specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? '*' : specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
          const imported = resolveImport(source, statement.source.value, exported, location(source.sourcePath, statement));
          if (imported) module.imports.set(specifier.local.name, imported);
        }
      } else if (provenVue && (statement.type === 'ExpressionStatement' && macro(statement.expression) || statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.every((entry) => entry.id.type === 'Identifier' && macro(entry.init)))) {
        // The source compiler already proved these exact macro bytes and scalar API.
      } else if (statement.type === 'ExportDefaultDeclaration') recordFunction(module, 'default', statement.declaration);
      else if (statement.type === 'ExportNamedDeclaration') {
        const declaration = statement.declaration;
        if (declaration?.type === 'FunctionDeclaration' && declaration.id) recordFunction(module, declaration.id.name, declaration);
        else if (declaration?.type === 'VariableDeclaration' && declaration.kind === 'const') {
          for (const entry of declaration.declarations) if (entry.id.type === 'Identifier') recordFunction(module, entry.id.name, entry.init);
          else fail('ODDS6002', 'Destructured exports are unsupported.', location(source.sourcePath, declaration));
        } else if (declaration?.type !== 'TSTypeAliasDeclaration' && declaration?.type !== 'TSInterfaceDeclaration') fail('ODDS6002', 'Re-exports and non-function value exports are unsupported.', location(source.sourcePath, statement));
      } else if (statement.type === 'FunctionDeclaration' && statement.id) recordFunction(module, statement.id.name, statement);
      else if (statement.type !== 'TSTypeAliasDeclaration' && statement.type !== 'TSInterfaceDeclaration' && statement.type !== 'EmptyStatement') {
        fail('ODDS6002', 'Module execution, aliases and mutable declarations are outside static source validation.', location(source.sourcePath, statement));
      }
    }
    // Reject binding writes even in unreachable callbacks; lexical aliases never establish proof.
    const importedNames = new Set(module.imports.keys());
    const target = (node: t.Node | null | undefined): boolean => !!node && (node.type === 'Identifier' ? importedNames.has(node.name)
      : node.type === 'MemberExpression' ? target(node.object) : node.type === 'ObjectPattern' ? node.properties.some((entry) => target(entry.type === 'RestElement' ? entry.argument : entry.value))
        : node.type === 'ArrayPattern' ? node.elements.some(target) : false);
    const walk = (node: t.Node): void => {
      if (node.type.startsWith('TS')) return;
      if ((node.type === 'AssignmentExpression' && target(node.left)) || (node.type === 'UpdateExpression' && target(node.argument)) || (node.type === 'UnaryExpression' && node.operator === 'delete' && target(node.argument))) fail('ODDS6002', 'Imported component bindings must not be reassigned or mutated.', location(source.sourcePath, node));
      if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.params.some((param) => target(param))) fail('ODDS6002', 'A parameter shadows an imported component binding.', location(source.sourcePath, node));
      for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string') walk(child as t.Node);
    };
    walk(program); return module;
  }
  function scalar(node: t.Node | null | undefined, at: SourceLocation): JsonScalar | undefined {
    if (node?.type === 'StringLiteral' || node?.type === 'BooleanLiteral' || node?.type === 'NumericLiteral') return node.value;
    if (node?.type === 'NullLiteral') return null;
    if (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value;
    const environment = environments.at(-1);
    if (node?.type === 'Identifier' && environment?.has(node.name)) { const value = environment.get(node.name); if (value === null || typeof value !== 'object') return value; }
    if (node?.type === 'MemberExpression' && node.object.type === 'Identifier') {
      const object = environment?.get(node.object.name);
      const key = !node.computed && node.property.type === 'Identifier' ? node.property.name : node.property.type === 'StringLiteral' ? node.property.value : undefined;
      if (object && typeof object === 'object' && key !== undefined && Object.hasOwn(object, key)) return object[key];
    }
    fail('ODDS6002', 'Computed property values cannot be statically certified.', at); return undefined;
  }
  function element(module: Module, tag: string, at: SourceLocation): Extract<AnalyzedDesignNode, { type: 'element' }> {
    const intrinsicJsx = module.source.language === 'tsx' && (/^[a-z]/.test(tag) || tag.includes('-'));
    const imported = intrinsicJsx ? undefined : module.imports.get(tag);
    const node: Extract<AnalyzedDesignNode, { type: 'element' }> = { type: 'element', tag, props: Object.create(null), slots: Object.create(null), location: at };
    if (imported?.code) node.code = imported.code;
    else if (!nativeTags.has(tag)) fail('ODDS1001', `Component ${tag} lacks a unique verified production import.`, at);
    return node;
  }
  function jsx(module: Module, node: t.Node | null | undefined): AnalyzedDesignNode[] {
    const at = location(module.source.sourcePath, node);
    if (node) renderedJsx.add(node);
    if (!node || node.type === 'JSXEmptyExpression') return [];
    if (node.type === 'JSXText') { const text = node.value.replace(/\s+/g, ' '); return text.trim() ? [{ type: 'text', text, location: at }] : []; }
    if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return [{ type: 'text', text: String(node.value), location: at }];
    if (node.type === 'Identifier' || node.type === 'MemberExpression') { const value = scalar(node, at); return value === undefined || value === null || typeof value === 'boolean' ? [] : [{ type: 'text', text: String(value), location: at }]; }
    if (node.type === 'JSXExpressionContainer') return jsx(module, node.expression);
    if (node.type === 'JSXFragment') return node.children.flatMap((child) => jsx(module, child));
    if (node.type !== 'JSXElement' || node.openingElement.name.type !== 'JSXIdentifier') { fail('ODDS6002', 'Only static JSX elements, fragments and literal text are supported.', at); return []; }
    const tag = node.openingElement.name.name;
    // JSX lowering uses literal strings for lowercase/custom-element names, regardless of imports.
    const intrinsic = /^[a-z]/.test(tag) || tag.includes('-');
    const local = intrinsic ? undefined : module.exports.get(tag); const imported = intrinsic ? undefined : module.imports.get(tag);
    if (local || (imported && !imported.code && !imported.runtime)) {
      if (node.openingElement.attributes.length || node.children.some((child) => child.type !== 'JSXText' || child.value.trim())) { fail('ODDS6002', 'Unbound local composition supports only zero-prop, zero-slot functions.', at); return []; }
      return renderFunction(local ? module : modules.get(imported!.path), local ? tag : imported!.exported);
    }
    if (imported?.runtime && imported.path === 'react' && imported.exported === 'Fragment') {
      if (node.openingElement.attributes.length) fail('ODDS6002', 'Fragment attributes are outside the static rendering grammar.', at);
      return node.children.flatMap((child) => jsx(module, child));
    }
    const resultNode = element(module, tag, at);
    const attributes: Array<{ name: string; value: t.Node | null | undefined }> = [];
    for (const attribute of node.openingElement.attributes) {
      if (attribute.type === 'JSXSpreadAttribute' && attribute.argument.type === 'ObjectExpression') {
        for (const property of attribute.argument.properties) {
          if (property.type !== 'ObjectProperty' || property.computed || (property.key.type !== 'Identifier' && property.key.type !== 'StringLiteral')) { fail('ODDS6002', 'JSX object spreads require explicit scalar/slot members.', at); continue; }
          attributes.push({ name: property.key.type === 'Identifier' ? property.key.name : property.key.value, value: property.value });
        }
      } else if (attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier') attributes.push({ name: attribute.name.name, value: attribute.value?.type === 'JSXExpressionContainer' ? attribute.value.expression : attribute.value });
      else fail('ODDS6002', 'Dynamic spreads and namespaced JSX attributes are unsupported.', at);
    }
    for (const { name, value } of attributes) {
      if (Object.hasOwn(resultNode.props, name) || Object.hasOwn(resultNode.slots, name)) { fail('ODDS6002', `Duplicate JSX member ${name}.`, at); continue; }
      if (Object.hasOwn(resultNode.code?.slots ?? {}, name)) resultNode.slots[name] = jsx(module, value);
      else if (name === 'style' && value?.type === 'ObjectExpression') {
        const declarations: string[] = [];
        for (const property of value.properties) {
          if (property.type !== 'ObjectProperty' || property.computed || (property.key.type !== 'Identifier' && property.key.type !== 'StringLiteral')) { fail('ODDS6002', 'Style objects require explicit literal property declarations.', at); continue; }
          const key = (property.key.type === 'Identifier' ? property.key.name : property.key.value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
          const literal = scalar(property.value, at); if (literal !== undefined) declarations.push(`${key}:${literal}`);
        }
        result.styles.push({ sourcePath: module.source.sourcePath, content: declarations.join(';'), inline: true });
        resultNode.props[name] = declarations.join(';');
        if (resultNode.code) fail('ODDS6002', 'Object-valued style props are outside the bound scalar production API.', at);
      } else { const literal = value ? scalar(value, at) : true; if (literal !== undefined) resultNode.props[name] = literal; }
    }
    const children = node.children.flatMap((child) => jsx(module, child));
    if (children.length) {
      if (Object.hasOwn(resultNode.slots, 'children')) fail('ODDS6002', 'Children cannot be supplied both as a prop and nested content.', at);
      resultNode.slots.children = children;
    }
    auditImplementation(resultNode);
    return [resultNode];
  }
  function auditUnrenderedJsx(module: Module, node: t.Node): void {
    if (node.type.startsWith('TS')) return;
    if ((node.type === 'JSXElement' || node.type === 'JSXFragment') && !renderedJsx.has(node)) {
      fail('ODDS6002', 'Additional JSX outside the proven call tree requires explicit source conformance.', location(module.source.sourcePath, node));
      result.audits.push(jsx(module, node)); return;
    }
    for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) if (child && typeof child === 'object' && 'type' in child && typeof child.type === 'string') auditUnrenderedJsx(module, child as t.Node);
  }
  function renderFunction(module: Module | undefined, exported: string, suppliedProps?: Record<string, JsonScalar>): AnalyzedDesignNode[] {
    if (!module) return [];
    const key = canonical([module.source.sourcePath, exported]);
    if (activeCalls.has(key) || activeCalls.size > 100) { fail('ODDS6002', 'Cyclic or excessive source composition cannot be certified.', location(module.source.sourcePath)); return []; }
    const fn = module.exports.get(exported);
    if (!fn) { fail('ODDS6003', `Selected export ${exported} is not a static component function.`, location(module.source.sourcePath)); return []; }
    activeCalls.add(key); renderedFunctions.add(key);
    const environment = new Map<string, JsonScalar | Record<string, JsonScalar>>();
    if (fn.async || fn.generator || fn.params.length && (!suppliedProps || fn.params.length !== 1)) fail('ODDS6002', 'Functions require synchronous static rendering and an explicitly materialized production props input.', location(module.source.sourcePath, fn));
    const parameter = suppliedProps ? fn.params[0] : undefined;
    if (parameter?.type === 'Identifier') environment.set(parameter.name, suppliedProps!);
    else if (parameter?.type === 'ObjectPattern') {
      for (const property of parameter.properties) {
        if (property.type !== 'ObjectProperty' || property.computed || (property.key.type !== 'Identifier' && property.key.type !== 'StringLiteral')) { fail('ODDS6002', 'Production prop destructuring requires literal member names without rest.', location(module.source.sourcePath, parameter)); continue; }
        const name = property.key.type === 'Identifier' ? property.key.name : property.key.value;
        const target = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
        const value = Object.hasOwn(suppliedProps!, name) ? suppliedProps![name] : property.value.type === 'AssignmentPattern' ? scalar(property.value.right, location(module.source.sourcePath, property)) : undefined;
        if (target.type !== 'Identifier') fail('ODDS6002', 'Nested production prop destructuring is unsupported.', location(module.source.sourcePath, property));
        else if (value !== undefined) environment.set(target.name, value);
      }
    } else if (parameter) fail('ODDS6002', 'Only direct identifier/destructured production props are supported.', location(module.source.sourcePath, parameter));
    environments.push(environment);
    let returned: t.Node | null | undefined = fn.body;
    if (fn.body.type === 'BlockStatement') {
      if (fn.body.body.length !== 1 || fn.body.body[0]?.type !== 'ReturnStatement') {
        fail('ODDS6002', 'Screen bodies must contain one static return; control flow and local mutation are unsupported.', location(module.source.sourcePath, fn));
        // A called helper can be unchanged since the run baseline. Still measure its
        // visible literals without claiming which unsupported branch executes.
        auditUnrenderedJsx(module, fn.body); returned = undefined;
      }
      else returned = fn.body.body[0].argument;
    }
    const nodes = jsx(module, returned); environments.pop(); activeCalls.delete(key); return nodes;
  }
  function auditImplementation(node: Extract<AnalyzedDesignNode, { type: 'element' }>): void {
    const code = node.code;
    if (!code || context.frozenSources.has(code.sourcePath) || !sources.has(code.sourcePath)) return;
    const props = Object.assign(Object.create(null), Object.fromEntries(Object.entries(code.props).flatMap(([name, definition]) => definition.default === undefined ? [] : [[name, definition.default]])), node.props) as Record<string, JsonScalar>;
    const key = canonical([code.id, props, node.slots]);
    if (implementationIds.has(key)) return;
    implementationIds.add(key);
    const nodes = code.framework === 'react' ? renderFunction(modules.get(code.sourcePath), code.exportName, props) : renderVue(code.sourcePath, props);
    result.implementations.push({ codeId: code.id, props, nodes });
  }
  interface VueNode { type: number; tag?: string; children?: VueNode[]; content?: string | VueNode; props?: VueNode[]; name?: string; value?: { content: string }; arg?: { content: string; isStatic: boolean }; exp?: { content: string }; loc?: { start: { line: number; column: number } } }
  function vueNodes(module: Module, nodes: VueNode[]): AnalyzedDesignNode[] {
    return nodes.flatMap<AnalyzedDesignNode>((node) => {
      const at = location(module.source.sourcePath, node);
      if (node.type === 2) return typeof node.content === 'string' && node.content.trim() ? [{ type: 'text' as const, text: node.content, location: at }] : [];
      if (node.type === 3) return [];
      if (node.type === 5 && typeof node.content === 'object' && typeof node.content.content === 'string') {
        try { const value = scalar(parseExpression(node.content.content, { plugins: ['typescript'] }), at); return value === undefined ? [] : [{ type: 'text' as const, text: value === null ? '' : String(value), location: at }]; }
        catch { fail('ODDS6001', 'Vue text expression cannot be parsed.', at); return []; }
      }
      if (node.type !== 1 || !node.tag) { fail('ODDS6002', 'Dynamic Vue text/control flow is outside the static template grammar.', at); return []; }
      const resultNode = element(module, node.tag, at);
      for (const attribute of node.props ?? []) {
        if (attribute.type === 6 && attribute.name) {
          if (attribute.name === 'style') result.styles.push({ sourcePath: module.source.sourcePath, content: attribute.value?.content ?? '', inline: true });
          resultNode.props[attribute.name] = attribute.value?.content ?? true;
        } else if (attribute.type === 7 && attribute.name === 'bind' && attribute.exp) {
          try {
            const expression = parseExpression(attribute.exp.content, { plugins: ['typescript'] });
            const fields = !attribute.arg && expression.type === 'ObjectExpression' ? expression.properties.flatMap((property) => {
              if (property.type !== 'ObjectProperty' || property.computed || (property.key.type !== 'Identifier' && property.key.type !== 'StringLiteral')) { fail('ODDS6002', 'Vue object bindings require explicit literal members.', at); return []; }
              return [{ name: property.key.type === 'Identifier' ? property.key.name : property.key.value, value: property.value }];
            }) : attribute.arg?.isStatic ? [{ name: attribute.arg.content, value: expression }] : [];
            if (!fields.length && (!attribute.arg || !attribute.arg.isStatic)) fail('ODDS6002', 'Computed Vue bindings are unsupported.', at);
            for (const field of fields) { if (Object.hasOwn(resultNode.props, field.name)) fail('ODDS6002', 'Duplicate Vue property declarations.', at); const value = scalar(field.value, at); if (value !== undefined) resultNode.props[field.name] = value; }
          }
          catch { fail('ODDS6001', 'Vue binding expression cannot be parsed.', at); }
        } else fail('ODDS6002', 'Vue directives require explicit static scalar bindings; loops, spreads and event handlers are unsupported.', at);
      }
      const children: VueNode[] = [];
      for (const child of node.children ?? []) {
        if (child.type === 1 && child.tag === 'template') {
          const slot = child.props?.find((prop) => prop.type === 7 && prop.name === 'slot');
          if (!slot || !slot.arg?.isStatic || slot.exp || child.props?.length !== 1) { fail('ODDS6002', 'Named Vue slots require a static unscoped name.', at); continue; }
          if (Object.hasOwn(resultNode.slots, slot.arg.content)) fail('ODDS6002', 'Duplicate Vue slot declarations.', at);
          resultNode.slots[slot.arg.content] = vueNodes(module, child.children ?? []);
        } else children.push(child);
      }
      const defaultChildren = vueNodes(module, children);
      if (defaultChildren.length) {
        if (Object.hasOwn(resultNode.slots, 'default')) fail('ODDS6002', 'Vue default slot is declared twice.', at);
        resultNode.slots.default = defaultChildren;
      }
      auditImplementation(resultNode);
      return [resultNode];
    });
  }
  const vueTemplates = new Map<string, VueNode[]>(); const htmlTrees = new Map<string, AnalyzedDesignNode[]>();
  function renderVue(path: string, props?: Record<string, JsonScalar>): AnalyzedDesignNode[] {
    renderedVue.add(path);
    const module = modules.get(path); if (!module) return [];
    const key = canonical([path, 'default']);
    if (activeCalls.has(key)) { fail('ODDS6002', 'Cyclic Vue component implementation.', location(path)); return []; }
    activeCalls.add(key); renderedFunctions.add(key);
    const environment = new Map<string, JsonScalar | Record<string, JsonScalar>>(Object.entries(props ?? {}));
    if (props) for (const statement of module.program.body) if (statement.type === 'VariableDeclaration') for (const declaration of statement.declarations) if (declaration.id.type === 'Identifier') environment.set(declaration.id.name, props);
    environments.push(environment); const nodes = vueNodes(module, vueTemplates.get(path) ?? []); environments.pop(); activeCalls.delete(key); return nodes;
  }
  function visitFile(path: string): void {
    if (result.visited.includes(path)) return;
    if (visiting.has(path)) { fail('ODDS6003', 'Circular application imports are unsupported.', location(path)); return; }
    const source = sources.get(path);
    if (!source) { fail('ODDS6003', `Selected source ${path} is missing.`, location(path)); return; }
    const frozen = context.frozenSources.get(path);
    if (frozen !== undefined) {
      if (source.sourceText !== frozen) fail('ODDS6005', 'Application bytes differ from the exact frozen library source.', location(path));
      else { result.visited.push(path); return; }
    }
    visiting.add(path);
    if (source.language === 'css') {
      result.styles.push({ sourcePath: path, content: source.sourceText, inline: false });
      try { postcss.parse(source.sourceText).walkAtRules('import', (rule) => {
        const quoted = rule.params.match(/^["']([^"']+)["']$/)?.[1]; const child = quoted ? pathFor(path, quoted) : undefined;
        if (child) visitFile(child); else fail('ODDS6003', 'CSS @import requires a supplied literal local file.', location(path));
      }); } catch { /* The style evaluator reports parser diagnostics with declaration locations. */ }
    }
    else if (source.language === 'tsx') readProgram(source, source.sourceText);
    else if (source.language === 'vue') {
      const { descriptor, errors } = parseSfc(source.sourceText, { filename: path });
      if (errors.length || !descriptor.template || !descriptor.scriptSetup || descriptor.script || descriptor.scriptSetup.lang !== 'ts' || descriptor.template.lang || descriptor.template.src || descriptor.scriptSetup.src || descriptor.customBlocks.length) {
        fail('ODDS6001', 'Vue source requires a parseable static template and script setup lang="ts" without external/custom blocks.', location(path));
      } else {
        const module = readProgram(source, descriptor.scriptSetup.content);
        if (module) vueTemplates.set(path, (descriptor.template.ast?.children ?? []) as unknown as VueNode[]);
        for (const style of descriptor.styles) {
          if (style.lang && style.lang !== 'css' || style.src) fail('ODDS6002', 'Vue styles require supplied plain CSS.', location(path));
          else result.styles.push({ sourcePath: path, content: style.content, inline: false });
        }
      }
    } else {
      const $ = load(source.sourceText, { sourceCodeLocationInfo: true });
      type HtmlNode = ReturnType<typeof $.root>['0']['children'][number];
      const html = (nodes: HtmlNode[]): AnalyzedDesignNode[] => nodes.flatMap<AnalyzedDesignNode>((node) => {
        const at = location(path);
        if (node.type === 'text') return node.data.trim() ? [{ type: 'text' as const, text: node.data, location: at }] : [];
        if (!('name' in node) || !('attribs' in node) || !('children' in node)) return [];
        if (node.name === 'script') { fail('ODDS6002', 'Executable HTML scripts cannot be statically certified.', at); return []; }
        if (node.name === 'style') { result.styles.push({ sourcePath: path, content: $(node).text(), inline: false }); return []; }
        if (node.name === 'link' && node.attribs.rel === 'stylesheet') { const linked = pathFor(path, node.attribs.href ?? ''); if (linked) visitFile(linked); else fail('ODDS6003', 'HTML stylesheet must be supplied through an exact local path.', at); return []; }
        const element: Extract<AnalyzedDesignNode, { type: 'element' }> = { type: 'element', tag: node.name, props: Object.assign(Object.create(null), node.attribs), slots: Object.create(null), location: at };
        if (!nativeTags.has(node.name)) fail('ODDS1001', `Unknown HTML component ${node.name}.`, at);
        for (const name of Object.keys(node.attribs)) if (name.toLowerCase().startsWith('on')) fail('ODDS6002', 'HTML event handlers are executable and unsupported.', at);
        if (node.attribs.style) result.styles.push({ sourcePath: path, content: node.attribs.style, inline: true });
        const children = html(node.children); if (children.length) element.slots.children = children;
        return [element];
      });
      htmlTrees.set(path, html($.root().toArray()[0]!.children));
    }
    visiting.delete(path); result.visited.push(path);
  }
  for (const output of [...outputs].sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'))) {
    visitFile(output.sourcePath); const source = sources.get(output.sourcePath);
    if (source?.language === 'vue' && output.exportName !== undefined && output.exportName !== 'default') fail('ODDS6002', 'A Vue SFC output must select its default export.', location(output.sourcePath));
    const nodes = source?.language === 'tsx' ? renderFunction(modules.get(output.sourcePath), output.exportName ?? 'default')
      : source?.language === 'vue' ? renderVue(output.sourcePath) : source?.language === 'html' ? htmlTrees.get(output.sourcePath) ?? [] : [];
    if (!source || source.language === 'css') fail('ODDS6002', 'A screen output must name React, Vue or HTML source.', location(output.sourcePath));
    result.outputs.push({ output, nodes });
  }
  // Audit every daemon-observed changed file, including unselected functions in a selected module.
  const auditPaths = context.auditPaths ?? context.sources.map((source) => source.sourcePath);
  for (const path of auditPaths) {
    const source = sources.get(path);
    if (!source) { fail('ODDS6003', 'An observed application source is missing from the byte snapshot.', location(path)); continue; }
    if (context.frozenSources.get(path) === source.sourceText) continue;
    const wasVisited = result.visited.includes(path);
    if (!wasVisited) {
      fail('ODDS6003', `Supplied application source ${path} is outside the selected entry graph.`, location(path));
      visitFile(path);
    }
    if (source.language === 'tsx') {
      const module = modules.get(path);
      for (const name of module?.exports.keys() ?? []) if (!renderedFunctions.has(canonical([path, name]))) {
        fail('ODDS6003', `Function ${name} is outside the selected production call graph.`, location(path));
        result.audits.push(renderFunction(module, name));
      }
      // Unknown branches/initializers still expose their known literal controls and styles.
      // They remain incomplete; this walk never claims to choose an executed branch.
      if (module) auditUnrenderedJsx(module, module.program);
    } else if (source.language === 'vue' && !renderedVue.has(path)) result.audits.push(renderVue(path));
    else if (source.language === 'html' && !wasVisited) result.audits.push(htmlTrees.get(path) ?? []);
  }
  return result;
}
