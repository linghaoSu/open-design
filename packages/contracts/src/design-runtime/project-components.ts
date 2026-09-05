import { z } from 'zod';
import { ComponentDefinitionSchema } from './component-registry.js';
import {
  ComponentReferenceSchema,
  DesignEntityIdSchema,
  DesignMemberNameSchema,
  DesignRuntimeSchemaVersionSchema,
} from './common.js';
import { ComponentInstanceSchema, UIIRDocumentSchema, UIIRNodeSchema, type UIIRNode } from './ui-ir.js';
import { ValidationDiagnosticSchema } from './validation.js';

const definitionRevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const locationPathSchema = z.array(z.union([z.string(), z.number().int().nonnegative()]));
export const LocalComponentReferenceSchema = ComponentReferenceSchema.refine((ref) => ref.startsWith('local:'), 'Expected a project-local component reference.');

/** A public prop may drive several targets, but each target has exactly one source. */
export const ProjectComponentPropMappingSchema = z.object({
  prop: DesignMemberNameSchema,
  nodeId: DesignEntityIdSchema,
  path: z.union([z.tuple([z.literal('props'), DesignMemberNameSchema]), z.tuple([z.literal('text')])]),
}).strict();
export type ProjectComponentPropMapping = z.infer<typeof ProjectComponentPropMappingSchema>;

function visitNodes(node: UIIRNode, path: (string | number)[], visitor: (node: UIIRNode, path: (string | number)[]) => void): void {
  visitor(node, path);
  if (node.type === 'component') {
    Object.entries(node.slots ?? {}).forEach(([slot, children]) => {
      children.forEach((child, index) => visitNodes(child, [...path, 'slots', slot, index], visitor));
    });
  }
}


/** Shared structural mapping rules for local components and packaged patterns. */
export function validateTemplatePropMappings(
  definition: { props: z.infer<typeof ComponentDefinitionSchema>['props']; template: UIIRNode; propMappings: ProjectComponentPropMapping[] },
  ctx: z.RefinementCtx,
): void {
  const nodes = new Map<string, UIIRNode>();
  visitNodes(definition.template, ['template'], (node, path) => {
    if (nodes.has(node.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'id'], message: 'Template node IDs must be unique within the definition.' });
    }
    nodes.set(node.id, node);
  });
  const targets = new Set<string>();
  const mappedProps = new Set<string>();
  definition.propMappings.forEach((mapping, index) => {
    const path = ['propMappings', index];
    const key = JSON.stringify([mapping.nodeId, mapping.path]);
    if (targets.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Each template target must have only one public prop mapping.' });
    }
    targets.add(key);
    mappedProps.add(mapping.prop);
    const prop = Object.hasOwn(definition.props, mapping.prop) ? definition.props[mapping.prop] : undefined;
    if (!prop) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'prop'], message: 'Mapped public prop is not declared.' });
    }
    const node = nodes.get(mapping.nodeId);
    if (!node) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'nodeId'], message: 'Mapped template node does not exist.' });
      return;
    }
    if (mapping.path[0] === 'text') {
      if (node.type !== 'text' || node.text !== '') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Text mapping requires an empty text-node placeholder.' });
      }
      const stringDomain = prop?.type === 'string' || (prop?.type === 'enum' && prop.values.every((value) => typeof value === 'string'));
      if (prop && (!stringDomain || (!prop.required && prop.default === undefined))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'prop'], message: 'A text mapping requires a string-valued public prop that is required or has a default.' });
      }
    } else {
      const targetProp = mapping.path[1];
      if (node.type === 'text') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Prop mapping requires a component or instance node.' });
      } else if ((node.type === 'component' && Object.hasOwn(node.props ?? {}, targetProp))
        || (node.type === 'instance' && node.overrides.some((override) => override.path[1] === targetProp))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Mapped template props must be absent; their default belongs to the public prop definition.' });
      }
    }
  });
  for (const prop of Object.keys(definition.props)) {
    if (!mappedProps.has(prop)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['props', prop], message: 'Every public prop requires an explicit template mapping.' });
    }
  }
}

/** Public prop defaults live only in props; mapped template targets carry no inherited value. */
export const ProjectComponentDefinitionSchema = ComponentDefinitionSchema.pick({
  schemaVersion: true, id: true, name: true, props: true,
}).extend({
  revision: definitionRevisionSchema,
  template: UIIRNodeSchema,
  propMappings: z.array(ProjectComponentPropMappingSchema),
}).strict().superRefine((definition, ctx) => {
  validateTemplatePropMappings(definition, ctx);
  visitNodes(definition.template, ['template'], (node, path) => {
    if (node.type === 'component' && node.ref.startsWith('local:')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'type'], message: 'Project-local reuse must use an override-only instance node.' });
    }
  });
});
export type ProjectComponentDefinition = z.infer<typeof ProjectComponentDefinitionSchema>;

export const ProjectComponentRegistrySchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  components: z.array(ProjectComponentDefinitionSchema),
}).strict().superRefine((registry, ctx) => {
  const ids = new Set<string>();
  registry.components.forEach((component, index) => {
    if (ids.has(component.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['components', index, 'id'], message: 'Duplicate project component ID.' });
    ids.add(component.id);
  });
});
export type ProjectComponentRegistry = z.infer<typeof ProjectComponentRegistrySchema>;

export const ComponentReferenceScreenOwnerSchema = z.object({
  kind: z.literal('screen'), documentId: DesignEntityIdSchema, screenId: DesignEntityIdSchema,
}).strict();
export type ComponentReferenceScreenOwner = z.infer<typeof ComponentReferenceScreenOwnerSchema>;
export const ComponentReferenceOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('component'), componentRef: LocalComponentReferenceSchema }).strict(),
  ComponentReferenceScreenOwnerSchema,
]);
export type ComponentReferenceOwner = z.infer<typeof ComponentReferenceOwnerSchema>;

/** Identity is (owner, nodeId); path is its current location, not an identity source. */
export const ReferenceUsageSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  owner: ComponentReferenceOwnerSchema,
  nodeId: DesignEntityIdSchema,
  target: ComponentReferenceSchema,
  path: locationPathSchema,
}).strict();
export type ReferenceUsage = z.infer<typeof ReferenceUsageSchema>;

function ownerKey(owner: ComponentReferenceOwner): string {
  return JSON.stringify(owner.kind === 'component' ? ['component', owner.componentRef] : ['screen', owner.documentId, owner.screenId]);
}
function usageKey(usage: ReferenceUsage): string {
  return JSON.stringify([ownerKey(usage.owner), usage.nodeId]);
}
function checkUnique<T>(values: T[], key: (value: T) => string, path: (string | number)[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const identity = key(value);
    if (seen.has(identity)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, index], message: 'Duplicate reference identity.' });
    seen.add(identity);
  });
}

/** Error diagnostics mean the graph cannot certify complete usage or safe deletion. */
export const ReferenceGraphSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  id: DesignEntityIdSchema,
  edges: z.array(ReferenceUsageSchema),
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((graph, ctx) => checkUnique(graph.edges, usageKey, ['edges'], ctx));
export type ReferenceGraph = z.infer<typeof ReferenceGraphSchema>;

export const ReferenceGraphQuerySchema = z.object({ target: ComponentReferenceSchema }).strict();
export type ReferenceGraphQuery = z.infer<typeof ReferenceGraphQuerySchema>;

/** Chains run outward from the target: [Card -> Button, Screen -> Card]. */
export const ReferenceGraphQueryResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  target: ComponentReferenceSchema,
  directUsages: z.array(ReferenceUsageSchema),
  transitiveUsages: z.array(ComponentReferenceOwnerSchema),
  affectedScreens: z.array(ComponentReferenceScreenOwnerSchema),
  chains: z.array(z.array(ReferenceUsageSchema).min(1)),
  cycles: z.array(z.array(LocalComponentReferenceSchema).min(2)),
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((result, ctx) => {
  checkUnique(result.directUsages, usageKey, ['directUsages'], ctx);
  checkUnique(result.transitiveUsages, ownerKey, ['transitiveUsages'], ctx);
  checkUnique(result.affectedScreens, ownerKey, ['affectedScreens'], ctx);
  checkUnique(result.chains, (chain) => JSON.stringify(chain.map(usageKey)), ['chains'], ctx);
  result.directUsages.forEach((usage, index) => {
    if (usage.target !== result.target) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['directUsages', index, 'target'], message: 'Direct usage must reference the queried target.' });
  });
  result.chains.forEach((chain, chainIndex) => {
    checkUnique(chain, usageKey, ['chains', chainIndex], ctx);
    chain.forEach((usage, index) => {
      const previous = chain[index - 1];
      const expectedTarget = previous ? previous.owner.kind === 'component' ? previous.owner.componentRef : undefined : result.target;
      if (usage.target !== expectedTarget) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chains', chainIndex, index], message: 'Dependency chain must connect successive owners to the queried target.' });
    });
  });
  result.cycles.forEach((cycle, index) => {
    if (cycle[0] !== cycle.at(-1) || new Set(cycle.slice(0, -1)).size !== cycle.length - 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cycles', index], message: 'A reference cycle must be a closed simple path.' });
    }
  });
});
export type ReferenceGraphQueryResult = z.infer<typeof ReferenceGraphQueryResultSchema>;

export const ComponentDeletionAnalysisSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  componentRef: LocalComponentReferenceSchema,
  canDelete: z.boolean(),
  usages: ReferenceGraphQueryResultSchema,
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((analysis, ctx) => {
  if (analysis.usages.target !== analysis.componentRef) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['usages', 'target'], message: 'Deletion analysis must query the component being deleted.' });
  const usages = analysis.usages;
  if (analysis.canDelete && (usages.directUsages.length || usages.transitiveUsages.length || usages.affectedScreens.length || usages.chains.length || usages.cycles.length
    || [...analysis.diagnostics, ...usages.diagnostics].some((diagnostic) => diagnostic.severity === 'error'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['canDelete'], message: 'Safe deletion requires no usages, cycles, or error diagnostics.' });
  }
});
export type ComponentDeletionAnalysis = z.infer<typeof ComponentDeletionAnalysisSchema>;

export const ResolvedInstanceFrameSchema = z.object({
  instanceId: DesignEntityIdSchema,
  componentRef: ComponentReferenceSchema,
  definitionRevision: definitionRevisionSchema.optional(),
}).strict().superRefine((frame, ctx) => {
  if (frame.componentRef.startsWith('local:') && frame.definitionRevision === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['definitionRevision'], message: 'Local instance origins require the resolved definition revision.' });
  }
});
export type ResolvedInstanceFrame = z.infer<typeof ResolvedInstanceFrameSchema>;
export const ResolvedNodeOriginSchema = z.object({
  nodeId: DesignEntityIdSchema,
  sourceNodeId: DesignEntityIdSchema,
  instancePath: z.array(ResolvedInstanceFrameSchema),
}).strict();
export type ResolvedNodeOrigin = z.infer<typeof ResolvedNodeOriginSchema>;

/** This is derived output; source documents continue to persist override-only instances. */
export const ResolvedUIIRResultSchema = z.object({
  schemaVersion: DesignRuntimeSchemaVersionSchema,
  document: UIIRDocumentSchema.nullable(),
  origins: z.array(ResolvedNodeOriginSchema),
  diagnostics: z.array(ValidationDiagnosticSchema),
}).strict().superRefine((result, ctx) => {
  const hasErrors = result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  if ((result.document === null) !== hasErrors) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document'], message: 'Resolution errors require a null document; successful resolution requires a document.' });
  }
  const nodeIds = new Set<string>();
  result.document?.screens.forEach((screen, screenIndex) => {
    screen.children.forEach((child, index) => visitNodes(child, ['document', 'screens', screenIndex, 'children', index], (node, path) => {
      nodeIds.add(node.id);
      if (node.type === 'instance' || (node.type === 'component' && node.ref.startsWith('local:'))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Resolved output must contain only design-system component and text nodes.' });
      }
    }));
  });
  checkUnique(result.origins, (origin) => origin.nodeId, ['origins'], ctx);
  result.origins.forEach((origin, index) => {
    if (!nodeIds.delete(origin.nodeId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origins', index, 'nodeId'], message: 'Origin does not identify a resolved node.' });
  });
  if (nodeIds.size) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origins'], message: 'Every resolved node requires its source origin.' });
});
export type ResolvedUIIRResult = z.infer<typeof ResolvedUIIRResultSchema>;

/** reject blocks referenced deletion; replace/detach/delete-instances are explicit alternatives. */
export const ProjectComponentDeleteRequestSchema = z.object({
  componentRef: LocalComponentReferenceSchema,
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('reject') }).strict(),
    z.object({ type: z.literal('replace'), replacementRef: ComponentReferenceSchema }).strict(),
    z.object({ type: z.literal('detach') }).strict(),
    z.object({ type: z.literal('delete-instances') }).strict(),
  ]),
}).strict().superRefine((request, ctx) => {
  if (request.action.type === 'replace' && request.action.replacementRef === request.componentRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['action', 'replacementRef'], message: 'Replacement must reference a different component.' });
  }
});
export type ProjectComponentDeleteRequest = z.infer<typeof ProjectComponentDeleteRequestSchema>;

export const ComponentDetachRequestSchema = z.object({
  instance: ComponentInstanceSchema,
  mode: z.enum(['explore', 'guided', 'strict']),
}).strict();
export type ComponentDetachRequest = z.infer<typeof ComponentDetachRequestSchema>;
