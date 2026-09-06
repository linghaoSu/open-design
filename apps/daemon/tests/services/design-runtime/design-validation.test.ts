import { describe, expect, it } from 'vitest';
import { validateStructuredDesign } from '../../../src/services/design-runtime/design-validation.js';
import { analyzeDesignSources } from '../../../src/services/design-runtime/design-source-analysis.js';
import { analyzeDesignStyles } from '../../../src/services/design-runtime/style-validation.js';
import { benchmarkStructuredDesign } from '../../../src/services/design-runtime/design-benchmark.js';
import { validationBenchmarkFixtures, validationFixture } from '../../fixtures/design-runtime/validation-benchmark.js';
import { createHandoff } from '../../../src/services/design-runtime/handoff.js';
import { emitHandoffCode } from '../../../src/services/design-runtime/handoff-emitter.js';
import { registerLocalComponentBinding } from '../../../src/services/design-runtime/local-component-binding.js';

function localFixture(framework: 'react' | 'vue', body: 'identifier' | 'destructured' | 'raw' | 'computed' | 'branch' = 'identifier') {
  const request = validationFixture(framework);
  request.snapshot.projectComponents.components = [{ schemaVersion: 1, id: 'card', name: 'Local card', revision: 1,
    props: { label: { type: 'string', required: false, default: 'Local label' } },
    template: { schemaVersion: 1, id: 'template-button', type: 'component', ref: 'ds:acme/button', props: { variant: 'primary' } }, propMappings: [{ prop: 'label', nodeId: 'template-button', path: ['props', 'label'] }],
  }];
  request.snapshot.document!.screens[0]!.children = [{ schemaVersion: 1, id: 'local-use', type: 'instance', ref: 'local:card', overrides: [] }];
  const bodySource = body === 'raw' ? '<button style={{color:"#f00"}}>{props.label}</button>' : body === 'computed' ? '<Button label={props.label.toUpperCase()}/>' : `<Button label={${body === 'destructured' ? 'label' : 'props.label'}}/>`;
  const sourceText = framework === 'react' ? `import {Button} from '@fixture/ui';export function Card(${body === 'destructured' ? '{label="Code default"}' : 'props'}:{label?:string}){${body === 'branch' ? 'if(props.label) return null;' : ''}return ${bodySource};}`
    : `\n<script setup lang="ts">import Button from '@fixture/ui/button';const props=withDefaults(defineProps<{label?:string}>(),{label:'Code default'});</script><template>${body === 'raw' ? '<button style="color:#f00">{{props.label}}</button>' : `<Button :label="${body === 'computed' ? 'props.label.toUpperCase()' : 'props.label'}"/>`}</template>`;
  const sourcePath = `project/Card.${framework === 'react' ? 'tsx' : 'vue'}`;
  const registered = registerLocalComponentBinding(request.snapshot, { source: { framework, sourceText, sourcePath, exportName: framework === 'react' ? 'Card' : 'default', codeComponentId: 'project/card' },
    binding: { schemaVersion: 1, id: 'local-card', componentRef: 'local:card', framework, codeComponentId: 'project/card', definitionRevision: 1, status: 'bound', verified: true },
  });
  if (!registered.ok) throw new Error(JSON.stringify(registered.diagnostics));
  request.snapshot.projectCodeIndex = registered.projectCodeIndex; request.snapshot.bindings = registered.bindings;
  request.snapshot.projectSources = [{ codeComponentId: 'project/card', sourceText }];
  request.sources = [{ sourcePath: request.outputs[0]!.sourcePath, language: framework === 'react' ? 'tsx' : 'vue', sourceText: framework === 'react'
    ? 'import {Card} from "../project/Card";export function Screen(){return <Card label="Local label"/>;}'
    : '<script setup lang="ts">import Card from "../project/Card.vue";</script><template><Card label="Local label"/></template>' },
  { sourcePath, language: framework === 'react' ? 'tsx' : 'vue', sourceText }];
  return request;
}

