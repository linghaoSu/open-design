import { z } from 'zod';
import { DesignRuntimeSchemaVersionSchema } from './common.js';

export const DesignConstraintSeveritySchema = z.enum(['off', 'warning', 'error']);
export type DesignConstraintSeverity = z.infer<typeof DesignConstraintSeveritySchema>;
export const DesignConstraintPolicySchema = z.object({
  unknownComponents: DesignConstraintSeveritySchema,
  unknownProps: DesignConstraintSeveritySchema,
  invalidVariants: DesignConstraintSeveritySchema,
  invalidSlots: DesignConstraintSeveritySchema,
  tokens: z.object({ undeclared: DesignConstraintSeveritySchema }).strict(),
  rawCss: z.object({ colors: DesignConstraintSeveritySchema, radius: DesignConstraintSeveritySchema, spacing: DesignConstraintSeveritySchema }).strict(),
  interactiveHtml: z.object({ customControlsWhenBoundComponentExists: DesignConstraintSeveritySchema }).strict(),
}).strict();
export type DesignConstraintPolicy = z.infer<typeof DesignConstraintPolicySchema>;

export const DesignConstraintSetSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  explore: DesignConstraintPolicySchema,
  guided: DesignConstraintPolicySchema,
  strict: DesignConstraintPolicySchema,
}).strict().superRefine((policies, ctx) => {
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === 'object' && value !== null) {
      for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key]);
    } else if (value !== 'error') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['strict', ...path], message: 'Strict mode cannot weaken structural constraints.' });
  };
  visit(policies.strict, []);
});
export type DesignConstraintSet = z.infer<typeof DesignConstraintSetSchema>;
