import { parse } from '@babel/parser';
import type * as t from '@babel/types';
import { posix } from 'node:path';
import {
  ComponentStoryArgTypeSchema, ComponentStoryDefinitionSchema, CompileSourceComponentResultSchema,
  CompileStorybookMetadataRequestSchema, DesignMemberNameSchema, JsonScalarSchema,
  type CodeComponentDefinition, type CompileSourceComponentResult, type CompileStorybookMetadataRequest,
  type ComponentStoryArgType, type JsonScalar, type SourceProvenance,
} from '@open-design/contracts';
import { CompilerError } from './react-compiler.js';
import { validateComponentProperties } from './component-validator.js';
import { assertStaticMetadataUses, metadataFields, metadataLiteral, metadataObject, selectedMetadataExport, unwrapMetadata, type MetadataFailure } from './static-source-metadata.js';

/** Conservative CSF3 examples. Story args never alter source-proven production defaults. */
export function compileStorybookMetadata(input: CompileStorybookMetadataRequest): CompileSourceComponentResult {
  const request = CompileStorybookMetadataRequestSchema.parse(input);
  const fail: MetadataFailure = (message, node) => {
    throw new CompilerError(message, request.sourcePath, 'default', node?.loc?.start.line, node?.loc ? node.loc.start.column + 1 : undefined);
  };
  let ast: ReturnType<typeof parse>;
  try { ast = parse(request.sourceText, { sourceType: 'module', plugins: ['typescript', 'jsx'] }); }
  catch (error) { return fail(`Invalid Storybook source: ${error instanceof Error ? error.message : String(error)}`); }
  const defaults = ast.program.body.filter((entry): entry is t.ExportDefaultDeclaration => entry.type === 'ExportDefaultDeclaration');
  if (defaults.length !== 1) fail('Expected exactly one CSF3 default metadata export');
  let metaNode: t.Node = defaults[0]!.declaration;
  const metadataNames = new Set(request.selections.map((selection) => selection.exportName));
  if (metaNode.type === 'Identifier') {
    const name = metaNode.name;
    metadataNames.add(name);
    const definitions = ast.program.body.flatMap((entry) => {
      const declaration = entry.type === 'ExportNamedDeclaration' ? entry.declaration : entry;
      return declaration?.type === 'VariableDeclaration' ? declaration.declarations.flatMap((item) => item.id.type === 'Identifier' && item.id.name === name ? [{ declaration, item }] : []) : [];
    });
    if (definitions.length !== 1 || definitions[0]!.declaration.kind !== 'const' || !definitions[0]!.item.init) fail('Default metadata must identify one local const object', metaNode);
    metaNode = definitions[0]!.item.init!;
  }
  assertStaticMetadataUses(ast.program, metadataNames, fail);
  const meta = metadataObject(metaNode, fail);
  metadataFields(meta, ['component', 'title', 'args', 'argTypes', 'tags'], fail);
  verifyComponentImport(ast.program, meta.get('component')?.value, request.sourcePath, request.compiled.codeComponent, fail);
  const inheritedArgs = args(meta.get('args')?.value, fail);
  const inheritedTypes = argTypes(meta.get('argTypes')?.value, request.sourcePath, 'default', request.compiled.codeComponent, fail);
  const title = meta.get('title') ? metadataLiteral(meta.get('title')!.value, fail) : undefined;
  if (title !== undefined && typeof title !== 'string') fail('Storybook title must be a literal string', meta.get('title'));
  const inheritedTags = tags(meta.get('tags')?.value, fail);
  const stories = request.selections.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((selection) => {
    const node = selectedMetadataExport(ast.program, selection.exportName, fail);
    const story = metadataObject(node, fail);
    metadataFields(story, ['name', 'args', 'argTypes', 'tags'], fail);
    const storyArgs = { ...inheritedArgs, ...args(story.get('args')?.value, fail) };
    validateArgs(storyArgs, request.compiled.codeComponent, fail, node);
    const selected = ComponentStoryDefinitionSchema.safeParse({
      id: selection.id, exportName: selection.exportName,
      name: story.get('name') ? metadataLiteral(story.get('name')!.value, fail) : selection.exportName,
      ...(title === undefined ? {} : { title }), args: storyArgs,
      argTypes: mergeArgTypes(inheritedTypes, argTypes(story.get('argTypes')?.value, request.sourcePath, selection.exportName, request.compiled.codeComponent, fail)),
      tags: combineTags([...inheritedTags, ...tags(story.get('tags')?.value, fail)]),
      source: provenance(request.sourcePath, selection.exportName, node),
    });
    if (!selected.success) return fail(`Invalid story metadata: ${selected.error.message}`, node);
    return selected.data;
  });
  const component = request.compiled.registry.components[0]!;
  const previous = component.stories ?? [];
  // Re-imports update the same stable selection IDs; other source examples remain intact.
  const combined = [...previous.filter((entry) => !stories.some((story) => story.id === entry.id)), ...stories]
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return CompileSourceComponentResultSchema.parse({ ...request.compiled, registry: {
    ...request.compiled.registry, components: [{ ...component, stories: combined }],
  } });
}

function provenance(sourcePath: string, exportName: string, node: t.Node): SourceProvenance {
  return { kind: 'storybook', sourcePath, exportName, ...(node.loc ? { line: node.loc.start.line } : {}), confidence: 1 };
}

