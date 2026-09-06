import { z } from 'zod';
export { ProjectDesignPreviewRequestSchema as ProjectDesignRuntimePreviewRequestSchema, ProjectDesignPreviewResultSchema as ProjectDesignRuntimePreviewResponseSchema } from '../design-runtime/preview.js';
export type { ProjectDesignPreviewRequest as ProjectDesignRuntimePreviewRequest, ProjectDesignPreviewResult as ProjectDesignRuntimePreviewResponse } from '../design-runtime/preview.js';
import {
  LegacyDesignSystemMigrationPlanSchema, LegacyDesignSystemMigrationReviewSchema,
  type LegacyDesignSystemMigrationReview,
  DesignPatternSearchResultSchema, DesignPatternReadResultSchema, DesignPatternInstantiationResultSchema, InstantiateDesignPatternRequestSchema,
  DesignGenerationTargetsSchema,
  ProjectDesignValidationSettingsSchema,
  DesignValidationSourceSchema,
  DesignValidationOutputSchema,
  StructuredDesignValidationResultSchema,
  DesignConstraintSetSchema,
  type DesignConstraintPolicy,
  type ProjectDesignValidationSettings,
  DesignSystemMigrationRecipeSchema,
  DesignSystemMigrationRecipePlanResultSchema,
  InstantiateDesignSystemMigrationRecipeRequestSchema,
  ApplyDesignSystemUpgradeRequestSchema,
  DesignSystemMigrationPlanSchema,
  DesignSystemUpgradeReviewSchema,
  CodeComponentDefinitionSchema,
  CodeComponentIndexSchema,
  ComponentBindingRegistrySchema,
  ComponentBindingSchema,
  ComponentCompilationSelectionSchema,
  ComponentStorySourceSelectionSchema,
  CompileComponentRegistryRequestSchema,
  ComponentDefinitionSchema,
  ComponentRegistrySchema,
  ComponentReferenceSchema,
  ComponentDeletionAnalysisSchema,
  ComponentDetachRequestSchema,
  ProjectComponentDefinitionSchema,
  ProjectComponentDeleteRequestSchema,
  ProjectComponentRegistrySchema,
  ReferenceGraphQueryResultSchema,
  ResolvedNodeOriginSchema,
  ResolvedUIIRResultSchema,
  SharedComponentChangeStateSchema,
  SharedComponentDraftSchema,
  SharedComponentImpactSchema,
  SharedComponentPublishedRevisionSchema,
  StageSharedComponentChangeRequestSchema,
  StageSharedComponentUndoRequestSchema,
  UIIRDocumentSchema,
  UIIRNodeSchema,
  DesignEntityIdSchema,
  DesignMemberNameSchema,
  DesignRuntimeSchemaVersionSchema,
  JsonValueSchema,
  DesignSystemPackageSchema,
  DesignSystemVersionSchema,
  DesignSystemSemVerSchema,
  DesignSystemVersionRangeSchema,
  DesignSystemDigestSchema,
  DesignSystemSourceBundleSchema,
  SourcePathSchema,
  DesignSystemResolutionResultSchema,
  ProjectDesignSystemDependenciesSchema,
  ProjectDesignSystemLockSchema,
  ValidationDiagnosticSchema,
  ExtractSourceCodeComponentRequestSchema,
  RegisterLocalComponentBindingRequestSchema,
  ComponentFrameworkSchema,
  HandoffBuildResultSchema,
  HandoffCodeResultSchema,
  HandoffScreenOutputSchema,
} from '../design-runtime/index.js';

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** One atomically persisted project snapshot; frozen source bytes live in the separate version catalog. */
export const ProjectDesignRuntimeStateSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  revision: revisionSchema,
  validationSettings: ProjectDesignValidationSettingsSchema,
  generationTargets: DesignGenerationTargetsSchema,
  registry: ComponentRegistrySchema.nullable(),
  codeIndex: CodeComponentIndexSchema,
  /** Registered project implementations remain separate from package-owned codeIndex. */
  projectCodeIndex: CodeComponentIndexSchema,
  bindings: ComponentBindingRegistrySchema,
  projectComponents: ProjectComponentRegistrySchema,
  document: UIIRDocumentSchema.nullable(),
  sharedChanges: SharedComponentChangeStateSchema,
  dependencies: ProjectDesignSystemDependenciesSchema,
  lock: ProjectDesignSystemLockSchema,
}).strict().superRefine((state, ctx) => {
  if ([state.projectCodeIndex.id, state.bindings.id, state.projectComponents.id, state.sharedChanges.id, state.dependencies.id, state.lock.id].some((id) => id !== state.codeIndex.id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', 'id'], message: 'All project runtime registries and change state must share a project identity.' });
  }
  if (state.dependencies.dependencies.length > 1 || state.lock.dependencies.length > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lock'], message: 'This project runtime supports one active design system.' });
  }
  if (state.dependencies.dependencies.length !== state.lock.dependencies.length || state.dependencies.dependencies[0]?.designSystemId !== state.lock.dependencies[0]?.designSystemId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lock'], message: 'Dependency intent and exact lock must select the same design system.' });
  }
  if (state.lock.dependencies.length && state.registry?.id !== state.lock.dependencies[0]?.designSystemId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registry'], message: 'The working registry must belong to the active design system.' });
  }
  if (state.registry === null && (state.codeIndex.components.length || state.bindings.bindings.some((binding) => binding.componentRef.startsWith('ds:')))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registry'], message: 'A project without a design system cannot contain design-system-owned code or bindings.' });
  }
  const packageCode = new Set(state.codeIndex.components.map((component) => component.id));
  if (state.projectCodeIndex.components.some((component) => packageCode.has(component.id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectCodeIndex'], message: 'Project and design-system code identities cannot collide.' });
  if (state.bindings.bindings.some((binding) => binding.componentRef.startsWith('ds:') && binding.status !== 'unbound' && state.projectCodeIndex.components.some((code) => code.id === binding.codeComponentId))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings'], message: 'Design-system bindings must reference design-system-owned code.' });
});
export type ProjectDesignRuntimeState = z.infer<typeof ProjectDesignRuntimeStateSchema>;

export const ProjectDesignRuntimeResponseSchema = z.object({ state: ProjectDesignRuntimeStateSchema }).strict();
export type ProjectDesignRuntimeResponse = z.infer<typeof ProjectDesignRuntimeResponseSchema>;

export const ProjectDesignRuntimeCompileRequestSchema = z.object({
  expectedRevision: revisionSchema,
  designSystemId: DesignEntityIdSchema,
  selections: z.array(ComponentCompilationSelectionSchema.omit({ sourceText: true }).extend({
    storySources: z.array(ComponentStorySourceSelectionSchema.omit({ sourceText: true })).min(1).optional(),
  })).min(1),
}).strict().superRefine((request, ctx) => {
  const checked = CompileComponentRegistryRequestSchema.safeParse({
    designSystemId: request.designSystemId,
    selections: request.selections.map((selection) => ({ ...selection, sourceText: '',
      ...(selection.storySources ? { storySources: selection.storySources.map((source) => ({ ...source, sourceText: '' })) } : {}),
    })),
  });
  if (!checked.success) checked.error.issues.forEach((issue) => ctx.addIssue(issue));
});
export type ProjectDesignRuntimeCompileRequest = z.infer<typeof ProjectDesignRuntimeCompileRequestSchema>;

export const ProjectDesignRuntimeRevisionRequestSchema = z.object({ expectedRevision: revisionSchema }).strict();
export type ProjectDesignRuntimeRevisionRequest = z.infer<typeof ProjectDesignRuntimeRevisionRequestSchema>;

export const ProjectDesignRuntimeBindRequestSchema = z.object({
  expectedRevision: revisionSchema,
  binding: ComponentBindingSchema,
}).strict().superRefine((request, ctx) => {
  if (request.binding.status !== 'bound') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['binding', 'status'], message: 'Bind requires a bound record; use unbind to remove its code target.' });
  }
});
export type ProjectDesignRuntimeBindRequest = z.infer<typeof ProjectDesignRuntimeBindRequestSchema>;

export const ProjectDesignRuntimeSearchRequestSchema = z.object({ query: z.string().optional() }).strict();
export type ProjectDesignRuntimeSearchRequest = z.infer<typeof ProjectDesignRuntimeSearchRequestSchema>;

export const ProjectDesignRuntimeComponentsResponseSchema = z.object({
  revision: revisionSchema,
  components: z.array(ComponentDefinitionSchema),
}).strict();
export type ProjectDesignRuntimeComponentsResponse = z.infer<typeof ProjectDesignRuntimeComponentsResponseSchema>;

export const ProjectDesignRuntimeCodeComponentsResponseSchema = z.object({
  revision: revisionSchema,
  components: z.array(CodeComponentDefinitionSchema),
}).strict();
export type ProjectDesignRuntimeCodeComponentsResponse = z.infer<typeof ProjectDesignRuntimeCodeComponentsResponseSchema>;

export const ProjectDesignRuntimeBindingResolutionSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), component: ComponentDefinitionSchema, codeComponent: CodeComponentDefinitionSchema }).strict(),
  z.object({ ok: z.literal(false), diagnostics: z.array(ValidationDiagnosticSchema) }).strict(),
]);
export type ProjectDesignRuntimeBindingResolution = z.infer<typeof ProjectDesignRuntimeBindingResolutionSchema>;
export const ProjectDesignRuntimeResolveResponseSchema = z.object({
  revision: revisionSchema,
  resolution: ProjectDesignRuntimeBindingResolutionSchema,
}).strict();
export type ProjectDesignRuntimeResolveResponse = z.infer<typeof ProjectDesignRuntimeResolveResponseSchema>;

