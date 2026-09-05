import { describe, expect, it } from 'vitest';
import {
  CodeComponentDefinitionSchema,
  ComponentBindingSchema,
  ComponentDefinitionSchema,
  ComponentInstanceSchema,
  ComponentOverrideSchema,
  ComponentPropDefinitionSchema,
  ComponentPropMappingSchema,
  ComponentReferenceSchema,
  ComponentRegistrySchema,
  ComponentSlotDefinitionSchema,
  JsonValueSchema,
  SourceProvenanceSchema,
  UIIRDocumentSchema,
  UIIRNodeSchema,
  UIIRScreenSchema,
  ValidationDiagnosticSchema,
  type ComponentBinding,
  type ComponentDefinition,
  type ComponentInstance,
  type ComponentRegistry,
  type UIIRDocument,
} from '../../src/design-runtime/index.js';

const source = { kind: 'typescript' as const, sourcePath: 'src/Button.tsx', exportName: 'Button', line: 2, confidence: 1 };
const component: ComponentDefinition = {
  schemaVersion: 1,
  id: 'Button',
  name: 'Button',
  props: {
    variant: { type: 'enum', values: ['primary', 'secondary', 'danger'], required: false, default: 'primary', source },
    size: { type: 'enum', values: ['sm', 'md', 'lg'], required: false },
    disabled: { type: 'boolean', required: false, default: false },
    label: { type: 'string', required: true },
    count: { type: 'number', required: false, default: 0 },
  },
  slots: { default: { accepts: ['text', 'ds:test/icon'], required: false, multiple: true } },
  states: ['default', 'hover', 'disabled'],
  source,
};
const registry: ComponentRegistry = { schemaVersion: 1, id: 'test', components: [component] };
const codeComponent = {
  schemaVersion: 1 as const,
  id: 'fixture/Button',
  framework: 'react' as const,
  name: 'Button',
  exportName: 'Button',
  sourcePath: 'src/Button.tsx',
  packageName: '@fixture/ui',
  props: component.props,
  source,
};
const binding: ComponentBinding = {
  schemaVersion: 1,
  id: 'binding:button',
  componentRef: 'ds:test/Button',
  framework: 'react',
  status: 'bound',
  codeComponentId: 'fixture/Button',
  verified: true,
  propMappings: [{ designProp: 'variant', codeProp: 'intent', values: { danger: 'destructive' } }],
  source,
};
const override = { schemaVersion: 1 as const, path: ['props', 'label'] as ['props', string], value: 'Production' };
const instance: ComponentInstance = {
  schemaVersion: 1, type: 'instance', id: 'application-card', ref: 'local:application-card', overrides: [override],
};
const textNode = { schemaVersion: 1 as const, type: 'text' as const, id: 'save-label', text: 'Save' };
const componentNode = {
  schemaVersion: 1 as const, type: 'component' as const, id: 'save-button', ref: 'ds:test/Button',
  props: { variant: 'primary' }, slots: { default: [textNode] },
};
const screen = { schemaVersion: 1 as const, type: 'screen' as const, id: 'applications', children: [componentNode, instance] };
const document: UIIRDocument = { schemaVersion: 1, id: 'product', screens: [screen] };
const diagnostic = {
  schemaVersion: 1 as const, code: 'ODDS1003' as const, severity: 'error' as const,
  message: "Button variant 'filled' does not exist.", nodeId: 'save-button', componentRef: 'ds:test/Button',
  path: ['props', 'variant'], allowedValues: ['primary', 'secondary', 'danger'], suggestedFix: { variant: 'primary' },
};

