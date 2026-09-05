import { describe, expect, it } from 'vitest';
import { ComponentBindingSchema, type ComponentBinding, type ComponentDefinition, type CodeComponentDefinition, type JsonScalar } from '@open-design/contracts';
import { materializeBindingProps, resolveComponentBinding } from '../../../src/services/design-runtime/binding-resolver.js';
import { composeProjectCodeIndex, registerLocalComponentBinding, revalidateLocalComponentBinding, synchronizeLocalComponentBindings, verifyProjectCodeSources, type LocalComponentBindingContext } from '../../../src/services/design-runtime/local-component-binding.js';

function context(): LocalComponentBindingContext {
  return { registry: { schemaVersion: 1, id: 'acme', components: [] }, baseCodeIndex: { schemaVersion: 1, id: 'acme', components: [] },
    projectCodeIndex: { schemaVersion: 1, id: 'project', components: [] }, bindings: { schemaVersion: 1, id: 'project', bindings: [] },
    projectComponents: { schemaVersion: 1, id: 'project', components: [{ schemaVersion: 1, id: 'card', name: 'Card', revision: 1,
      props: { label: { type: 'string', required: true, default: 'Hello' } }, template: { schemaVersion: 1, type: 'text', id: 'text', text: '' },
      propMappings: [{ prop: 'label', nodeId: 'text', path: ['text'] }],
    }] } };
}
const source = { framework: 'react' as const, sourceText: "export function Card({label='Hello'}:{label?:string}) {return null;}", sourcePath: 'src/Card.tsx', exportName: 'Card', codeComponentId: 'project/card' };
const binding: Extract<ComponentBinding, { status: 'bound' }> = { schemaVersion: 1, id: 'binding/card', componentRef: 'local:card', framework: 'react', codeComponentId: source.codeComponentId, status: 'bound', verified: true, definitionRevision: 1 };

describe('project code ownership and local binding lifecycle', () => {
  it('registers source-proven local code atomically and preserves it in a locked code overlay', () => {
    const before = context(); const copy = structuredClone(before);
    const result = registerLocalComponentBinding(before, { source, binding });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(before).toEqual(copy);
    expect(result.binding).toEqual(binding);
    const ds = { ...result.projectCodeIndex.components[0]!, id: 'ds/card', exportName: 'DsCard' };
    const combined = composeProjectCodeIndex({ schemaVersion: 1, id: 'acme', components: [ds] }, result.projectCodeIndex);
    expect(combined.components.map((entry) => entry.id)).toEqual(['ds/card', 'project/card']);
    expect(combined.id).toBe('project');
    expect(() => composeProjectCodeIndex({ schemaVersion: 1, id: 'acme', components: [result.projectCodeIndex.components[0]!] }, result.projectCodeIndex)).toThrow(/collides/);
  });
  it('treats legacy and template-only revision drift as stale until explicit local verification', () => {
    const input = context(); const result = registerLocalComponentBinding(input, { source, binding }); if (!result.ok) throw new Error('fixture');
    const current = { ...input, projectCodeIndex: result.projectCodeIndex, bindings: result.bindings };
    const legacy = ComponentBindingSchema.parse({ ...binding, definitionRevision: undefined });
    expect(resolveComponentBinding(legacy, current.registry, result.codeIndex.components, current.projectComponents)).toMatchObject({ ok: false, diagnostics: [{ code: 'ODDS3002' }] });
    expect(resolveComponentBinding(binding, current.registry, result.codeIndex.components)).toMatchObject({ ok: false });
    current.projectComponents.components[0]!.revision = 2;
    current.projectComponents.components[0]!.name = 'Published card';
    current.bindings = synchronizeLocalComponentBindings(current);
    expect(current.bindings.bindings[0]).toMatchObject({ status: 'stale', verified: false, definitionRevision: 1 });
    const verified = revalidateLocalComponentBinding(current, binding.id);
    expect(verified).toMatchObject({ ok: true, binding: { status: 'bound', definitionRevision: 2 } });
    current.projectComponents.components = [];
    expect(synchronizeLocalComponentBindings(current).bindings[0]).toMatchObject({ status: 'broken' });
  });
  it('rejects invalid source, wrong revisions and package identity collisions without mutating any input', () => {
    for (const mutate of ['source', 'revision', 'collision'] as const) {
      const input = context();
      const request = { source: { ...source }, binding: { ...binding } };
      if (mutate === 'source') request.source.sourceText = 'export function Card(props:{onClick:()=>void}) {return null;}';
      if (mutate === 'revision') request.binding.definitionRevision = 9;
      if (mutate === 'collision') input.baseCodeIndex.components = [{ schemaVersion: 1, id: source.codeComponentId, framework: 'react', name: 'Card', exportName: 'Card', sourcePath: source.sourcePath, props: {} }];
      const copy = structuredClone(input);
      expect(registerLocalComponentBinding(input, request)).toMatchObject({ ok: false });
      expect(input).toEqual(copy);
    }
  });
  it('requires fresh source evidence and distinguishes API drift from body-only edits', () => {
    const result = registerLocalComponentBinding(context(), { source, binding }); if (!result.ok) throw new Error('fixture');
    const evidence = { codeComponentId: source.codeComponentId, sourceText: source.sourceText };
    expect(verifyProjectCodeSources(result.projectCodeIndex, [evidence])).toEqual([]);
    expect(verifyProjectCodeSources(result.projectCodeIndex, [{ ...evidence, sourceText: source.sourceText.replace('return null', 'return <span>{label}</span>') }])).toEqual([]);
    for (const entries of [[], [evidence, evidence], [{ ...evidence, codeComponentId: 'unknown' }], [{ ...evidence, sourceText: source.sourceText.replace("label='Hello'", "label='Changed'") }]]) {
      expect(verifyProjectCodeSources(result.projectCodeIndex, entries)).toContainEqual(expect.objectContaining({ code: 'ODDS7004', severity: 'error' }));
    }
  });
  it('cannot steal a design-system binding identity when registering local production code', () => {
    const input = context();
    input.bindings.bindings = [{ ...binding, componentRef: 'ds:acme/existing', codeComponentId: 'ds/existing', definitionRevision: undefined }];
    const before = structuredClone(input);
    expect(registerLocalComponentBinding(input, { source, binding })).toMatchObject({ ok: false, diagnostics: [{ message: expect.stringContaining('different component/framework relationship') }] });
    expect(input).toEqual(before);
    const first = registerLocalComponentBinding(context(), { source, binding }); if (!first.ok) throw new Error('fixture');
    expect(registerLocalComponentBinding({ ...context(), projectCodeIndex: first.projectCodeIndex, bindings: first.bindings }, { source, binding })).toMatchObject({ ok: true });
  });
});

