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

/** Source-proven capability, independent from the design system's allowed child references. */
export const CodeComponentSlotDefinitionSchema = z.object({
  kind: z.enum(['react-node', 'vue-slot']),
  required: z.boolean(),
  multiple: z.boolean(),
  source: SourceProvenanceSchema.optional(),
}).strict();
export type CodeComponentSlotDefinition = z.infer<typeof CodeComponentSlotDefinitionSchema>;

export const CodeComponentDefinitionSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: CodeIdentitySchema,
  framework: ComponentFrameworkSchema,
  name: z.string().min(1),
  exportName: z.string().min(1),
  sourcePath: SourcePathSchema,
  packageName: z.string().min(1).optional(),
  props: ComponentPropsSchema,
  slots: z.record(DesignMemberNameSchema, CodeComponentSlotDefinitionSchema).optional(),
  source: SourceProvenanceSchema.optional(),
}).strict().superRefine((component, ctx) => {
  Object.entries(component.slots ?? {}).forEach(([name, slot]) => {
    if (Object.hasOwn(component.props, name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots', name], message: 'Code props and slots cannot share a member name.' });
    if (slot.kind !== (component.framework === 'react' ? 'react-node' : 'vue-slot')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slots', name, 'kind'], message: 'Code slot capability must match its framework.' });
  });
});
export type CodeComponentDefinition = z.infer<typeof CodeComponentDefinitionSchema>;

export const ComponentPropMappingSchema = z.object({
  designProp: DesignMemberNameSchema,
  codeProp: DesignMemberNameSchema,
  /** Keys encode scalar design values using String(value); ambiguous domains need a future schema. */
  values: z.record(JsonObjectKeySchema, JsonScalarSchema).optional(),
}).strict();
export type ComponentPropMapping = z.infer<typeof ComponentPropMappingSchema>;

export const ComponentSlotMappingSchema = z.object({
  designSlot: DesignMemberNameSchema,
  codeSlot: DesignMemberNameSchema,
  source: SourceProvenanceSchema.optional(),
}).strict();
export type ComponentSlotMapping = z.infer<typeof ComponentSlotMappingSchema>;

const bindingFields = {
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: CodeIdentitySchema,
  componentRef: ComponentReferenceSchema,
  framework: ComponentFrameworkSchema,
  source: SourceProvenanceSchema.optional(),
  propMappings: z.array(ComponentPropMappingSchema).optional(),
  slotMappings: z.array(ComponentSlotMappingSchema).optional(),
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
  const designSlots = new Set<string>();
  const codeSlots = new Set<string>();
  binding.slotMappings?.forEach((mapping, index) => {
    if (designSlots.has(mapping.designSlot) || codeSlots.has(mapping.codeSlot)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['slotMappings', index], message: 'Slot mappings must be one-to-one.' });
    designSlots.add(mapping.designSlot); codeSlots.add(mapping.codeSlot);
  });
});
export type ComponentBinding = z.infer<typeof ComponentBindingSchema>;
