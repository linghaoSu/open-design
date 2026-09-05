import { z } from 'zod';
import { DesignEntityIdSchema, DesignMemberNameSchema, DesignRuntimeSchemaVersionSchema, JsonValueSchema } from './common.js';
import { DesignPatternDefinitionSchema } from './design-patterns.js';
import { DesignSystemLockedDependencySchema, ProjectDesignSystemLockSchema } from './design-system-version.js';
import { ProjectComponentRegistrySchema } from './project-components.js';
import { UIIRDocumentSchema, UIIRNodeSchema, type UIIRNode } from './ui-ir.js';
import { ValidationDiagnosticSchema } from './validation.js';

export const DesignPatternRuntimeContextSchema = z.object({
  lock: ProjectDesignSystemLockSchema,
  projectComponents: ProjectComponentRegistrySchema,
  document: UIIRDocumentSchema,
}).strict().superRefine((context, ctx) => {
  if (context.lock.id !== context.projectComponents.id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectComponents', 'id'], message: 'Pattern context must belong to the locked project.' });
});
export type DesignPatternRuntimeContext = z.infer<typeof DesignPatternRuntimeContextSchema>;

export const InstantiateDesignPatternRequestSchema = z.object({
  patternId: DesignEntityIdSchema, instanceId: DesignEntityIdSchema, destinationScreenId: DesignEntityIdSchema,
  props: z.record(DesignMemberNameSchema, JsonValueSchema),
  slots: z.record(DesignMemberNameSchema, z.array(UIIRNodeSchema)),
}).strict();
export type InstantiateDesignPatternRequest = z.infer<typeof InstantiateDesignPatternRequestSchema>;

export const DesignPatternNodeOriginSchema = z.object({
  nodeId: DesignEntityIdSchema,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pattern'), patternId: DesignEntityIdSchema, sourceNodeId: DesignEntityIdSchema }).strict(),
    z.object({ kind: z.literal('slot'), slot: DesignMemberNameSchema, sourceNodeId: DesignEntityIdSchema,
      path: z.array(z.union([z.string(), z.number().int().nonnegative().safe()])).min(1) }).strict(),
  ]),
}).strict();
export type DesignPatternNodeOrigin = z.infer<typeof DesignPatternNodeOriginSchema>;

export const DesignPatternInstantiationResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  patternId: DesignEntityIdSchema, instanceId: DesignEntityIdSchema,
  dependency: DesignSystemLockedDependencySchema,
  node: UIIRNodeSchema.nullable(), origins: z.array(DesignPatternNodeOriginSchema), diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((result, ctx) => {
  const errors = result.diagnostics.some((entry) => entry.severity === 'error');
  if (errors !== (result.node === null) || (result.node === null && result.origins.length)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['node'], message: 'Pattern errors require a null subtree and no origins; successful output requires a subtree.' });
  const ids = new Set<string>();
  const visit = (node: UIIRNode): void => {
    if (ids.has(node.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['node'], message: 'Instantiated node IDs must be unique.' });
    ids.add(node.id);
    if (node.type === 'component') for (const children of Object.values(node.slots ?? {})) children.forEach(visit);
  };
  if (result.node) visit(result.node);
  const origins = new Set<string>();
  result.origins.forEach((origin, index) => {
    if (!ids.has(origin.nodeId) || origins.has(origin.nodeId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origins', index, 'nodeId'], message: 'Every origin must identify one unique instantiated node.' });
    origins.add(origin.nodeId);
    if (origin.source.kind === 'pattern' && origin.source.patternId !== result.patternId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origins', index, 'source'], message: 'Pattern origins must identify the instantiated pattern.' });
  });
  if (origins.size !== ids.size) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origins'], message: 'Every instantiated node requires its source origin.' });
});
export type DesignPatternInstantiationResult = z.infer<typeof DesignPatternInstantiationResultSchema>;

export const DesignPatternSearchResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, dependency: DesignSystemLockedDependencySchema, patterns: z.array(DesignPatternDefinitionSchema),
}).strict();
export type DesignPatternSearchResult = z.infer<typeof DesignPatternSearchResultSchema>;
export const DesignPatternReadResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema, dependency: DesignSystemLockedDependencySchema, pattern: DesignPatternDefinitionSchema,
}).strict();
export type DesignPatternReadResult = z.infer<typeof DesignPatternReadResultSchema>;
