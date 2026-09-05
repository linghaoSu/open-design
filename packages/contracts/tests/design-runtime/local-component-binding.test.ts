import { describe, expect, it } from 'vitest';
import { ComponentBindingSchema, ComponentPropMappingSchema, RegisterLocalComponentBindingRequestSchema } from '../../src/design-runtime/index.js';

const binding = { schemaVersion: 1, id: 'local/card', componentRef: 'local:card', framework: 'react', status: 'bound', verified: true, codeComponentId: 'project/card', definitionRevision: 1 };
describe('local binding and typed value-transform contracts', () => {
  it('round-trips exact local revision evidence while retaining readable legacy bindings', () => {
    expect(ComponentBindingSchema.parse(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
    const { definitionRevision: _, ...legacy } = binding;
    expect(ComponentBindingSchema.safeParse(legacy).success).toBe(true);
    expect(ComponentBindingSchema.safeParse({ ...binding, componentRef: 'ds:acme/card' }).success).toBe(false);
    expect(ComponentBindingSchema.safeParse({ ...binding, definitionRevision: 0 }).success).toBe(false);
  });
  it('preserves scalar identity and rejects duplicate or contradictory transformations', () => {
    const mapping = { designProp: 'value', codeProp: 'value', valueTransform: { type: 'map', entries: [{ from: 1, to: 'number' }, { from: '1', to: 'string' }, { from: null, to: 'null' }] } };
    expect(ComponentPropMappingSchema.parse(JSON.parse(JSON.stringify(mapping)))).toEqual(mapping);
    expect(ComponentPropMappingSchema.safeParse({ ...mapping, values: {} }).success).toBe(false);
    expect(ComponentPropMappingSchema.safeParse({ ...mapping, valueTransform: { type: 'map', entries: [{ from: 1, to: 'a' }, { from: 1, to: 'b' }] } }).success).toBe(false);
  });
  it('requires source selection, current revision, and local binding identity to agree', () => {
    const request = { source: { framework: 'react', sourceText: '', sourcePath: 'src/Card.tsx', exportName: 'Card', codeComponentId: 'project/card' }, binding };
    expect(RegisterLocalComponentBindingRequestSchema.safeParse(request).success).toBe(true);
    expect(RegisterLocalComponentBindingRequestSchema.safeParse({ ...request, binding: { ...binding, definitionRevision: undefined } }).success).toBe(false);
    expect(RegisterLocalComponentBindingRequestSchema.safeParse({ ...request, source: { ...request.source, codeComponentId: 'other' } }).success).toBe(false);
  });
});
