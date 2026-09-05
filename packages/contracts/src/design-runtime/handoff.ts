import { z } from 'zod';
import { CodeComponentIndexSchema, ComponentBindingRegistrySchema, type CodeComponentIndex, type ComponentBindingRegistry } from './code-index.js';
import { ComponentBindingSchema } from './component-binding.js';
import { ComponentRegistrySchema, type ComponentRegistry } from './component-registry.js';
import { ComponentFrameworkSchema, ComponentReferenceSchema, DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema, type ComponentFramework } from './common.js';
import { DesignSystemSemanticDiffSchema, type DesignSystemSemanticDiff } from './design-system-diff.js';
import { DesignSystemUpgradeReviewSchema, type DesignSystemUpgradeReview } from './design-system-upgrade.js';
import { DesignSystemSemVerSchema, DesignSystemVersionSchema, ProjectDesignSystemDependenciesSchema, ProjectDesignSystemLockSchema, type DesignSystemVersion, type ProjectDesignSystemDependencies, type ProjectDesignSystemLock } from './design-system-version.js';
import { ProjectCodeSourceEvidenceSchema, type ProjectCodeSourceEvidence } from './local-component-binding.js';
import { ProjectComponentRegistrySchema, type ProjectComponentRegistry } from './project-components.js';
import { SharedComponentPublishedRevisionSchema, type SharedComponentPublishedRevision } from './shared-component-changes.js';
import { UIIRDocumentSchema, type UIIRDocument } from './ui-ir.js';
import { ValidationDiagnosticSchema, type ValidationDiagnostic } from './validation.js';

/** A declaration (including ranges/tags/workspace protocols) is never installed-version evidence. */
export const HandoffTargetPackageSchema = z.object({
  name: z.string().min(1), declaredRange: z.string().min(1).optional(),
  installation: z.discriminatedUnion('status', [
    z.object({ status: z.literal('observed'), version: DesignSystemSemVerSchema }).strict(),
    z.object({ status: z.literal('unknown') }).strict(),
  ]),
}).strict();
export type HandoffTargetPackage = z.infer<typeof HandoffTargetPackageSchema>;

function unique(values: string[], path: string[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>(); values.forEach((value, index) => {
    if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message: 'Handoff identities must be unique.' });
    seen.add(value);
  });
}

/** Portable proof inputs: emitters can revalidate instead of trusting a stored ready flag. */
export const HandoffSnapshotSchema: z.ZodType<HandoffSnapshot> = z.object({
  registry: ComponentRegistrySchema.nullable(), projectComponents: ProjectComponentRegistrySchema,
  baseCodeIndex: CodeComponentIndexSchema, projectCodeIndex: CodeComponentIndexSchema,
  bindings: ComponentBindingRegistrySchema, document: UIIRDocumentSchema,
  dependencies: ProjectDesignSystemDependenciesSchema, lock: ProjectDesignSystemLockSchema,
  versions: z.array(DesignSystemVersionSchema), projectSources: z.array(ProjectCodeSourceEvidenceSchema),
  targetPackages: z.array(HandoffTargetPackageSchema),
}).strict().superRefine((snapshot, ctx) => {
  const projectId = snapshot.projectComponents.id;
  for (const key of ['projectCodeIndex', 'bindings', 'dependencies', 'lock'] as const) {
    if (snapshot[key].id !== projectId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, 'id'], message: 'Project handoff aggregates must share the project identity.' });
  }
  unique(snapshot.versions.map((version) => JSON.stringify([version.package.id, version.package.version])), ['versions'], ctx);
  unique(snapshot.projectSources.map((source) => source.codeComponentId), ['projectSources'], ctx);
  unique(snapshot.targetPackages.map((pkg) => pkg.name), ['targetPackages'], ctx);
});
export interface HandoffSnapshot {
  registry: ComponentRegistry | null; projectComponents: ProjectComponentRegistry;
  baseCodeIndex: CodeComponentIndex; projectCodeIndex: CodeComponentIndex; bindings: ComponentBindingRegistry;
  document: UIIRDocument; dependencies: ProjectDesignSystemDependencies; lock: ProjectDesignSystemLock;
  versions: DesignSystemVersion[]; projectSources: ProjectCodeSourceEvidence[]; targetPackages: HandoffTargetPackage[];
}

export const HandoffChangeContextSchema: z.ZodType<HandoffChangeContext> = z.object({
  semanticDiff: DesignSystemSemanticDiffSchema.optional(),
  /** Historical reviewed impact; current source/lock proof is performed independently. */
  upgradeReview: DesignSystemUpgradeReviewSchema.optional(),
  sharedRevisions: z.array(SharedComponentPublishedRevisionSchema).optional(),
}).strict().superRefine((context, ctx) => {
  unique((context.sharedRevisions ?? []).map((revision) => JSON.stringify([revision.componentRef, revision.definition.revision])), ['sharedRevisions'], ctx);
});
export interface HandoffChangeContext {
  semanticDiff?: DesignSystemSemanticDiff | undefined; upgradeReview?: DesignSystemUpgradeReview | undefined;
  sharedRevisions?: SharedComponentPublishedRevision[] | undefined;
}

