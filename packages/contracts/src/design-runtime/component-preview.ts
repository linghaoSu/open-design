import { z } from 'zod';
import { DesignEntityIdSchema, JsonObjectKeySchema, JsonValueSchema, SourcePathSchema } from './common.js';
import { DesignSystemDigestSchema } from './design-system-identity.js';
import { DesignPreviewBundleSchema, DesignPreviewRuntimeSchema, DesignPreviewSourceEvidenceSchema } from './preview.js';
import { ValidationDiagnosticSchema } from './validation.js';

/** Preview guesses are never registry definitions, binding proof, or production defaults. */
export const ComponentPreviewPropsSchema = z.record(JsonObjectKeySchema, JsonValueSchema);
export const ComponentPreviewRequestSchema = z.object({
  sourcePath: SourcePathSchema.refine((path) => /\.(?:jsx|tsx)$/i.test(path), 'Select a JSX or TSX source file.'),
  exportName: z.string().min(1).max(256).optional(),
  props: ComponentPreviewPropsSchema.optional(),
}).strict();
export type ComponentPreviewRequest = z.infer<typeof ComponentPreviewRequestSchema>;

export const ComponentPreviewControlSchema = z.object({
  name: JsonObjectKeySchema,
  kind: z.enum(['string', 'number', 'boolean', 'enum', 'object', 'array', 'function', 'react-node', 'unknown']),
  required: z.boolean(), provenance: z.enum(['typescript', 'default', 'usage', 'unknown']),
  hasDefault: z.boolean(), defaultValue: JsonValueSchema.optional(), options: z.array(JsonValueSchema).min(1).optional(),
}).strict().superRefine((control, ctx) => {
  if (Object.hasOwn(control, 'defaultValue') && !control.hasDefault) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultValue'], message: 'A source default value requires source default evidence.' });
  if ((control.kind === 'enum') !== Boolean(control.options)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Only enum controls carry nonempty choices.' });
});
export type ComponentPreviewControl = z.infer<typeof ComponentPreviewControlSchema>;

/** Null placeholders become inert callbacks in the sandbox, never executable input strings. */
export const ComponentPreviewCallbackSchema = z.object({
  path: z.array(z.union([JsonObjectKeySchema, z.number().int().nonnegative().max(1000)])).min(1).max(12),
  async: z.boolean(), returnValue: JsonValueSchema.optional(),
}).strict();
export type ComponentPreviewCallback = z.infer<typeof ComponentPreviewCallbackSchema>;
export const ComponentPreviewDiagnosticSchema = ValidationDiagnosticSchema;
export type ComponentPreviewDiagnostic = z.infer<typeof ComponentPreviewDiagnosticSchema>;

export const ComponentPreviewResponseSchema = z.object({
  schemaVersion: z.literal(1), projectId: DesignEntityIdSchema,
  sourcePath: SourcePathSchema, requestedExport: z.string().min(1).max(256).optional(), requestedProps: ComponentPreviewPropsSchema,
  sourceDigest: DesignSystemDigestSchema,
  exports: z.array(z.string().min(1).max(256)).max(100), selectedExport: z.string().min(1).max(256).nullable(),
  controls: z.array(ComponentPreviewControlSchema).max(100), mockProps: ComponentPreviewPropsSchema, effectiveProps: ComponentPreviewPropsSchema,
  callbacks: z.array(ComponentPreviewCallbackSchema).max(200), bundle: DesignPreviewBundleSchema.nullable(),
  evidence: z.array(DesignPreviewSourceEvidenceSchema).max(256), runtimePackages: z.array(DesignPreviewRuntimeSchema),
  diagnostics: z.array(ComponentPreviewDiagnosticSchema),
}).strict().superRefine((response, ctx) => {
  for (const [field, keys] of [['exports', response.exports], ['controls', response.controls.map((control) => control.name)], ['callbacks', response.callbacks.map((callback) => JSON.stringify(callback.path))]] as const) {
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'Preview identities must be unique.' });
  }
  if (response.selectedExport !== null && (!response.exports.includes(response.selectedExport) || response.requestedExport !== undefined && response.requestedExport !== response.selectedExport)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selectedExport'], message: 'Selected export must match a source candidate and any explicit request.' });
  const errors = response.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if (response.bundle !== null && (response.selectedExport === null || errors) || response.bundle === null && !errors) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bundle'], message: 'A bundle requires a selected component and no errors; an unavailable bundle requires an actionable error.' });
  response.callbacks.forEach((callback, index) => {
    let value: unknown = response.effectiveProps;
    for (const key of callback.path) value = value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string | number, unknown>)[key] : undefined;
    if (value !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['callbacks', index], message: 'A mock callback must identify an explicit null placeholder in effective props.' });
  });
});
export type ComponentPreviewResponse = z.infer<typeof ComponentPreviewResponseSchema>;