export const ProjectDesignRuntimeRegisterLocalBindingRequestSchema = z.object({
  expectedRevision: revisionSchema,
  source: ExtractSourceCodeComponentRequestSchema.omit({ sourceText: true }),
  binding: RegisterLocalComponentBindingRequestSchema.innerType().shape.binding,
}).strict().superRefine(({ expectedRevision: _revision, source, binding }, ctx) => {
  const result = RegisterLocalComponentBindingRequestSchema.safeParse({ source: { ...source, sourceText: '' }, binding });
  if (!result.success) result.error.issues.forEach((issue) => ctx.addIssue(issue));
});
export type ProjectDesignRuntimeRegisterLocalBindingRequest = z.infer<typeof ProjectDesignRuntimeRegisterLocalBindingRequestSchema>;
export const ProjectDesignRuntimeRegisterLocalBindingResponseSchema = z.object({ state: ProjectDesignRuntimeStateSchema, binding: ComponentBindingSchema, diagnostics: z.array(ValidationDiagnosticSchema) }).strict();
export type ProjectDesignRuntimeRegisterLocalBindingResponse = z.infer<typeof ProjectDesignRuntimeRegisterLocalBindingResponseSchema>;
export const ProjectDesignRuntimeRefreshCodeResponseSchema = z.object({ state: ProjectDesignRuntimeStateSchema, diagnostics: z.array(ValidationDiagnosticSchema) }).strict();
export type ProjectDesignRuntimeRefreshCodeResponse = z.infer<typeof ProjectDesignRuntimeRefreshCodeResponseSchema>;

