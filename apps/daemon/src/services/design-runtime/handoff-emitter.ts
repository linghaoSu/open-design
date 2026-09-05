import { posix } from 'node:path';
import { parse as parseTypeScript } from '@babel/parser';
import { compileScript, compileTemplate, parse as parseSfc } from '@vue/compiler-sfc';
import {
  EmitHandoffCodeRequestSchema, HandoffCodeResultSchema, HandoffManifestSchema,
  type CodeComponentDefinition, type ComponentBinding, type EmitHandoffCodeRequest, type HandoffCodeFile,
  type HandoffCodeResult, type HandoffManifest, type HandoffScreenOutput, type JsonScalar,
  type UIIRNode, type ValidationDiagnostic,
} from '@open-design/contracts';
import { materializeBindingProps } from './binding-resolver.js';
import { composeProjectCodeIndex } from './local-component-binding.js';
import { createHandoff, handoffDiagnostic, handoffRequest } from './handoff.js';

export type HandoffCodeNode = { type: 'text'; sourceNodeId: string; text: string } | {
  type: 'component'; sourceNodeId: string; componentRef: string;
  codeComponent: CodeComponentDefinition; binding: Extract<ComponentBinding, { status: 'bound' }>;
  props: Record<string, JsonScalar>; slots: Record<string, HandoffCodeNode[]>;
};
export type MaterializedHandoffCallsResult =
  | { ok: true; manifest: HandoffManifest; screens: { id: string; nodes: HandoffCodeNode[] }[]; diagnostics: ValidationDiagnostic[] }
  | { ok: false; diagnostics: ValidationDiagnostic[] };

/** Shared expected production-call plan for emission and later source conformance validation. */
export function materializeHandoffCalls(input: HandoffManifest): MaterializedHandoffCallsResult {
  const parsed = HandoffManifestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, diagnostics: [handoffDiagnostic('ODDS7001', `Invalid handoff manifest: ${parsed.error.message}`)] };
  const rebuilt = createHandoff(handoffRequest(parsed.data));
  if (!rebuilt.manifest?.ready) return { ok: false, diagnostics: rebuilt.diagnostics };
  const manifest = rebuilt.manifest; const snapshot = manifest.snapshot;
  const index = composeProjectCodeIndex(snapshot.baseCodeIndex, snapshot.projectCodeIndex);
  const diagnostics = [...rebuilt.diagnostics];
  const visit = (node: UIIRNode): HandoffCodeNode | undefined => {
    if (node.type === 'text') return { type: 'text', sourceNodeId: node.id, text: node.text };
    const binding = manifest.coverage.find((entry) => entry.componentRef === node.ref)?.binding;
    if (binding?.status !== 'bound') { diagnostics.push(handoffDiagnostic('ODDS3004', 'Code emission requires a verified production relationship.', node.ref)); return; }
    const code = index.components.find((entry) => entry.id === binding.codeComponentId)!;
    const props = node.type === 'component' ? node.props ?? {} : Object.fromEntries(node.overrides.map((override) => [override.path[1], override.value]));
    const materialized = materializeBindingProps(binding, snapshot.registry, index.components, props, snapshot.projectComponents);
    if (!materialized.ok) { diagnostics.push(...materialized.diagnostics); return; }
    // These names are framework control fields and cannot deliver ordinary declared props.
    for (const name of Object.keys(code.props)) {
      if (name === 'key' || name === 'ref' || manifest.framework === 'vue' && (name === 'ref_for' || name === 'ref_key' || name.startsWith('onVnode') || name.includes('-'))) diagnostics.push(handoffDiagnostic('ODDS7001', `Code property ${name} has framework-specific behavior unsupported by deterministic emission.`, node.ref));
    }
    const slots: Record<string, HandoffCodeNode[]> = Object.create(null);
    if (node.type === 'component') {
      for (const mapping of [...(binding.slotMappings ?? [])].sort((left, right) => compare(left.codeSlot, right.codeSlot))) {
        if (!Object.hasOwn(node.slots ?? {}, mapping.designSlot)) continue;
        const name = mapping.codeSlot;
        if (manifest.framework === 'react' && (name === 'key' || name === 'ref') || manifest.framework === 'vue' && (name.startsWith('_') || name === '$stable')) diagnostics.push(handoffDiagnostic('ODDS7001', `Code slot ${name} is reserved by the target framework.`, node.ref));
        slots[name] = node.slots![mapping.designSlot]!.map(visit).filter((child): child is HandoffCodeNode => child !== undefined);
      }
    }
    return { type: 'component', sourceNodeId: node.id, componentRef: node.ref, codeComponent: code, binding, props: materialized.props, slots };
  };
  const screens = snapshot.document.screens.map((screen) => ({ id: screen.id, nodes: screen.children.map(visit).filter((node): node is HandoffCodeNode => node !== undefined) }));
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? { ok: false, diagnostics } : { ok: true, manifest, screens, diagnostics };
}

