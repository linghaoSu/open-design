import { z } from 'zod';
import {
  CodeIdentitySchema,
  ComponentFrameworkSchema,
  ComponentReferenceSchema,
  DesignMemberNameSchema,
  DesignRuntimeSchemaVersionSchema,
  JsonScalarSchema,
  JsonObjectKeySchema,
  SourcePathSchema,
  SourceProvenanceSchema,
} from './common.js';
import { ComponentPropsSchema } from './component-registry.js';

export const CodeComponentDefinitionSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: CodeIdentitySchema,
  framework: ComponentFrameworkSchema,
  name: z.string().min(1),
  exportName: z.string().min(1),
  sourcePath: SourcePathSchema,
  packageName: z.string().min(1).optional(),
  props: ComponentPropsSchema,
  source: SourceProvenanceSchema.optional(),
}).strict();
export type CodeComponentDefinition = z.infer<typeof CodeComponentDefinitionSchema>;

export const ComponentPropMappingSchema = z.object({
  designProp: DesignMemberNameSchema,
  codeProp: DesignMemberNameSchema,
  /** Keys encode scalar design values using String(value); ambiguous domains need a future schema. */
  values: z.record(JsonObjectKeySchema, JsonScalarSchema).optional(),
}).strict();
export type ComponentPropMapping = z.infer<typeof ComponentPropMappingSchema>;

const bindingFields = {
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: CodeIdentitySchema,
  componentRef: ComponentReferenceSchema,
  framework: ComponentFrameworkSchema,
  source: SourceProvenanceSchema.optional(),
  propMappings: z.array(ComponentPropMappingSchema).optional(),
};

/** `verified` means valid against the current code contract, not previously verified. */
export const ComponentBindingSchema = z.discriminatedUnion('status', [
  z.object({ ...bindingFields, status: z.literal('unbound'), verified: z.literal(false) }).strict(),
  z.object({ ...bindingFields, status: z.literal('candidate'), codeComponentId: CodeIdentitySchema, verified: z.literal(false) }).strict(),
  z.object({ ...bindingFields, status: z.literal('bound'), codeComponentId: CodeIdentitySchema, verified: z.literal(true) }).strict(),
  z.object({ ...bindingFields, status: z.literal('stale'), codeComponentId: CodeIdentitySchema, verified: z.literal(false) }).strict(),
  z.object({ ...bindingFields, status: z.literal('broken'), codeComponentId: CodeIdentitySchema, verified: z.literal(false) }).strict(),
]).superRefine((binding, ctx) => {
  const designProps = new Set<string>();
  const codeProps = new Set<string>();
  binding.propMappings?.forEach((mapping, index) => {
    if (designProps.has(mapping.designProp) || codeProps.has(mapping.codeProp)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['propMappings', index], message: 'Prop mappings must be one-to-one.' });
    }
    designProps.add(mapping.designProp);
    codeProps.add(mapping.codeProp);
  });
});
export type ComponentBinding = z.infer<typeof ComponentBindingSchema>;