describe('structured design runtime wire contracts', () => {
  const persistedCases = [
    { name: 'component', schema: ComponentDefinitionSchema, value: component },
    { name: 'registry', schema: ComponentRegistrySchema, value: registry },
    { name: 'code component', schema: CodeComponentDefinitionSchema, value: codeComponent },
    { name: 'binding', schema: ComponentBindingSchema, value: binding },
    { name: 'override', schema: ComponentOverrideSchema, value: override },
    { name: 'instance', schema: ComponentInstanceSchema, value: instance },
    { name: 'text node', schema: UIIRNodeSchema, value: textNode },
    { name: 'component node', schema: UIIRNodeSchema, value: componentNode },
    { name: 'screen', schema: UIIRScreenSchema, value: screen },
    { name: 'document', schema: UIIRDocumentSchema, value: document },
    { name: 'diagnostic', schema: ValidationDiagnosticSchema, value: diagnostic },
  ];

  it.each(persistedCases)('round-trips the versioned $name without losing information', ({ schema, value }) => {
    const parsed = schema.parse(value);
    expect(parsed).toEqual(value);
    expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(value);
  });

  it.each(persistedCases)('rejects missing/future versions and unknown fields in $name', ({ schema, value }) => {
    const { schemaVersion: _, ...unversioned } = value;
    expect(schema.safeParse(unversioned).success).toBe(false);
    expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...value, unsupported: true }).success).toBe(false);
  });

  it('preserves identity and binding when the display name changes', () => {
    const renamed = ComponentRegistrySchema.parse({ ...registry, components: [{ ...component, name: 'ActionButton' }] });
    expect(renamed.components[0]?.id).toBe('Button');
    expect(ComponentBindingSchema.parse(binding).componentRef).toBe(`ds:${renamed.id}/${renamed.components[0]?.id}`);
  });

  it('rejects colliding component identities instead of merging them by display name', () => {
    expect(ComponentRegistrySchema.safeParse({ ...registry, components: [component, { ...component, name: 'Other' }] }).success).toBe(false);
    expect(ComponentRegistrySchema.safeParse({ ...registry, components: [component, { ...component, id: 'another-button' }] }).success).toBe(true);
  });

  it.each(['Button', 'ds:Button', 'ds:test@2.0/Button', 'ds:test/Button@2.0', 'ds:test/../Button', 'local:', 'local:card/path'])('rejects ambiguous/version-bearing reference %s', (ref) => {
    expect(ComponentReferenceSchema.safeParse(ref).success).toBe(false);
  });

  it('accepts stable local and design-system references independent of display names', () => {
    expect(ComponentReferenceSchema.parse('ds:acme/cmp_123')).toBe('ds:acme/cmp_123');
    expect(ComponentReferenceSchema.parse('local:cmp_123')).toBe('local:cmp_123');
  });
});