function mergeArgTypes(inherited: Record<string, ComponentStoryArgType>, selected: Record<string, ComponentStoryArgType>): Record<string, ComponentStoryArgType> {
  const merged = new Map(Object.entries(inherited));
  for (const [name, value] of Object.entries(selected)) merged.set(name, { ...merged.get(name), ...value });
  return Object.fromEntries(merged);
}

function combineTags(values: string[]): string[] {
  const included = new Set<string>();
  for (const value of values) {
    if (value.startsWith('!')) included.delete(value.slice(1));
    else included.add(value);
  }
  return [...included];
}

function verifyComponentImport(program: t.Program, node: t.Node | undefined, storyPath: string, code: CodeComponentDefinition, fail: MetadataFailure): void {
  if (node?.type !== 'Identifier') fail('Storybook component must be a directly imported component identifier', node);
  const matches = program.body.flatMap((statement) => statement.type === 'ImportDeclaration' && statement.importKind !== 'type'
    ? statement.specifiers.filter((specifier) => specifier.local.name === node.name).map((specifier) => ({ statement, specifier })) : []);
  const match = matches[0];
  if (matches.length !== 1 || !match) fail('Storybook component must use one direct runtime import', node);
  let exported: string;
  if (code.framework === 'vue') {
    if (match.specifier.type !== 'ImportDefaultSpecifier') fail('Vue Storybook components require a direct default runtime import', node);
    exported = 'default';
  } else {
    if (match.specifier.type !== 'ImportSpecifier' || match.specifier.importKind === 'type') fail('React Storybook components require a direct named runtime import', node);
    exported = match.specifier.imported.type === 'Identifier' ? match.specifier.imported.name : match.specifier.imported.value;
  }
  const specifier = match.statement.source.value;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) fail('Storybook package and alias import resolution is unsupported; supply a direct relative source import', match.statement);
  const target = posix.normalize(posix.join(posix.dirname(storyPath), specifier));
  const candidates = posix.extname(target) ? [target] : code.framework === 'vue' ? [target, `${target}.vue`] : [target, `${target}.tsx`, `${target}.ts`];
  if (exported !== code.exportName || !candidates.includes(code.sourcePath)) fail('Storybook component import does not identify the selected code source and export', match.statement);
}

function args(node: t.Node | undefined, fail: MetadataFailure): Record<string, JsonScalar> {
  if (!node) return {};
  return Object.fromEntries([...metadataObject(node, fail)].map(([name, property]) => {
    const value = JsonScalarSchema.safeParse(metadataLiteral(property.value, fail));
    if (!DesignMemberNameSchema.safeParse(name).success || !value.success) return fail('Story args must have valid member names and finite scalar literal values', property);
    return [name, value.data];
  }));
}

function validateArgs(values: Record<string, JsonScalar>, code: CodeComponentDefinition, fail: MetadataFailure, node: t.Node): void {
  const scalarProps = Object.fromEntries(Object.entries(values).filter(([name]) => !Object.hasOwn(code.slots ?? {}, name)));
  const diagnostics = validateComponentProperties(code, { component: code.id, props: scalarProps });
  if (diagnostics.length) fail(`Invalid story args: ${diagnostics.map((entry) => entry.message).join(' ')}`, node);
  for (const [name, slot] of Object.entries(code.slots ?? {})) {
    if (Object.hasOwn(values, name) && slot.kind !== 'react-node') fail(`Scalar args cannot express the Vue slot ${name}`, node);
    if (slot.required && !Object.hasOwn(values, name)) fail(`Story requires a literal value for code slot ${name}`, node);
  }
}

function argTypes(node: t.Node | undefined, sourcePath: string, exportName: string, code: CodeComponentDefinition, fail: MetadataFailure): Record<string, ComponentStoryArgType> {
  if (!node) return {};
  return Object.fromEntries([...metadataObject(node, fail)].map(([name, property]) => {
    if (!Object.hasOwn(code.props, name) && !Object.hasOwn(code.slots ?? {}, name)) fail(`Story argType ${name} is absent from the selected code contract`, property);
    const fields = metadataObject(property.value, fail);
    metadataFields(fields, ['description', 'options', 'control'], fail);
    const value = Object.fromEntries([...fields].map(([field, entry]) => {
      if (field === 'control' && unwrapMetadata(entry.value).type === 'ObjectExpression') {
        const control = metadataObject(entry.value, fail); metadataFields(control, ['type'], fail);
        if (!control.has('type')) fail('Control metadata requires a literal type', entry);
        return [field, metadataLiteral(control.get('type')!.value, fail)];
      }
      return [field, metadataLiteral(entry.value, fail)];
    }));
    const result = ComponentStoryArgTypeSchema.safeParse({ ...value, source: provenance(sourcePath, exportName, property) });
    if (!result.success) return fail(`Invalid argType metadata: ${result.error.message}`, property);
    for (const option of result.data.options ?? []) {
      const prop = Object.hasOwn(code.props, name) ? code.props[name] : undefined;
      if (prop && (prop.type === 'enum' ? !prop.values.includes(option) : typeof option !== prop.type)) fail(`Story options for ${name} exceed the source-proven property domain`, property);
    }
    return [name, result.data];
  }));
}

function tags(node: t.Node | undefined, fail: MetadataFailure): string[] {
  if (!node) return [];
  const value = metadataLiteral(node, fail);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) fail('Storybook tags must be literal nonempty strings', node);
  return value as string[];
}
