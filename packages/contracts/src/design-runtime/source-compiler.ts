import { z } from 'zod';
import { CodeComponentDefinitionSchema, ComponentBindingSchema, type ComponentBinding } from './component-binding.js';
import { ComponentRegistrySchema } from './component-registry.js';
import { ComponentStorySelectionSchema } from './component-stories.js';
import { CodeIdentitySchema, ComponentFrameworkSchema, DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema } from './common.js';

/** Supplied source only. Filesystem/module resolution remains the caller's responsibility. */
export const ExtractSourceCodeComponentRequestSchema = z.object({
  framework: ComponentFrameworkSchema,
  sourceText: z.string(),
  sourcePath: SourcePathSchema,
  /** React selects a proved local named/default export; Vue script-setup SFC selects "default" explicitly. */
  exportName: z.string().min(1),
  codeComponentId: CodeIdentitySchema,
  packageName: z.string().min(1).optional(),
}).strict();
export type ExtractSourceCodeComponentRequest = z.infer<typeof ExtractSourceCodeComponentRequestSchema>;

export const CompileSourceComponentRequestSchema = ExtractSourceCodeComponentRequestSchema.extend({
  designSystemId: DesignEntityIdSchema,
  componentId: DesignEntityIdSchema,
  /** Explicit same-file metadata export; never guessed from a component display name.
   * Vue places it in normal <script lang="ts"> with component: "default";
   * React metadata identifies the selected component with its direct identifier.
   */
  metadataExportName: z.string().min(1).optional(),
}).strict();
export type CompileSourceComponentRequest = z.infer<typeof CompileSourceComponentRequestSchema>;

export const CompileSourceComponentResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  registry: ComponentRegistrySchema,
  codeComponent: CodeComponentDefinitionSchema,
  binding: ComponentBindingSchema.refine((binding): binding is Extract<ComponentBinding, { status: 'bound' }> => binding.status === 'bound', 'Compiled design components require an explicit bound relationship.'),
}).strict().superRefine((result, ctx) => {
  const component = result.registry.components[0];
  if (result.registry.components.length !== 1 || !component || result.binding.componentRef !== `ds:${result.registry.id}/${component.id}`
    || result.binding.codeComponentId !== result.codeComponent.id || result.binding.framework !== result.codeComponent.framework) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['binding'], message: 'Compiled component, code identity, and binding must agree.' });
  }
});
export type CompileSourceComponentResult = z.infer<typeof CompileSourceComponentResultSchema>;

export const CompileStorybookMetadataRequestSchema = z.object({
  sourceText: z.string(),
  sourcePath: SourcePathSchema,
  compiled: CompileSourceComponentResultSchema,
  selections: z.array(ComponentStorySelectionSchema).min(1),
}).strict().superRefine((input, ctx) => {
  const ids = new Set<string>();
  const exports = new Set<string>();
  input.selections.forEach((selection, index) => {
    if (ids.has(selection.id) || exports.has(selection.exportName)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selections', index], message: 'Story IDs and selected exports must be unique.' });
    ids.add(selection.id); exports.add(selection.exportName);
  });
});
export type CompileStorybookMetadataRequest = z.infer<typeof CompileStorybookMetadataRequestSchema>;
