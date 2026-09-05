import { z } from 'zod';
import { DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema } from './common.js';
import {
  LocalComponentReferenceSchema,
  ProjectComponentDefinitionSchema,
  ProjectComponentRegistrySchema,
  ReferenceGraphQueryResultSchema,
  ResolvedUIIRResultSchema,
} from './project-components.js';
import { ValidationDiagnosticSchema } from './validation.js';

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const publishedRevisionSchema = revisionSchema.refine((revision) => revision > 0, 'Published definition revisions start at 1.');

export const SharedComponentDraftSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  componentRef: LocalComponentReferenceSchema,
  baseDefinition: ProjectComponentDefinitionSchema.nullable(),
  proposedDefinition: ProjectComponentDefinitionSchema,
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('edit') }).strict(),
    z.object({ type: z.literal('undo'), definitionRevision: publishedRevisionSchema }).strict(),
  ]),
}).strict().superRefine((draft, ctx) => {
  if (draft.componentRef !== `local:${draft.proposedDefinition.id}`
    || (draft.baseDefinition && draft.componentRef !== `local:${draft.baseDefinition.id}`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['componentRef'], message: 'Draft and definition identities must agree.' });
  }
  if (draft.proposedDefinition.revision !== (draft.baseDefinition?.revision ?? 0) + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proposedDefinition', 'revision'], message: 'A draft advances its published definition by exactly one revision.' });
  }
  if (draft.source.type === 'undo' && (!draft.baseDefinition || draft.source.definitionRevision >= draft.baseDefinition.revision)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'definitionRevision'], message: 'Undo restores content from an earlier published revision.' });
  }
});
export type SharedComponentDraft = z.infer<typeof SharedComponentDraftSchema>;

