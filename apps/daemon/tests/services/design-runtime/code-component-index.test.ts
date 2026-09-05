import { describe, expect, it } from 'vitest';
import type { CodeComponentDefinition, CodeComponentIndex, ComponentBinding, ComponentBindingRegistry, ComponentRegistry } from '@open-design/contracts';
import {
  bindComponent,
  getCodeComponent,
  getComponentBinding,
  reindexComponentBindings,
  removeComponentBinding,
  revalidateComponentBinding,
  searchCodeComponents,
  unbindComponent,
  upsertComponentBinding,
} from '../../../src/services/design-runtime/code-component-index.js';

function fixture() {
  const code: CodeComponentDefinition = {
    schemaVersion: 1, id: 'acme/Button', name: 'Button', framework: 'react', exportName: 'Button', sourcePath: 'src/Button.tsx', packageName: '@acme/ui',
    props: { variant: { type: 'enum', values: ['primary', 'secondary'], required: false }, disabled: { type: 'boolean', required: false } },
  };
  const index: CodeComponentIndex = { schemaVersion: 1, id: 'acme', components: [code] };
  const registry: ComponentRegistry = {
    schemaVersion: 1, id: 'acme', components: [{ schemaVersion: 1, id: 'button', name: 'Action', props: code.props }],
  };
  const binding: ComponentBinding = {
    schemaVersion: 1, id: 'binding:button', componentRef: 'ds:acme/button', framework: 'react', codeComponentId: code.id, status: 'bound', verified: true,
  };
  const bindings: ComponentBindingRegistry = { schemaVersion: 1, id: 'acme', bindings: [binding] };
  return { code, index, registry, binding, bindings };
}

describe('code component index queries', () => {
  it('gets exact identities and searches metadata deterministically without name-based binding', () => {
    const { index, code } = fixture();
    index.components = [{ ...code, id: 'z/Button', framework: 'vue' }, { ...code, id: 'a/Button' }, code];
    expect(getCodeComponent(index, code.id)).toBe(code);
    expect(getCodeComponent(index, 'Button')).toBeUndefined();
    expect(searchCodeComponents(index, ' BUTTON @ACME/UI ')).toEqual([index.components[1], code, index.components[0]]);
    expect(searchCodeComponents(index, 'button', 'vue')).toEqual([index.components[0]]);
    expect(searchCodeComponents(index, 'button missing')).toEqual([]);
    expect(index.components[0]!.id).toBe('z/Button');
  });
});

