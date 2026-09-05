import { z } from 'zod';
import { CodeIdentitySchema, DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema } from './common.js';
import { DesignSystemDigestSchema, DesignSystemSemVerSchema } from './design-system-identity.js';
import { DesignSystemMigrationRuleSchema, refineDesignSystemMigrationRules } from './migration-rules.js';

/** Package IDs only; a recipe cannot carry project-local bindings or arbitrary replacement code. */
export const DesignSystemPackageBindingDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['revalidate', 'unbind', 'remove']), bindingId: CodeIdentitySchema }).strict(),
  z.object({ type: z.literal('use-target-package'), bindingId: CodeIdentitySchema, targetBindingId: CodeIdentitySchema }).strict(),
]);
export type DesignSystemPackageBindingDecision = z.infer<typeof DesignSystemPackageBindingDecisionSchema>;

/** The immutable containing package supplies target identity/version/digest, avoiding self-reference. */
export const DesignSystemMigrationRecipeSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  name: z.string().min(1),
  from: z.object({ version: DesignSystemSemVerSchema, digest: DesignSystemDigestSchema }).strict(),
  rules: z.array(DesignSystemMigrationRuleSchema),
  packageBindingDecisions: z.array(DesignSystemPackageBindingDecisionSchema),
}).strict().superRefine((recipe, ctx) => {
  refineDesignSystemMigrationRules(recipe.rules, ctx);
  const bindings = new Set<string>();
  recipe.packageBindingDecisions.forEach((decision, index) => {
    if (bindings.has(decision.bindingId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['packageBindingDecisions', index], message: 'Each published binding has one recipe decision.' });
    bindings.add(decision.bindingId);
  });
});
export type DesignSystemMigrationRecipe = z.infer<typeof DesignSystemMigrationRecipeSchema>;