/** Immutable snapshot identity is (componentRef, definition.revision); null marks an imported baseline. */
export const SharedComponentPublishedRevisionSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  componentRef: LocalComponentReferenceSchema,
  definition: ProjectComponentDefinitionSchema,
  changeId: DesignEntityIdSchema.nullable(),
}).strict().superRefine((entry, ctx) => {
  if (entry.componentRef !== `local:${entry.definition.id}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['componentRef'], message: 'History snapshot identity must match its component.' });
  }
});
export type SharedComponentPublishedRevision = z.infer<typeof SharedComponentPublishedRevisionSchema>;

export const SharedComponentChangeStateSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  drafts: z.array(SharedComponentDraftSchema),
  history: z.array(SharedComponentPublishedRevisionSchema),
}).strict().superRefine((state, ctx) => {
  const changeIds = new Set<string>();
  const revisions = new Set<string>();
  const baselines = new Set<string>();
  state.history.forEach((entry, index) => {
    const key = JSON.stringify([entry.componentRef, entry.definition.revision]);
    if (revisions.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['history', index], message: 'Duplicate published component revision.' });
    revisions.add(key);
    if (entry.changeId === null) {
      if (baselines.has(entry.componentRef)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['history', index, 'changeId'], message: 'Each component can capture its imported baseline only once.' });
      baselines.add(entry.componentRef);
    }
    if (entry.changeId !== null) {
      if (changeIds.has(entry.changeId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['history', index, 'changeId'], message: 'Published change IDs must be unique.' });
      changeIds.add(entry.changeId);
    }
  });
  const components = new Set<string>();
  state.drafts.forEach((draft, index) => {
    if (changeIds.has(draft.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['drafts', index, 'id'], message: 'Draft IDs cannot be reused across pending or published changes.' });
    if (components.has(draft.componentRef)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['drafts', index, 'componentRef'], message: 'Only one pending draft per component is allowed.' });
    changeIds.add(draft.id);
    components.add(draft.componentRef);
    if (draft.source.type === 'undo' && !revisions.has(JSON.stringify([draft.componentRef, draft.source.definitionRevision]))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['drafts', index, 'source'], message: 'Undo must identify an immutable published snapshot in history.' });
    }
  });
});
export type SharedComponentChangeState = z.infer<typeof SharedComponentChangeStateSchema>;

/** Current errors remain visible in current; diagnostics describes whether the proposed project can publish. */
export const SharedComponentImpactSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  componentRef: LocalComponentReferenceSchema,
  baseRevision: revisionSchema,
  proposedRevision: publishedRevisionSchema,
  usages: ReferenceGraphQueryResultSchema,
  current: ResolvedUIIRResultSchema,
  proposed: ResolvedUIIRResultSchema,
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((impact, ctx) => {
  if (impact.usages.target !== impact.componentRef) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['usages', 'target'], message: 'Impact usages must query the changed component.' });
  if (impact.proposedRevision !== impact.baseRevision + 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proposedRevision'], message: 'Impact must describe the next definition revision.' });
  if (impact.current.document && impact.proposed.document && impact.current.document.id !== impact.proposed.document.id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['proposed', 'document', 'id'], message: 'Impact compares the same semantic document.' });
  }
  const hasProposedErrors = [...impact.proposed.diagnostics, ...impact.usages.diagnostics].some((diagnostic) => diagnostic.severity === 'error');
  if (hasProposedErrors && !impact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['diagnostics'], message: 'Impact cannot hide proposed validation or incomplete-graph errors.' });
  }
});
export type SharedComponentImpact = z.infer<typeof SharedComponentImpactSchema>;

export const StageSharedComponentChangeRequestSchema = z.object({
  draftId: DesignEntityIdSchema,
  expectedDefinitionRevision: revisionSchema,
  definition: ProjectComponentDefinitionSchema,
}).strict().superRefine((request, ctx) => {
  if (request.definition.revision !== request.expectedDefinitionRevision + 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['definition', 'revision'], message: 'Proposed revision must follow expectedDefinitionRevision.' });
  }
});
export type StageSharedComponentChangeRequest = z.infer<typeof StageSharedComponentChangeRequestSchema>;

export const PublishSharedComponentChangeRequestSchema = z.object({
  draftId: DesignEntityIdSchema,
  expectedDefinitionRevision: revisionSchema,
}).strict();
export type PublishSharedComponentChangeRequest = z.infer<typeof PublishSharedComponentChangeRequestSchema>;

export const StageSharedComponentUndoRequestSchema = z.object({
  draftId: DesignEntityIdSchema,
  componentRef: LocalComponentReferenceSchema,
  expectedDefinitionRevision: publishedRevisionSchema,
  restoreDefinitionRevision: publishedRevisionSchema,
}).strict().superRefine((request, ctx) => {
  if (request.restoreDefinitionRevision >= request.expectedDefinitionRevision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['restoreDefinitionRevision'], message: 'Undo restores an earlier published revision as new content.' });
  }
});
export type StageSharedComponentUndoRequest = z.infer<typeof StageSharedComponentUndoRequestSchema>;

export const SharedComponentStageResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  changes: SharedComponentChangeStateSchema,
  draft: SharedComponentDraftSchema,
  impact: SharedComponentImpactSchema,
}).strict().superRefine((result, ctx) => {
  const stored = result.changes.drafts.find((draft) => draft.id === result.draft.id);
  if (!stored || stored.componentRef !== result.draft.componentRef || stored.proposedDefinition.revision !== result.draft.proposedDefinition.revision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', 'drafts'], message: 'Staged result must contain its returned draft.' });
  }
  if (result.impact.componentRef !== result.draft.componentRef || result.impact.proposedRevision !== result.draft.proposedDefinition.revision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['impact'], message: 'Staged impact must describe its returned draft.' });
  }
});
export type SharedComponentStageResult = z.infer<typeof SharedComponentStageResultSchema>;

export const SharedComponentPublishResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  changes: SharedComponentChangeStateSchema,
  projectComponents: ProjectComponentRegistrySchema,
  impact: SharedComponentImpactSchema,
}).strict().superRefine((result, ctx) => {
  if (result.changes.id !== result.projectComponents.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', 'id'], message: 'Published definitions and history must belong to the same project.' });
  const definition = result.projectComponents.components.find((component) => `local:${component.id}` === result.impact.componentRef);
  if (!definition || definition.revision !== result.impact.proposedRevision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectComponents'], message: 'Published registry must contain the proposed revision.' });
  }
  if (!result.changes.history.some((entry) => entry.componentRef === result.impact.componentRef && entry.definition.revision === result.impact.proposedRevision && entry.changeId !== null)
    || result.changes.drafts.some((draft) => draft.componentRef === result.impact.componentRef)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes'], message: 'Publish must archive its revision and remove the component draft.' });
  }
  if (result.impact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['impact', 'diagnostics'], message: 'A published result cannot contain blocking impact errors.' });
  }
});
export type SharedComponentPublishResult = z.infer<typeof SharedComponentPublishResultSchema>;

/** An explicit graph rewrite can revise several surviving definitions in one atomic operation. */
export const SharedComponentRegistryChangeResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  projectComponents: ProjectComponentRegistrySchema,
  changes: SharedComponentChangeStateSchema,
  resolved: ResolvedUIIRResultSchema,
}).strict().superRefine((result, ctx) => {
  if (result.changes.id !== result.projectComponents.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', 'id'], message: 'Registry rewrites and history must belong to the same project.' });
  if (result.resolved.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resolved'], message: 'A committed registry rewrite must have no validation errors.' });
  }
});
export type SharedComponentRegistryChangeResult = z.infer<typeof SharedComponentRegistryChangeResultSchema>;
