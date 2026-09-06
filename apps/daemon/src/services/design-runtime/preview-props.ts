import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import {
  ComponentPreviewPropsSchema, type ComponentPreviewCallback, type ComponentPreviewControl,
  type ComponentPreviewResponse, type JsonValue, type ValidationDiagnostic,
} from '@open-design/contracts';

type Kind = ComponentPreviewControl['kind'];
type Provenance = ComponentPreviewControl['provenance'];
interface Model {
  kind: Kind; provenance: Provenance; required: boolean; hasDefault: boolean; defaultValue?: JsonValue;
  options?: JsonValue[]; fields?: Map<string, Model>; item?: Model; tuple?: Model[];
  result?: Model; async?: boolean; conflict?: boolean;
}
type ComponentFunction = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;
interface ComponentSource { fn: ComponentFunction | t.ClassMethod; propsType?: t.TSType; classComponent?: boolean; classDefaults?: t.Node }
type Scope = Map<string, Model | null>;
export interface AnalyzeComponentPreviewSourceInput { sourceText: string; sourcePath: string; exportName?: string | undefined; props?: Record<string, JsonValue> | undefined }
export type ComponentPreviewAnalysis = Pick<ComponentPreviewResponse, 'exports' | 'selectedExport' | 'controls' | 'mockProps' | 'effectiveProps' | 'callbacks' | 'diagnostics'>;
const unknown = (): Model => ({ kind: 'unknown', provenance: 'unknown', required: true, hasDefault: false });
const model = (kind: Kind, provenance: Provenance): Model => ({ ...unknown(), kind, provenance });
const isNode = (value: unknown): value is t.Node => Boolean(value && typeof value === 'object' && 'type' in value && typeof value.type === 'string');
function children(node: t.Node): t.Node[] { return Object.values(node).flatMap((value: unknown) => (Array.isArray(value) ? value : [value]).filter(isNode)); }
function unwrap(node: t.Node): t.Node {
  return node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSTypeAssertion' || node.type === 'ParenthesizedExpression' ? unwrap(node.expression) : node;
}
function key(node: t.Node, computed = false): string | undefined {
  const value = node.type === 'StringLiteral' ? node.value : node.type === 'NumericLiteral' ? String(node.value) : !computed && node.type === 'Identifier' ? node.name : undefined;
  return value === '__proto__' ? undefined : value;
}
function names(node: t.Node): string[] {
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'RestElement') return names(node.argument);
  if (node.type === 'AssignmentPattern') return names(node.left);
  if (node.type === 'ObjectPattern') return node.properties.flatMap((entry) => names(entry.type === 'RestElement' ? entry.argument : entry.value));
  if (node.type === 'ArrayPattern') return node.elements.flatMap((entry) => entry ? names(entry) : []);
  return [];
}
function literal(node: t.Node, depth = 0): { value: JsonValue } | undefined {
  if (depth > 10) return undefined;
  node = unwrap(node);
  if (node.type === 'StringLiteral' || node.type === 'BooleanLiteral') return { value: node.value };
  if (node.type === 'NullLiteral') return { value: null };
  if (node.type === 'NumericLiteral' && Number.isFinite(node.value)) return { value: node.value };
  if (node.type === 'UnaryExpression' && ['-', '+'].includes(node.operator) && node.argument.type === 'NumericLiteral') return { value: node.operator === '-' ? -node.argument.value : node.argument.value };
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return { value: node.quasis[0]?.value.cooked ?? '' };
  if (node.type === 'ArrayExpression') {
    const values = node.elements.map((entry) => entry ? literal(entry, depth + 1) : undefined);
    return values.every((entry) => entry !== undefined) ? { value: values.map((entry) => entry!.value) } : undefined;
  }
  if (node.type === 'ObjectExpression') {
    const value: Record<string, JsonValue> = Object.create(null);
    for (const entry of node.properties) {
      if (entry.type !== 'ObjectProperty') return undefined;
      const name = key(entry.key, entry.computed); const parsed = literal(entry.value, depth + 1);
      if (name === undefined || !parsed || Object.hasOwn(value, name)) return undefined;
      value[name] = parsed.value;
    }
    return { value };
  }
  return undefined;
}
function fromValue(value: JsonValue): Model {
  if (value === null) return { ...model('enum', 'default'), options: [null] };
  if (Array.isArray(value)) return { ...model('array', 'default'), ...(value.length ? { item: fromValue(value[0]!) } : {}) };
  if (typeof value === 'object') return { ...model('object', 'default'), fields: new Map(Object.entries(value).map(([name, entry]) => [name, fromValue(entry)])) };
  return model(typeof value as 'string' | 'number' | 'boolean', 'default');
}

