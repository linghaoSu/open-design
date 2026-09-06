import { z } from 'zod';
import { ComponentBindingSchema, type ComponentBinding } from './component-binding.js';
import { CodeIdentitySchema, DesignRuntimeSchemaVersionSchema, SourcePathSchema } from './common.js';
import { CodeComponentIndexSchema, ComponentBindingRegistrySchema } from './code-index.js';
import { ExtractSourceCodeComponentRequestSchema } from './source-compiler.js';
import { ValidationDiagnosticSchema } from './validation.js';

/** Evidence is associated with a registered identity; the registered path/export are authoritative. */
export const ProjectCodeSourceEvidenceSchema = z.object({ codeComponentId: CodeIdentitySchema, sourceText: z.string(),
  sourceFiles: z.array(z.object({ sourcePath: SourcePathSchema, sourceText: z.string().max(4 * 1024 * 1024) }).strict()).max(64).optional(),
}).strict().superRefine((value, ctx) => {
  const paths = value.sourceFiles?.map((file) => file.sourcePath) ?? [];
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceFiles'], message: 'Source dependency paths must be unique.' });
  if ((value.sourceFiles?.reduce((total, file) => total + file.sourceText.length, 0) ?? 0) > 16 * 1024 * 1024) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceFiles'], message: 'Source dependencies exceed their text budget.' });
});
export type ProjectCodeSourceEvidence = z.infer<typeof ProjectCodeSourceEvidenceSchema>;

export const RegisterLocalComponentBindingRequestSchema = z.object({
  source: ExtractSourceCodeComponentRequestSchema,
  binding: ComponentBindingSchema.refine((binding): binding is Extract<ComponentBinding, { status: 'bound' }> => binding.status === 'bound' && binding.componentRef.startsWith('local:'), 'Local registration requires an explicit bound local relationship.'),
}).strict().superRefine((request, ctx) => {
  if (request.binding.codeComponentId !== request.source.codeComponentId || request.binding.framework !== request.source.framework) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['binding'], message: 'Source selection and binding must identify the same code component and framework.' });
  if (request.binding.definitionRevision === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['binding', 'definitionRevision'], message: 'New local verification requires the exact definition revision.' });
});
export type RegisterLocalComponentBindingRequest = z.infer<typeof RegisterLocalComponentBindingRequestSchema>;

export const RegisterLocalComponentBindingResultSchema = z.discriminatedUnion('ok', [
  z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, ok: z.literal(true),
    projectCodeIndex: CodeComponentIndexSchema, codeIndex: CodeComponentIndexSchema,
    bindings: ComponentBindingRegistrySchema, binding: ComponentBindingSchema,
    diagnostics: z.array(ValidationDiagnosticSchema).length(0),
  }).strict(),
  z.object({ schemaVersion: DesignRuntimeSchemaVersionSchema, ok: z.literal(false), diagnostics: z.array(ValidationDiagnosticSchema).min(1) }).strict(),
]);
export type RegisterLocalComponentBindingResult = z.infer<typeof RegisterLocalComponentBindingResultSchema>;
