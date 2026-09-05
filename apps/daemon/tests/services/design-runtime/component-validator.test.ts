import { describe, expect, it } from 'vitest';
import type { ComponentRegistry, JsonValue } from '@open-design/contracts';

import { validateComponentUsage } from '../../../src/services/design-runtime/component-validator.js';

function registry(): ComponentRegistry {
  return {
    schemaVersion: 1,
    id: 'test',
    components: [{
      schemaVersion: 1,
      id: 'Button',
      name: 'Primary action',
      props: {
        variant: { type: 'enum', values: ['primary', 'secondary'], required: true },
        disabled: { type: 'boolean', required: false },
        label: { type: 'string', required: true, default: 'Continue' },
        count: { type: 'number', required: false },
      },
    }],
  };
}

describe('validateComponentUsage', () => {
  it('accepts declared values without changing the usage or applying defaults', () => {
    const usage = { component: 'ds:test/Button', props: { variant: 'primary', disabled: false, count: 0 } };
    expect(validateComponentUsage(registry(), usage)).toEqual([]);
    expect(usage.props).toEqual({ variant: 'primary', disabled: false, count: 0 });
  });

  it('returns ODDS1003 and the legal variant values for an invented variant', () => {
    expect(validateComponentUsage(registry(), {
      component: 'ds:test/Button',
      nodeId: 'submit',
      props: { variant: 'danger' },
    })).toEqual([{
      schemaVersion: 1,
      code: 'ODDS1003',
      severity: 'error',
      message: 'Property variant must be one of the declared enum values.',
      componentRef: 'ds:test/Button',
      nodeId: 'submit',
      path: ['props', 'variant'],
      allowedValues: ['primary', 'secondary'],
    }]);
  });

  it.each(['Button', 'ds:other/Button', 'ds:test/Primary action', 'local:Button', 'ds:test/Missing'])(
    'rejects reference %s instead of guessing by name',
    (component) => {
      expect(validateComponentUsage(registry(), { component, props: {} })).toMatchObject([
        { code: 'ODDS1001', componentRef: component, path: ['component'] },
      ]);
    },
  );

  it('reports unknown props, wrong primitive types, and missing required props separately', () => {
    expect(validateComponentUsage(registry(), {
      component: 'ds:test/Button',
      props: { unknown: 'value', disabled: 'false', count: '1', label: null },
    }).map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'ODDS1005', path: ['props', 'count'] },
      { code: 'ODDS1005', path: ['props', 'disabled'] },
      { code: 'ODDS1005', path: ['props', 'label'] },
      { code: 'ODDS1002', path: ['props', 'unknown'] },
      { code: 'ODDS1006', path: ['props', 'variant'] },
    ]);
  });

  it.each([1, false, null, [], {}] satisfies JsonValue[])(
    'rejects %j as an enum value without coercing its type',
    (variant) => {
      expect(validateComponentUsage(registry(), {
        component: 'ds:test/Button', props: { variant },
      })).toMatchObject([{ code: 'ODDS1003' }]);
    },
  );

  it('handles scalar enum values and falsy defaults without coercion', () => {
    const input = registry();
    input.components[0]!.props = {
      mode: { type: 'enum', values: [false, 0, null], required: true, default: null },
      disabled: { type: 'boolean', required: true, default: false },
    };
    expect(validateComponentUsage(input, { component: 'ds:test/Button', props: {} })).toEqual([]);
    for (const mode of [false, 0, null]) {
      expect(validateComponentUsage(input, { component: 'ds:test/Button', props: { mode } })).toEqual([]);
    }
    expect(validateComponentUsage(input, {
      component: 'ds:test/Button', props: { mode: '0' },
    })).toMatchObject([{ code: 'ODDS1003' }]);
  });

  it('does not treat inherited property names as registry properties', () => {
    expect(validateComponentUsage(registry(), {
      component: 'ds:test/Button', props: { variant: 'primary', toString: 'custom' },
    })).toMatchObject([{ code: 'ODDS1002', path: ['props', 'toString'] }]);
  });
});