/** Syntax-only, bounded preview hints. Does not import modules, call functions, or certify a component contract. */
export function analyzeComponentPreviewSource(input: AnalyzeComponentPreviewSourceInput): ComponentPreviewAnalysis {
  const diagnostics: ValidationDiagnostic[] = [];
  const warn = (message: string, node?: t.Node, severity: 'warning' | 'error' = 'warning'): void => {
    if (diagnostics.length >= 100) return;
    const diagnostic: ValidationDiagnostic = { schemaVersion: 1, code: 'ODDS8002', severity, message,
      ...(node?.loc ? { location: { sourcePath: input.sourcePath, line: node.loc.start.line, column: node.loc.start.column + 1 } } : {}) };
    if (!diagnostics.some((entry) => entry.message === message)) diagnostics.push(diagnostic);
  };
  const empty = (): ComponentPreviewAnalysis => ({ exports: [], selectedExport: null, controls: [], mockProps: {}, effectiveProps: {}, callbacks: [], diagnostics });
  if (input.sourceText.length > 4 * 1024 * 1024) { warn('Source exceeds the preview analysis budget.', undefined, 'error'); return empty(); }
  let program: t.Program;
  try { program = parse(input.sourceText, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program; }
  catch (error) { warn(`Source could not be parsed: ${error instanceof Error ? error.message : String(error)}`, undefined, 'error'); return empty(); }
  const types = new Map<string, t.TSTypeAliasDeclaration | t.TSInterfaceDeclaration>();
  const declarations = new Map<string, t.Node>();
  const contextualTypes = new Map<string, t.TSType>();
  const reactNames = new Map<string, string>();
  const reactNamespaces = new Set<string>();
  const topNames = new Set<string>();
  const duplicateTypes = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') for (const entry of statement.specifiers) topNames.add(entry.local.name);
    if (statement.type === 'ImportDeclaration' && statement.source.value === 'react') for (const entry of statement.specifiers) {
      if (entry.type === 'ImportSpecifier') reactNames.set(entry.local.name, entry.imported.type === 'Identifier' ? entry.imported.name : entry.imported.value);
      else reactNamespaces.add(entry.local.name);
    }
    const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
    if (!declaration) continue;
    if ('id' in declaration && declaration.id?.type === 'Identifier') topNames.add(declaration.id.name);
    if (declaration.type === 'VariableDeclaration') for (const entry of declaration.declarations) names(entry.id).forEach((name) => topNames.add(name));
    if (declaration.type === 'TSTypeAliasDeclaration' || declaration.type === 'TSInterfaceDeclaration') {
      if (types.has(declaration.id.name)) duplicateTypes.add(declaration.id.name);
      types.set(declaration.id.name, declaration);
    }
    if (declaration.type === 'FunctionDeclaration' && declaration.id) declarations.set(declaration.id.name, declaration);
    if (declaration.type === 'ClassDeclaration' && declaration.id) declarations.set(declaration.id.name, declaration);
    if (declaration.type === 'VariableDeclaration') for (const entry of declaration.declarations) if (entry.id.type === 'Identifier' && entry.init) {
      declarations.set(entry.id.name, entry.init);
      if (entry.id.typeAnnotation?.type === 'TSTypeAnnotation') contextualTypes.set(entry.id.name, entry.id.typeAnnotation.typeAnnotation);
    }
  }
  // The component playground explicitly supplies this React global before loading source.
  if (!topNames.has('React')) reactNamespaces.add('React');
  function isReact(node: t.Node, name: string): boolean {
    if (node.type === 'Identifier') return reactNames.get(node.name) === name;
    if (node.type === 'MemberExpression') return node.object.type === 'Identifier' && reactNamespaces.has(node.object.name) && key(node.property, node.computed) === name;
    if (node.type === 'TSQualifiedName') return node.left.type === 'Identifier' && reactNamespaces.has(node.left.name) && node.right.name === name;
    return false;
  }
  function contextualProps(node: t.TSType | undefined): t.TSType | undefined {
    return node?.type === 'TSTypeReference' && ['FC', 'FunctionComponent', 'ComponentType'].some((name) => isReact(node.typeName, name)) ? node.typeParameters?.params[0] : undefined;
  }
  function component(node: t.Node | undefined, callable = false, seen = new Set<string>()): ComponentSource | undefined {
    if (!node) return undefined; node = unwrap(node);
    if (node.type === 'Identifier' && !seen.has(node.name)) {
      seen.add(node.name); const source = component(declarations.get(node.name), callable, seen); const propsType = contextualProps(contextualTypes.get(node.name));
      return source ? { ...source, ...(propsType ? { propsType } : {}) } : undefined;
    }
    if (node.type === 'CallExpression' && ['memo', 'forwardRef'].some((name) => isReact(node.callee, name))) {
      const source = component(node.arguments[0], callable, seen);
      const propsType = node.typeParameters?.type === 'TSTypeParameterInstantiation' ? node.typeParameters.params[isReact(node.callee, 'forwardRef') ? 1 : 0] : undefined;
      return source ? { ...source, ...(propsType ? { propsType } : {}) } : undefined;
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (!node.superClass || !['Component', 'PureComponent'].some((name) => isReact(node.superClass!, name))) return undefined;
      const render = node.body.body.find((entry): entry is t.ClassMethod => entry.type === 'ClassMethod' && !entry.static && key(entry.key, entry.computed) === 'render');
      const propsType = node.superTypeParameters?.type === 'TSTypeParameterInstantiation' ? node.superTypeParameters.params[0] : undefined;
      const defaults = node.body.body.find((entry): entry is t.ClassProperty => entry.type === 'ClassProperty' && entry.static && key(entry.key, entry.computed) === 'defaultProps');
      return render ? { fn: render, classComponent: true, ...(propsType ? { propsType } : {}), ...(defaults?.value ? { classDefaults: defaults.value } : {}) } : undefined;
    }
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return undefined;
    const fn = node as ComponentFunction;
    const hasJsx = (entry: t.Node): boolean => entry.type === 'JSXElement' || entry.type === 'JSXFragment' || entry.type === 'CallExpression' && isReact(entry.callee, 'createElement') || !['FunctionDeclaration', 'FunctionExpression'].includes(entry.type) && children(entry).some(hasJsx);
    return callable || hasJsx(fn.body) ? { fn } : undefined;
  }
  const candidates = new Map<string, ComponentSource & { localName?: string }>();
  const add = (name: string, node: t.Node | undefined, localName?: string): void => {
    const source = component(node, name === 'default' || /^[A-Z]/.test(name));
    const propsType = contextualProps(contextualTypes.get(localName ?? name));
    if (source) candidates.set(name, { ...source, ...(propsType ? { propsType } : {}), ...(localName ? { localName } : node?.type === 'ClassDeclaration' && node.id ? { localName: node.id.name } : source.fn.type === 'FunctionDeclaration' && source.fn.id ? { localName: source.fn.id.name } : {}) });
  };
  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') add('default', statement.declaration, statement.declaration.type === 'Identifier' ? statement.declaration.name : undefined);
    if (statement.type !== 'ExportNamedDeclaration' || statement.source || statement.exportKind === 'type') continue;
    if (statement.declaration?.type === 'FunctionDeclaration' && statement.declaration.id) add(statement.declaration.id.name, statement.declaration);
    if (statement.declaration?.type === 'ClassDeclaration' && statement.declaration.id) add(statement.declaration.id.name, statement.declaration);
    if (statement.declaration?.type === 'VariableDeclaration') for (const entry of statement.declaration.declarations) if (entry.id.type === 'Identifier') add(entry.id.name, entry.init ?? undefined, entry.id.name);
    for (const entry of statement.specifiers) if (entry.type === 'ExportSpecifier' && entry.exportKind !== 'type') add(entry.exported.type === 'Identifier' ? entry.exported.name : entry.exported.value, declarations.get(entry.local.name), entry.local.name);
  }
  const exports = [...candidates.keys()].slice(0, 100);
  const selectedExport = input.exportName ?? (candidates.has('default') ? 'default' : exports[0]);
  const selected = selectedExport === undefined ? undefined : candidates.get(selectedExport);
  if (!selected || exports.length !== candidates.size) { warn(selectedExport ? `Export ${JSON.stringify(selectedExport)} is not an analyzable local JSX component.` : 'No local exported JSX component was found.', undefined, 'error'); return { ...empty(), exports }; }
  const classComponent = selected.classComponent;

  let typeVisits = 0;
  function typeModel(node: t.TSType, seen = new Set<string>(), depth = 0): Model {
    if (++typeVisits > 2000 || depth > 10) { warn('A recursive or oversized props type exceeded the preview analysis limit.', node); return unknown(); }
    const again = (next: t.TSType): Model => typeModel(next, new Set(seen), depth + 1);
    if (node.type === 'TSParenthesizedType' || node.type === 'TSOptionalType' || node.type === 'TSRestType') return again(node.typeAnnotation);
    if (node.type === 'TSStringKeyword') return model('string', 'typescript');
    if (node.type === 'TSNumberKeyword') return model('number', 'typescript');
    if (node.type === 'TSBooleanKeyword') return model('boolean', 'typescript');
    if (node.type === 'TSLiteralType') { const value = literal(node.literal); if (value) return { ...model('enum', 'typescript'), options: [value.value] }; }
    if (node.type === 'TSNullKeyword') return { ...model('enum', 'typescript'), options: [null] };
    if (node.type === 'TSArrayType') return { ...model('array', 'typescript'), item: again(node.elementType) };
    if (node.type === 'TSTupleType') return { ...model('array', 'typescript'), tuple: node.elementTypes.map((entry) => again(entry.type === 'TSNamedTupleMember' ? entry.elementType : entry)) };
    if (node.type === 'TSFunctionType' || node.type === 'TSConstructorType') return { ...model('function', 'typescript'), ...(node.typeAnnotation ? { result: again(node.typeAnnotation.typeAnnotation) } : {}) };
    if (node.type === 'TSTypeLiteral') return members(node.members, seen, depth);
    if (node.type === 'TSIntersectionType') {
      const parts = node.types.map(again); if (parts.every((part) => part.kind === 'object')) return { ...model('object', 'typescript'), fields: new Map(parts.flatMap((part) => [...(part.fields ?? [])])) };
    }
    if (node.type === 'TSUnionType') {
      const parts = node.types.map(again);
      if (parts.every((part) => part.kind === 'enum')) return { ...model('enum', 'typescript'), options: [...new Map(parts.flatMap((part) => part.options ?? []).map((value) => [JSON.stringify(value), value])).values()] };
      const nonEmpty = parts.filter((part) => part.kind !== 'unknown' && !(part.kind === 'enum' && part.options?.every((value) => value === null)));
      if (nonEmpty.length) { warn('Preview mocks one branch of a union; other branches remain available through JSON overrides.', node); return nonEmpty[0]!; }
    }
    if (node.type === 'TSTypeReference') {
      const name = node.typeName.type === 'Identifier' ? node.typeName.name : node.typeName.right.name;
      if (node.typeName.type === 'Identifier' && !topNames.has(name) && ['Partial', 'Required', 'Pick', 'Omit'].includes(name)) {
        const args = node.typeParameters?.params ?? [];
        if (args.length === (name === 'Partial' || name === 'Required' ? 1 : 2)) {
          const base = again(args[0]!);
          const selected = args[1] ? again(args[1]) : undefined;
          const fields = base.fields;
          if (base.kind === 'object' && fields && (!selected || selected.kind === 'enum' && selected.options?.every((value) => typeof value === 'string' && (name === 'Omit' || fields.has(value))))) {
            const keys = new Set(selected?.options ?? []);
            return { ...model('object', 'typescript'), fields: new Map([...fields].filter(([field]) => !selected || (name === 'Pick' ? keys.has(field) : !keys.has(field))).map(([field, value]) => [field, { ...value, ...(name === 'Partial' || name === 'Required' ? { required: name === 'Required' } : {}) }])) };
          }
        }
        warn(`Utility type ${name} has an unresolved source shape or key selection; enter explicit JSON props.`, node); return unknown();
      }
      if (node.typeName.type === 'Identifier' && types.has(name) && !duplicateTypes.has(name) && !seen.has(name)) {
        const declaration = types.get(name)!;
        if (!declaration.typeParameters && !node.typeParameters) {
          seen = new Set(seen).add(name);
          if (declaration.type === 'TSTypeAliasDeclaration') return typeModel(declaration.typeAnnotation, seen, depth + 1);
          const result = members(declaration.body.body, seen, depth + 1);
          for (const parent of declaration.extends ?? []) {
            if (parent.expression.type !== 'Identifier' || parent.typeParameters) { warn('Imported or generic interface inheritance is unresolved.', parent); continue; }
            const inherited = typeModel({ type: 'TSTypeReference', typeName: parent.expression }, seen, depth + 1);
            if (inherited.fields) result.fields = new Map([...inherited.fields, ...(result.fields ?? [])]);
          }
          return result;
        }
      }
      if (!types.has(name) && ['Array', 'ReadonlyArray', 'Promise', 'Readonly'].includes(name) && node.typeParameters?.params.length === 1) {
        const value = again(node.typeParameters.params[0]!);
        if (name === 'Promise') return { ...value, async: true };
        return name === 'Readonly' ? value : { ...model('array', 'typescript'), item: value };
      }
      if (['ReactNode', 'ReactElement'].some((kind) => isReact(node.typeName, kind))) return model('react-node', 'typescript');
      warn(`Type ${name} is imported, generic, recursive, or ambiguous; its preview shape is unresolved.`, node); return unknown();
    }
    if (['TSVoidKeyword', 'TSUndefinedKeyword', 'TSNeverKeyword'].includes(node.type)) return unknown();
    warn(`Type ${node.type} has no deterministic preview mock.`, node); return unknown();
  }
  function members(entries: t.TSTypeElement[], seen: Set<string>, depth: number): Model {
    const fields = new Map<string, Model>();
    for (const entry of entries.slice(0, 100)) {
      if ((entry.type !== 'TSPropertySignature' && entry.type !== 'TSMethodSignature') || entry.computed) { warn('Computed props and index signatures need explicit preview values.', entry); continue; }
      const name = key(entry.key); if (name === undefined) { warn('Reserved or unknown prop name cannot be mocked.', entry); continue; }
      const value = entry.type === 'TSMethodSignature' ? { ...model('function', 'typescript'), ...(entry.typeAnnotation ? { result: typeModel(entry.typeAnnotation.typeAnnotation, new Set(seen), depth + 1) } : {}) }
        : entry.typeAnnotation ? typeModel(entry.typeAnnotation.typeAnnotation, new Set(seen), depth + 1) : unknown();
      value.required = !entry.optional; fields.set(name, value);
    }
    return { ...model('object', 'typescript'), fields };
  }
  function infer(value: Model, kind: Kind, node?: t.Node): void {
    if (value.conflict || value.provenance === 'typescript' || value.provenance === 'default') return;
    if (value.kind === 'unknown') { value.kind = kind; value.provenance = 'usage'; return; }
    if (value.kind === kind || value.kind === 'enum' && ['string', 'number', 'boolean'].includes(kind)) return;
    value.kind = 'unknown'; value.conflict = true; value.provenance = 'unknown'; warn('Conflicting prop usages need an explicit JSON preview value.', node);
  }
  function field(parent: Model, name: string, node?: t.Node): Model | undefined {
    if (name === '__proto__') { warn('Reserved prop paths cannot be mocked.', node); return undefined; }
    infer(parent, 'object', node);
    if (parent.kind !== 'object') return undefined;
    parent.fields ??= new Map(); let value = parent.fields.get(name);
    if (!value) { value = unknown(); parent.fields.set(name, value); }
    return value;
  }
  function item(parent: Model, node?: t.Node): Model | undefined { infer(parent, 'array', node); if (parent.kind !== 'array') return undefined; parent.item ??= unknown(); return parent.item; }
  function applyDefault(value: Model, expression: t.Node): void {
    value.hasDefault = true;
    const parsed = literal(expression);
    if (parsed) {
      value.defaultValue = parsed.value;
      if (value.kind === 'unknown') Object.assign(value, fromValue(parsed.value), { required: value.required, hasDefault: true, defaultValue: parsed.value });
    } else warn('A computed component default is preserved by omitting the prop; it is never evaluated during analysis.', expression);
  }
  const parameter = selected.fn.params[0];
  const annotated = parameter?.type === 'AssignmentPattern' ? parameter.left : parameter;
  const propsType = selected.propsType ?? (annotated && 'typeAnnotation' in annotated && annotated.typeAnnotation?.type === 'TSTypeAnnotation' ? annotated.typeAnnotation.typeAnnotation : undefined);
  const root = propsType ? typeModel(propsType) : { ...model('object', 'usage'), fields: new Map<string, Model>() };
  if (root.kind !== 'object') { warn('The complete props type is unresolved; direct local usages supply preview hints.', parameter); root.kind = 'object'; root.fields ??= new Map(); }
  const scope: Scope = new Map();
  function bind(pattern: t.Node, value: Model | undefined, target: Scope): void {
    if (pattern.type === 'Identifier') { target.set(pattern.name, value ?? null); return; }
    if (pattern.type === 'AssignmentPattern') { if (value) applyDefault(value, pattern.right); bind(pattern.left, value, target); return; }
    if (pattern.type === 'ObjectPattern') for (const entry of pattern.properties) {
      if (entry.type === 'RestElement') { for (const name of names(entry)) target.set(name, null); continue; }
      const name = key(entry.key, entry.computed); if (name === undefined) { warn('Dynamic destructuring cannot be inferred.', entry); continue; }
      bind(entry.value, value ? field(value, name, entry) : undefined, target);
    }
    if (pattern.type === 'ArrayPattern') pattern.elements.forEach((entry, index) => { if (entry) bind(entry, value?.tuple?.[index] ?? (value ? item(value, entry) : undefined), target); });
  }
  if (parameter) bind(parameter, root, scope);
  for (const other of selected.fn.params.slice(1)) for (const name of names(other)) scope.set(name, null);
  // Only the last direct defaultProps assignment applies; source execution remains in the sandbox.
  let defaults = selected.classDefaults;
  if (selected.localName) for (const statement of program.body) {
    if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'AssignmentExpression') continue;
    const assignment = statement.expression; const left = assignment.left;
    if (left.type !== 'MemberExpression' || left.object.type !== 'Identifier' || left.object.name !== selected.localName || key(left.property, left.computed) !== 'defaultProps') continue;
    defaults = assignment.right;
  }
  if (defaults) {
    if (defaults.type !== 'ObjectExpression') warn('Nonliteral defaultProps cannot be inferred; configure explicit preview props.', defaults);
    else for (const entry of defaults.properties) {
      if (entry.type !== 'ObjectProperty') { warn('Spread or method defaultProps cannot be inferred.', entry); continue; }
      const name = key(entry.key, entry.computed); if (name === undefined) continue;
      const value = field(root, name, entry); if (value) applyDefault(value, entry.value);
    }
  }
  function ref(node: t.Node, current: Scope): Model | undefined {
    node = unwrap(node);
    if (node.type === 'Identifier') return current.get(node.name) ?? undefined;
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      if (classComponent && node.object.type === 'ThisExpression' && key(node.property, node.computed) === 'props') return root;
      const parent = ref(node.object, current); if (!parent) return undefined;
      const name = key(node.property, node.computed);
      if (node.computed && node.property.type === 'NumericLiteral') return parent.tuple?.[node.property.value] ?? item(parent, node);
      if (name === 'length' && ['array', 'string'].includes(parent.kind)) return model('number', 'usage');
      return name === undefined ? undefined : field(parent, name, node);
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      if ((node.callee.type === 'MemberExpression' || node.callee.type === 'OptionalMemberExpression') && ['map', 'flatMap', 'filter', 'forEach', 'find', 'some', 'every', 'reduce', 'push', 'slice', 'join', 'toFixed', 'toPrecision', 'toExponential', 'trim', 'toLowerCase', 'toUpperCase', 'split', 'replace', 'startsWith', 'endsWith'].includes(key(node.callee.property, node.callee.computed) ?? '')) return undefined;
      const callee = ref(node.callee, current); if (!callee) return undefined;
      infer(callee, 'function', node); if (callee.kind !== 'function') return undefined;
      callee.result ??= unknown(); return callee.result;
    }
    return undefined;
  }
  let visited = 0;
  function visit(node: t.Node, current: Scope, depth = 0): void {
    if (++visited > 40_000 || depth > 100) { warn('Source usage analysis exceeded its traversal budget.', node); return; }
    if (node.type.startsWith('TS') || node.type === 'TypeAnnotation') return;
    if (node.type === 'BlockStatement') {
      const inner = new Map(current);
      for (const statement of node.body) {
        if (statement.type === 'VariableDeclaration') for (const entry of statement.declarations) for (const name of names(entry.id)) inner.set(name, null);
        if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id) inner.set(statement.id.name, null);
      }
      node.body.forEach((entry) => visit(entry, inner, depth + 1)); return;
    }
    if (node.type === 'VariableDeclarator') { if (node.init) { const value = ref(node.init, current); bind(node.id, value, current); visit(node.init, current, depth + 1); } return; }
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      const fn = node as ComponentFunction; const inner = new Map(current);
      if (fn.type !== 'ArrowFunctionExpression' && fn.id) inner.set(fn.id.name, null);
      for (const parameter of fn.params) for (const name of names(parameter)) inner.set(name, null);
      visit(fn.body, inner, depth + 1); return;
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = unwrap(node.callee);
      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        const parent = ref(callee.object, current); const method = key(callee.property, callee.computed);
        if (parent && method && ['map', 'flatMap', 'filter', 'forEach', 'find', 'some', 'every', 'reduce', 'push', 'slice', 'join'].includes(method)) {
          const element = item(parent, callee);
          node.arguments.forEach((argument, index) => {
            if ((argument.type === 'ArrowFunctionExpression' || argument.type === 'FunctionExpression') && element) {
              const inner = new Map(current); argument.params.forEach((param, position) => bind(param, position === (method === 'reduce' ? 1 : 0) ? element : model('number', 'usage'), inner)); visit(argument.body, inner, depth + 1);
            } else { if (method === 'push' && element) { const parsed = literal(argument); if (parsed && element.kind === 'unknown') Object.assign(element, fromValue(parsed.value), { provenance: 'usage' }); } visit(argument, current, depth + 1); }
            void index;
          }); return;
        }
        if (parent && method && ['toFixed', 'toPrecision', 'toExponential', 'trim', 'toLowerCase', 'toUpperCase', 'split', 'replace', 'startsWith', 'endsWith'].includes(method)) {
          infer(parent, ['toFixed', 'toPrecision', 'toExponential'].includes(method) ? 'number' : 'string', callee); node.arguments.forEach((entry) => visit(entry, current, depth + 1)); return;
        }
      }
      const value = ref(callee, current); if (value) infer(value, 'function', callee);
      node.arguments.forEach((entry) => visit(entry, current, depth + 1)); return;
    }
    if (node.type === 'JSXAttribute' && node.value?.type === 'JSXExpressionContainer' && node.name.type === 'JSXIdentifier') {
      const value = ref(node.value.expression, current);
      if (value) infer(value, /^on[A-Z]/.test(node.name.name) ? 'function' : ['disabled', 'checked', 'hidden', 'multiple', 'required'].includes(node.name.name) ? 'boolean' : 'string', node);
      visit(node.value.expression, current, depth + 1); return;
    }
    if (node.type === 'JSXExpressionContainer') { const value = ref(node.expression, current); if (value) infer(value, 'string', node); visit(node.expression, current, depth + 1); return; }
    if (node.type === 'ConditionalExpression' || node.type === 'IfStatement') { const value = ref(node.test, current); if (value) infer(value, 'boolean', node.test); }
    if (node.type === 'UnaryExpression' && node.operator === '!') { const value = ref(node.argument, current); if (value) infer(value, 'boolean', node); }
    if (node.type === 'BinaryExpression') {
      for (const [side, other] of [[node.left, node.right], [node.right, node.left]] as const) {
        const value = ref(side, current); if (!value) continue;
        if (['-', '*', '/', '%', '**', '<', '>', '<=', '>='].includes(node.operator)) infer(value, 'number', node);
        else { const parsed = literal(other); if (parsed && parsed.value !== null && typeof parsed.value !== 'object') infer(value, typeof parsed.value as 'string' | 'number' | 'boolean', node); }
      }
    }
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') { ref(node, current); return; }
    if (node.type === 'AssignmentExpression') { for (const name of names(node.left)) current.set(name, null); visit(node.right, current, depth + 1); return; }
    children(node).forEach((entry) => visit(entry, current, depth + 1));
  }
  visit(selected.fn.body, scope);
  const callbacks: ComponentPreviewCallback[] = [];
  let mocked = 0;
  function mock(value: Model, path: (string | number)[], callbackTarget = callbacks): JsonValue | undefined {
    if (++mocked > 2000 || path.length > 10) { warn('Nested mock values exceeded the preview size limit.'); return undefined; }
    if (value.hasDefault) return undefined;
    switch (value.kind) {
      case 'string': case 'react-node': return `Preview ${path.map(String).join(' ') || 'text'}`;
      case 'number': return 1;
      case 'boolean': return true;
      case 'enum': return value.options?.[0];
      case 'object': { const output: Record<string, JsonValue> = Object.create(null); for (const [name, child] of value.fields ?? []) { const result = mock(child, [...path, name], callbackTarget); if (result !== undefined) output[name] = result; } return output; }
      case 'array': return (value.tuple ?? [value.item ?? unknown(), value.item ?? unknown()]).map((entry, index) => mock(entry, [...path, index], callbackTarget) ?? null);
      case 'function': {
        const result = value.result && value.result.kind !== 'unknown' ? mock(value.result, [...path, 'returnValue'], []) : undefined;
        if (callbackTarget.length < 200) callbackTarget.push({ path, async: value.result?.async ?? false, ...(result === undefined ? {} : { returnValue: result }) });
        return null;
      }
      case 'unknown': warn(`Prop ${path.map(String).join('.')} has no reliable inferred value; set it explicitly if needed.`); return undefined;
    }
  }
  const controls: ComponentPreviewControl[] = [];
  const mockProps: Record<string, JsonValue> = Object.create(null);
  for (const [name, value] of [...(root.fields ?? [])].slice(0, 100)) {
    // Required describes a preview input, not TypeScript's declared member optionality.
    // Omission deliberately lets the actual component supply any source default.
    controls.push({ name, kind: value.kind, required: value.required && !value.hasDefault, provenance: value.provenance, hasDefault: value.hasDefault,
      ...(Object.hasOwn(value, 'defaultValue') ? { defaultValue: value.defaultValue! } : {}), ...(value.kind === 'enum' && value.options?.length ? { options: value.options } : {}) });
    const result = mock(value, [name]); if (result !== undefined) mockProps[name] = result;
  }
  const requested = ComponentPreviewPropsSchema.parse(input.props ?? {});
  const effectiveProps = Object.assign(Object.create(null) as Record<string, JsonValue>, mockProps, requested);
  // Overrides replace complete top-level props. A user object is never silently patched with mock callbacks.
  const retainedCallbacks = callbacks.filter((callback) => !Object.hasOwn(requested, callback.path[0]!));
  return { exports, selectedExport: selectedExport!, controls, mockProps, effectiveProps, callbacks: retainedCallbacks, diagnostics };
}