const handoffFields = {
  id: DesignEntityIdSchema, projectId: DesignEntityIdSchema,
  projectRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  framework: ComponentFrameworkSchema, snapshot: HandoffSnapshotSchema,
  changeContext: HandoffChangeContextSchema.optional(),
};
export const CreateHandoffRequestSchema: z.ZodType<CreateHandoffRequest> = z.object(handoffFields).strict().superRefine((request, ctx) => {
  if (request.projectId !== request.snapshot.projectComponents.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'Handoff project identity must match the supplied snapshot.' });
});
export interface CreateHandoffRequest {
  id: string; projectId: string; projectRevision: number; framework: ComponentFramework;
  snapshot: HandoffSnapshot; changeContext?: HandoffChangeContext | undefined;
}

export const HandoffBindingCoverageSchema = z.object({
  componentRef: ComponentReferenceSchema, binding: ComponentBindingSchema.nullable(),
  ready: z.boolean(), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((coverage, ctx) => {
  if (coverage.binding && coverage.binding.componentRef !== coverage.componentRef) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['binding'], message: 'Coverage must identify the same design component as its binding.' });
  const errors = coverage.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (coverage.ready && (errors || coverage.binding?.status !== 'bound') || !coverage.ready && !errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ready'], message: 'Ready coverage requires a bound relationship without errors; missing coverage requires actionable diagnostics.' });
  if (coverage.ready && coverage.componentRef.startsWith('local:') && coverage.binding?.definitionRevision === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['binding', 'definitionRevision'], message: 'Ready local coverage requires explicit definition revision evidence.' });
});
export type HandoffBindingCoverage = z.infer<typeof HandoffBindingCoverageSchema>;

export const HandoffManifestSchema: z.ZodType<HandoffManifest> = z.object({
  ...handoffFields,
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  coverage: z.array(HandoffBindingCoverageSchema),
  ready: z.boolean(), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.projectId !== manifest.snapshot.projectComponents.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'Handoff project identity must match its supplied snapshot.' });
  unique(manifest.coverage.map((coverage) => coverage.componentRef), ['coverage'], ctx);
  const expectedReady = manifest.coverage.every((coverage) => coverage.ready) && !manifest.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (manifest.ready !== expectedReady) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ready'], message: 'Handoff readiness must include every required binding and diagnostic.' });
});
export interface HandoffManifest extends CreateHandoffRequest {
  schemaVersion: 1; coverage: HandoffBindingCoverage[]; ready: boolean; diagnostics: ValidationDiagnostic[];
}

export const HandoffBuildResultSchema: z.ZodType<HandoffBuildResult> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, manifest: HandoffManifestSchema.nullable(),
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((result, ctx) => {
  if (!result.manifest && !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['manifest'], message: 'A missing manifest requires error diagnostics.' });
  if (result.manifest && JSON.stringify(result.diagnostics) !== JSON.stringify(result.manifest.diagnostics)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['diagnostics'], message: 'Build diagnostics must preserve the complete manifest diagnostics.' });
});
export interface HandoffBuildResult { schemaVersion: 1; manifest: HandoffManifest | null; diagnostics: ValidationDiagnostic[] }

export const HandoffScreenOutputSchema = z.object({ screenId: DesignEntityIdSchema, sourcePath: SourcePathSchema, exportName: z.string().min(1) }).strict();
export type HandoffScreenOutput = z.infer<typeof HandoffScreenOutputSchema>;
export const EmitHandoffCodeRequestSchema: z.ZodType<EmitHandoffCodeRequest> = z.object({ manifest: HandoffManifestSchema, outputs: z.array(HandoffScreenOutputSchema) }).strict();
export interface EmitHandoffCodeRequest { manifest: HandoffManifest; outputs: HandoffScreenOutput[] }
export const HandoffCodeFileSchema = HandoffScreenOutputSchema.extend({ language: z.enum(['tsx', 'vue']), content: z.string() }).strict();
export type HandoffCodeFile = z.infer<typeof HandoffCodeFileSchema>;
export const HandoffCodeResultSchema: z.ZodType<HandoffCodeResult> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, ok: z.boolean(), files: z.array(HandoffCodeFileSchema), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((result, ctx) => {
  const errors = result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (result.ok === errors || !result.ok && result.files.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'Code emission is all-or-nothing, with errors on failure.' });
  unique(result.files.map((file) => file.screenId), ['files'], ctx);
  unique(result.files.map((file) => file.sourcePath.normalize('NFC').toLowerCase()), ['files'], ctx);
});
export interface HandoffCodeResult { schemaVersion: 1; ok: boolean; files: HandoffCodeFile[]; diagnostics: ValidationDiagnostic[] }
