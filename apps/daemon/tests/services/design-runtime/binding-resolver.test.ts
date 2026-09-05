import { describe, expect, it } from 'vitest';
import type { CodeComponentDefinition, ComponentBinding, ComponentRegistry } from '@open-design/contracts';

import { materializeBindingProps, resolveComponentBinding } from '../../../src/services/design-runtime/binding-resolver.js';

function fixture(): { registry: ComponentRegistry; binding: ComponentBinding; code: CodeComponentDefinition } {
  return {
    registry: {
      schemaVersion: 1,
      id: 'test',
      components: [{
        schemaVersion: 1,
        id: 'Button',
        name: 'Design button',
        props: {
          variant: { type: 'enum', values: ['primary', 'secondary'], required: true },
          disabled: { type: 'boolean', required: false },
        },
      }],
    },
    binding: {
      schemaVersion: 1,
      id: 'button-binding',
      componentRef: 'ds:test/Button',
      framework: 'react',
      status: 'bound',
      verified: true,
      codeComponentId: 'fixture/Button',
    },
    code: {
      schemaVersion: 1,
      id: 'fixture/Button',
      name: 'Code button',
      framework: 'react',
      exportName: 'Button',
      sourcePath: 'src/Button.tsx',
      props: {
        variant: { type: 'enum', values: ['primary', 'secondary', 'danger'], required: true },
        disabled: { type: 'boolean', required: false },
      },
    },
  };
}

describe('resolveComponentBinding', () => {
  it('resolves ds:test/Button to the exact code ID regardless of display names and candidate order', () => {
    const { binding, registry, code } = fixture();
    const decoy = { ...code, id: 'another/Button', name: registry.components[0]!.name };
    const expected = { ok: true, component: registry.components[0], codeComponent: code };
    expect(resolveComponentBinding(binding, registry, [decoy, code])).toEqual(expected);
    expect(resolveComponentBinding(binding, registry, [code, decoy])).toEqual(expected);
  });

  it.each([
    ['candidate', 'ODDS3004'],
    ['unbound', 'ODDS3004'],
    ['stale', 'ODDS3002'],
    ['broken', 'ODDS3001'],
  ] as const)('refuses a %s binding', (status, diagnosticCode) => {
    const { binding, registry, code } = fixture();
    const changed: ComponentBinding = status === 'unbound'
      ? {
        schemaVersion: 1, id: binding.id, componentRef: binding.componentRef,
        framework: binding.framework, status, verified: false,
      }
      : { ...binding, status, verified: false, codeComponentId: code.id };
    expect(resolveComponentBinding(changed, registry, [code])).toMatchObject({
      ok: false, diagnostics: [{ code: diagnosticCode }],
    });
  });

  it('refuses an unverified bound binding', () => {
    const { binding, registry, code } = fixture();
    binding.verified = false;
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({
      ok: false, diagnostics: [{ code: 'ODDS3004' }],
    });
  });

  it.each(['local:Button', 'ds:other/Button', 'ds:test/Design button'])('does not guess design reference %s', (ref) => {
    const { binding, registry, code } = fixture();
    binding.componentRef = ref;
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({
      ok: false, diagnostics: [{ code: 'ODDS3001', path: ['componentRef'] }],
    });
  });

  it('rejects absent and ambiguous code identities', () => {
    const { binding, registry, code } = fixture();
    for (const candidates of [[], [code, { ...code }], [{ ...code, id: 'other/Button' }]]) {
      expect(resolveComponentBinding(binding, registry, candidates)).toMatchObject({
        ok: false, diagnostics: [{ code: 'ODDS3001', path: ['codeComponentId'] }],
      });
    }
  });

  it('rejects a framework mismatch and incomplete export metadata', () => {
    const { binding, registry, code } = fixture();
    for (const candidate of [{ ...code, framework: 'vue' as const }, { ...code, exportName: '' }, { ...code, sourcePath: ' ' }]) {
      expect(resolveComponentBinding(binding, registry, [candidate])).toMatchObject({
        ok: false, diagnostics: [{ code: 'ODDS3001' }],
      });
    }
  });

  it('allows explicit compatible prop renames', () => {
    const { binding, registry, code } = fixture();
    code.props.appearance = code.props.variant!;
    delete code.props.variant;
    binding.propMappings = [{ designProp: 'variant', codeProp: 'appearance' }];
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
  });

  it.each([false, true])('rejects declared slots without code slot metadata (required: %s)', (required) => {
    const { binding, registry, code } = fixture();
    registry.components[0]!.slots = {};
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
    registry.components[0]!.slots.content = { accepts: ['text'], required, multiple: false };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'ODDS3001', path: ['slots'] }],
    });
  });

  it('materializes declared design defaults and preserves defaultless omission', () => {
    const { binding, registry, code } = fixture();
    const design = registry.components[0]!;
    design.props.disabled = { type: 'boolean', required: false, default: false };
    code.props.disabled = { type: 'boolean', required: false, default: true };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
    expect(materializeBindingProps(binding, registry, [code], {variant:'primary'})).toMatchObject({ ok: true, props: {disabled:false} });
    code.props.disabled = { type: 'boolean', required: false };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
    design.props.disabled = { type: 'boolean', required: false };
    code.props.disabled = { type: 'boolean', required: false, default: false };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: false });
    design.props.disabled = { type: 'boolean', required: true, default: false };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
    design.props.disabled = { type: 'boolean', required: true };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
  });

  it('rejects missing mapping endpoints and incomplete value transforms', () => {
    const { binding, registry, code } = fixture();
    for (const propMappings of [
      [{ designProp: 'unknown', codeProp: 'variant' }],
      [{ designProp: 'variant', codeProp: 'unknown' }],
      [{ designProp: 'variant', codeProp: 'variant', values: { primary: 'secondary' } }],
    ]) {
      expect(resolveComponentBinding({ ...binding, propMappings }, registry, [code])).toMatchObject({
        ok: false, diagnostics: [{ code: 'ODDS3001', path: ['propMappings', 0] }],
      });
    }
  });

  it('rejects duplicate mappings and collisions with implicit same-name mappings', () => {
    const { binding, registry, code } = fixture();
    const mapping = { designProp: 'variant', codeProp: 'variant' };
    binding.propMappings = [mapping, mapping];
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: false });
    registry.components[0]!.props.inactive = { type: 'boolean', required: false };
    binding.propMappings = [{ designProp: 'inactive', codeProp: 'disabled' }];
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({
      ok: false, diagnostics: [{ code: 'ODDS3001', message: 'Multiple design properties map to code property disabled.' }],
    });
  });

  it('rejects a narrower code enum and a primitive type mismatch', () => {
    const { binding, registry, code } = fixture();
    code.props.variant = { type: 'enum', values: ['primary'], required: true };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: false });
    code.props.variant = { type: 'boolean', required: true };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: false });
    code.props.variant = { type: 'string', required: true };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
  });

  it('requires mappings for required code props and respects declared defaults', () => {
    const { binding, registry, code } = fixture();
    code.props.label = { type: 'string', required: true };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({
      ok: false, diagnostics: [{ code: 'ODDS3001', message: 'Required code property label has no design property mapping.' }],
    });
    code.props.label = { type: 'string', required: true, default: 'Continue' };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
    code.props.disabled = { type: 'boolean', required: true };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: false });
    registry.components[0]!.props.disabled = { type: 'boolean', required: false, default: false };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
    code.props.disabled = { type: 'boolean', required: true, default: false };
    expect(resolveComponentBinding(binding, registry, [code])).toMatchObject({ ok: true });
  });
});