describe('explicit component binding operations', () => {
  it('binds and resolves exact targets while leaving every supplied snapshot unchanged', () => {
    const { bindings, binding, registry, index } = fixture();
    bindings.bindings = [];
    const before = JSON.stringify({ bindings, registry, index });
    const { schemaVersion: _, status: __, verified: ___, ...input } = binding;
    const result = bindComponent(bindings, input, registry, index);
    expect(result).toMatchObject({ ok: true, binding });
    if (!result.ok) throw new Error('Expected binding');
    expect(getComponentBinding(result.bindings, 'ds:acme/button', 'react')).toEqual(binding);
    expect(getComponentBinding(result.bindings, 'ds:acme/button', 'vue')).toBeUndefined();
    expect(JSON.stringify({ bindings, registry, index })).toBe(before);
  });

  it('rejects invalid contracts and conflicting stable binding identities', () => {
    const { bindings, binding, registry, index } = fixture();
    expect(upsertComponentBinding(bindings, { ...binding, codeComponentId: 'missing' }, registry, index)).toMatchObject({ ok: false, diagnostics: [{ code: 'ODDS3001' }] });
    expect(upsertComponentBinding(bindings, { ...binding, id: 'replacement-id' }, registry, index)).toMatchObject({ ok: false, diagnostics: [{ path: ['id'] }] });
    expect(bindings.bindings).toEqual([binding]);
  });

  it('updates the existing binding by stable identity and allows explicit property mapping', () => {
    const { bindings, binding, registry, index, code } = fixture();
    code.props = { intent: code.props.variant!, disabled: code.props.disabled! };
    const updated = { ...binding, propMappings: [{ designProp: 'variant', codeProp: 'intent' }] };
    const result = upsertComponentBinding(bindings, updated, registry, index);
    expect(result).toMatchObject({ ok: true, binding: updated, bindings: { bindings: [updated] } });
    expect(bindings.bindings).toEqual([binding]);
  });

  it('stores an unverified candidate without claiming a successful resolution', () => {
    const { bindings, binding, registry, index } = fixture();
    const candidate: ComponentBinding = { ...binding, status: 'candidate', verified: false, codeComponentId: 'pending/Button' };
    const result = upsertComponentBinding(bindings, candidate, registry, index);
    expect(result).toMatchObject({ ok: true, binding: candidate });
    if (!result.ok) throw new Error('Expected candidate');
    expect(revalidateComponentBinding(result.bindings, binding.id, registry, index)).toMatchObject({ ok: false });
  });

  it('unbinds without losing the stable relationship identity, then removes idempotently', () => {
    const { bindings, binding } = fixture();
    binding.propMappings = [{ designProp: 'variant', codeProp: 'variant' }];
    const result = unbindComponent(bindings, binding.id);
    expect(result).toMatchObject({ ok: true, binding: { id: binding.id, componentRef: binding.componentRef, status: 'unbound', verified: false } });
    if (!result.ok) throw new Error('Expected unbind');
    expect(result.binding).not.toHaveProperty('codeComponentId');
    expect(result.binding).not.toHaveProperty('propMappings');
    expect(removeComponentBinding(result.bindings, binding.id).bindings).toEqual([]);
    expect(removeComponentBinding(result.bindings, 'missing')).toEqual(result.bindings);
    expect(unbindComponent(bindings, 'missing')).toMatchObject({ ok: false });
    expect(bindings.bindings[0]!.status).toBe('bound');
  });

  it.each(['candidate', 'stale', 'broken'] as const)('explicitly revalidates a %s binding but never fabricates an absent target', (status) => {
    const { bindings, binding, index, registry } = fixture();
    bindings.bindings = [{ ...binding, status, verified: false }];
    expect(revalidateComponentBinding(bindings, binding.id, registry, index)).toMatchObject({ ok: true, binding: { status: 'bound', verified: true } });
    expect(revalidateComponentBinding(bindings, binding.id, registry, { ...index, components: [] })).toMatchObject({ ok: false });
    expect(bindings.bindings[0]!.status).toBe(status);
  });

  it('does not verify an unbound or absent binding', () => {
    const { bindings, binding, index, registry } = fixture();
    const result = unbindComponent(bindings, binding.id);
    if (!result.ok) throw new Error('Expected unbind');
    expect(revalidateComponentBinding(result.bindings, binding.id, registry, index)).toMatchObject({ ok: false });
    expect(revalidateComponentBinding(bindings, 'missing', registry, index)).toMatchObject({ ok: false });
  });
});

