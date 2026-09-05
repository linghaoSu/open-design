import { z } from 'zod';
import { CodeIdentitySchema, ComponentReferenceSchema, DesignEntityIdSchema, DesignMemberNameSchema, DesignRuntimeSchemaVersionSchema, JsonScalarSchema, SourcePathSchema } from './common.js';
import { ComponentBindingSchema } from './component-binding.js';
import { ComponentBindingRegistrySchema, CodeComponentIndexSchema } from './code-index.js';
import { DesignSystemDigestSchema, DesignSystemLockedDependencySchema, DesignSystemVersionRangeSchema, ProjectDesignSystemDependenciesSchema, ProjectDesignSystemLockSchema } from './design-system-version.js';
import { DesignSystemSemanticDiffSchema } from './design-system-diff.js';
import { ComponentReferenceOwnerSchema, ComponentReferenceScreenOwnerSchema, ProjectComponentRegistrySchema, ReferenceUsageSchema, ResolvedUIIRResultSchema } from './project-components.js';
import { SharedComponentChangeStateSchema } from './shared-component-changes.js';
import { UIIRDocumentSchema } from './ui-ir.js';
import { ValidationDiagnosticSchema } from './validation.js';

import { DesignSystemMigrationRuleSchema, refineDesignSystemMigrationRules } from './migration-rules.js';
export { DesignSystemMigrationRuleSchema, type DesignSystemMigrationRule } from './migration-rules.js';

export const DesignSystemUpgradeBindingDecisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['revalidate', 'unbind', 'remove']), bindingId: CodeIdentitySchema }).strict(),
  z.object({ type: z.literal('use-target-package'), bindingId: CodeIdentitySchema, targetBindingId: CodeIdentitySchema }).strict(),
  z.object({ type: z.literal('set-binding'), bindingId: CodeIdentitySchema, binding: ComponentBindingSchema }).strict(),
]);
export type DesignSystemUpgradeBindingDecision = z.infer<typeof DesignSystemUpgradeBindingDecisionSchema>;

/** Rules are simultaneous, identified by their old target; partial maps retain unmatched scalars. Keys are typed values, never stringified. */
export const DesignSystemMigrationPlanSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, id: DesignEntityIdSchema,
  from: DesignSystemLockedDependencySchema, to: DesignSystemLockedDependencySchema,
  targetRange: DesignSystemVersionRangeSchema,
  rules: z.array(DesignSystemMigrationRuleSchema), bindingDecisions: z.array(DesignSystemUpgradeBindingDecisionSchema),
}).strict().superRefine((plan, ctx) => {
  if (plan.from.designSystemId !== plan.to.designSystemId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'Upgrade retains the design-system identity.' });
  refineDesignSystemMigrationRules(plan.rules, ctx, plan.from.designSystemId);
  const bindings = new Set<string>();
  plan.bindingDecisions.forEach((decision, index) => {
    if (bindings.has(decision.bindingId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindingDecisions', index], message: 'Each binding has one explicit decision.' });
    bindings.add(decision.bindingId);
    if (decision.type === 'set-binding' && decision.binding.id !== decision.bindingId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindingDecisions', index, 'binding', 'id'], message: 'The binding must retain its selected stable identity.' });
  });
});
export type DesignSystemMigrationPlan = z.infer<typeof DesignSystemMigrationPlanSchema>;

export const DesignSystemUpgradeContextSchema = z.object({
  projectId: DesignEntityIdSchema, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dependencies: ProjectDesignSystemDependenciesSchema, lock: ProjectDesignSystemLockSchema,
  projectComponents: ProjectComponentRegistrySchema, document: UIIRDocumentSchema.nullable(),
  codeIndex: CodeComponentIndexSchema, bindings: ComponentBindingRegistrySchema, sharedChanges: SharedComponentChangeStateSchema,
}).strict().superRefine((context, ctx) => {
  for (const field of ['dependencies', 'lock', 'projectComponents', 'codeIndex', 'bindings', 'sharedChanges'] as const) if (context[field].id !== context.projectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field, 'id'], message: 'Upgrade state must belong to one project.' });
  if (context.lock.dependencies.length !== 1 || context.dependencies.dependencies.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lock'], message: 'A reviewed upgrade requires one active design system.' });
});
export type DesignSystemUpgradeContext = z.infer<typeof DesignSystemUpgradeContextSchema>;

export const DesignSystemUpgradeReviewSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, id: DesignEntityIdSchema, projectId: DesignEntityIdSchema,
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), baseDigest: DesignSystemDigestSchema, planDigest: DesignSystemDigestSchema,
  plan: DesignSystemMigrationPlanSchema, diff: DesignSystemSemanticDiffSchema,
  current: ResolvedUIIRResultSchema, proposed: ResolvedUIIRResultSchema,
  affectedUsages: z.array(ReferenceUsageSchema), affectedScreens: z.array(ComponentReferenceScreenOwnerSchema),
  invalidOverrides: z.array(z.object({ owner: ComponentReferenceOwnerSchema, nodeId: DesignEntityIdSchema, property: DesignMemberNameSchema, diagnostics: z.array(ValidationDiagnosticSchema).min(1) }).strict()),
  codeImpact: z.object({ bindings: z.array(ComponentBindingSchema), sourceFiles: z.array(SourcePathSchema), coverage: z.literal('registered-bindings') }).strict(),
  bindingTransitions: z.array(z.object({ bindingId: CodeIdentitySchema, before: ComponentBindingSchema.nullable(), after: ComponentBindingSchema.nullable() }).strict()),
  tokenUsageCoverage: z.literal('not-indexed'), sourceUsageCoverage: z.literal('conservative-design-system-screens'),
  diagnostics: z.array(ValidationDiagnosticSchema), canApply: z.boolean(),
}).strict().superRefine((review, ctx) => {
  if (review.canApply && (review.proposed.document === null || review.diagnostics.some((item) => item.severity === 'error'))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['canApply'], message: 'Only a validated proposal can be applied; current diagnostics are informational.' });
  if (JSON.stringify(review.plan.from) !== JSON.stringify(review.diff.from) || JSON.stringify(review.plan.to) !== JSON.stringify(review.diff.to)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['diff'], message: 'Review diff must describe the exact migration plan versions.' });
});
export type DesignSystemUpgradeReview = z.infer<typeof DesignSystemUpgradeReviewSchema>;
export const ApplyDesignSystemUpgradeRequestSchema = z.object({ reviewId: DesignEntityIdSchema, baseDigest: DesignSystemDigestSchema, planDigest: DesignSystemDigestSchema, plan: DesignSystemMigrationPlanSchema }).strict();
export type ApplyDesignSystemUpgradeRequest = z.infer<typeof ApplyDesignSystemUpgradeRequestSchema>;
export const DesignSystemUpgradeResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, projectComponents: ProjectComponentRegistrySchema, document: UIIRDocumentSchema.nullable(),
  bindings: ComponentBindingRegistrySchema, codeIndex: CodeComponentIndexSchema, sharedChanges: SharedComponentChangeStateSchema,
  dependencies: ProjectDesignSystemDependenciesSchema, lock: ProjectDesignSystemLockSchema, review: DesignSystemUpgradeReviewSchema,
}).strict();
export type DesignSystemUpgradeResult = z.infer<typeof DesignSystemUpgradeResultSchema>;