function transformFixture(values: JsonScalar[]) {
  const component: ComponentDefinition = { schemaVersion: 1, id: 'button', name: 'Button', props: Object.fromEntries([['constructor', { type: 'enum' as const, values, required: true, default: values[0]! }]]) };
  const code: CodeComponentDefinition = { schemaVersion: 1, id: 'code/button', framework: 'react', name: 'Button', exportName: 'Button', sourcePath: 'src/Button.tsx', props: Object.fromEntries([['toString', { type: 'string' as const, required: true, default: 'code-default' }]]) };
  const bound: ComponentBinding = { schemaVersion: 1, id: 'binding/button', componentRef: 'ds:acme/button', framework: 'react', codeComponentId: code.id, status: 'bound', verified: true,
    propMappings: [{ designProp: 'constructor', codeProp: 'toString', valueTransform: { type: 'map', entries: values.map((from, index) => ({ from, to: `value-${index}` })) } }] };
  return { component, code, bound, registry: { schemaVersion: 1 as const, id: 'acme', components: [component] } };
}

describe('canonical binding value application', () => {
  it('maps typed scalar collisions and design defaults without prototype lookup or code-default drift', () => {
    const fixture = transformFixture([1, '1', false, 'false', null, 'null', 'constructor', 'toString']);
    const before = structuredClone(fixture);
    expect(resolveComponentBinding(fixture.bound, fixture.registry, [fixture.code]).ok).toBe(true);
    expect(materializeBindingProps(fixture.bound, fixture.registry, [fixture.code], {})).toMatchObject({ ok: true, props: { toString: 'value-0' } });
    const definition = fixture.component.props['constructor' as string]!;
    for (const [index, value] of (definition.type === 'enum' ? definition.values : []).entries()) {
      expect(materializeBindingProps(fixture.bound, fixture.registry, [fixture.code], { constructor: value })).toMatchObject({ ok: true, props: { toString: `value-${index}` } });
    }
    expect(fixture).toEqual(before);
  });
  it('supports complete unambiguous legacy maps and rejects ambiguous/incomplete/unknown/out-of-domain mappings', () => {
    const fixture = transformFixture(['constructor', 'toString']);
    fixture.bound.propMappings = [{ designProp: 'constructor', codeProp: 'toString', values: { constructor: 'first', toString: 'second' } }];
    expect(materializeBindingProps(fixture.bound, fixture.registry, [fixture.code], {})).toMatchObject({ ok: true, props: { toString: 'first' } });
    fixture.bound.propMappings[0]!.values = { constructor: 'first' };
    expect(resolveComponentBinding(fixture.bound, fixture.registry, [fixture.code]).ok).toBe(false);
    const ambiguous = transformFixture([1, '1']); ambiguous.bound.propMappings = [{ designProp: 'constructor', codeProp: 'toString', values: { '1': 'both' } }];
    expect(resolveComponentBinding(ambiguous.bound, ambiguous.registry, [ambiguous.code]).ok).toBe(false);
    for (const entries of [[{ from: 'unknown', to: 'x' }], [{ from: 'constructor', to: 1 }, { from: 'toString', to: 2 }]]) {
      fixture.bound.propMappings = [{ designProp: 'constructor', codeProp: 'toString', valueTransform: { type: 'map', entries } }];
      expect(resolveComponentBinding(fixture.bound, fixture.registry, [fixture.code]).ok).toBe(false);
    }
  });
  it('retains defaultless omission and refuses stale relationships before materialization', () => {
    const fixture = transformFixture([false, true]); fixture.component.props['constructor' as string] = { type: 'boolean', required: false };
    expect(resolveComponentBinding(fixture.bound, fixture.registry, [fixture.code]).ok).toBe(false);
    fixture.code.props['toString' as string] = { type: 'string', required: false };
    expect(materializeBindingProps(fixture.bound, fixture.registry, [fixture.code], {})).toEqual({ ok: true, props: {} });
    expect(materializeBindingProps({ ...fixture.bound, status: 'stale', verified: false }, fixture.registry, [fixture.code], { constructor: false })).toMatchObject({ ok: false, diagnostics: [{ code: 'ODDS3002' }] });
  });
});
