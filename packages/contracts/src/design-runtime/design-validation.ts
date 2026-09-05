import { z } from 'zod';
import { CodeComponentIndexSchema, ComponentBindingRegistrySchema } from './code-index.js';
import { ComponentRegistrySchema } from './component-registry.js';
import { DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema } from './common.js';
import { DesignConstraintSetSchema } from './design-constraints.js';
import { DesignTokenRegistrySchema } from './design-tokens.js';
import { DesignSystemVersionSchema, ProjectDesignSystemDependenciesSchema, ProjectDesignSystemLockSchema } from './design-system-version.js';
import { HandoffTargetPackageSchema } from './handoff.js';
import { ProjectCodeSourceEvidenceSchema } from './local-component-binding.js';
import { ProjectComponentRegistrySchema } from './project-components.js';
import { UIIRDocumentSchema } from './ui-ir.js';
import { ValidationDiagnosticSchema } from './validation.js';

export const DesignValidationModeSchema = z.enum(['explore', 'guided', 'strict']);
export type DesignValidationMode = z.infer<typeof DesignValidationModeSchema>;

/** Project policy is used only without a locked package; a lock owns its policy. */
export const ProjectDesignValidationSettingsSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  mode: DesignValidationModeSchema,
  projectConstraints: DesignConstraintSetSchema,
}).strict();
export type ProjectDesignValidationSettings = z.infer<typeof ProjectDesignValidationSettingsSchema>;

export const DesignValidationSourceSchema = z.object({
  sourcePath: SourcePathSchema,
  language: z.enum(['tsx', 'vue', 'html', 'css']),
  sourceText: z.string(),
}).strict();
export type DesignValidationSource = z.infer<typeof DesignValidationSourceSchema>;

/** File paths are explicit. The evaluator never reads the filesystem or infers a framework. */
export const DesignValidationOutputSchema = z.object({
  sourcePath: SourcePathSchema,
  exportName: z.string().min(1).optional(),
  screenId: DesignEntityIdSchema.optional(),
}).strict();
export type DesignValidationOutput = z.infer<typeof DesignValidationOutputSchema>;

export const DesignValidationSnapshotSchema = z.object({
  registry: ComponentRegistrySchema.nullable(),
  projectComponents: ProjectComponentRegistrySchema,
  baseCodeIndex: CodeComponentIndexSchema,
  projectCodeIndex: CodeComponentIndexSchema,
  bindings: ComponentBindingRegistrySchema,
  document: UIIRDocumentSchema.nullable(),
  tokens: DesignTokenRegistrySchema,
  dependencies: ProjectDesignSystemDependenciesSchema,
  lock: ProjectDesignSystemLockSchema,
  versions: z.array(DesignSystemVersionSchema),
  projectSources: z.array(ProjectCodeSourceEvidenceSchema),
  targetPackages: z.array(HandoffTargetPackageSchema),
}).strict();
export type DesignValidationSnapshot = z.infer<typeof DesignValidationSnapshotSchema>;

export const ValidateStructuredDesignRequestSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  projectId: DesignEntityIdSchema,
  projectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  settings: ProjectDesignValidationSettingsSchema,
  snapshot: DesignValidationSnapshotSchema,
  sources: z.array(DesignValidationSourceSchema),
  outputs: z.array(DesignValidationOutputSchema),
}).strict().superRefine((request, ctx) => {
  for (const [field, values] of [
    ['sources', request.sources.map((source) => source.sourcePath)],
    ['outputs', request.outputs.map((output) => JSON.stringify([output.sourcePath, output.exportName]))],
  ] as const) {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field, index], message: 'Selected source/output identities must be unique.' });
      seen.add(value);
    });
  }
  for (const field of ['projectComponents', 'projectCodeIndex', 'bindings', 'dependencies', 'lock'] as const) {
    if (request.snapshot[field].id !== request.projectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['snapshot', field, 'id'], message: 'Validation context must use one project identity.' });
  }
});
export type ValidateStructuredDesignRequest = z.infer<typeof ValidateStructuredDesignRequestSchema>;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DesignReuseMetricSchema = z.object({ reused: count, total: count, rate: z.number().min(0).max(1).nullable() }).strict().superRefine((metric, ctx) => {
  if (metric.reused > metric.total || metric.rate !== (metric.total === 0 ? null : metric.reused / metric.total)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reuse rate must use the reported counts; an empty denominator is unknown.' });
});
export type DesignReuseMetric = z.infer<typeof DesignReuseMetricSchema>;
export const DesignValidationMetricsSchema = z.object({
  componentReuse: DesignReuseMetricSchema,
  bindingReuse: DesignReuseMetricSchema,
  unknownComponents: count,
  unknownTokens: count,
  rawColors: count,
  rawSpacing: count,
  rawRadius: count,
  intrinsicControls: count,
  duplicateControls: count,
  duplicateStructures: count,
  unsupported: count,
  unresolvedImports: count,
}).strict();
export type DesignValidationMetrics = z.infer<typeof DesignValidationMetricsSchema>;
export const DesignValidationCoverageSchema = z.object({
  semantic: z.boolean(), source: z.boolean(), imports: z.boolean(), styles: z.boolean(), bindings: z.boolean(), conformance: z.boolean(),
}).strict();
export type DesignValidationCoverage = z.infer<typeof DesignValidationCoverageSchema>;

export const StructuredDesignValidationResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  mode: DesignValidationModeSchema,
  policySource: z.enum(['project', 'locked']),
  diagnostics: z.array(ValidationDiagnosticSchema),
  coverage: DesignValidationCoverageSchema,
  metrics: DesignValidationMetricsSchema,
  semanticReuse: DesignReuseMetricSchema,
  accepted: z.boolean(),
  strictReady: z.boolean(),
}).strict().superRefine((result, ctx) => {
  const errors = result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (result.accepted === errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accepted'], message: 'Acceptance must reflect diagnostic severity.' });
  if (result.mode === 'strict' && result.accepted !== result.strictReady) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['accepted'], message: 'Strict acceptance requires Strict readiness.' });
  if (result.strictReady && (errors || !Object.values(result.coverage).every(Boolean))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['strictReady'], message: 'Strict readiness requires complete evidence and no errors.' });
});
export type StructuredDesignValidationResult = z.infer<typeof StructuredDesignValidationResultSchema>;

/** Corpus observations are explicit measurements, never model-quality estimates. */
const DesignBenchmarkTaskSchema = z.enum(['resource-list', 'resource-detail', 'settings', 'form', 'dialog', 'dashboard', 'empty-state', 'error-state']);
export interface DesignBenchmarkCase {
  id: string;
  task: z.infer<typeof DesignBenchmarkTaskSchema>;
  request: ValidateStructuredDesignRequest;
  repairSteps: Array<{ reason: string; request: ValidateStructuredDesignRequest }>;
}
export const DesignBenchmarkCaseSchema: z.ZodType<DesignBenchmarkCase> = z.object({
  id: DesignEntityIdSchema,
  task: DesignBenchmarkTaskSchema,
  request: ValidateStructuredDesignRequestSchema,
  repairSteps: z.array(z.object({ reason: z.string().min(1), request: ValidateStructuredDesignRequestSchema }).strict()),
}).strict();
export interface DesignBenchmarkResult {
  schemaVersion: 1;
  cases: Array<{
    id: string;
    task: DesignBenchmarkCase['task'];
    initial: StructuredDesignValidationResult;
    final: StructuredDesignValidationResult;
    repairs: Array<{ reason: string; result: StructuredDesignValidationResult }>;
    repairSteps: number;
    repeatable: boolean;
    repeats: number;
    metricVariance: number;
  }>;
  repeatable: boolean;
  generationVariance: null;
}
export const DesignBenchmarkResultSchema: z.ZodType<DesignBenchmarkResult> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  cases: z.array(z.object({ id: DesignEntityIdSchema, task: DesignBenchmarkTaskSchema,
    initial: StructuredDesignValidationResultSchema, final: StructuredDesignValidationResultSchema,
    repairs: z.array(z.object({ reason: z.string().min(1), result: StructuredDesignValidationResultSchema }).strict()),
    repairSteps: count, repeatable: z.boolean(), repeats: count, metricVariance: z.number().nonnegative(),
  }).strict()),
  repeatable: z.boolean(),
  generationVariance: z.null(),
}).strict();
