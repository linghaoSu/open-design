import { z } from 'zod';
import { ComponentFrameworkSchema, DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema, type ComponentFramework } from './common.js';
import { DesignSystemDigestSchema, DesignSystemSemVerSchema } from './design-system-identity.js';
import { ApplyDesignSystemUpgradeRequestSchema, type ApplyDesignSystemUpgradeRequest } from './design-system-upgrade.js';
import { HandoffScreenOutputSchema, HandoffTargetPackageSchema, type HandoffScreenOutput, type HandoffTargetPackage } from './handoff.js';
import { ProjectDesignSystemLockSchema, type ProjectDesignSystemLock } from './design-system-version.js';
import { ComponentReferenceScreenOwnerSchema, ResolvedNodeOriginSchema, type ComponentReferenceScreenOwner, type ResolvedNodeOrigin } from './project-components.js';
import { ValidationDiagnosticSchema, type ValidationDiagnostic } from './validation.js';

export const DesignPreviewKindSchema = z.enum(['semantic-design', 'production-handoff']);
export type DesignPreviewKind = z.infer<typeof DesignPreviewKindSchema>;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const DesignPreviewComparisonSchema: z.ZodType<DesignPreviewComparison> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shared-draft'), draftId: DesignEntityIdSchema, expectedDefinitionRevision: revision }).strict(),
  z.object({ type: z.literal('upgrade'), proof: ApplyDesignSystemUpgradeRequestSchema }).strict(),
]);
export type DesignPreviewComparison = { type: 'shared-draft'; draftId: string; expectedDefinitionRevision: number } | { type: 'upgrade'; proof: ApplyDesignSystemUpgradeRequest };

