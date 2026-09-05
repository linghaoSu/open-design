import { z } from 'zod';
import type { JsonValue } from '../common.js';
export type { JsonValue } from '../common.js';

export const DESIGN_RUNTIME_SCHEMA_VERSION = 1 as const;
export const DesignRuntimeSchemaVersionSchema = z.literal(DESIGN_RUNTIME_SCHEMA_VERSION);

/** Assigned once by an owner; never recomputed from a display name. */
export const DesignEntityIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const ComponentReferenceSchema = z.string().regex(
  /^(?:ds:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*|local:[A-Za-z0-9][A-Za-z0-9._-]*)$/,
  'Expected ds:<system-id>/<component-id> or local:<component-id>, without a version.',
);
export type ComponentReference = z.infer<typeof ComponentReferenceSchema>;

/** Opaque code/binding identity, not a filesystem location or display name. */
export const CodeIdentitySchema = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:/%-]*$/);
export const DesignMemberNameSchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/)
  .refine((name) => name !== '__proto__', 'Reserved member name.');
export const SourcePathSchema = z.string().min(1).refine(
  (path) => !/[\\:\u0000-\u001f]/.test(path)
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  'Expected a normalized repository-relative POSIX path.',
);

export const JsonScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type JsonScalar = z.infer<typeof JsonScalarSchema>;
/** Zod's object output cannot preserve __proto__; reject it instead of silently dropping data. */
export const JsonObjectKeySchema = z.string().refine((key) => key !== '__proto__', 'Reserved JSON object key.');
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  JsonScalarSchema,
  z.array(JsonValueSchema),
  z.record(JsonObjectKeySchema, JsonValueSchema),
]));

export const SourceProvenanceSchema = z.object({
  kind: z.enum(['typescript', 'manual', 'agent', 'storybook', 'vue']),
  sourcePath: SourcePathSchema,
  exportName: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();
export type SourceProvenance = z.infer<typeof SourceProvenanceSchema>;

export const ComponentFrameworkSchema = z.enum(['react', 'vue']);
export type ComponentFramework = z.infer<typeof ComponentFrameworkSchema>;

/** Bare production import specifiers retain their subpath; installation belongs to the npm root. */
export function codeImportPackageName(specifier: string): string | null {
  const parts = specifier.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..') || /[\\\s:%?#]/.test(specifier)) return null;
  const scoped = specifier.startsWith('@');
  const count = scoped ? 2 : 1;
  if (parts.length < count) return null;
  const root = parts.slice(0, count).join('/');
  if (!/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(root)) return null;
  return parts.slice(count).every((part) => /^[A-Za-z0-9_$.-]+$/.test(part)) ? root : null;
}