/** Select stored facts, never caller-authored claimed source or historical review evidence. */
export const ProjectDesignRuntimeHandoffChangeSelectionSchema = z.object({
  fromVersion: z.object({ designSystemId: DesignEntityIdSchema, version: DesignSystemSemVerSchema }).strict().optional(),
  sharedChangeIds: z.array(DesignEntityIdSchema).refine((ids) => new Set(ids).size === ids.length, 'Shared change identities must be unique.').optional(),
}).strict();
export const ProjectDesignRuntimeCreateHandoffRequestSchema = z.object({
  expectedRevision: revisionSchema, id: DesignEntityIdSchema, framework: ComponentFrameworkSchema,
  changeContextSelection: ProjectDesignRuntimeHandoffChangeSelectionSchema.optional(),
}).strict();
export type ProjectDesignRuntimeCreateHandoffRequest = z.infer<typeof ProjectDesignRuntimeCreateHandoffRequestSchema>;
export const ProjectDesignRuntimeHandoffResponseSchema = z.object({ revision: revisionSchema, result: HandoffBuildResultSchema }).strict().superRefine((response, ctx) => {
  if (response.result.manifest && response.result.manifest.projectRevision !== response.revision) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revision'], message: 'Handoff must identify the exact response revision.' });
});
export type ProjectDesignRuntimeHandoffResponse = z.infer<typeof ProjectDesignRuntimeHandoffResponseSchema>;
export const ProjectDesignRuntimeEmitHandoffRequestSchema = ProjectDesignRuntimeCreateHandoffRequestSchema.extend({ outputs: z.array(HandoffScreenOutputSchema) }).strict();
export type ProjectDesignRuntimeEmitHandoffRequest = z.infer<typeof ProjectDesignRuntimeEmitHandoffRequestSchema>;
export const ProjectDesignRuntimeEmitHandoffResponseSchema = z.object({ revision: revisionSchema, handoff: HandoffBuildResultSchema, code: HandoffCodeResultSchema }).strict().superRefine((response, ctx) => {
  if (response.handoff.manifest && response.handoff.manifest.projectRevision !== response.revision) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revision'], message: 'Emitted code must identify the exact handoff revision.' });
  if (response.code.ok && !response.handoff.manifest?.ready) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: 'Successful emission requires a ready, verified handoff.' });
});
export type ProjectDesignRuntimeEmitHandoffResponse = z.infer<typeof ProjectDesignRuntimeEmitHandoffResponseSchema>;

