import { describe, expect, it } from 'vitest';
import { CodeComponentDefinitionSchema, ComponentBindingSchema, ComponentRegistrySchema, CompileStorybookMetadataRequestSchema, ExtractSourceCodeComponentRequestSchema } from '../../src/design-runtime/index.js';

describe('source compiler contracts', () => {
  it('rejects code slot/prop overlap and capability from a different framework', () => {
    const code = { schemaVersion: 1, id: 'code/card', framework: 'react', name: 'Card', exportName: 'Card', sourcePath: 'src/Card.tsx', props: {}, slots: { children: { kind: 'react-node', required: true, multiple: true } } };
    expect(CodeComponentDefinitionSchema.safeParse(code).success).toBe(true);
    expect(CodeComponentDefinitionSchema.safeParse({ ...code, framework: 'vue' }).success).toBe(false);
    expect(CodeComponentDefinitionSchema.safeParse({ ...code, props: { children: { type: 'string', required: true } } }).success).toBe(false);
  });
  it('rejects repeated design or code slot targets', () => {
    const binding = { schemaVersion: 1, id: 'binding', componentRef: 'ds:test/card', codeComponentId: 'code/card', framework: 'react', status: 'bound', verified: true };
    for (const second of [{ designSlot: 'body', codeSlot: 'header' }, { designSlot: 'footer', codeSlot: 'children' }]) {
      expect(ComponentBindingSchema.safeParse({ ...binding, slotMappings: [{ designSlot: 'body', codeSlot: 'children' }, second] }).success).toBe(false);
    }
  });
  it('does not mix stable story selection identity with export names or runtime defaults', () => {
    const component = { schemaVersion: 1, id: 'button', name: 'Button', props: { variant: { type: 'enum', required: false, values: ['primary', 'secondary'], default: 'primary' } } };
    const compiled = { schemaVersion: 1, registry: { schemaVersion: 1, id: 'test', components: [component] },
      codeComponent: { ...component, id: 'code/button', framework: 'react', exportName: 'Button', sourcePath: 'src/Button.tsx' },
      binding: { schemaVersion: 1, id: 'binding', componentRef: 'ds:test/button', codeComponentId: 'code/button', framework: 'react', status: 'bound', verified: true } };
    const request = { sourceText: '', sourcePath: 'src/Button.stories.tsx', compiled, selections: [{ id: 'stable-story', exportName: 'Primary' }] };
    expect(CompileStorybookMetadataRequestSchema.safeParse(request).success).toBe(true);
    expect(CompileStorybookMetadataRequestSchema.safeParse({ ...request, selections: [...request.selections, { id: 'stable-story', exportName: 'Renamed' }] }).success).toBe(false);
    const story = { id: 'stable-story', name: 'Example', exportName: 'Primary', args: { variant: 'secondary' }, argTypes: {}, source: { kind: 'storybook', sourcePath: request.sourcePath } };
    const registry = ComponentRegistrySchema.parse({ ...compiled.registry, components: [{ ...component, stories: [story] }] });
    expect(registry.components[0]!.props.variant!.default).toBe('primary');
    expect(ComponentRegistrySchema.safeParse({ ...registry, components: [{ ...component, stories: [story, story] }] }).success).toBe(false);
  });
  it('requires explicit framework and stable source identity for extraction', () => {
    expect(ExtractSourceCodeComponentRequestSchema.safeParse({ framework: 'react', sourceText: '', sourcePath: 'src/Card.tsx', exportName: 'Card', codeComponentId: 'code/card' }).success).toBe(true);
    expect(ExtractSourceCodeComponentRequestSchema.safeParse({ sourceText: '', sourcePath: '../Card.tsx', exportName: 'Card' }).success).toBe(false);
  });
});
