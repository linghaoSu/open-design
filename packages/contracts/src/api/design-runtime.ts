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
}).strict().superRefine((state, ctx) => {
  if (state.codeIndex.id !== state.bindings.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bindings', 'id'], message: 'Project index and binding registry identities must match.' });
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
