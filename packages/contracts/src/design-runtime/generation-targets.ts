import { z } from 'zod';
import { DesignRuntimeSchemaVersionSchema } from './common.js';
import { DesignValidationOutputSchema } from './design-validation.js';

/** Authoring declarations. These never limit the daemon's observed source inventory. */
export const DesignGenerationTargetsSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  outputs: z.array(DesignValidationOutputSchema).max(500),
}).strict().superRefine((value, ctx) => {
  const keys = new Set<string>(); const screens = new Set<string>();
  value.outputs.forEach((output, index) => {
    const key = JSON.stringify([output.sourcePath, output.exportName]);
    if (keys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs', index], message: 'Generation output declarations must be unique.' });
    keys.add(key);
    if (output.screenId !== undefined) {
      if (screens.has(output.screenId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs', index, 'screenId'], message: 'A semantic screen must have one generation output.' });
      screens.add(output.screenId);
    }
  });
});
export type DesignGenerationTargets = z.infer<typeof DesignGenerationTargetsSchema>;
export function defaultDesignGenerationTargets(): DesignGenerationTargets { return { schemaVersion: 1, outputs: [] }; }