export const ProjectDesignRuntimeValidateRequestSchema = z.object({
  component: z.string().min(1),
  props: z.record(DesignMemberNameSchema, JsonValueSchema),
  nodeId: DesignEntityIdSchema.optional(),
}).strict();
export type ProjectDesignRuntimeValidateRequest = z.infer<typeof ProjectDesignRuntimeValidateRequestSchema>;
export const ProjectDesignRuntimeValidateResponseSchema = z.object({
  revision: revisionSchema,
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict();
export type ProjectDesignRuntimeValidateResponse = z.infer<typeof ProjectDesignRuntimeValidateResponseSchema>;


export const ProjectDesignRuntimeSaveDocumentRequestSchema = z.object({ expectedRevision: revisionSchema, document: UIIRDocumentSchema }).strict();
export type ProjectDesignRuntimeSaveDocumentRequest = z.infer<typeof ProjectDesignRuntimeSaveDocumentRequestSchema>;
export const ProjectDesignRuntimeValidateDocumentRequestSchema = z.object({ document: UIIRDocumentSchema }).strict();
export type ProjectDesignRuntimeValidateDocumentRequest = z.infer<typeof ProjectDesignRuntimeValidateDocumentRequestSchema>;
export const ProjectDesignRuntimeDocumentResponseSchema = z.object({ revision: revisionSchema, resolution: ResolvedUIIRResultSchema }).strict();
export type ProjectDesignRuntimeDocumentResponse = z.infer<typeof ProjectDesignRuntimeDocumentResponseSchema>;

export const ProjectDesignRuntimeReferencesRequestSchema = z.object({ componentRef: ComponentReferenceSchema }).strict();
export type ProjectDesignRuntimeReferencesRequest = z.infer<typeof ProjectDesignRuntimeReferencesRequestSchema>;
export const ProjectDesignRuntimeReferencesResponseSchema = z.object({ revision: revisionSchema, references: ReferenceGraphQueryResultSchema }).strict();
export type ProjectDesignRuntimeReferencesResponse = z.infer<typeof ProjectDesignRuntimeReferencesResponseSchema>;
export const ProjectDesignRuntimeProjectComponentsResponseSchema = z.object({ revision: revisionSchema, components: z.array(ProjectComponentDefinitionSchema) }).strict();
export type ProjectDesignRuntimeProjectComponentsResponse = z.infer<typeof ProjectDesignRuntimeProjectComponentsResponseSchema>;
export const ProjectDesignRuntimeDeletionResponseSchema = z.object({ revision: revisionSchema, analysis: ComponentDeletionAnalysisSchema }).strict();
export type ProjectDesignRuntimeDeletionResponse = z.infer<typeof ProjectDesignRuntimeDeletionResponseSchema>;
export const ProjectDesignRuntimeHistoryResponseSchema = z.object({ revision: revisionSchema, history: z.array(SharedComponentPublishedRevisionSchema) }).strict();
export type ProjectDesignRuntimeHistoryResponse = z.infer<typeof ProjectDesignRuntimeHistoryResponseSchema>;

export const ProjectDesignRuntimeStageComponentRequestSchema = z.object({
  expectedRevision: revisionSchema,
  ...StageSharedComponentChangeRequestSchema.innerType().shape,
}).strict().superRefine(({ expectedRevision: _revision, ...request }, ctx) => {
  const result = StageSharedComponentChangeRequestSchema.safeParse(request);
  if (!result.success) result.error.issues.forEach((issue) => ctx.addIssue(issue));
});
export type ProjectDesignRuntimeStageComponentRequest = z.infer<typeof ProjectDesignRuntimeStageComponentRequestSchema>;
export const ProjectDesignRuntimeStageComponentResponseSchema = z.object({
  state: ProjectDesignRuntimeStateSchema, draft: SharedComponentDraftSchema, impact: SharedComponentImpactSchema,
}).strict();
export type ProjectDesignRuntimeStageComponentResponse = z.infer<typeof ProjectDesignRuntimeStageComponentResponseSchema>;
export const ProjectDesignRuntimeChangeResponseSchema = z.object({
  revision: revisionSchema, draft: SharedComponentDraftSchema, impact: SharedComponentImpactSchema,
}).strict();
export type ProjectDesignRuntimeChangeResponse = z.infer<typeof ProjectDesignRuntimeChangeResponseSchema>;
export const ProjectDesignRuntimePublishComponentRequestSchema = z.object({ expectedRevision: revisionSchema, expectedDefinitionRevision: revisionSchema }).strict();
export type ProjectDesignRuntimePublishComponentRequest = z.infer<typeof ProjectDesignRuntimePublishComponentRequestSchema>;
export const ProjectDesignRuntimePublishComponentResponseSchema = z.object({ state: ProjectDesignRuntimeStateSchema, impact: SharedComponentImpactSchema }).strict();
export type ProjectDesignRuntimePublishComponentResponse = z.infer<typeof ProjectDesignRuntimePublishComponentResponseSchema>;
export const ProjectDesignRuntimeUndoComponentRequestSchema = z.object({
  expectedRevision: revisionSchema,
  ...StageSharedComponentUndoRequestSchema.innerType().omit({ componentRef: true }).shape,
}).strict().superRefine(({ expectedRevision: _revision, ...request }, ctx) => {
  const result = StageSharedComponentUndoRequestSchema.safeParse({ ...request, componentRef: 'local:component' });
  if (!result.success) result.error.issues.forEach((issue) => ctx.addIssue(issue));
});
export type ProjectDesignRuntimeUndoComponentRequest = z.infer<typeof ProjectDesignRuntimeUndoComponentRequestSchema>;
export const ProjectDesignRuntimeDeleteComponentRequestSchema = z.object({
  expectedRevision: revisionSchema, action: ProjectComponentDeleteRequestSchema.innerType().shape.action,
}).strict();
export type ProjectDesignRuntimeDeleteComponentRequest = z.infer<typeof ProjectDesignRuntimeDeleteComponentRequestSchema>;
/** The legacy mode field is accepted but ignored; the daemon applies the saved project mode. */
export const ProjectDesignRuntimeDetachRequestSchema = ComponentDetachRequestSchema;
export type ProjectDesignRuntimeDetachRequest = z.infer<typeof ProjectDesignRuntimeDetachRequestSchema>;
export const ProjectDesignRuntimeDetachResponseSchema = z.object({
  revision: revisionSchema, node: UIIRNodeSchema.nullable(), origins: z.array(ResolvedNodeOriginSchema), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((result, ctx) => {
  const hasErrors = result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if ((result.node === null) !== hasErrors || (result.node === null && result.origins.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['node'], message: 'Detach errors require a null node and no derived origins.' });
  }
});
export type ProjectDesignRuntimeDetachResponse = z.infer<typeof ProjectDesignRuntimeDetachResponseSchema>;


export const ProjectDesignRuntimeVersionSummarySchema = z.object({
  id: DesignEntityIdSchema, name: z.string().min(1), version: DesignSystemSemVerSchema,
  digest: DesignSystemDigestSchema, sourceDigest: DesignSystemDigestSchema,
}).strict();
export type ProjectDesignRuntimeVersionSummary = z.infer<typeof ProjectDesignRuntimeVersionSummarySchema>;
export const ProjectDesignRuntimeVersionsResponseSchema = z.object({ revision: revisionSchema, versions: z.array(ProjectDesignRuntimeVersionSummarySchema) }).strict();
export type ProjectDesignRuntimeVersionsResponse = z.infer<typeof ProjectDesignRuntimeVersionsResponseSchema>;
export const ProjectDesignRuntimeVersionResponseSchema = z.object({ revision: revisionSchema, version: DesignSystemVersionSchema }).strict();
export type ProjectDesignRuntimeVersionResponse = z.infer<typeof ProjectDesignRuntimeVersionResponseSchema>;
export const ProjectDesignRuntimeImportVersionRequestSchema = z.object({ expectedRevision: revisionSchema, package: DesignSystemPackageSchema }).strict();
export type ProjectDesignRuntimeImportVersionRequest = z.infer<typeof ProjectDesignRuntimeImportVersionRequestSchema>;
export const ProjectDesignRuntimePublishVersionResponseSchema = z.object({ state: ProjectDesignRuntimeStateSchema, version: ProjectDesignRuntimeVersionSummarySchema }).strict();
export type ProjectDesignRuntimePublishVersionResponse = z.infer<typeof ProjectDesignRuntimePublishVersionResponseSchema>;
const packageFields = DesignSystemPackageSchema.innerType().shape;
/** Selected paths are read as UTF-8; full-package import supports binary bundle entries. */
export const ProjectDesignRuntimePublishCurrentRequestSchema = z.object({
  expectedRevision: revisionSchema, name: z.string().min(1), version: DesignSystemSemVerSchema,
  sourcePaths: z.array(SourcePathSchema).min(1),
  constraints: packageFields.constraints.optional(), tokens: packageFields.tokens.optional(), patterns: packageFields.patterns.optional(),
  codeCompatibility: packageFields.codeCompatibility.optional(), origin: packageFields.origin, migrations: packageFields.migrations,
}).strict().superRefine((request, ctx) => {
  const bundle = DesignSystemSourceBundleSchema.safeParse({ schemaVersion: 1, files: request.sourcePaths.map((path) => ({ path, encoding: 'utf8', content: '' })) });
  if (!bundle.success) bundle.error.issues.forEach((issue) => ctx.addIssue({ ...issue, path: ['sourcePaths', issue.path[1] ?? 0] }));
});
export type ProjectDesignRuntimePublishCurrentRequest = z.infer<typeof ProjectDesignRuntimePublishCurrentRequestSchema>;
export const ProjectDesignRuntimeActivateDependencyRequestSchema = z.object({
  expectedRevision: revisionSchema, designSystemId: DesignEntityIdSchema, version: DesignSystemSemVerSchema, range: DesignSystemVersionRangeSchema,
}).strict();
export type ProjectDesignRuntimeActivateDependencyRequest = z.infer<typeof ProjectDesignRuntimeActivateDependencyRequestSchema>;
export const ProjectDesignRuntimeDependencyResponseSchema = z.object({ revision: revisionSchema, resolution: DesignSystemResolutionResultSchema }).strict();
export type ProjectDesignRuntimeDependencyResponse = z.infer<typeof ProjectDesignRuntimeDependencyResponseSchema>;


export const ProjectDesignRuntimeReviewUpgradeRequestSchema = z.object({
  expectedRevision: revisionSchema, plan: DesignSystemMigrationPlanSchema,
}).strict();
export type ProjectDesignRuntimeReviewUpgradeRequest = z.infer<typeof ProjectDesignRuntimeReviewUpgradeRequestSchema>;
export const ProjectDesignRuntimeReviewUpgradeResponseSchema = z.object({
  revision: revisionSchema, review: DesignSystemUpgradeReviewSchema,
}).strict().superRefine((response, ctx) => {
  if (response.revision !== response.review.baseRevision) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revision'], message: 'Review must describe the returned project revision.' });
});
export type ProjectDesignRuntimeReviewUpgradeResponse = z.infer<typeof ProjectDesignRuntimeReviewUpgradeResponseSchema>;
export const ProjectDesignRuntimeApplyUpgradeRequestSchema = z.object({
  expectedRevision: revisionSchema, ...ApplyDesignSystemUpgradeRequestSchema.shape,
}).strict();
export type ProjectDesignRuntimeApplyUpgradeRequest = z.infer<typeof ProjectDesignRuntimeApplyUpgradeRequestSchema>;
export const ProjectDesignRuntimeApplyUpgradeResponseSchema = z.object({
  state: ProjectDesignRuntimeStateSchema, review: DesignSystemUpgradeReviewSchema,
}).strict().superRefine((response, ctx) => {
  if (!response.review.canApply || response.state.revision !== response.review.baseRevision + 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['review'], message: 'Applied state must follow an applicable review by one project revision.' });
  if (response.state.codeIndex.id !== response.review.projectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['review', 'projectId'], message: 'Applied state must belong to the reviewed project.' });
  const locked = response.state.lock.dependencies[0];
  const target = response.review.plan.to;
  if (!locked || locked.designSystemId !== target.designSystemId || locked.version !== target.version || locked.digest !== target.digest || locked.source.digest !== target.source.digest) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['state', 'lock'], message: 'Applied state must lock the reviewed target.' });
});
export type ProjectDesignRuntimeApplyUpgradeResponse = z.infer<typeof ProjectDesignRuntimeApplyUpgradeResponseSchema>;


