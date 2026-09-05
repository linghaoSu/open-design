import { parse as parseTypeScript } from '@babel/parser';
import { compileScript, compileTemplate, parse as parseSfc } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { HandoffManifestSchema, type ComponentFramework, type HandoffManifest, type HandoffScreenOutput } from '@open-design/contracts';
import { handoffFixture, localHandoffFixture } from '../../fixtures/design-runtime/handoff.js';
import { createHandoff } from '../../../src/services/design-runtime/handoff.js';
import { emitHandoffCode, materializeHandoffCalls } from '../../../src/services/design-runtime/handoff-emitter.js';

function ready(input = handoffFixture()): HandoffManifest {
  const result = createHandoff(input);
  if (!result.manifest?.ready) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
  return result.manifest;
}
function output(framework: ComponentFramework, screenId = 'main'): HandoffScreenOutput {
  return { screenId, sourcePath: `src/pages/nested/${screenId}.${framework === 'react' ? 'tsx' : 'vue'}`, exportName: framework === 'react' ? 'Screen' : 'default' };
}

describe('production component code emission', () => {
  it.each(['react', 'vue'] as const)('emits %s production imports, scalar props and ordered named slots as actual parseable source', (framework) => {
    const manifest = ready(handoffFixture(framework)); const before = structuredClone(manifest);
    const request = { manifest, outputs: [output(framework)] };
    const result = emitHandoffCode(request);
    expect(result).toMatchObject({ ok: true, diagnostics: [], files: [{ language: framework === 'react' ? 'tsx' : 'vue' }] });
    const content = result.files[0]!.content;
    expect(content).toContain(framework === 'react' ? 'import { Panel as OdComponent0 } from "@acme/ui"' : 'import OdComponent0 from "@acme/ui"');
    if (framework === 'react') {
      expect(parseTypeScript(content, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).errors).toEqual([]);
      expect(content).toContain('"side-panel": <>{"Side"}</>');
      expect(content).toContain('"constructor": <>{"Own constructor"}</>');
      expect(content).toContain('"toString": <>{"Own toString"}</>');
    } else {
      const parsed = parseSfc(content); expect(parsed.errors).toEqual([]);
      expect(compileScript(parsed.descriptor, { id: 'test' }).content).toContain('import OdComponent0');
      const template = compileTemplate({ source: parsed.descriptor.template!.content, id: 'test', filename: 'Screen.vue' });
      expect(template.errors).toEqual([]);
      expect(template.code).toContain('"side-panel"'); expect(template.code).toContain('constructor:'); expect(template.code).toContain('toString:');
    }
    const calls = materializeHandoffCalls(manifest); if (!calls.ok) throw new Error('expected verified calls');
    expect(calls.screens[0]!.nodes[0]).toMatchObject({ sourceNodeId: 'panel', componentRef: 'ds:acme/panel', props: { label: 'Welcome' }, slots: { [framework === 'react' ? 'children' : 'default']: [{ type: 'text', sourceNodeId: 'body', text: 'Body' }] } });
    expect(emitHandoffCode(request)).toEqual(result); expect(manifest).toEqual(before);
  });

  it.each(['react', 'vue'] as const)('preserves bound local %s calls and materializes mapped design defaults and explicit overrides', (framework) => {
    const manifest = ready(localHandoffFixture(framework));
    const calls = materializeHandoffCalls(manifest); if (!calls.ok) throw new Error(calls.diagnostics[0]?.message);
    expect(calls.screens[0]!.nodes).toMatchObject([
      { type: 'component', sourceNodeId: 'default-card', componentRef: 'local:card', binding: { definitionRevision: 2 }, props: { appearance: 'filled' }, slots: {} },
      { type: 'component', sourceNodeId: 'override-card', componentRef: 'local:card', props: { appearance: 'outline' }, slots: {} },
    ]);
    const result = emitHandoffCode({ manifest, outputs: [output(framework)] }); expect(result.ok).toBe(true);
    const content = result.files[0]!.content;
    const script = framework === 'react' ? content : compileScript(parseSfc(content).descriptor, { id: 'test' }).content;
    const imports = parseTypeScript(script, { sourceType: 'module', plugins: ['typescript', 'jsx'] }).program.body.filter((node) => node.type === 'ImportDeclaration');
    expect(imports.map((node) => node.source.value)).toContain(`../../components/Card 'quoted' \`file\`${framework === 'vue' ? '.vue' : ''}`);
    expect(content).not.toContain('@acme/ui'); expect(content).not.toContain('primary');
    expect(content).toContain('filled'); expect(content).toContain('outline');
  });

  it.each(['react', 'vue'] as const)('escapes %s script delimiters, quotes, backticks and Unicode line separators without changing scalar data', (framework) => {
    const input = handoffFixture(framework); const value = '</script><script>" & ` ${alert(1)} {{template}}\u2028\u2029';
    const panel = input.snapshot.document.screens[0]!.children[0]!; if (panel.type !== 'component') throw new Error('fixture');
    panel.props = { label: value }; panel.slots!.body = [{ schemaVersion: 1, id: 'unsafe-text', type: 'text', text: value }];
    const manifest = ready(input); const calls = materializeHandoffCalls(manifest); if (!calls.ok) throw new Error('expected calls');
    expect(calls.screens[0]!.nodes[0]).toMatchObject({ props: { label: value }, slots: { [framework === 'react' ? 'children' : 'default']: [{ text: value }] } });
    const result = emitHandoffCode({ manifest, outputs: [output(framework)] }); expect(result).toMatchObject({ ok: true, diagnostics: [] });
    const content = result.files[0]!.content;
    expect(content).toContain('\\u003c/script\\u003e'); expect(content).toContain('\\u2028\\u2029');
    expect(content).not.toContain('</script><script>'); expect(content).not.toContain('\u2028');
    if (framework === 'vue') expect(content.match(/<\/script>/g)).toHaveLength(1);
  });

  it.each(['react', 'vue'] as const)('preserves own constructor/toString %s properties instead of inherited object members', (framework) => {
    for (const name of ['constructor', 'toString'] as const) {
      const manifest = ready(localHandoffFixture(framework, name));
      const calls = materializeHandoffCalls(manifest); if (!calls.ok) throw new Error('expected calls');
      const call = calls.screens[0]!.nodes[0]!; if (call.type !== 'component') throw new Error('expected component');
      expect(Object.hasOwn(call.props, name)).toBe(true); expect(call.props[name]).toBe('filled');
      const result = emitHandoffCode({ manifest, outputs: [output(framework)] }); expect(result.ok).toBe(true);
      expect(result.files[0]!.content).toContain(framework === 'react' ? `"${name}": "filled"` : `&quot;${name}&quot;: &quot;filled&quot;`);
    }
  });

  it('emits a valid Vue SFC for a text-only screen with no production imports', () => {
    const input = handoffFixture('vue'); input.snapshot.document.screens[0]!.children = [{ schemaVersion: 1, id: 'text', type: 'text', text: 'Hello' }];
    const result = emitHandoffCode({ manifest: ready(input), outputs: [output('vue')] });
    expect(result).toMatchObject({ ok: true, diagnostics: [] });
    const parsed = parseSfc(result.files[0]!.content); expect(parsed.errors).toEqual([]);
    expect(() => compileScript(parsed.descriptor, { id: 'text-only' })).not.toThrow();
  });

  it.each(['slot name', "slot'quote", 'slot:argument', 'slot[dynamic]'])(
    'rejects slot name %s at the canonical boundary before it can change Vue directive grammar', (name) => {
      const manifest = ready(handoffFixture('vue'));
      manifest.snapshot.baseCodeIndex.components[0]!.slots = { [name]: { kind: 'vue-slot', required: false, multiple: false } };
      expect(HandoffManifestSchema.safeParse(manifest).success).toBe(false);
      expect(emitHandoffCode({ manifest, outputs: [output('vue')] })).toMatchObject({ ok: false, files: [], diagnostics: [expect.objectContaining({ code: 'ODDS7001' })] });
    },
  );

  it.each(['production-source', 'case-path', 'ancestor-path', 'missing-screen', 'unknown-screen', 'invalid-export', 'outside-project'] as const)(
    'rejects %s output conflicts atomically', (failure) => {
      const input = handoffFixture(); input.snapshot.document.screens.push({ schemaVersion: 1, type: 'screen', id: 'second', children: [] });
      const outputs = [output('react'), output('react', 'second')];
      if (failure === 'production-source') outputs[1]!.sourcePath = input.snapshot.baseCodeIndex.components[0]!.sourcePath;
      if (failure === 'case-path') outputs[1]!.sourcePath = outputs[0]!.sourcePath.toUpperCase().replace('.TSX', '.tsx');
      if (failure === 'ancestor-path') outputs[1]!.sourcePath = `${outputs[0]!.sourcePath}/Child.tsx`;
      if (failure === 'missing-screen') outputs.pop();
      if (failure === 'unknown-screen') outputs[1]!.screenId = 'unknown';
      if (failure === 'invalid-export') outputs[1]!.exportName = 'class';
      if (failure === 'outside-project') outputs[1]!.sourcePath = '../outside.tsx';
      const manifest = ready(input); const before = structuredClone(manifest);
      expect(emitHandoffCode({ manifest, outputs })).toMatchObject({ ok: false, files: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS7001', severity: 'error' })]) });
      expect(manifest).toEqual(before);
    },
  );

  it('revalidates portable source and revision facts instead of trusting cached successful manifest flags', () => {
    const manifest = ready(localHandoffFixture());
    manifest.snapshot.projectSources = [];
    expect(manifest.ready).toBe(true);
    expect(materializeHandoffCalls(manifest)).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS7004' })]) });
    expect(emitHandoffCode({ manifest, outputs: [output('react')] })).toMatchObject({ ok: false, files: [] });
    const drift = ready(localHandoffFixture()); drift.snapshot.projectComponents.components[0]!.revision++;
    expect(emitHandoffCode({ manifest: drift, outputs: [output('react')] })).toMatchObject({ ok: false, files: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS3002' })]) });
  });
});
