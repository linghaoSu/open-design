import { describe, expect, it } from 'vitest';
import { ProjectComponentDefinitionSchema } from '@open-design/contracts';
import { formForDefinition, prepareDefinition } from '../../src/components/project-structure-drafts';

describe('project component form drafts', () => {
  it.each([false, 0, null])('round trips an explicit enum default %s without storing inherited values in the template', (value) => {
    const definition = ProjectComponentDefinitionSchema.parse({
      schemaVersion: 1, id: 'value', name: 'Value', revision: 2,
      props: { constructor: { type: 'enum', required: false, values: [false, 0, null], default: value } },
      template: { schemaVersion: 1, type: 'instance', id: 'root', ref: 'ds:test/Value', overrides: [] },
      propMappings: [{ prop: 'constructor', nodeId: 'root', path: ['props', 'value'] }],
    });
    const form = formForDefinition(definition, 2);
    const result = prepareDefinition(form);
    expect(result).toEqual({ success: true, definition: { ...definition, revision: 3 }, issues: [] });
  });

  it('preserves duplicate names as editable rows rather than silently overwriting one property', () => {
    const definition = ProjectComponentDefinitionSchema.parse({
      schemaVersion: 1, id: 'value', name: 'Value', revision: 1,
      props: { text: { type: 'string', required: true } },
      template: { schemaVersion: 1, type: 'text', id: 'root', text: '' },
      propMappings: [{ prop: 'text', nodeId: 'root', path: ['text'] }],
    });
    const form = formForDefinition(definition, 1);
    form.props.push({ ...form.props[0]!, key: 'another-row', hasDefault: true, defaultValue: { kind: 'string', input: 'Retained' } });
    const result = prepareDefinition(form);
    expect(result.success).toBe(false);
    expect(result.issues).toContain('props.text: Duplicate property name.');
    expect(form.props).toHaveLength(2);
    expect(form.props[1]!.defaultValue.input).toBe('Retained');
  });
});
