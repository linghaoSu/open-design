import { z } from 'zod';
import { DesignGenerationTargetsSchema, type DesignGenerationTargets } from './generation-targets.js';
export { DesignGenerationTargetsSchema, defaultDesignGenerationTargets, type DesignGenerationTargets } from './generation-targets.js';
import { DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema } from './common.js';
import { DesignConstraintSetSchema, type DesignConstraintSet } from './design-constraints.js';
import { DesignSystemDigestSchema, ProjectDesignSystemDependenciesSchema, ProjectDesignSystemLockSchema, type ProjectDesignSystemDependencies, type ProjectDesignSystemLock } from './design-system-version.js';
import { DesignValidationModeSchema, DesignValidationOutputSchema, StructuredDesignValidationResultSchema, type DesignValidationMode, type DesignValidationOutput, type StructuredDesignValidationResult } from './design-validation.js';
import { ValidationDiagnosticSchema, type ValidationDiagnostic } from './validation.js';

/** Immutable daemon-issued policy facts, captured before a logical task's prompt is frozen. */
export interface DesignGenerationPolicy {
  schemaVersion: 1; mode: DesignValidationMode; constraints: DesignConstraintSet;
  source: 'project' | 'locked'; dependencies: ProjectDesignSystemDependencies;
  lock: ProjectDesignSystemLock; digest: string;
}
export const DesignGenerationPolicySchema: z.ZodType<DesignGenerationPolicy> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, mode: DesignValidationModeSchema,
  constraints: DesignConstraintSetSchema, source: z.enum(['project', 'locked']),
  dependencies: ProjectDesignSystemDependenciesSchema, lock: ProjectDesignSystemLockSchema,
  digest: DesignSystemDigestSchema,
}).strict();

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DesignGenerationDecisionSchema = z.enum(['not_applicable', 'advisory', 'accepted', 'repair_required', 'blocked', 'canceled']);
export type DesignGenerationDecision = z.infer<typeof DesignGenerationDecisionSchema>;
export interface DesignGenerationReport {
  schemaVersion: 1; executionId: string; runId: string; attempt: 0 | 1;
  mode: DesignValidationMode; policyDigest: string; projectRevision: number;
  decision: DesignGenerationDecision; reasonCodes: string[]; diagnostics: ValidationDiagnostic[];
  inventory: { baselineDigest: string; sourceDigest: string; complete: boolean; changed: string[]; deleted: string[] };
  outputs: DesignValidationOutput[]; validation: StructuredDesignValidationResult | null;
}
export const DesignGenerationReportSchema: z.ZodType<DesignGenerationReport> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, executionId: DesignEntityIdSchema, runId: DesignEntityIdSchema,
  attempt: z.union([z.literal(0), z.literal(1)]), mode: DesignValidationModeSchema, policyDigest: DesignSystemDigestSchema,
  projectRevision: count, decision: DesignGenerationDecisionSchema, reasonCodes: z.array(z.string().min(1)),
  diagnostics: z.array(ValidationDiagnosticSchema),
  inventory: z.object({ baselineDigest: DesignSystemDigestSchema, sourceDigest: DesignSystemDigestSchema,
    complete: z.boolean(), changed: z.array(SourcePathSchema), deleted: z.array(SourcePathSchema) }).strict(),
  outputs: z.array(DesignValidationOutputSchema), validation: StructuredDesignValidationResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.validation && value.validation.mode !== value.mode) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validation', 'mode'], message: 'Generation validation must retain the frozen mode.' });
  if (value.decision === 'accepted' && (!value.validation?.accepted || !value.inventory.complete || value.mode === 'strict' && !value.validation.strictReady || value.diagnostics.some((issue) => issue.severity === 'error'))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decision'], message: 'Accepted delivery requires complete inventory and passing frozen-policy validation; Strict also requires readiness.' });
  if (value.decision === 'advisory' && value.mode !== 'explore') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['decision'], message: 'Only Explore can deliver an advisory result without satisfying its policy.' });
  if (value.decision === 'repair_required' && value.attempt !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attempt'], message: 'A logical generation execution permits at most one design repair.' });
});