describe('code index binding invalidation', () => {
  it.each(['add', 'remove', 'requiredness', 'cardinality'] as const)('marks compatible slot %s changes stale', (change) => {
    const { index, code, bindings, binding, registry } = fixture();
    code.slots = { children: { kind: 'react-node', required: true, multiple: false } };
    registry.components[0]!.slots = { body: { accepts: ['text'], required: true, multiple: false } };
    binding.slotMappings = [{ designSlot: 'body', codeSlot: 'children' }];
    const next = structuredClone(index);
    const slots = next.components[0]!.slots!;
    if (change === 'add') slots.footer = { kind: 'react-node', required: false, multiple: true };
    if (change === 'remove') code.slots.footer = { kind: 'react-node', required: false, multiple: true };
    if (change === 'requiredness') slots.children!.required = false;
    if (change === 'cardinality') slots.children!.multiple = true;
    expect(reindexComponentBindings(bindings, index, next, registry).bindings[0]).toMatchObject({ status: 'stale', verified: false });
    expect(binding.status).toBe('bound');
  });

  it('keeps verification when only slot provenance or member ordering changes', () => {
    const { index, code, bindings, registry } = fixture();
    code.slots = { children: { kind: 'react-node', required: false, multiple: true }, footer: { kind: 'react-node', required: false, multiple: false } };
    const next: CodeComponentIndex = { ...index, components: [{ ...code, slots: {
      footer: { ...code.slots.footer!, source: { kind: 'typescript', sourcePath: 'types/Shared.ts', line: 42 } },
      children: { ...code.slots.children!, source: { kind: 'typescript', sourcePath: code.sourcePath, line: 500 } },
    } }] };
    expect(reindexComponentBindings(bindings, index, next, registry)).toEqual(bindings);
  });

  it('preserves verification for unrelated additions, display names, provenance, property and enum order changes', () => {
    const { index, code, bindings, registry } = fixture();
    const next: CodeComponentIndex = { ...index, components: [{
      ...code, name: 'New display name',
      source: { kind: 'typescript', sourcePath: code.sourcePath, line: 900 },
      props: {
        disabled: code.props.disabled!,
        variant: { type: 'enum', values: ['secondary', 'primary'], required: false, source: { kind: 'typescript', sourcePath: code.sourcePath, line: 901 } },
      },
    }, { ...code, id: 'acme/AnotherButton' }] };
    expect(reindexComponentBindings(bindings, index, next, registry)).toEqual(bindings);
  });

  it.each([
    { exportName: 'RenamedButton' },
    { sourcePath: 'src/components/Button.tsx' },
    { packageName: '@acme/components' },
    { props: { variant: { type: 'enum' as const, values: ['primary', 'secondary', 'danger'], required: false }, disabled: { type: 'boolean' as const, required: false } } },
  ])('marks a compatible public contract change stale %#', (change) => {
    const { index, code, bindings, registry } = fixture();
    const updated = reindexComponentBindings(bindings, index, { ...index, components: [{ ...code, ...change }] }, registry);
    expect(updated.bindings[0]).toMatchObject({ status: 'stale', verified: false });
    expect(bindings.bindings[0]!.status).toBe('bound');
  });

  it('marks removed, renamed-identity and framework-mismatched targets broken', () => {
    const { index, code, bindings, registry } = fixture();
    for (const components of [
      [],
      [{ ...code, id: 'acme/RenamedIdentity' }],
      [{ ...code, framework: 'vue' as const }],
    ]) {
      expect(reindexComponentBindings(bindings, index, { ...index, components }, registry).bindings[0]).toMatchObject({ status: 'broken', verified: false });
    }
  });

  it('marks incompatible API drift stale and refuses verification until the contract is repaired', () => {
    const { index, code, bindings, binding, registry } = fixture();
    const narrowed: CodeComponentIndex = { ...index, components: [{
      ...code, props: { ...code.props, variant: { type: 'enum', values: ['primary'], required: false } },
    }] };
    const stale = reindexComponentBindings(bindings, index, narrowed, registry);
    expect(stale.bindings[0]).toMatchObject({ status: 'stale', verified: false });
    expect(revalidateComponentBinding(stale, binding.id, registry, narrowed)).toMatchObject({ ok: false });
    expect(revalidateComponentBinding(stale, binding.id, registry, index)).toMatchObject({ ok: true, binding: { status: 'bound', verified: true } });
  });

  it.each(['candidate', 'stale', 'broken'] as const)('never silently promotes a %s binding after code recovery', (status) => {
    const { bindings, binding, index, registry } = fixture();
    bindings.bindings = [{ ...binding, status, verified: false }];
    expect(reindexComponentBindings(bindings, { ...index, components: [] }, index, registry)).toEqual(bindings);
  });

  it('preserves unbound records and invalidates previously unverifiable bound records', () => {
    const { bindings, binding, index, registry } = fixture();
    expect(reindexComponentBindings(bindings, { ...index, components: [] }, index, registry).bindings[0]).toMatchObject({ status: 'stale', verified: false });
    const result = unbindComponent(bindings, binding.id);
    if (!result.ok) throw new Error('Expected unbind');
    expect(reindexComponentBindings(result.bindings, index, { ...index, components: [] }, registry)).toEqual(result.bindings);
  });
});
