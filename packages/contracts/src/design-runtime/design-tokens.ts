import { z } from 'zod';
import { DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourceProvenanceSchema } from './common.js';

export const DesignTokenReferenceSchema = z.string().regex(/^token:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
export type DesignTokenReference = z.infer<typeof DesignTokenReferenceSchema>;
const fields = {
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  name: z.string().min(1),
  cssVariable: z.string().regex(/^--[A-Za-z][A-Za-z0-9_-]*$/),
  source: SourceProvenanceSchema.optional(),
};
const dimension = { value: z.number().finite().nonnegative(), unit: z.enum(['px', 'rem', 'em', '%']) };

/** Explicit scalar CSS values only; aliases and arbitrary CSS expressions require a later schema. */
export const DesignTokenSchema = z.discriminatedUnion('type', [
  z.object({ ...fields, type: z.literal('color'), value: z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/) }).strict(),
  z.object({ ...fields, type: z.literal('spacing'), ...dimension }).strict(),
  z.object({ ...fields, type: z.literal('radius'), ...dimension }).strict(),
  z.object({ ...fields, type: z.literal('font-size'), ...dimension }).strict(),
  z.object({ ...fields, type: z.literal('font-family'), value: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ ...fields, type: z.literal('font-weight'), value: z.number().int().min(1).max(1000) }).strict(),
  z.object({ ...fields, type: z.literal('duration'), value: z.number().finite().nonnegative(), unit: z.enum(['ms', 's']) }).strict(),
]);
export type DesignToken = z.infer<typeof DesignTokenSchema>;

export const DesignTokenRegistrySchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  tokens: z.array(DesignTokenSchema),
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  const variables = new Set<string>();
  registry.tokens.forEach((token, index) => {
    if (ids.has(token.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokens', index, 'id'], message: 'Token IDs must be unique.' });
    if (variables.has(token.cssVariable)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokens', index, 'cssVariable'], message: 'Token CSS variables must be unique.' });
    ids.add(token.id);
    variables.add(token.cssVariable);
  });
});
export type DesignTokenRegistry = z.infer<typeof DesignTokenRegistrySchema>;