export interface DesignGenerationInventory {
  schemaVersion: 1; digest: string; complete: boolean; diagnostics: ValidationDiagnostic[];
  files: Array<{ path: string; digest: string | null; size: number; language: 'tsx' | 'vue' | 'html' | 'css' | null }>;
}
export const DesignGenerationInventorySchema: z.ZodType<DesignGenerationInventory> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, digest: DesignSystemDigestSchema,
  complete: z.boolean(), diagnostics: z.array(ValidationDiagnosticSchema),
  files: z.array(z.object({ path: SourcePathSchema, digest: DesignSystemDigestSchema.nullable(), size: count,
    language: z.enum(['tsx', 'vue', 'html', 'css']).nullable() }).strict()),
}).strict().superRefine((value, ctx) => {
  if (value.complete && value.diagnostics.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['complete'], message: 'Incomplete inventory diagnostics cannot certify coverage.' });
  const paths = new Set<string>();
  value.files.forEach((file, index) => {
    if (paths.has(file.path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', index], message: 'Inventory paths must be unique.' });
    if (value.complete && file.language && file.digest === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', index, 'digest'], message: 'Every analyzed source requires byte identity.' });
    paths.add(file.path);
  });
});

/** Daemon-owned durable execution. Public callers cannot mint or reset its attempt/authority. */
export interface DesignGenerationExecution {
  schemaVersion: 1; id: string; projectId: string; conversationId: string | null; authorityKey: string;
  initialRunId: string; latestRunId: string; policy: DesignGenerationPolicy; targets: DesignGenerationTargets;
  baselineStatus: 'pending' | 'ready'; baseline: DesignGenerationInventory; semanticDigest: string; attempt: 0 | 1; revision: number;
  awaitingContinuation?: boolean | undefined;
  status: 'active' | 'terminal'; report: DesignGenerationReport | null;
  repair?: { schemaVersion: 1; sourceRunId: string; runId: string; finalText: string; finalTextDigest: string; sourceReport: DesignGenerationReport } | undefined;
}
export const DesignGenerationExecutionSchema: z.ZodType<DesignGenerationExecution> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, id: DesignEntityIdSchema, projectId: DesignEntityIdSchema,
  conversationId: DesignEntityIdSchema.nullable(), authorityKey: DesignSystemDigestSchema,
  initialRunId: DesignEntityIdSchema, latestRunId: DesignEntityIdSchema, policy: DesignGenerationPolicySchema,
  targets: DesignGenerationTargetsSchema, baselineStatus: z.enum(['pending', 'ready']), baseline: DesignGenerationInventorySchema, semanticDigest: DesignSystemDigestSchema,
  awaitingContinuation: z.boolean().optional(),
  attempt: z.union([z.literal(0), z.literal(1)]), revision: count, status: z.enum(['active', 'terminal']), report: DesignGenerationReportSchema.nullable(),
  repair: z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, sourceRunId: DesignEntityIdSchema, runId: DesignEntityIdSchema,
    finalText: z.string().min(1), finalTextDigest: DesignSystemDigestSchema, sourceReport: DesignGenerationReportSchema }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.baselineStatus === 'pending' && (value.baseline.complete || value.report?.decision === 'accepted')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['baselineStatus'], message: 'A pending baseline cannot certify source identity or delivery.' });
  if (value.policy.lock.id !== value.projectId || value.policy.dependencies.id !== value.projectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['policy'], message: 'Generation policy belongs to one project.' });
  if (value.report && (value.report.executionId !== value.id || value.report.runId !== value.latestRunId || value.report.policyDigest !== value.policy.digest || value.report.mode !== value.policy.mode || value.report.inventory.baselineDigest !== value.baseline.digest || value.report.attempt !== value.attempt)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report'], message: 'A report must match its execution, current Run, policy, baseline and attempt.' });
  if (value.status === 'terminal' && !value.report) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['report'], message: 'Terminal design executions require a durable report.' });
  if (value.attempt === 1 && !value.repair || value.repair && (value.attempt !== 1 || value.repair.runId === value.repair.sourceRunId
    || value.repair.sourceReport.executionId !== value.id || value.repair.sourceReport.runId !== value.repair.sourceRunId || value.repair.sourceReport.attempt !== 0
    || value.repair.sourceReport.decision !== 'repair_required' || value.repair.sourceReport.policyDigest !== value.policy.digest
    || value.repair.sourceReport.inventory.baselineDigest !== value.baseline.digest)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repair'], message: 'Attempt one requires its immutable initial failure and authorized repair identity.' });
});