export const ProjectDesignRuntimeMigrationRecipesResponseSchema = z.object({
  revision: revisionSchema, recipes: z.array(DesignSystemMigrationRecipeSchema),
}).strict();
export type ProjectDesignRuntimeMigrationRecipesResponse = z.infer<typeof ProjectDesignRuntimeMigrationRecipesResponseSchema>;
export const ProjectDesignRuntimeInstantiateMigrationRecipeRequestSchema = z.object({
  expectedRevision: revisionSchema, designSystemId: DesignEntityIdSchema, version: DesignSystemSemVerSchema,
  ...InstantiateDesignSystemMigrationRecipeRequestSchema.shape,
}).strict();
export type ProjectDesignRuntimeInstantiateMigrationRecipeRequest = z.infer<typeof ProjectDesignRuntimeInstantiateMigrationRecipeRequestSchema>;
export const ProjectDesignRuntimeMigrationRecipeResponseSchema = z.object({
  revision: revisionSchema, ...DesignSystemMigrationRecipePlanResultSchema.shape,
}).strict();
export type ProjectDesignRuntimeMigrationRecipeResponse = z.infer<typeof ProjectDesignRuntimeMigrationRecipeResponseSchema>;


/** Fresh copies prevent authoring a project policy from mutating another project's defaults. */
export function defaultProjectDesignValidationSettings(): ProjectDesignValidationSettings {
  const policy = (severity: 'warning' | 'error'): DesignConstraintPolicy => ({
    unknownComponents: severity, unknownProps: severity, invalidVariants: severity, invalidSlots: severity,
    tokens: { undeclared: severity }, rawCss: { colors: severity, spacing: severity, radius: severity },
    interactiveHtml: { customControlsWhenBoundComponentExists: severity },
  });
  return { schemaVersion: 1, mode: 'explore', projectConstraints: { schemaVersion: 1, explore: policy('warning'), guided: policy('error'), strict: policy('error') } };
}
export const ProjectDesignRuntimeValidationSettingsRequestSchema = z.object({ expectedRevision: revisionSchema, settings: ProjectDesignValidationSettingsSchema }).strict();
export type ProjectDesignRuntimeValidationSettingsRequest = z.infer<typeof ProjectDesignRuntimeValidationSettingsRequestSchema>;
export const ProjectDesignRuntimeValidationSettingsResponseSchema = z.object({
  revision: revisionSchema, settings: ProjectDesignValidationSettingsSchema, lock: ProjectDesignSystemLockSchema,
  effectiveConstraints: z.object({ source: z.enum(['project', 'locked']), constraints: DesignConstraintSetSchema }).strict().nullable(),
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict();
export type ProjectDesignRuntimeValidationSettingsResponse = z.infer<typeof ProjectDesignRuntimeValidationSettingsResponseSchema>;
export const ProjectDesignRuntimeValidateArtifactsRequestSchema = z.object({
  expectedRevision: revisionSchema,
  sources: z.array(DesignValidationSourceSchema.omit({ sourceText: true })).min(1).max(500),
  outputs: z.array(DesignValidationOutputSchema).min(1).max(500),
}).strict().superRefine((input, ctx) => {
  const paths = new Set<string>();
  input.sources.forEach((source, index) => {
    if (paths.has(source.sourcePath)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sources', index], message: 'Source paths must be unique.' });
    paths.add(source.sourcePath);
  });
  const outputs = new Set<string>();
  input.outputs.forEach((output, index) => {
    const source = input.sources.find((entry) => entry.sourcePath === output.sourcePath);
    const id = JSON.stringify([output.sourcePath, output.exportName]);
    if (!source || source.language === 'css' || outputs.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs', index], message: 'Each output must uniquely select a supplied React, Vue or HTML file.' });
    outputs.add(id);
  });
});
export type ProjectDesignRuntimeValidateArtifactsRequest = z.infer<typeof ProjectDesignRuntimeValidateArtifactsRequestSchema>;
export const ProjectDesignRuntimeValidateArtifactsResponseSchema = z.object({ revision: revisionSchema, result: StructuredDesignValidationResultSchema }).strict();
export type ProjectDesignRuntimeValidateArtifactsResponse = z.infer<typeof ProjectDesignRuntimeValidateArtifactsResponseSchema>;

export const ProjectDesignRuntimePatternsResponseSchema = z.object({ revision: revisionSchema, ...DesignPatternSearchResultSchema.shape }).strict();
export type ProjectDesignRuntimePatternsResponse = z.infer<typeof ProjectDesignRuntimePatternsResponseSchema>;
export const ProjectDesignRuntimePatternResponseSchema = z.object({ revision: revisionSchema, ...DesignPatternReadResultSchema.shape }).strict();
export type ProjectDesignRuntimePatternResponse = z.infer<typeof ProjectDesignRuntimePatternResponseSchema>;
export const ProjectDesignRuntimeInstantiatePatternRequestSchema = InstantiateDesignPatternRequestSchema.omit({ patternId: true }).extend({
  expectedRevision: revisionSchema, document: UIIRDocumentSchema,
}).strict();
export type ProjectDesignRuntimeInstantiatePatternRequest = z.infer<typeof ProjectDesignRuntimeInstantiatePatternRequestSchema>;
export const ProjectDesignRuntimeInstantiatePatternResponseSchema = z.object({ revision: revisionSchema }).passthrough().transform(({ revision, ...result }, ctx) => {
  const parsed = DesignPatternInstantiationResultSchema.safeParse(result);
  if (!parsed.success) { for (const issue of parsed.error.issues) ctx.addIssue(issue); return z.NEVER; }
  return { revision, ...parsed.data };
});
export type ProjectDesignRuntimeInstantiatePatternResponse = z.infer<typeof ProjectDesignRuntimeInstantiatePatternResponseSchema>;

/** Planned outputs are authoring intent; saving them does not certify source or semantic coverage. */
export const ProjectDesignRuntimeGenerationTargetsRequestSchema = z.object({ expectedRevision: revisionSchema, targets: DesignGenerationTargetsSchema }).strict();
export type ProjectDesignRuntimeGenerationTargetsRequest = z.infer<typeof ProjectDesignRuntimeGenerationTargetsRequestSchema>;
export const ProjectDesignRuntimeGenerationTargetsResponseSchema = z.object({ revision: revisionSchema, targets: DesignGenerationTargetsSchema }).strict();
export type ProjectDesignRuntimeGenerationTargetsResponse = z.infer<typeof ProjectDesignRuntimeGenerationTargetsResponseSchema>;

export const ProjectDesignRuntimeReviewLegacyMigrationRequestSchema = z.object({ expectedRevision: revisionSchema, plan: LegacyDesignSystemMigrationPlanSchema }).strict();
export type ProjectDesignRuntimeReviewLegacyMigrationRequest = z.infer<typeof ProjectDesignRuntimeReviewLegacyMigrationRequestSchema>;
export interface ProjectDesignRuntimeReviewLegacyMigrationResponse { revision: number; review: LegacyDesignSystemMigrationReview }
export const ProjectDesignRuntimeReviewLegacyMigrationResponseSchema: z.ZodType<ProjectDesignRuntimeReviewLegacyMigrationResponse> = z.object({ revision: revisionSchema, review: LegacyDesignSystemMigrationReviewSchema }).strict().superRefine((response, ctx) => {
  if (response.revision !== response.review.baseRevision) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revision'], message: 'The review must identify the exact project revision.' });
});
export const ProjectDesignRuntimeApplyLegacyMigrationRequestSchema = ProjectDesignRuntimeReviewLegacyMigrationRequestSchema.extend({
  reviewId: DesignEntityIdSchema, baseDigest: DesignSystemDigestSchema, planDigest: DesignSystemDigestSchema, sourceDigest: DesignSystemDigestSchema,
}).strict();
export type ProjectDesignRuntimeApplyLegacyMigrationRequest = z.infer<typeof ProjectDesignRuntimeApplyLegacyMigrationRequestSchema>;
export interface ProjectDesignRuntimeApplyLegacyMigrationResponse {
  state: ProjectDesignRuntimeState; review: LegacyDesignSystemMigrationReview; version: ProjectDesignRuntimeVersionSummary;
}
export const ProjectDesignRuntimeApplyLegacyMigrationResponseSchema: z.ZodType<ProjectDesignRuntimeApplyLegacyMigrationResponse> = z.object({
  state: ProjectDesignRuntimeStateSchema, review: LegacyDesignSystemMigrationReviewSchema, version: ProjectDesignRuntimeVersionSummarySchema,
}).strict().superRefine((response, ctx) => {
  const { state, review, version } = response;
  const candidate = review.candidate;
  const locked = state.lock.dependencies[0];
  if (!review.canApply || !candidate || state.revision !== review.baseRevision + 1 || state.codeIndex.id !== review.projectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['review'], message: 'Applied state must follow its applicable review by exactly one project revision.' });
  if (!candidate || version.id !== candidate.package.id || version.name !== candidate.package.name || version.version !== candidate.package.version || version.digest !== candidate.digest || version.sourceDigest !== candidate.sourceDigest
    || locked?.designSystemId !== version.id || locked.version !== version.version || locked.digest !== version.digest || locked.source.digest !== version.sourceDigest) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['version'], message: 'Applied migration must install the exact reviewed immutable package and source.' });
});
export { ComponentPreviewRequestSchema, ComponentPreviewResponseSchema, type ComponentPreviewRequest, type ComponentPreviewResponse } from '../design-runtime/component-preview.js';