describe('property, source and binding schemas', () => {
  it.each([
    { type: 'enum', required: false, values: [] },
    { type: 'enum', required: false, values: ['primary', 'primary'] },
    { type: 'enum', required: false, values: ['primary'], default: 'filled' },
    { type: 'boolean', required: false, default: 'false' },
    { type: 'number', required: false, default: Infinity },
    { type: 'string', required: false, default: 1 },
    { type: 'any', required: false },
    { type: 'boolean' },
  ])('rejects an invalid prop definition %#', (prop) => {
    expect(ComponentPropDefinitionSchema.safeParse(prop).success).toBe(false);
  });

  it('retains the type of scalar enum values and null defaults through serialization', () => {
    const prop = { type: 'enum', required: false, values: [null, true, 'true', 1, '1'], default: null };
    expect(ComponentPropDefinitionSchema.parse(JSON.parse(JSON.stringify(prop)))).toEqual(prop);
  });

  it('requires explicit slot cardinality and fully qualified allowed component identities', () => {
    expect(ComponentSlotDefinitionSchema.parse(component.slots?.default)).toEqual(component.slots?.default);
    expect(ComponentSlotDefinitionSchema.safeParse({ accepts: ['Button'], required: false, multiple: true }).success).toBe(false);
    expect(ComponentSlotDefinitionSchema.safeParse({ accepts: ['text'] }).success).toBe(false);
  });

  it.each(['/abs/Button.tsx', '../Button.tsx', 'src/../Button.tsx', 'src\\Button.tsx', 'C:/Button.tsx', 'src//Button.tsx', './Button.tsx'])('rejects non-relative or non-normalized provenance %s', (sourcePath) => {
    expect(SourceProvenanceSchema.safeParse({ ...source, sourcePath }).success).toBe(false);
    expect(CodeComponentDefinitionSchema.safeParse({ ...codeComponent, sourcePath }).success).toBe(false);
  });

  it('rejects invalid confidence or source positions', () => {
    expect(SourceProvenanceSchema.safeParse({ ...source, confidence: 1.1 }).success).toBe(false);
    expect(SourceProvenanceSchema.safeParse({ ...source, line: 0 }).success).toBe(false);
  });

  it.each(['candidate', 'stale', 'broken'] as const)('round-trips %s binding state without claiming verification', (status) => {
    const value = { ...binding, status, verified: false };
    expect(ComponentBindingSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(ComponentBindingSchema.safeParse({ ...value, verified: true }).success).toBe(false);
  });

  it('requires a target for bound bindings and no target for unbound bindings', () => {
    const { codeComponentId: _, ...withoutTarget } = binding;
    expect(ComponentBindingSchema.safeParse(withoutTarget).success).toBe(false);
    const unbound = { ...withoutTarget, status: 'unbound', verified: false };
    expect(ComponentBindingSchema.parse(JSON.parse(JSON.stringify(unbound)))).toEqual(unbound);
    expect(ComponentBindingSchema.safeParse({ ...unbound, codeComponentId: 'fixture/Button' }).success).toBe(false);
    expect(ComponentBindingSchema.safeParse({ ...binding, verified: false }).success).toBe(false);
  });

  it('round-trips explicit semantic prop/value mappings and rejects ambiguous destinations', () => {
    const mapping = binding.propMappings?.[0];
    expect(ComponentPropMappingSchema.parse(mapping)).toEqual(mapping);
    expect(ComponentBindingSchema.safeParse({ ...binding, propMappings: [mapping, { designProp: 'tone', codeProp: 'intent' }] }).success).toBe(false);
    expect(ComponentBindingSchema.safeParse({ ...binding, propMappings: [mapping, mapping] }).success).toBe(false);
  });
});

describe('semantic IR and diagnostic boundaries', () => {
  it('stores only explicit instance overrides; reset is represented by removing an override', () => {
    expect(ComponentInstanceSchema.parse({ ...instance, overrides: [] }).overrides).toEqual([]);
    expect(ComponentInstanceSchema.safeParse({ ...instance, props: { label: 'inherited copy' } }).success).toBe(false);
    expect(ComponentInstanceSchema.safeParse({ ...instance, children: [textNode] }).success).toBe(false);
    expect(ComponentInstanceSchema.safeParse({ ...instance, overrides: [override, override] }).success).toBe(false);
  });

  it('rejects unsupported nested overrides and graphical node fields', () => {
    expect(ComponentOverrideSchema.safeParse({ ...override, path: ['props', 'label', 'color'] }).success).toBe(false);
    expect(ComponentOverrideSchema.safeParse({ ...override, path: ['slots', 'footer'] }).success).toBe(false);
    expect(UIIRNodeSchema.safeParse({ ...componentNode, x: 10, y: 20 }).success).toBe(false);
  });

  it('detects duplicate node identities across screens and deep slot hierarchies', () => {
    const repeated = { ...screen, id: 'dashboard' };
    const parsed = UIIRDocumentSchema.safeParse({ ...document, screens: [screen, repeated] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['screens', 1, 'children', 0, 'slots', 'default', 0, 'id'] }),
      ]));
    }
  });

  it('allows structurally valid unresolved references for the runtime to diagnose', () => {
    expect(UIIRNodeSchema.parse({ ...componentNode, ref: 'ds:test/not-yet-defined' }).type).toBe('component');
  });

  it('round-trips nested JSON values, rejecting non-JSON values', () => {
    const value = { data: [null, true, 1, 'text', { status: 'healthy' }] };
    expect(JsonValueSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    for (const invalid of [undefined, NaN, Infinity, 1n, () => {}, { missing: undefined }, new Date()]) {
      expect(JsonValueSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('preserves diagnostic repair values, locations, and stable codes', () => {
    expect(ValidationDiagnosticSchema.parse(diagnostic)).toEqual(diagnostic);
    expect(ValidationDiagnosticSchema.safeParse({ ...diagnostic, code: 'ODDS9999' }).success).toBe(false);
    expect(ValidationDiagnosticSchema.safeParse({ ...diagnostic, severity: 'fatal' }).success).toBe(false);
  });

  it('rejects JSON keys that cannot be preserved, including nested values and mapping keys', () => {
    const value = JSON.parse('{"__proto__":{"safe":true},"normal":1}');
    expect(JsonValueSchema.safeParse(value).success).toBe(false);
    expect(JsonValueSchema.safeParse({ nested: [value] }).success).toBe(false);
    expect(ComponentOverrideSchema.safeParse({ ...override, value }).success).toBe(false);
    expect(UIIRNodeSchema.safeParse({ ...componentNode, props: { data: value } }).success).toBe(false);
    expect(ValidationDiagnosticSchema.safeParse({ ...diagnostic, suggestedFix: value }).success).toBe(false);
    expect(ComponentPropMappingSchema.safeParse({
      designProp: 'variant', codeProp: 'intent', values: JSON.parse('{"__proto__":"primary"}'),
    }).success).toBe(false);
  });
});
