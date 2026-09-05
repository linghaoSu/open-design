import { z } from 'zod';
import { ComponentStoryDefinitionSchema } from './component-stories.js';
import {
  ComponentReferenceSchema,
  DesignEntityIdSchema,
  DesignMemberNameSchema,
  DesignRuntimeSchemaVersionSchema,
  JsonScalarSchema,
  SourceProvenanceSchema,
} from './common.js';

const propFields = {
  required: z.boolean(),
  source: SourceProvenanceSchema.optional(),
};

/** V1 deliberately models only JSON scalar props; unsupported APIs are not `any`. */
export const ComponentPropDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ ...propFields, type: z.literal('string'), default: z.string().optional() }).strict(),
  z.object({ ...propFields, type: z.literal('number'), default: z.number().finite().optional() }).strict(),
  z.object({ ...propFields, type: z.literal('boolean'), default: z.boolean().optional() }).strict(),
  z.object({
    ...propFields,
    type: z.literal('enum'),
    values: z.array(JsonScalarSchema).min(1),
    default: JsonScalarSchema.optional(),
  }).strict(),
]).superRefine((prop, ctx) => {
  if (prop.type !== 'enum') return;
  if (new Set(prop.values).size !== prop.values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['values'], message: 'Enum values must be unique.' });
  }
  if (prop.default !== undefined && !prop.values.includes(prop.default)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['default'], message: 'Default must be an allowed enum value.' });
  }
});
export type ComponentPropDefinition = z.infer<typeof ComponentPropDefinitionSchema>;
export const ComponentPropsSchema = z.record(DesignMemberNameSchema, ComponentPropDefinitionSchema);

export const ComponentSlotDefinitionSchema = z.object({
  accepts: z.array(z.union([z.literal('text'), ComponentReferenceSchema])).min(1),
  required: z.boolean(),
  multiple: z.boolean(),
  source: SourceProvenanceSchema.optional(),
}).strict();
export type ComponentSlotDefinition = z.infer<typeof ComponentSlotDefinitionSchema>;

export const ComponentDefinitionSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  name: z.string().min(1),
  props: ComponentPropsSchema,
  slots: z.record(DesignMemberNameSchema, ComponentSlotDefinitionSchema).optional(),
  states: z.array(DesignMemberNameSchema).optional(),
  source: SourceProvenanceSchema.optional(),
  stories: z.array(ComponentStoryDefinitionSchema).superRefine((stories, ctx) => {
    const ids = new Set<string>();
    stories.forEach((story, index) => {
      if (ids.has(story.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Story identities must be unique within a component.' });
      ids.add(story.id);
    });
  }).optional(),
}).strict();
export type ComponentDefinition = z.infer<typeof ComponentDefinitionSchema>;

/** Registry id supplies the design-system namespace; component IDs survive renames. */
export const ComponentRegistrySchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  components: z.array(ComponentDefinitionSchema),
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  registry.components.forEach((component, index) => {
    if (ids.has(component.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', index, 'id'], message: 'Duplicate component ID.' });
    }
    ids.add(component.id);
  });
});
export type ComponentRegistry = z.infer<typeof ComponentRegistrySchema>;
