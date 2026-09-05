import { z } from 'zod';
import { DesignEntityIdSchema, DesignMemberNameSchema, JsonScalarSchema, SourceProvenanceSchema } from './common.js';

export const ComponentStorySelectionSchema = z.object({ id: DesignEntityIdSchema, exportName: z.string().min(1) }).strict();
export type ComponentStorySelection = z.infer<typeof ComponentStorySelectionSchema>;

/** Storybook control annotations describe examples, not the production prop API. */
export const ComponentStoryArgTypeSchema = z.object({
  description: z.string().optional(),
  options: z.array(JsonScalarSchema).min(1).optional(),
  control: z.union([z.string().min(1), z.literal(false)]).optional(),
  source: SourceProvenanceSchema,
}).strict();
export type ComponentStoryArgType = z.infer<typeof ComponentStoryArgTypeSchema>;

/** Args use production code member names and never replace runtime prop defaults. */
export const ComponentStoryDefinitionSchema = z.object({
  id: DesignEntityIdSchema,
  name: z.string().min(1),
  exportName: z.string().min(1),
  title: z.string().optional(),
  args: z.record(DesignMemberNameSchema, JsonScalarSchema),
  argTypes: z.record(DesignMemberNameSchema, ComponentStoryArgTypeSchema),
  tags: z.array(z.string().min(1)).optional(),
  source: SourceProvenanceSchema,
}).strict();
export type ComponentStoryDefinition = z.infer<typeof ComponentStoryDefinitionSchema>;
