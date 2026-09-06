import { z } from 'zod';
import { ComponentCompilationSelectionSchema, ComponentStorySourceSelectionSchema, CompileComponentRegistryRequestSchema, type ComponentCompilationSelection } from './code-index.js';
import { ComponentReferenceSchema, DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema } from './common.js';
import { DesignConstraintSetSchema, type DesignConstraintSet } from './design-constraints.js';
import { DesignTokenSchema } from './design-tokens.js';
import { DesignSystemDigestSchema, DesignSystemPackageSchema, DesignSystemSemVerSchema, DesignSystemSourceBundleSchema, DesignSystemVersionSchema, type DesignSystemPackage, type DesignSystemVersion } from './design-system-version.js';
import { ValidationDiagnosticSchema, type ValidationDiagnostic } from './validation.js';

export type LegacyMigrationComponentSelection = Omit<ComponentCompilationSelection, 'sourceText' | 'storySources'> & {
  storySources?: Omit<NonNullable<ComponentCompilationSelection['storySources']>[number], 'sourceText'>[] | undefined;
};
export interface LegacyDesignSystemMigrationPlan {
  schemaVersion: 1;
  designSystemId: string;
  name: string;
  version: string;
  mode: 'explore' | 'guided';
  sourcePaths: string[];
  tokenStylesheet?: string | undefined;
  selections: LegacyMigrationComponentSelection[];
  constraints: DesignConstraintSet;
  codeCompatibility: DesignSystemPackage['codeCompatibility'];
}
const sourceSelection = ComponentCompilationSelectionSchema.omit({ sourceText: true }).extend({
  storySources: z.array(ComponentStorySourceSelectionSchema.omit({ sourceText: true })).min(1).optional(),
});
/** Authoring selections only: the daemon reads and proves every selected source. */
export const LegacyDesignSystemMigrationPlanSchema: z.ZodType<LegacyDesignSystemMigrationPlan> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  designSystemId: DesignEntityIdSchema,
  name: z.string().min(1),
  version: DesignSystemSemVerSchema,
  mode: z.enum(['explore', 'guided']),
  sourcePaths: z.array(SourcePathSchema).min(1),
  tokenStylesheet: SourcePathSchema.optional(),
  selections: z.array(sourceSelection),
  constraints: DesignConstraintSetSchema,
  codeCompatibility: DesignSystemPackageSchema.innerType().shape.codeCompatibility,
}).strict().superRefine((plan, ctx) => {
  const bundle = DesignSystemSourceBundleSchema.safeParse({ schemaVersion: 1, files: plan.sourcePaths.map((path) => ({ path, encoding: 'utf8', content: '' })) });
  if (!bundle.success) for (const issue of bundle.error.issues) ctx.addIssue({ ...issue, path: ['sourcePaths', ...issue.path] });
  const paths = new Set(plan.sourcePaths);
  const requiredPaths = [plan.tokenStylesheet, ...plan.selections.flatMap((selection) => [selection.sourcePath, ...selection.storySources?.map((source) => source.sourcePath) ?? []])];
  for (const path of requiredPaths) if (path !== undefined && !paths.has(path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourcePaths'], message: `Selected source ${path} must be explicitly included in sourcePaths.` });
  if (plan.selections.length) {
    const compiled = CompileComponentRegistryRequestSchema.safeParse({ designSystemId: plan.designSystemId,
      selections: plan.selections.map((selection) => ({ ...selection, sourceText: '',
        ...(selection.storySources ? { storySources: selection.storySources.map((source) => ({ ...source, sourceText: '' })) } : {}),
      })),
    });
    if (!compiled.success) for (const issue of compiled.error.issues) ctx.addIssue(issue);
  }
  const compatibility = new Set<string>();
  for (const [index, entry] of plan.codeCompatibility.entries()) {
    const key = JSON.stringify([entry.framework, entry.packageName]);
    if (compatibility.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['codeCompatibility', index], message: 'Each framework/package pair needs one compatibility declaration.' });
    compatibility.add(key);
  }
});

const tokenRecordFields = { cssVariable: z.string().min(1), sourcePath: SourcePathSchema, line: z.number().int().positive(), sourceValue: z.string() };
export const LegacyDesignTokenMigrationRecordSchema = z.discriminatedUnion('status', [
  z.object({ ...tokenRecordFields, status: z.literal('converted'), token: DesignTokenSchema }).strict(),
  z.object({ ...tokenRecordFields, status: z.literal('unresolved'), reason: z.enum(['unsupported-value', 'unsupported-token', 'unsupported-context', 'conflicting-declarations', 'invalid-name']) }).strict(),
]).superRefine((record, ctx) => {
  if (record.status === 'converted' && (record.token.cssVariable !== record.cssVariable || record.token.source?.sourcePath !== record.sourcePath || record.token.source.line !== record.line)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['token'], message: 'Converted tokens must retain their exact declaration provenance.' });
  }
});
export type LegacyDesignTokenMigrationRecord = z.infer<typeof LegacyDesignTokenMigrationRecordSchema>;

