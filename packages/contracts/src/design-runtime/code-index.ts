import { z } from 'zod';
import { CodeComponentDefinitionSchema, ComponentBindingSchema } from './component-binding.js';
import { ComponentRegistrySchema } from './component-registry.js';
import { ComponentStorySelectionSchema } from './component-stories.js';
import {
  CodeIdentitySchema,
  ComponentFrameworkSchema,
  DesignEntityIdSchema,
  DesignRuntimeSchemaVersionSchema,
  SourcePathSchema,
} from './common.js';

export const CodeComponentIndexSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  components: z.array(CodeComponentDefinitionSchema),
}).strict().superRefine((index, ctx) => {
  const ids = new Set<string>();
  index.components.forEach((component, position) => {
    if (ids.has(component.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', position, 'id'], message: 'Duplicate code component ID.' });
    }
    ids.add(component.id);
  });
});
export type CodeComponentIndex = z.infer<typeof CodeComponentIndexSchema>;

const bindingsSchema = z.array(ComponentBindingSchema).superRefine((bindings, ctx) => {
  const ids = new Set<string>();
  const targets = new Set<string>();
  bindings.forEach((binding, position) => {
    if (ids.has(binding.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [position, 'id'], message: 'Duplicate binding ID.' });
    }
    const target = `${binding.componentRef}\u0000${binding.framework}`;
    if (targets.has(target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [position, 'componentRef'], message: 'Only one binding per component and framework is allowed.' });
    }
    ids.add(binding.id);
    targets.add(target);
  });
});

export const ComponentBindingRegistrySchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  bindings: bindingsSchema,
}).strict();
export type ComponentBindingRegistry = z.infer<typeof ComponentBindingRegistrySchema>;

export const ComponentStorySourceSelectionSchema = z.object({
  sourceText: z.string(),
  sourcePath: SourcePathSchema,
  selections: z.array(ComponentStorySelectionSchema).min(1),
}).strict();
export type ComponentStorySourceSelection = z.infer<typeof ComponentStorySourceSelectionSchema>;

export const ComponentCompilationSelectionSchema = z.object({
  sourceText: z.string(),
  sourcePath: SourcePathSchema,
  exportName: z.string().min(1),
  componentId: DesignEntityIdSchema,
  codeComponentId: CodeIdentitySchema,
  packageName: z.string().min(1).optional(),
  /** Omission preserves the original React compilation request contract. */
  framework: ComponentFrameworkSchema.optional(),
  metadataExportName: z.string().min(1).optional(),
  storySources: z.array(ComponentStorySourceSelectionSchema).min(1).optional(),
}).strict();
export type ComponentCompilationSelection = z.infer<typeof ComponentCompilationSelectionSchema>;

export const CompileComponentRegistryRequestSchema = z.object({
  designSystemId: DesignEntityIdSchema,
  selections: z.array(ComponentCompilationSelectionSchema).min(1),
}).strict().superRefine((request, ctx) => {
  const designIds = new Set<string>();
  const codeIds = new Set<string>();
  const exports = new Set<string>();
  request.selections.forEach((selection, position) => {
    const storyIds = new Set<string>();
    const storyPaths = new Set<string>();
    for (const [sourceIndex, source] of (selection.storySources ?? []).entries()) {
      const path = ['selections', position, 'storySources', sourceIndex];
      if (storyPaths.has(source.sourcePath)) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Group story selections from the same source path together.' });
      storyPaths.add(source.sourcePath);
      const storyExports = new Set<string>();
      source.selections.forEach((story, storyIndex) => {
        if (storyIds.has(story.id) || storyExports.has(story.exportName)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'selections', storyIndex], message: 'Story IDs and selected source exports must be unique within a component.' });
        storyIds.add(story.id); storyExports.add(story.exportName);
      });
    }
    for (const [field, value, seen] of [
      ['componentId', selection.componentId, designIds],
      ['codeComponentId', selection.codeComponentId, codeIds],
      ['exportName', `${selection.sourcePath}\u0000${selection.exportName}`, exports],
    ] as const) {
      if (seen.has(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selections', position, field], message: `Duplicate component selection ${field}.` });
      }
      seen.add(value);
    }
  });
});
export type CompileComponentRegistryRequest = z.infer<typeof CompileComponentRegistryRequestSchema>;

export const CompileComponentRegistryResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  registry: ComponentRegistrySchema,
  codeIndex: CodeComponentIndexSchema,
  bindings: bindingsSchema,
}).strict().superRefine((result, ctx) => {
  const designRefs = new Set(result.registry.components.map((component) => `ds:${result.registry.id}/${component.id}`));
  const codeComponents = new Map(result.codeIndex.components.map((component) => [component.id, component]));
  result.bindings.forEach((binding, position) => {
    if (!designRefs.has(binding.componentRef)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', position, 'componentRef'], message: 'Binding design component is absent from the compiled registry.' });
    }
    if (binding.status !== 'unbound') {
      const code = codeComponents.get(binding.codeComponentId);
      if (!code || code.framework !== binding.framework) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', position, 'codeComponentId'], message: 'Binding code component is absent or has a different framework.' });
      }
    }
  });
});
export type CompileComponentRegistryResult = z.infer<typeof CompileComponentRegistryResultSchema>;
