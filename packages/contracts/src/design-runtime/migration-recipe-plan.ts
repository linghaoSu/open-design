import { z } from 'zod';
import { DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema } from './common.js';
import { DesignSystemVersionRangeSchema } from './design-system-identity.js';
import { DesignSystemMigrationPlanSchema } from './design-system-upgrade.js';
import { DesignSystemPackageBindingDecisionSchema } from './migration-recipes.js';
import { ValidationDiagnosticSchema } from './validation.js';

export const InstantiateDesignSystemMigrationRecipeRequestSchema = z.object({
  recipeId: DesignEntityIdSchema, planId: DesignEntityIdSchema, targetRange: DesignSystemVersionRangeSchema,
}).strict();
export type InstantiateDesignSystemMigrationRecipeRequest = z.infer<typeof InstantiateDesignSystemMigrationRecipeRequestSchema>;
export const DesignSystemMigrationRecipePlanResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, recipeId: DesignEntityIdSchema, plan: DesignSystemMigrationPlanSchema,
  skippedBindingDecisions: z.array(DesignSystemPackageBindingDecisionSchema), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict();
export type DesignSystemMigrationRecipePlanResult = z.infer<typeof DesignSystemMigrationRecipePlanResultSchema>;