export interface LegacyDesignSystemMigrationReview {
  schemaVersion: 1;
  id: string;
  projectId: string;
  baseRevision: number;
  baseDigest: string;
  planDigest: string;
  sourceDigest: string;
  files: { path: string; digest: string; byteLength: number }[];
  candidate: DesignSystemVersion | null;
  tokens: LegacyDesignTokenMigrationRecord[];
  compiledComponentRefs: string[];
  /** Every selected original file is preserved byte-for-byte, including unresolved reference material. */
  preservedSourcePaths: string[];
  diagnostics: ValidationDiagnostic[];
  canApply: boolean;
}
const unique = (values: string[]) => new Set(values).size === values.length;
export const LegacyDesignSystemMigrationReviewSchema: z.ZodType<LegacyDesignSystemMigrationReview> = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  projectId: DesignEntityIdSchema,
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  baseDigest: DesignSystemDigestSchema, planDigest: DesignSystemDigestSchema, sourceDigest: DesignSystemDigestSchema,
  files: z.array(z.object({ path: SourcePathSchema, digest: DesignSystemDigestSchema, byteLength: z.number().int().nonnegative() }).strict()).min(1),
  candidate: DesignSystemVersionSchema.nullable(),
  tokens: z.array(LegacyDesignTokenMigrationRecordSchema),
  compiledComponentRefs: z.array(ComponentReferenceSchema).refine(unique, 'Compiled component references must be unique.'),
  preservedSourcePaths: z.array(SourcePathSchema).min(1).refine(unique, 'Preserved source paths must be unique.'),
  diagnostics: z.array(ValidationDiagnosticSchema), canApply: z.boolean(),
}).strict().superRefine((review, ctx) => {
  const paths = review.files.map((file) => file.path);
  const samePaths = (other: string[]) => other.length === paths.length && other.every((path) => paths.includes(path));
  if (!unique(paths) || !samePaths(review.preservedSourcePaths)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['preservedSourcePaths'], message: 'The complete unique selected source inventory must be preserved.' });
  for (const [index, record] of review.tokens.entries()) if (!paths.includes(record.sourcePath)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokens', index], message: 'Token evidence must refer to a selected source.' });
  const converted = review.tokens.filter((record) => record.status === 'converted');
  if (review.canApply && (!review.candidate || review.diagnostics.some((diagnostic) => diagnostic.severity === 'error') || !converted.length && !review.compiledComponentRefs.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['canApply'], message: 'Applying requires a valid candidate with converted facts and no error diagnostics.' });
  }
  if (review.candidate) {
    const { package: pkg } = review.candidate;
    if (review.candidate.sourceDigest !== review.sourceDigest || !samePaths(pkg.source.files.map((file) => file.path))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['candidate'], message: 'The candidate must freeze the exact reviewed source inventory and digest.' });
    const refs = pkg.registry.components.map((component) => `ds:${pkg.id}/${component.id}`);
    if (refs.length !== review.compiledComponentRefs.length || !review.compiledComponentRefs.every((ref) => refs.includes(ref))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compiledComponentRefs'], message: 'All packaged components must have an explicit compiled selection.' });
    if (converted.length !== pkg.tokens.tokens.length || !unique(converted.map((record) => record.token.id)) || !converted.every((record) => pkg.tokens.tokens.some((token) => JSON.stringify(token) === JSON.stringify(record.token)))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tokens'], message: 'The candidate must contain exactly the converted token evidence.' });
  }
});
