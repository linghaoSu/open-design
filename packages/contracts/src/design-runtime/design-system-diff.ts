import { z } from 'zod';
import { CodeIdentitySchema, ComponentFrameworkSchema, DesignEntityIdSchema, DesignRuntimeSchemaVersionSchema, JsonValueSchema, SourcePathSchema } from './common.js';
import { DesignSystemLockedDependencySchema } from './design-system-version.js';
import { ValidationDiagnosticSchema } from './validation.js';

/** Natural identities within one design system; display names never supply identity. */
export const DesignSystemDiffEntitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['component', 'token', 'pattern', 'design-system', 'migration']), id: DesignEntityIdSchema }).strict(),
  z.object({ kind: z.enum(['code-component', 'binding']), id: CodeIdentitySchema }).strict(),
  z.object({ kind: z.literal('constraint'), mode: z.enum(['explore', 'guided', 'strict']) }).strict(),
  z.object({ kind: z.literal('code-compatibility'), framework: ComponentFrameworkSchema, packageName: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('source'), path: SourcePathSchema }).strict(),
]);
export type DesignSystemDiffEntity = z.infer<typeof DesignSystemDiffEntitySchema>;

/** Explicit presence preserves the difference between a missing value and JSON null. */
export const DesignSystemDiffValueSchema = z.discriminatedUnion('present', [
  z.object({ present: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), value: JsonValueSchema }).strict(),
]);
export type DesignSystemDiffValue = z.infer<typeof DesignSystemDiffValueSchema>;

export const DesignSystemSemanticChangeSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  entity: DesignSystemDiffEntitySchema,
  /** Entity-relative path. Empty means the complete entity was added or removed. */
  path: z.array(z.string().min(1)),
  kind: z.enum(['added', 'removed', 'renamed', 'changed']),
  breaking: z.boolean(),
  reason: z.string().min(1),
  before: DesignSystemDiffValueSchema,
  after: DesignSystemDiffValueSchema,
}).strict().superRefine((change, ctx) => {
  const presence = change.kind === 'added' ? !change.before.present && change.after.present
    : change.kind === 'removed' ? change.before.present && !change.after.present
      : change.before.present && change.after.present;
  if (!presence) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'Change kind must agree with before/after presence.' });
  if (change.kind === 'renamed' && (change.path.length !== 1 || change.path[0] !== 'name' || change.breaking
    || !change.before.present || typeof change.before.value !== 'string' || !change.after.present || typeof change.after.value !== 'string')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['kind'], message: 'Rename preserves entity identity and changes only its display name without breaking compatibility.' });
  }
});
export type DesignSystemSemanticChange = z.infer<typeof DesignSystemSemanticChangeSchema>;

export const DesignSystemSemanticDiffSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  from: DesignSystemLockedDependencySchema,
  to: DesignSystemLockedDependencySchema,
  changes: z.array(DesignSystemSemanticChangeSchema),
  recommendedBump: z.enum(['none', 'patch', 'minor', 'major']),
}).strict().superRefine((diff, ctx) => {
  if (diff.from.designSystemId !== diff.to.designSystemId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to', 'designSystemId'], message: 'A semantic diff compares the same design-system identity.' });
  if (diff.from.version === diff.to.version && (diff.from.digest !== diff.to.digest || diff.from.source.digest !== diff.to.source.digest)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'An exact published version cannot have different content.' });
  }
  const ids = new Set<string>(); const locations = new Set<string>();
  diff.changes.forEach((change, index) => {
    // Owner fields are fixed by the discriminated schema, with a stable declaration order.
    const location = JSON.stringify([change.entity, change.path]);
    if (ids.has(change.id) || locations.has(location)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['changes', index], message: 'Change IDs and semantic locations must be unique.' });
    ids.add(change.id); locations.add(location);
  });
  const breaking = diff.changes.some((change) => change.breaking);
  if ((diff.recommendedBump === 'major') !== breaking || (diff.recommendedBump === 'none') !== !diff.changes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recommendedBump'], message: 'The recommendation must reflect breaking changes and an empty diff.' });
  }
});
export type DesignSystemSemanticDiff = z.infer<typeof DesignSystemSemanticDiffSchema>;

export const DesignSystemDiffResultSchema = z.discriminatedUnion('ok', [
  z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, ok: z.literal(true), diff: DesignSystemSemanticDiffSchema, diagnostics: z.array(ValidationDiagnosticSchema).length(0) }).strict(),
  z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, ok: z.literal(false), diff: z.null(), diagnostics: z.array(ValidationDiagnosticSchema).min(1).refine((entries) => entries.some((entry) => entry.severity === 'error'), 'A failed diff requires an error diagnostic.') }).strict(),
]);
export type DesignSystemDiffResult = z.infer<typeof DesignSystemDiffResultSchema>;
