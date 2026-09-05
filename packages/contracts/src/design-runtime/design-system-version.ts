import { z } from 'zod';
import { CodeComponentIndexSchema, ComponentBindingRegistrySchema } from './code-index.js';
import { ComponentRegistrySchema } from './component-registry.js';
import { ComponentFrameworkSchema, DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema } from './common.js';
import { DesignConstraintSetSchema } from './design-constraints.js';
import { DesignPatternRegistrySchema } from './design-patterns.js';
import { DesignTokenRegistrySchema } from './design-tokens.js';
import { DesignSystemMigrationRecipeSchema } from './migration-recipes.js';
import { refineDesignSystemMigrationRules } from './migration-rules.js';
import { ValidationDiagnosticSchema } from './validation.js';

import { DesignSystemSemVerSchema, DesignSystemVersionRangeSchema, DesignSystemDigestSchema } from './design-system-identity.js';
export * from './design-system-identity.js';

const sourceFields = { path: SourcePathSchema };
export const DesignSystemSourceFileSchema = z.discriminatedUnion('encoding', [
  z.object({ ...sourceFields, encoding: z.literal('utf8'), content: z.string() }).strict(),
  z.object({ ...sourceFields, encoding: z.literal('base64'), content: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict(),
]);
export type DesignSystemSourceFile = z.infer<typeof DesignSystemSourceFileSchema>;
export const DesignSystemSourceBundleSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  files: z.array(DesignSystemSourceFileSchema).min(1),
}).strict().superRefine((bundle, ctx) => {
  const paths = new Set<string>();
  bundle.files.forEach((file, index) => {
    // Content-addressed bundles must also materialize without case/Unicode path aliases.
    const key = file.path.normalize('NFC').toLowerCase();
    if (paths.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', index, 'path'], message: 'Source paths must be unique without case or Unicode aliases.' });
    paths.add(key);
  });
  for (const [index, file] of bundle.files.entries()) {
    const parts = file.path.normalize('NFC').toLowerCase().split('/');
    for (let length = 1; length < parts.length; length++) {
      if (paths.has(parts.slice(0, length).join('/'))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', index, 'path'], message: 'Source files cannot also be ancestors of another source path.' });
    }
  }
});
export type DesignSystemSourceBundle = z.infer<typeof DesignSystemSourceBundleSchema>;

export const DesignSystemPackageSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  name: z.string().min(1),
  version: DesignSystemSemVerSchema,
  registry: ComponentRegistrySchema,
  codeIndex: CodeComponentIndexSchema,
  bindings: ComponentBindingRegistrySchema,
  tokens: DesignTokenRegistrySchema,
  patterns: DesignPatternRegistrySchema,
  constraints: DesignConstraintSetSchema,
  codeCompatibility: z.array(z.object({ framework: ComponentFrameworkSchema, packageName: z.string().min(1), version: DesignSystemVersionRangeSchema }).strict()),
  source: DesignSystemSourceBundleSchema,
  /** Absence stays absent so existing immutable package digests remain valid. */
  migrations: z.array(DesignSystemMigrationRecipeSchema).optional(),
  /** Provenance only. Frozen bundle bytes, never a mutable checkout, are rendering authority. */
  origin: z.object({ type: z.literal('git'), repository: z.string().url(), commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict().optional(),
}).strict().superRefine((pkg, ctx) => {
  for (const key of ['registry', 'codeIndex', 'bindings', 'tokens', 'patterns'] as const) {
    if (pkg[key].id !== pkg.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, 'id'], message: 'Packaged registries must share the immutable design-system identity.' });
  }
  const recipeIds = new Set<string>();
  for (const [index, recipe] of (pkg.migrations ?? []).entries()) {
    if (recipeIds.has(recipe.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['migrations', index, 'id'], message: 'Migration recipe IDs must be unique.' });
    recipeIds.add(recipe.id);
    refineDesignSystemMigrationRules(recipe.rules, { ...ctx, addIssue: (issue) => ctx.addIssue({ ...issue, path: ['migrations', index, ...(issue.path ?? [])] }) }, pkg.id);
  }
  const targets = new Set<string>();
  pkg.codeCompatibility.forEach((entry, index) => {
    const key = JSON.stringify([entry.framework, entry.packageName]);
    if (targets.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['codeCompatibility', index], message: 'Each framework/package pair needs one compatibility declaration.' });
    targets.add(key);
  });
});
export type DesignSystemPackage = z.infer<typeof DesignSystemPackageSchema>;

export const DesignSystemVersionSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  package: DesignSystemPackageSchema,
  digest: DesignSystemDigestSchema,
  sourceDigest: DesignSystemDigestSchema,
}).strict();
export type DesignSystemVersion = z.infer<typeof DesignSystemVersionSchema>;
export const DesignSystemVersionCatalogSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, id: DesignEntityIdSchema, versions: z.array(DesignSystemVersionSchema),
}).strict().superRefine((catalog, ctx) => {
  const identities = new Set<string>();
  catalog.versions.forEach((entry, index) => {
    const key = JSON.stringify([entry.package.id, entry.package.version]);
    if (identities.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', index], message: 'Published design-system version identities are immutable and unique.' });
    identities.add(key);
  });
});
export type DesignSystemVersionCatalog = z.infer<typeof DesignSystemVersionCatalogSchema>;

export const DesignSystemDependencySchema = z.object({ designSystemId: DesignEntityIdSchema, version: DesignSystemVersionRangeSchema }).strict();
export type DesignSystemDependency = z.infer<typeof DesignSystemDependencySchema>;
export const DesignSystemLockedDependencySchema = z.object({
  designSystemId: DesignEntityIdSchema, version: DesignSystemSemVerSchema, digest: DesignSystemDigestSchema,
  source: z.object({ type: z.literal('bundle'), digest: DesignSystemDigestSchema }).strict(),
}).strict();
export type DesignSystemLockedDependency = z.infer<typeof DesignSystemLockedDependencySchema>;
function uniqueDependencies(entries: { designSystemId: string }[], ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  entries.forEach((entry, index) => {
    if (ids.has(entry.designSystemId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dependencies', index, 'designSystemId'], message: 'Design-system dependency IDs must be unique.' });
    ids.add(entry.designSystemId);
  });
}
export const ProjectDesignSystemDependenciesSchema = z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, id: DesignEntityIdSchema, dependencies: z.array(DesignSystemDependencySchema) }).strict().superRefine((state, ctx) => uniqueDependencies(state.dependencies, ctx));
export type ProjectDesignSystemDependencies = z.infer<typeof ProjectDesignSystemDependenciesSchema>;
export const ProjectDesignSystemLockSchema = z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, id: DesignEntityIdSchema, dependencies: z.array(DesignSystemLockedDependencySchema) }).strict().superRefine((state, ctx) => uniqueDependencies(state.dependencies, ctx));
export type ProjectDesignSystemLock = z.infer<typeof ProjectDesignSystemLockSchema>;

export const DesignSystemResolutionResultSchema = z.discriminatedUnion('ok', [
  z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, ok: z.literal(true), versions: z.array(DesignSystemVersionSchema), diagnostics: z.array(ValidationDiagnosticSchema).length(0) }).strict(),
  z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, ok: z.literal(false), versions: z.array(DesignSystemVersionSchema).length(0), diagnostics: z.array(ValidationDiagnosticSchema).min(1) }).strict(),
]);
export type DesignSystemResolutionResult = z.infer<typeof DesignSystemResolutionResultSchema>;
