import { describe, expect, it } from 'vitest';
import {
  CodeComponentIndexSchema,
  ComponentCompilationSelectionSchema,
  ComponentBindingRegistrySchema,
  CompileComponentRegistryRequestSchema,
  CompileComponentRegistryResultSchema,
  type CompileComponentRegistryResult,
} from '../../src/design-runtime/index.js';

const result: CompileComponentRegistryResult = {
  schemaVersion: 1,
  registry: { schemaVersion: 1, id: 'acme', components: [{ schemaVersion: 1, id: 'button', name: 'Button', props: {} }] },
  codeIndex: {
    schemaVersion: 1, id: 'acme',
    components: [{ schemaVersion: 1, id: 'acme/Button', framework: 'react', name: 'Button', exportName: 'Button', sourcePath: 'src/Button.tsx', props: {} }],
  },
  bindings: [{ schemaVersion: 1, id: 'binding:button', componentRef: 'ds:acme/button', framework: 'react', status: 'bound', verified: true, codeComponentId: 'acme/Button' }],
};
const bindingRegistry = { schemaVersion: 1, id: 'acme', bindings: result.bindings };
const request = {
  designSystemId: 'acme',
  selections: [{ sourceText: 'export function Button() {}', sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'acme/Button', packageName: '@acme/ui' }],
};

describe('code index and binding registry contracts', () => {
  it.each([
    [CodeComponentIndexSchema, result.codeIndex],
    [ComponentBindingRegistrySchema, bindingRegistry],
    [CompileComponentRegistryResultSchema, result],
  ] as const)('round-trips persisted contract %# and rejects missing/future versions', (schema, value) => {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const { schemaVersion: _, ...unversioned } = value;
    expect(schema.safeParse(unversioned).success).toBe(false);
    expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...value, unknown: 1 }).success).toBe(false);
  });

  it('rejects duplicate code identities even when their names or frameworks differ', () => {
    const code = result.codeIndex.components[0]!;
    expect(CodeComponentIndexSchema.safeParse({ ...result.codeIndex, components: [code, { ...code, name: 'Other', framework: 'vue' }] }).success).toBe(false);
    expect(CodeComponentIndexSchema.safeParse({ ...result.codeIndex, components: [code, { ...code, id: 'other/Button' }] }).success).toBe(true);
  });

  it('rejects duplicate binding IDs and multiple bindings for a component/framework', () => {
    const binding = result.bindings[0]!;
    for (const duplicate of [{ ...binding, componentRef: 'ds:acme/other' }, { ...binding, id: 'another-binding' }]) {
      expect(ComponentBindingRegistrySchema.safeParse({ ...bindingRegistry, bindings: [binding, duplicate] }).success).toBe(false);
    }
    expect(ComponentBindingRegistrySchema.safeParse({ ...bindingRegistry, bindings: [binding, { ...binding, id: 'vue-binding', framework: 'vue' }] }).success).toBe(true);
    expect(CompileComponentRegistryResultSchema.safeParse({ ...result, bindings: [...result.bindings, { ...binding, id: 'duplicate' }] }).success).toBe(false);
  });

  it('rejects dangling compiler-result references and framework mismatches', () => {
    const binding = result.bindings[0]!;
    for (const invalid of [{ ...binding, componentRef: 'ds:acme/missing' }, { ...binding, codeComponentId: 'acme/Missing' }, { ...binding, framework: 'vue' }]) {
      expect(CompileComponentRegistryResultSchema.safeParse({ ...result, bindings: [invalid] }).success).toBe(false);
    }
  });

  it('parses unversioned compile requests without accepting unknown fields', () => {
    expect(CompileComponentRegistryRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(ComponentCompilationSelectionSchema.parse(JSON.parse(JSON.stringify(request.selections[0])))).toEqual(request.selections[0]);
    expect(CompileComponentRegistryRequestSchema.safeParse({ ...request, selections: [] }).success).toBe(false);
    expect(CompileComponentRegistryRequestSchema.safeParse({ ...request, schemaVersion: 1 }).success).toBe(false);
  });

  it('rejects duplicate requested identities and repeated source exports', () => {
    const selection = request.selections[0]!;
    for (const duplicate of [
      { ...selection, codeComponentId: 'another/Button', sourcePath: 'src/Other.tsx' },
      { ...selection, componentId: 'another-button', sourcePath: 'src/Other.tsx' },
      { ...selection, componentId: 'another-button', codeComponentId: 'another/Button' },
    ]) {
      expect(CompileComponentRegistryRequestSchema.safeParse({ ...request, selections: [selection, duplicate] }).success).toBe(false);
    }
    expect(CompileComponentRegistryRequestSchema.safeParse({ ...request, selections: [selection, { ...selection, componentId: 'input', codeComponentId: 'acme/Input', exportName: 'Input' }] }).success).toBe(true);
  });
});