/** All requested screen files succeed together. This function never writes to the target repository. */
export function emitHandoffCode(input: EmitHandoffCodeRequest): HandoffCodeResult {
  const parsed = EmitHandoffCodeRequestSchema.safeParse(input);
  if (!parsed.success) return { schemaVersion: 1, ok: false, files: [], diagnostics: [handoffDiagnostic('ODDS7001', `Invalid code output request: ${parsed.error.message}`)] };
  const calls = materializeHandoffCalls(parsed.data.manifest);
  if (!calls.ok) return { schemaVersion: 1, ok: false, files: [], diagnostics: calls.diagnostics };
  const { manifest } = calls; const diagnostics = [...calls.diagnostics];
  const outputs = parsed.data.outputs;
  const screens = new Map(calls.screens.map((screen) => [screen.id, screen]));
  const seenScreens = new Set<string>(); const paths = new Set<string>();
  const codePaths = [...manifest.snapshot.baseCodeIndex.components, ...manifest.snapshot.projectCodeIndex.components].map((component) => pathKey(component.sourcePath));
  for (const output of outputs) {
    if (!screens.has(output.screenId) || seenScreens.has(output.screenId)) diagnostics.push(handoffDiagnostic('ODDS7001', `Each output must identify a unique handoff screen: ${output.screenId}.`));
    seenScreens.add(output.screenId);
    const key = pathKey(output.sourcePath);
    if ([...paths, ...codePaths].some((existing) => pathCollides(existing, key))) diagnostics.push(handoffDiagnostic('ODDS7001', `Output ${output.sourcePath} collides with another output or registered production source.`));
    paths.add(key);
    const extension = manifest.framework === 'react' ? '.tsx' : '.vue';
    if (!output.sourcePath.endsWith(extension)) diagnostics.push(handoffDiagnostic('ODDS7001', `A ${manifest.framework} output must use ${extension}: ${output.sourcePath}.`));
    if (manifest.framework === 'vue' ? output.exportName !== 'default' : !identifier(output.exportName)) diagnostics.push(handoffDiagnostic('ODDS7001', 'React outputs require an explicit identifier export; Vue SFC outputs require the default export.'));
  }
  if (seenScreens.size !== screens.size) diagnostics.push(handoffDiagnostic('ODDS7001', 'Output paths must cover every handoff screen exactly once.'));
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { schemaVersion: 1, ok: false, files: [], diagnostics };
  const files: HandoffCodeFile[] = [];
  for (const output of [...outputs].sort((left, right) => compare(left.sourcePath, right.sourcePath))) {
    try {
      const nodes = screens.get(output.screenId)!.nodes;
      const content = emitScreen(manifest.framework, output, nodes);
      validateGeneratedSource(manifest.framework, output.sourcePath, content);
      files.push({ ...output, language: manifest.framework === 'react' ? 'tsx' : 'vue', content });
    } catch (error) { diagnostics.push(handoffDiagnostic('ODDS7001', `Cannot emit ${output.sourcePath}: ${error instanceof Error ? error.message : String(error)}`)); }
  }
  return HandoffCodeResultSchema.parse({ schemaVersion: 1, ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'), files: diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? [] : files, diagnostics });
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function pathKey(path: string): string { return path.normalize('NFC').toLowerCase(); }
function pathCollides(left: string, right: string): boolean { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
function identifier(value: string): boolean { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value); }

/** JSON literals cannot escape into JSX, HTML/SFC block delimiters, or JavaScript template syntax. */
function literal(value: JsonScalar): string {
  return JSON.stringify(value).replace(/[<>&{}\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function htmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emitScreen(framework: 'react' | 'vue', output: HandoffScreenOutput, nodes: HandoffCodeNode[]): string {
  const components = new Map<string, CodeComponentDefinition>();
  const collect = (node: HandoffCodeNode): void => {
    if (node.type === 'text') return;
    components.set(node.codeComponent.id, node.codeComponent);
    for (const children of Object.values(node.slots)) children.forEach(collect);
  };
  nodes.forEach(collect);
  const ordered = [...components.values()].sort((left, right) => compare(left.id, right.id));
  const aliases = new Map(ordered.map((component, index) => [component.id, `OdComponent${index}`]));
  const imports = ordered.map((component) => {
    let module = component.packageName;
    if (!module) {
      module = posix.relative(posix.dirname(output.sourcePath), component.sourcePath);
      if (framework === 'react') module = module.replace(/\.[jt]sx?$/, '');
      else if (!module.endsWith('.vue')) throw new Error('Relative Vue component imports require an SFC source path.');
      if (!module.startsWith('.')) module = `./${module}`;
    }
    const alias = aliases.get(component.id)!;
    if (component.exportName === 'default') return `import ${alias} from ${literal(module)};`;
    if (!identifier(component.exportName)) throw new Error(`Unsupported production export name ${JSON.stringify(component.exportName)}.`);
    return `import { ${component.exportName} as ${alias} } from ${literal(module)};`;
  });
  const reactNode = (node: HandoffCodeNode): string => {
    if (node.type === 'text') return `{${literal(node.text)}}`;
    const fields = Object.keys(node.props).sort().map((name) => `${literal(name)}: ${literal(node.props[name]!)}`);
    for (const name of Object.keys(node.slots).sort()) fields.push(`${literal(name)}: <>${node.slots[name]!.map(reactNode).join('')}</>`);
    return `<${aliases.get(node.codeComponent.id)}${fields.length ? ` {...{ ${fields.join(', ')} }}` : ''} />`;
  };
  const vueNode = (node: HandoffCodeNode): string => {
    if (node.type === 'text') return `{{ ${literal(node.text)} }}`;
    const fields = Object.keys(node.props).sort().map((name) => `${literal(name)}: ${literal(node.props[name]!)}`);
    const tag = aliases.get(node.codeComponent.id)!;
    const slots = Object.keys(node.slots).sort().map((name) => `<template v-slot:${name}>${node.slots[name]!.map(vueNode).join('')}</template>`).join('');
    return `<${tag}${fields.length ? ` v-bind="${htmlAttribute(`{ ${fields.join(', ')} }`)}"` : ''}>${slots}</${tag}>`;
  };
  if (framework === 'react') return `${imports.join('\n')}${imports.length ? '\n\n' : ''}export function ${output.exportName}() {\n  return <>${nodes.map(reactNode).join('')}</>;\n}\n`;
  return `<script setup lang="ts">\n${imports.length ? imports.join('\n') : '// No production imports are required for this text-only screen.'}\n</script>\n\n<template>\n  ${nodes.map(vueNode).join('')}\n</template>\n`;
}

function validateGeneratedSource(framework: 'react' | 'vue', sourcePath: string, sourceText: string): void {
  if (framework === 'react') { parseTypeScript(sourceText, { sourceType: 'module', plugins: ['typescript', 'jsx'] }); return; }
  const { descriptor, errors } = parseSfc(sourceText, { filename: sourcePath });
  if (errors.length) throw new Error(errors.map((error) => typeof error === 'string' ? error : error.message).join(' '));
  compileScript(descriptor, { id: sourcePath, sourceMap: false, fs: { fileExists: () => false, readFile: () => undefined } });
  const result = compileTemplate({ source: descriptor.template?.content ?? '', filename: sourcePath, id: sourcePath, transformAssetUrls: false });
  if (result.errors.length) throw new Error(result.errors.map((error) => typeof error === 'string' ? error : error.message).join(' '));
}