describe('structural design validation', () => {
  it.each(validationBenchmarkFixtures().map((fixture) => [fixture.task, fixture.repairSteps[0]!.request] as const))('certifies the authored %s source against its semantic calls and exact library', (_task, request) => {
    const result = validateStructuredDesign(request);
    expect(result.diagnostics).toEqual([]);
    expect(result.strictReady).toBe(true);
    expect(result.coverage).toEqual({ semantic: true, source: true, imports: true, styles: true, bindings: true, conformance: true });
    expect(result.metrics.componentReuse.rate).toBe(1);
    expect(result.metrics.rawColors).toBe(0); // Frozen Button implementation contains raw red by design.
    expect(result.metrics.rawSpacing).toBe(0); // Frozen Field implementation contains raw padding.
  });

  it('separates unlocked base-source proof from project-owned handoff proof while retaining the exact-lock requirement', () => {
    const request = validationFixture('react');
    const version = request.snapshot.versions[0]!;
    request.snapshot.projectSources = request.snapshot.baseCodeIndex.components.map((code) => ({
      codeComponentId: code.id, sourceText: version.package.source.files.find((file) => file.path === code.sourcePath)!.content,
    }));
    request.snapshot.versions = [];
    request.snapshot.lock.dependencies = [];
    request.snapshot.dependencies.dependencies = [];
    expect(request.snapshot.projectCodeIndex.components).toEqual([]);

    const result = validateStructuredDesign(request);
    expect(result.coverage.bindings).toBe(true);
    expect(result.diagnostics.filter((issue) => issue.code === 'ODDS7004')).toEqual([]);
    expect(result).toMatchObject({ accepted: false, strictReady: false, diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'ODDS5003', message: expect.stringContaining('explicitly lock') }),
    ]) });
    // The handoff boundary itself remains strict about project evidence ownership.
    const { tokens: _tokens, ...snapshot } = request.snapshot;
    const handoff = createHandoff({ id: 'unlocked', projectId: request.projectId, projectRevision: request.projectRevision,
      framework: 'react', snapshot: { ...snapshot, document: snapshot.document! } });
    expect(handoff.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS7004', message: expect.stringContaining('uniquely') }));
  });

  it.each(['base', 'project'] as const)('still proves the current %s code contract before adapting mixed evidence to handoff', (owner) => {
    const request = localFixture('react');
    const version = request.snapshot.versions[0]!;
    request.snapshot.projectSources.push(...request.snapshot.baseCodeIndex.components.map((code) => ({
      codeComponentId: code.id, sourceText: version.package.source.files.find((file) => file.path === code.sourcePath)!.content,
    })));
    request.snapshot.versions = [];
    request.snapshot.lock.dependencies = [];
    request.snapshot.dependencies.dependencies = [];
    const valid = validateStructuredDesign(request);
    expect(valid.coverage.bindings).toBe(true);
    expect(valid.diagnostics.filter((issue) => issue.code === 'ODDS7004')).toEqual([]);
    expect(valid.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS5003' }));

    const code = (owner === 'base' ? request.snapshot.baseCodeIndex : request.snapshot.projectCodeIndex).components[0]!;
    request.snapshot.projectSources.find((entry) => entry.codeComponentId === code.id)!.sourceText =
      `export function ${code.exportName}(props:{changedRequiredContract:number}){return null;}`;
    const stale = validateStructuredDesign(request);
    expect(stale).toMatchObject({ accepted: false, strictReady: false, coverage: { bindings: false }, diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'ODDS7004', message: expect.stringContaining(code.id) }),
    ]) });
  });

  it.each(['react', 'vue'] as const)('accepts canonical %s literal object emission and rejects modified props or slot order', (framework) => {
    const request = validationFixture(framework);
    const { tokens: _tokens, ...snapshot } = request.snapshot;
    const handoff = createHandoff({ id: 'test', projectId: request.projectId, projectRevision: request.projectRevision, framework, snapshot: { ...snapshot, document: snapshot.document! } });
    expect(handoff.manifest?.ready).toBe(true);
    const emitted = emitHandoffCode({ manifest: handoff.manifest!, outputs: request.outputs.map((output) => ({ sourcePath: output.sourcePath, exportName: output.exportName!, screenId: output.screenId! })) });
    expect(emitted.ok).toBe(true);
    request.sources = emitted.files.map((file) => ({ sourcePath: file.sourcePath, sourceText: file.content, language: file.language }));
    expect(validateStructuredDesign(request).strictReady).toBe(true);
    request.sources[0]!.sourceText = request.sources[0]!.sourceText.replace('Add resource', 'Unrelated action').replace('Resource Alpha', 'Unrelated details');
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { conformance: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6004' })]) });
  });

  it.each([['react', 'identifier'], ['react', 'destructured'], ['vue', 'identifier']] as const)('audits bound local %s %s forwarding using actual scalar props while retaining its public call', (framework, form) => {
    const request = localFixture(framework, form);
    const result = validateStructuredDesign(request);
    expect(result.diagnostics).toEqual([]);
    expect(result.strictReady).toBe(true);
    expect(result.metrics.bindingReuse).toEqual({ reused: 2, total: 2, rate: 1 });
    const { tokens: _tokens, ...snapshot } = request.snapshot;
    const handoff = createHandoff({ id: 'local', projectId: request.projectId, projectRevision: 1, framework, snapshot: { ...snapshot, document: snapshot.document! } });
    const emitted = emitHandoffCode({ manifest: handoff.manifest!, outputs: request.outputs.map((output) => ({ sourcePath: output.sourcePath, screenId: output.screenId!, exportName: output.exportName! })) });
    expect(emitted.files[0]?.content).toContain('Card');
    request.sources[0]!.sourceText = emitted.files[0]!.content;
    expect(validateStructuredDesign(request).strictReady).toBe(true);
  });

  it.each(['react', 'vue'] as const)('does not exempt registered local %s raw controls or styles merely because its API matches', (framework) => {
    const result = validateStructuredDesign(localFixture(framework, 'raw'));
    expect(result.strictReady).toBe(false);
    expect(result.metrics).toMatchObject({ intrinsicControls: 1, duplicateControls: 1, rawColors: 1 });
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS3003' }), expect.objectContaining({ code: 'ODDS2002' })]));
  });

  it.each([['react', 'computed'], ['react', 'branch'], ['vue', 'computed']] as const)('keeps %s %s local implementation flow incomplete', (framework, body) => {
    expect(validateStructuredDesign(localFixture(framework, body))).toMatchObject({ strictReady: false, coverage: { source: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6002' })]) });
  });

  it.each([
    'background-image:linear-gradient(red,blue)', 'border-top:1px solid red', 'border-start-start-radius:12px', 'border-inline-color:red', 'c\\6flor:red', 'inset-inline-start:12px', 'column-rule-color:red',
    'inset-block-end:12px', 'scroll-margin-inline-start:12px', 'scroll-padding-block:12px', 'stop-color:red', 'text-emphasis-color:red', '-webkit-text-fill-color:red', 'column-rule:1px solid red',
  ])('does not certify protected CSS escape %s', (declaration) => {
    const request = validationFixture(); request.sources[1]!.sourceText = `main{${declaration}}`;
    const result = validateStructuredDesign(request);
    expect(result.strictReady).toBe(false);
    expect(result.diagnostics.some((issue) => ['ODDS6002', 'ODDS2002', 'ODDS2003', 'ODDS2004'].includes(issue.code))).toBe(true);
  });
  it('requires the actual default Vue SFC export rather than accepting an arbitrary selected name', () => {
    const request = validationFixture('vue'); request.outputs[0]!.exportName = 'MissingExport';
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { source: false } });
  });
  it('matches Vue null interpolation to empty text instead of the JavaScript string null', () => {
    const request = validationFixture('vue');
    const source = request.sources[0]!;
    source.sourceText = source.sourceText.replace('{{ "Resource Alpha" }}', '{{null}}');
    const root = request.snapshot.document!.screens[0]!.children[0]!;
    if (root.type !== 'component') throw new Error('root');
    const text = root.slots!.body!.find((node) => node.type === 'text');
    if (!text || text.type !== 'text') throw new Error('text');
    text.text = 'null';
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { conformance: false } });
    text.text = '';
    expect(validateStructuredDesign(request).strictReady).toBe(true);
  });

  it.each(['react', 'vue'] as const)('blocks missing import bytes and tampered exact %s library bytes', (framework) => {
    const request = validationFixture(framework);
    request.sources[0]!.sourceText = request.sources[0]!.sourceText.replace(/@fixture\/ui(?:\/button)?/, '@unknown/ui');
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { imports: false } });
    const tampered = validationFixture(framework); const file = tampered.snapshot.versions[0]!.package.source.files[0]!;
    tampered.sources.push({ sourcePath: file.path, language: framework === 'react' ? 'tsx' : 'vue', sourceText: `${file.content}\n// changed bytes` });
    expect(validateStructuredDesign(tampered)).toMatchObject({ strictReady: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6005' })]) });
  });

  it.each(['react', 'vue'] as const)('preserves explicitly supplied empty %s slots instead of equating them with absence', (framework) => {
    const request = validationFixture(framework); const root = request.snapshot.document!.screens[0]!.children[0]!;
    if (root.type !== 'component') throw new Error('root');
    root.slots = { body: [] };
    const { tokens: _tokens, ...snapshot } = request.snapshot;
    const handoff = createHandoff({ id: 'empty-slots', projectId: request.projectId, projectRevision: 1, framework, snapshot: { ...snapshot, document: snapshot.document! } });
    const emitted = emitHandoffCode({ manifest: handoff.manifest!, outputs: request.outputs.map((output) => ({ sourcePath: output.sourcePath, exportName: output.exportName!, screenId: output.screenId! })) });
    request.sources = emitted.files.map((file) => ({ sourcePath: file.sourcePath, language: file.language, sourceText: file.content }));
    expect(validateStructuredDesign(request).strictReady).toBe(true);
    const before = request.sources[0]!.sourceText;
    request.sources[0]!.sourceText = framework === 'react' ? before.replace(', "children": <></>', '') : before.replace('<template v-slot:default></template>', '');
    expect(request.sources[0]!.sourceText).not.toBe(before);
    expect(validateStructuredDesign(request)).toMatchObject({ accepted: false, strictReady: false, coverage: { conformance: false } });
  });

  it('compares slot order and refuses Strict acceptance when installed-package compatibility is only advisory', () => {
    const request = validationFixture(); const root = request.snapshot.document!.screens[0]!.children[0]!;
    if (root.type !== 'component') throw new Error('root');
    root.slots!.body!.reverse();
    expect(validateStructuredDesign(request)).toMatchObject({ accepted: false, strictReady: false, coverage: { conformance: false } });
    const warning = localFixture('react');
    const code = warning.snapshot.projectCodeIndex.components[0]!; code.packageName = '@project/card';
    warning.snapshot.targetPackages.push({ name: '@project/card', installation: { status: 'observed', version: '1.0.0' } });
    warning.sources[0]!.sourceText = warning.sources[0]!.sourceText.replace('../project/Card', '@project/card');
    const result = validateStructuredDesign(warning);
    expect(result).toMatchObject({ strictReady: false, accepted: false });
    expect(result.diagnostics.some((issue) => issue.severity === 'error')).toBe(true);
  });

  it.each(['template', 'default', 'override'] as const)('finds token references inherited from a local %s', (origin) => {
    const request = localFixture('react'); const definition = request.snapshot.projectComponents.components[0]!;
    if (origin === 'default') definition.props.label!.default = 'token:acme/missing';
    else if (origin === 'override') {
      const use = request.snapshot.document!.screens[0]!.children[0]!;
      if (use.type !== 'instance') throw new Error('instance');
      use.overrides = [{ schemaVersion: 1, path: ['props', 'label'], value: 'token:acme/missing' }];
    } else {
      definition.props = {}; definition.propMappings = [];
      if (definition.template.type !== 'component') throw new Error('component');
      definition.template.props = { label: 'token:acme/missing', variant: 'primary' };
    }
    const result = validateStructuredDesign(request);
    expect(result.strictReady).toBe(false);
    expect(result.metrics.unknownTokens).toBe(1);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS2001', message: expect.stringContaining('token:acme/missing') }));
  });

  it.each(['react', 'vue'] as const)('rejects a different bound local %s implementation even when both bodies use valid design components', (framework) => {
    const request = localFixture(framework);
    const codePath = request.snapshot.projectCodeIndex.components[0]!.sourcePath;
    const file = request.sources.find((source) => source.sourcePath === codePath)!;
    file.sourceText = framework === 'react' ? file.sourceText.replace('<Button label={props.label}/>', '<Button label="Wrong label"/>') : file.sourceText.replace(':label="props.label"', 'label="Wrong label"');
    request.snapshot.projectSources[0]!.sourceText = file.sourceText;
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { source: true, conformance: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6004', message: expect.stringContaining('local implementation') })]) });
  });

  it('does not treat a lowercase JSX import alias as a production component call', () => {
    const request = validationFixture();
    request.snapshot.document!.screens[0]!.children = [{ schemaVersion: 1, type: 'component', id: 'action', ref: 'ds:acme/button', props: { label: 'Save' } }];
    request.sources = [{ sourcePath: request.outputs[0]!.sourcePath, language: 'tsx', sourceText: 'import {Button as button} from "@fixture/ui";export function Screen(){return <button label="Save"/>;}' }];
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { conformance: false }, metrics: { intrinsicControls: 1, componentReuse: { reused: 0 } } });
  });

  it('does not interpret an arbitrary runtime import named Fragment as React.Fragment', () => {
    const request = validationFixture(); request.sources[0]!.sourceText = 'import {useState as Fragment} from "react";' + request.sources[0]!.sourceText.replace('return <Panel', 'return <Fragment><Panel').replace('</Panel>;', '</Panel></Fragment>;');
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { source: false } });
  });

  it.each(['Button = Replacement;', 'Object.assign(Button, {render: Other});', 'const Alias = Button;'])('cannot turn %s into verified import reuse', (mutation) => {
    const request = validationFixture(); request.sources[0]!.sourceText += mutation;
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, coverage: { source: false } });
  });

  it('rejects an import shadow and unrelated semantic document even when both are individually parseable', () => {
    const request = validationFixture(); request.sources[0]!.sourceText = request.sources[0]!.sourceText.replace('Screen()', 'Screen(Button: unknown)');
    expect(validateStructuredDesign(request)).toMatchObject({ strictReady: false, diagnostics: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('shadows') })]) });
    const unrelated = validationFixture(); unrelated.snapshot.document!.screens[0]!.children = [{ schemaVersion: 1, id: 'different', type: 'text', text: 'Unrelated document' }];
    expect(validateStructuredDesign(unrelated)).toMatchObject({ strictReady: false, coverage: { conformance: false } });
  });

  it.each(['tsx', 'vue', 'html'] as const)('preserves hostile and prototype member names from %s source', (language) => {
    const sourceText = language === 'tsx' ? 'export function Screen(){return <button __proto__="x" constructor="y" toString="z"/>;}'
      : language === 'vue' ? '<script setup lang="ts">// static</script><template><button __proto__="x" constructor="y" toString="z"/></template>'
        : '<button __proto__="x" constructor="y" toString="z"></button>';
    const result = analyzeDesignSources({ sources: [{ sourcePath: `screen.${language}`, language, sourceText }], codes: [], provenCodeSources: new Map(), frozenSources: new Map() }, [{ sourcePath: `screen.${language}`, exportName: language === 'tsx' ? 'Screen' : 'default' }]);
    const find = (nodes: typeof result.outputs[number]['nodes']): typeof nodes[number] | undefined => nodes.find((node) => node.type === 'element' && node.tag === 'button') ?? nodes.flatMap((node) => node.type === 'element' ? Object.values(node.slots).flat() : []).map((node) => find([node])).find(Boolean);
    const button = find(result.outputs[0]!.nodes);
    expect(button?.type).toBe('element');
    if (button?.type !== 'element') throw new Error('button');
    expect(Object.hasOwn(button.props, '__proto__')).toBe(true);
    expect(button.props['__proto__']).toBe('x');
    expect(button.props['constructor']).toBe('y');
    expect(button.props[language === 'html' ? 'tostring' : 'toString']).toBe('z');
    expect(Object.getPrototypeOf(button.props)).toBeNull();
  });

  it('records intrinsic controls and unknown role evidence under advisory policies without certifying Strict', () => {
    const request = validationFixture(); request.settings.mode = 'explore'; request.snapshot.document = null;
    request.sources[0]!.sourceText = 'export function Screen(){return <><button style={{color:"#f00",padding:"12px",borderRadius:"8px"}}>Save</button><button>Save</button></>; }';
    request.sources = [request.sources[0]!];
    const result = validateStructuredDesign(request);
    expect(result).toMatchObject({ accepted: true, strictReady: false, metrics: { intrinsicControls: 2, duplicateControls: 2, rawColors: 1, rawSpacing: 1, rawRadius: 1 } });
    expect(result.diagnostics.some((issue) => issue.code === 'ODDS3003' && issue.severity === 'warning')).toBe(true);
    const rolesAbsent = validationFixture(); rolesAbsent.settings.mode = 'explore'; rolesAbsent.snapshot.document = null;
    rolesAbsent.sources = [{ sourcePath: 'screen.tsx', language: 'tsx', sourceText: 'export function Screen(){return <select/>;}' }]; rolesAbsent.outputs = [{ sourcePath: 'screen.tsx', exportName: 'Screen' }];
    expect(validateStructuredDesign(rolesAbsent)).toMatchObject({ strictReady: false, metrics: { intrinsicControls: 1 }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6005', message: expect.stringContaining('role') })]) });
  });

  it('warns when a Guided HTML control duplicates an available production control in another framework', () => {
    const request = validationFixture('react'); request.settings.mode = 'guided'; request.snapshot.document = null;
    request.snapshot.versions = []; request.snapshot.lock.dependencies = []; request.snapshot.dependencies.dependencies = [];
    request.snapshot.projectSources = request.snapshot.baseCodeIndex.components.map((code) => ({ codeComponentId: code.id,
      sourceText: validationFixture('react').snapshot.versions[0]!.package.source.files.find((file) => file.path === code.sourcePath)!.content,
    }));
    request.settings.projectConstraints.guided.interactiveHtml.customControlsWhenBoundComponentExists = 'warning';
    request.sources = [{ sourcePath: 'screen.html', language: 'html', sourceText: '<button>Save</button>' }]; request.outputs = [{ sourcePath: 'screen.html' }];
    const result = validateStructuredDesign(request);
    expect(result).toMatchObject({ accepted: true, strictReady: false, metrics: { intrinsicControls: 1, duplicateControls: 1 } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS3003', severity: 'warning', message: expect.stringContaining('HTML') }));
  });

  it('does not advertise a React binding as an available Vue control replacement', () => {
    const request = validationFixture('react'); request.settings.mode = 'explore'; request.snapshot.document = null;
    request.sources = [{ sourcePath: 'screen.vue', language: 'vue', sourceText: '<script setup lang="ts">// static</script><template><button>Save</button></template>' }]; request.outputs = [{ sourcePath: 'screen.vue', exportName: 'default' }];
    const result = validateStructuredDesign(request);
    expect(result.metrics).toMatchObject({ intrinsicControls: 1, duplicateControls: 0 });
    expect(result.diagnostics.some((issue) => issue.code === 'ODDS3003')).toBe(false);
  });

  it('checks typed tokens and reports an empty reuse denominator as unknown', () => {
    const request = validationFixture(); request.settings.mode = 'explore'; request.snapshot.document = null;
    request.sources = [{ sourcePath: 'screen.html', language: 'html', sourceText: '<main style="padding:var(--color-primary);color:var(--missing)">Text</main>' }]; request.outputs = [{ sourcePath: 'screen.html' }];
    const result = validateStructuredDesign(request);
    expect(result.metrics).toMatchObject({ unknownTokens: 1, componentReuse: { reused: 0, total: 0, rate: null } });
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS2001' }), expect.objectContaining({ code: 'ODDS2005' })]));
    expect(analyzeDesignStyles('main{color:var(--color-primary)}', 'x.css', request.snapshot.tokens).complete).toBe(true);
  });

  it('measures all eight maintained fixtures repeatably without claiming model generation variance', () => {
    const fixtures = validationBenchmarkFixtures(); const before = structuredClone(fixtures);
    const result = benchmarkStructuredDesign(fixtures, 3);
    expect(result.cases).toHaveLength(8);
    expect(result.repeatable).toBe(true);
    expect(result.generationVariance).toBeNull();
    for (const entry of result.cases) expect(entry, entry.id).toMatchObject({ metricVariance: 0, initial: { strictReady: false, metrics: { rawColors: 1 } }, final: { strictReady: true, metrics: { rawColors: 0 } }, repairSteps: 1, repairs: [expect.anything()] });
    const baseline = fixtures[0]!;
    expect(benchmarkStructuredDesign([{ ...baseline, request: baseline.repairSteps[0]!.request, repairSteps: [] }]).cases[0]).toMatchObject({ repairSteps: 0, repairs: [], initial: { strictReady: true }, final: { strictReady: true } });
    expect(fixtures).toEqual(before);
  });
});