/** Source bytes, roots, installed observations and prepared snapshots are daemon-owned. */
export const ProjectDesignPreviewRequestSchema: z.ZodType<ProjectDesignPreviewRequest> = z.object({
  expectedRevision: revision, id: DesignEntityIdSchema, framework: ComponentFrameworkSchema, kind: DesignPreviewKindSchema,
  screenIds: z.array(DesignEntityIdSchema).min(1).max(6), outputs: z.array(HandoffScreenOutputSchema).max(6).optional(),
  comparison: DesignPreviewComparisonSchema.optional(),
}).strict().superRefine((request, ctx) => {
  if (new Set(request.screenIds).size !== request.screenIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screenIds'], message: 'Preview screens must be unique.' });
  if (request.outputs && (request.outputs.length !== request.screenIds.length || new Set(request.outputs.map((output) => output.screenId)).size !== request.screenIds.length || request.outputs.some((output) => !request.screenIds.includes(output.screenId)))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputs'], message: 'Authored preview outputs must cover each selected screen exactly once.' });
});
export interface ProjectDesignPreviewRequest {
  expectedRevision: number; id: string; framework: ComponentFramework; kind: DesignPreviewKind; screenIds: string[];
  outputs?: HandoffScreenOutput[] | undefined; comparison?: DesignPreviewComparison | undefined;
}
export const DesignPreviewSourceEvidenceSchema = z.object({
  sourcePath: z.string().min(1), digest: DesignSystemDigestSchema, byteLength: z.number().int().nonnegative().max(4 * 1024 * 1024),
  origin: z.enum(['frozen-design-system', 'current-project', 'installed-package', 'tool-runtime', 'generated']),
  packageName: z.string().min(1).optional(), version: DesignSystemSemVerSchema.optional(),
}).strict();
export type DesignPreviewSourceEvidence = z.infer<typeof DesignPreviewSourceEvidenceSchema>;
export const DesignPreviewBundleSchema = z.object({ javascript: z.string().max(8 * 1024 * 1024), css: z.string().max(2 * 1024 * 1024), digest: DesignSystemDigestSchema }).strict();
export type DesignPreviewBundle = z.infer<typeof DesignPreviewBundleSchema>;
export const DesignPreviewScreenSchema = z.object({
  screenId: DesignEntityIdSchema, sourcePath: SourcePathSchema, exportName: z.string().min(1),
  bundle: DesignPreviewBundleSchema.nullable(), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((screen, ctx) => {
  const errors = screen.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (screen.bundle !== null && errors || screen.bundle === null && !errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundle'], message: 'A renderable bundle requires no screen errors; a missing bundle requires actionable errors.' });
});
export type DesignPreviewScreen = z.infer<typeof DesignPreviewScreenSchema>;
export const DesignPreviewRuntimeSchema = z.object({ name: z.enum(['react', 'react-dom', 'vue']), version: DesignSystemSemVerSchema, origin: z.literal('tool-runtime') }).strict();
export type DesignPreviewRuntime = z.infer<typeof DesignPreviewRuntimeSchema>;
export const DesignPreviewSideSchema: z.ZodType<DesignPreviewSide> = z.object({
  role: z.enum(['current', 'proposed']), kind: DesignPreviewKindSchema, lock: ProjectDesignSystemLockSchema,
  origins: z.array(ResolvedNodeOriginSchema), sourceEvidence: z.array(DesignPreviewSourceEvidenceSchema).max(256),
  sourceDigest: DesignSystemDigestSchema, runtimePackages: z.array(DesignPreviewRuntimeSchema), targetPackages: z.array(HandoffTargetPackageSchema),
  screens: z.array(DesignPreviewScreenSchema).min(1).max(6), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((side, ctx) => {
  if (new Set(side.screens.map((screen) => screen.screenId)).size !== side.screens.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screens'], message: 'Each side must contain unique screen identities.' });
  const keys = side.sourceEvidence.map((source) => JSON.stringify([source.origin, source.packageName, source.version, source.sourcePath]));
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceEvidence'], message: 'Source evidence identities must be unique.' });
  if (side.sourceEvidence.reduce((total, entry) => total + entry.byteLength, 0) > 24 * 1024 * 1024) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceEvidence'], message: 'Preview source evidence exceeds its aggregate byte budget.' });
  if (side.diagnostics.some((entry) => entry.severity === 'error') && side.screens.some((screen) => screen.bundle !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screens'], message: 'Side-wide validation errors cannot accompany renderable bundles.' });
});
export interface DesignPreviewSide {
  role: 'current' | 'proposed'; kind: DesignPreviewKind; lock: ProjectDesignSystemLock; origins: ResolvedNodeOrigin[];
  sourceEvidence: DesignPreviewSourceEvidence[]; sourceDigest: string; runtimePackages: DesignPreviewRuntime[];
  targetPackages: HandoffTargetPackage[]; screens: DesignPreviewScreen[]; diagnostics: ValidationDiagnostic[];
}
/** Graph/review impact remains separate from the caller-selected visual sample. */
export const DesignPreviewImpactSchema = z.object({
  source: z.enum(['shared-reference-graph', 'reviewed-upgrade', 'none']),
  affectedScreens: z.array(ComponentReferenceScreenOwnerSchema), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((impact, ctx) => {
  const keys = impact.affectedScreens.map((screen) => JSON.stringify([screen.documentId, screen.screenId]));
  if (new Set(keys).size !== keys.length || impact.source === 'none' && keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['affectedScreens'], message: 'Impact must retain unique screens from an explicit graph or review.' });
});
export interface DesignPreviewImpact { source: 'shared-reference-graph' | 'reviewed-upgrade' | 'none'; affectedScreens: ComponentReferenceScreenOwner[]; diagnostics: ValidationDiagnostic[] }
export const ProjectDesignPreviewResultSchema: z.ZodType<ProjectDesignPreviewResult> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, projectId: DesignEntityIdSchema, revision,
  request: ProjectDesignPreviewRequestSchema, requestDigest: DesignSystemDigestSchema, sides: z.array(DesignPreviewSideSchema).min(1).max(2),
  impact: DesignPreviewImpactSchema, diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((result, ctx) => {
  if (result.revision !== result.request.expectedRevision) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['revision'], message: 'Preview belongs to its exact selected project revision.' });
  const impactSource = result.request.comparison?.type === 'shared-draft' ? 'shared-reference-graph' : result.request.comparison?.type === 'upgrade' ? 'reviewed-upgrade' : 'none';
  if (result.impact.source !== impactSource) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['impact'], message: 'Impact evidence must match the selected comparison.' });
  if (result.sides.length !== (result.request.comparison ? 2 : 1) || result.sides[0]?.role !== 'current' || result.sides[1] && result.sides[1].role !== 'proposed') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sides'], message: 'Preview sides must preserve current/proposed comparison identity.' });
  result.sides.forEach((side, index) => {
    if (side.kind !== result.request.kind || side.lock.id !== result.projectId || side.screens.length !== result.request.screenIds.length || side.screens.some((screen) => !result.request.screenIds.includes(screen.screenId))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sides', index], message: 'Preview evidence must match the requested kind, project and complete selected screens.' });
  });
});
export interface ProjectDesignPreviewResult { schemaVersion: 1; projectId: string; revision: number; request: ProjectDesignPreviewRequest; requestDigest: string; impact: DesignPreviewImpact; sides: DesignPreviewSide[]; diagnostics: ValidationDiagnostic[] }
