import { z } from 'zod';
import {
  CodeComponentDefinitionSchema,
  CodeComponentIndexSchema,
  ComponentBindingRegistrySchema,
  ComponentBindingSchema,
  ComponentCompilationSelectionSchema,
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
  ValidationDiagnosticSchema,
} from '../design-runtime/index.js';

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** One atomically persisted project snapshot; source text remains in project files. */
export const ProjectDesignRuntimeStateSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  revision: revisionSchema,
  registry: ComponentRegistrySchema.nullable(),
  codeIndex: CodeComponentIndexSchema,
  bindings: ComponentBindingRegistrySchema,
  projectComponents: ProjectComponentRegistrySchema,
  document: UIIRDocumentSchema.nullable(),
  sharedChanges: SharedComponentChangeStateSchema,
}).strict().superRefine((state, ctx) => {
  if ([state.bindings.id, state.projectComponents.id, state.sharedChanges.id].some((id) => id !== state.codeIndex.id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', 'id'], message: 'All project runtime registries and change state must share a project identity.' });
  }
  if (state.registry === null && (state.codeIndex.components.length || state.bindings.bindings.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['registry'], message: 'An uncompiled project cannot contain code components or bindings.' });
  }
});
export type ProjectDesignRuntimeState = z.infer<typeof ProjectDesignRuntimeStateSchema>;

export const ProjectDesignRuntimeResponseSchema = z.object({ state: ProjectDesignRuntimeStateSchema }).strict();
export type ProjectDesignRuntimeResponse = z.infer<typeof ProjectDesignRuntimeResponseSchema>;

export const ProjectDesignRuntimeCompileRequestSchema = z.object({
  expectedRevision: revisionSchema,
  designSystemId: DesignEntityIdSchema,
  selections: z.array(ComponentCompilationSelectionSchema.omit({ sourceText: true })).min(1),
}).strict().superRefine((request, ctx) => {
  const checked = CompileComponentRegistryRequestSchema.safeParse({
    designSystemId: request.designSystemId,
    selections: request.selections.map((selection) => ({ ...selection, sourceText: '' })),
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
