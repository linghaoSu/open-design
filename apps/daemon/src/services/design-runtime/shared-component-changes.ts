import {
  DesignEntityIdSchema,
  LocalComponentReferenceSchema,
  ProjectComponentRegistrySchema,
  PublishSharedComponentChangeRequestSchema,
  SharedComponentChangeStateSchema,
  SharedComponentDraftSchema,
  SharedComponentImpactSchema,
  SharedComponentPublishedRevisionSchema,
  SharedComponentPublishResultSchema,
  SharedComponentRegistryChangeResultSchema,
  SharedComponentStageResultSchema,
  StageSharedComponentChangeRequestSchema,
  StageSharedComponentUndoRequestSchema,
  type ProjectComponentDefinition,
  type ProjectComponentRegistry,
  type PublishSharedComponentChangeRequest,
  type SharedComponentChangeState,
  type SharedComponentDraft,
  type SharedComponentImpact,
  type SharedComponentPublishedRevision,
  type SharedComponentPublishResult,
  type SharedComponentRegistryChangeResult,
  type SharedComponentStageResult,
  type StageSharedComponentChangeRequest,
  type StageSharedComponentUndoRequest,
  type UIIRDocument,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { resolveProjectDocument } from './project-components.js';
import { compareDesignRuntimeKeys, queryReferenceGraph, type DesignRuntimeLimits, type ProjectComponentContext } from './reference-graph.js';

export interface SharedComponentContext extends Omit<ProjectComponentContext, 'document'> {
  document: UIIRDocument | null;
}

export class SharedComponentChangeError extends Error {
  readonly diagnostics: ValidationDiagnostic[];
  readonly impact: SharedComponentImpact | undefined;
  readonly expectedDefinitionRevision: number | undefined;
  readonly currentDefinitionRevision: number | undefined;

  constructor(
    readonly code: 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION_FAILED',
    message: string,
    options: { diagnostics?: ValidationDiagnostic[]; impact?: SharedComponentImpact; expectedDefinitionRevision?: number; currentDefinitionRevision?: number } = {},
  ) {
    super(message);
    this.name = 'SharedComponentChangeError';
    this.diagnostics = options.diagnostics ?? [];
    this.impact = options.impact;
    this.expectedDefinitionRevision = options.expectedDefinitionRevision;
    this.currentDefinitionRevision = options.currentDefinitionRevision;
  }
}

/** Object insertion order is not snapshot content; array order and explicit values are. */
function stableSnapshot(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const object = entry as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort(compareDesignRuntimeKeys).map((key) => [key, object[key]]));
    }
    return entry;
  });
}

function contextWithDocument(input: SharedComponentContext): ProjectComponentContext {
  return {
    ...input,
    document: input.document ?? { schemaVersion: 1, id: input.projectComponents.id, screens: [] },
  };
}

function parseChanges(input: SharedComponentContext, changes: SharedComponentChangeState): SharedComponentChangeState {
  const parsed = SharedComponentChangeStateSchema.parse(changes);
  ProjectComponentRegistrySchema.parse(input.projectComponents);
  if (parsed.id !== input.projectComponents.id) throw new SharedComponentChangeError('CONFLICT', 'Shared changes belong to a different project component registry.');
  return parsed;
}

function findDefinition(input: SharedComponentContext, componentRef: string): ProjectComponentDefinition | undefined {
  return input.projectComponents.components.find((definition) => componentRef === `local:${definition.id}`);
}

function assertRevision(
  input: SharedComponentContext,
  changes: SharedComponentChangeState,
  componentRef: string,
  expectedDefinitionRevision: number,
): ProjectComponentDefinition | undefined {
  const current = findDefinition(input, componentRef);
  const currentDefinitionRevision = current?.revision ?? 0;
  if (currentDefinitionRevision !== expectedDefinitionRevision) {
    throw new SharedComponentChangeError('CONFLICT', 'The published component revision changed; refresh before staging or publishing.', { expectedDefinitionRevision, currentDefinitionRevision });
  }
  const history = changes.history.filter((entry) => entry.componentRef === componentRef);
  if (history.length && !history.some((entry) => entry.definition.revision === currentDefinitionRevision)) {
    throw new SharedComponentChangeError('CONFLICT', 'The live component revision is absent from its published history.');
  }
  for (const entry of history) {
    if (entry.definition.revision > currentDefinitionRevision
      || (entry.definition.revision === currentDefinitionRevision && stableSnapshot(entry.definition) !== stableSnapshot(current))) {
      throw new SharedComponentChangeError('CONFLICT', 'Published component history cannot be rewound or overwritten.');
    }
  }
  return current;
}

function proposedRegistry(input: SharedComponentContext, draft: SharedComponentDraft): ProjectComponentRegistry {
  return ProjectComponentRegistrySchema.parse({
    ...input.projectComponents,
    components: [
      ...input.projectComponents.components.filter((definition) => definition.id !== draft.proposedDefinition.id),
      draft.proposedDefinition,
    ].sort((a, b) => compareDesignRuntimeKeys(a.id, b.id)),
  });
}

function computeImpact(input: SharedComponentContext, draft: SharedComponentDraft, limits: DesignRuntimeLimits): SharedComponentImpact {
  const currentContext = contextWithDocument(input);
  const proposedContext = { ...currentContext, projectComponents: proposedRegistry(input, draft) };
  const current = resolveProjectDocument(currentContext, limits);
  const proposed = resolveProjectDocument(proposedContext, limits);
  // Incoming references remain explicit in the proposed source. New definitions may
  // repair previously dangling instances, so absent old definitions are not queried.
  const usages = queryReferenceGraph(proposedContext, draft.componentRef, limits);
  const diagnostics = new Map<string, ValidationDiagnostic>();
  for (const diagnostic of [...proposed.diagnostics, ...usages.diagnostics]) diagnostics.set(stableSnapshot(diagnostic), diagnostic);
  return SharedComponentImpactSchema.parse({
    schemaVersion: 1,
    componentRef: draft.componentRef,
    baseRevision: draft.baseDefinition?.revision ?? 0,
    proposedRevision: draft.proposedDefinition.revision,
    usages,
    current,
    proposed,
    diagnostics: [...diagnostics.entries()].sort(([a], [b]) => compareDesignRuntimeKeys(a, b)).map(([, diagnostic]) => diagnostic),
  });
}

function stage(
  input: SharedComponentContext,
  changes: SharedComponentChangeState,
  rawRequest: StageSharedComponentChangeRequest,
  source: SharedComponentDraft['source'],
  limits: DesignRuntimeLimits,
): SharedComponentStageResult {
  const request = StageSharedComponentChangeRequestSchema.parse(rawRequest);
  const parsed = parseChanges(input, changes);
  const componentRef = `local:${request.definition.id}`;
  const current = assertRevision(input, parsed, componentRef, request.expectedDefinitionRevision);
  if (parsed.history.some((entry) => entry.changeId === request.draftId)
    || parsed.drafts.some((draft) => (draft.id === request.draftId && draft.componentRef !== componentRef)
      || (draft.componentRef === componentRef && draft.id !== request.draftId))) {
    throw new SharedComponentChangeError('CONFLICT', 'Use the existing pending draft ID, or discard it before starting another change. Published change IDs cannot be reused.');
  }
  const draft = SharedComponentDraftSchema.parse({
    schemaVersion: 1,
    id: request.draftId,
    componentRef,
    baseDefinition: current ?? null,
    proposedDefinition: request.definition,
    source,
  });
  const next = SharedComponentChangeStateSchema.parse({
    ...parsed,
    drafts: [...parsed.drafts.filter((existing) => existing.id !== draft.id), draft].sort((a, b) => compareDesignRuntimeKeys(a.id, b.id)),
  });
  return SharedComponentStageResultSchema.parse({ schemaVersion: 1, changes: next, draft, impact: computeImpact(input, draft, limits) });
}

/** Drafts never alter the published registry or source document, even when validation fails. */
export function stageSharedComponentChange(
  input: SharedComponentContext,
  changes: SharedComponentChangeState,
  request: StageSharedComponentChangeRequest,
  limits: DesignRuntimeLimits = {},
): SharedComponentStageResult {
  return stage(input, changes, request, { type: 'edit' }, limits);
}

function checkedDraft(input: SharedComponentContext, changes: SharedComponentChangeState, draftId: string, expectedRevision?: number): SharedComponentDraft {
  DesignEntityIdSchema.parse(draftId);
  const draft = changes.drafts.find((entry) => entry.id === draftId);
  if (!draft) throw new SharedComponentChangeError('NOT_FOUND', 'Shared component draft does not exist.');
  const baseRevision = draft.baseDefinition?.revision ?? 0;
  const current = assertRevision(input, changes, draft.componentRef, expectedRevision ?? baseRevision);
  if ((current?.revision ?? 0) !== baseRevision || stableSnapshot(current ?? null) !== stableSnapshot(draft.baseDefinition)) {
    throw new SharedComponentChangeError('CONFLICT', 'The published definition no longer matches the draft base snapshot.');
  }
  return draft;
}

export function inspectSharedComponentChange(
  input: SharedComponentContext,
  changes: SharedComponentChangeState,
  draftId: string,
  limits: DesignRuntimeLimits = {},
): SharedComponentImpact {
  const parsed = parseChanges(input, changes);
  return computeImpact(input, checkedDraft(input, parsed, draftId), limits);
}

/** Recompute full proposed-project validation before returning any publishable mutation. */
export function publishSharedComponentChange(
  input: SharedComponentContext,
  changes: SharedComponentChangeState,
  rawRequest: PublishSharedComponentChangeRequest,
  limits: DesignRuntimeLimits = {},
): SharedComponentPublishResult {
  const request = PublishSharedComponentChangeRequestSchema.parse(rawRequest);
  const parsed = parseChanges(input, changes);
  const draft = checkedDraft(input, parsed, request.draftId, request.expectedDefinitionRevision);
  const impact = computeImpact(input, draft, limits);
  if (impact.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new SharedComponentChangeError('VALIDATION_FAILED', 'Shared component change is blocked by proposed project validation errors.', { diagnostics: impact.diagnostics, impact });
  }
  const history = [...parsed.history];
  if (draft.baseDefinition && !history.some((entry) => entry.componentRef === draft.componentRef && entry.definition.revision === draft.baseDefinition!.revision)) {
    history.push({ schemaVersion: 1, componentRef: draft.componentRef, definition: draft.baseDefinition, changeId: null });
  }
  history.push({ schemaVersion: 1, componentRef: draft.componentRef, definition: draft.proposedDefinition, changeId: draft.id });
  history.sort((a, b) => compareDesignRuntimeKeys(a.componentRef, b.componentRef) || a.definition.revision - b.definition.revision);
  return SharedComponentPublishResultSchema.parse({
    schemaVersion: 1,
    projectComponents: proposedRegistry(input, draft),
    changes: { ...parsed, drafts: parsed.drafts.filter((entry) => entry.id !== draft.id), history },
    impact,
  });
}

export function discardSharedComponentChange(changes: SharedComponentChangeState, draftId: string): SharedComponentChangeState {
  const parsed = SharedComponentChangeStateSchema.parse(changes);
  DesignEntityIdSchema.parse(draftId);
  if (!parsed.drafts.some((draft) => draft.id === draftId)) throw new SharedComponentChangeError('NOT_FOUND', 'Shared component draft does not exist.');
  return SharedComponentChangeStateSchema.parse({ ...parsed, drafts: parsed.drafts.filter((draft) => draft.id !== draftId) });
}

export function stageSharedComponentUndo(
  input: SharedComponentContext,
  changes: SharedComponentChangeState,
  rawRequest: StageSharedComponentUndoRequest,
  limits: DesignRuntimeLimits = {},
): SharedComponentStageResult {
  const request = StageSharedComponentUndoRequestSchema.parse(rawRequest);
  const parsed = parseChanges(input, changes);
  assertRevision(input, parsed, request.componentRef, request.expectedDefinitionRevision);
  const historical = parsed.history.find((entry) => entry.componentRef === request.componentRef && entry.definition.revision === request.restoreDefinitionRevision);
  if (!historical) throw new SharedComponentChangeError('NOT_FOUND', 'The requested published definition revision is not in history.');
  return stage(input, parsed, {
    draftId: request.draftId,
    expectedDefinitionRevision: request.expectedDefinitionRevision,
    definition: { ...historical.definition, revision: request.expectedDefinitionRevision + 1 },
  }, { type: 'undo', definitionRevision: request.restoreDefinitionRevision }, limits);
}

export function getSharedComponentHistory(changes: SharedComponentChangeState, componentRef: string): SharedComponentPublishedRevision[] {
  LocalComponentReferenceSchema.parse(componentRef);
  return SharedComponentChangeStateSchema.parse(changes).history
    .filter((entry) => entry.componentRef === componentRef)
    .sort((a, b) => a.definition.revision - b.definition.revision)
    .map((entry) => SharedComponentPublishedRevisionSchema.parse(entry));
}

/**
 * Records explicit deletion/replacement rewrites as one validated snapshot. Surviving
 * definitions advance together, so temporarily dangling intermediate registries never
 * become publishable. Each changed survivor needs a caller-supplied unique change ID.
 */
export function recordSharedComponentRegistryChange(
  before: SharedComponentContext,
  after: SharedComponentContext,
  changes: SharedComponentChangeState,
  changeIds: Readonly<Record<string, string>>,
  limits: DesignRuntimeLimits = {},
): SharedComponentRegistryChangeResult {
  const parsed = parseChanges(before, changes);
  const afterRegistry = ProjectComponentRegistrySchema.parse(after.projectComponents);
  if (afterRegistry.id !== before.projectComponents.id || stableSnapshot(after.registry) !== stableSnapshot(before.registry)) {
    throw new SharedComponentChangeError('CONFLICT', 'A project component rewrite cannot change its project or design-system registry.');
  }
  const previous = new Map(before.projectComponents.components.map((definition) => [definition.id, definition]));
  if (afterRegistry.components.some((definition) => !previous.has(definition.id))) {
    throw new SharedComponentChangeError('VALIDATION_FAILED', 'New component identities must be created through a staged initial revision.');
  }
  const changed = new Set<string>();
  const components = afterRegistry.components.map((definition) => {
    const old = previous.get(definition.id)!;
    if (stableSnapshot({ ...definition, revision: 0 }) === stableSnapshot({ ...old, revision: 0 })) return old;
    changed.add(`local:${definition.id}`);
    return { ...definition, revision: old.revision + 1 };
  });
  const remaining = new Set(components.map((definition) => definition.id));
  const affected = new Set([...changed, ...before.projectComponents.components.filter((definition) => !remaining.has(definition.id)).map((definition) => `local:${definition.id}`)]);
  if (parsed.drafts.some((draft) => affected.has(draft.componentRef))) {
    throw new SharedComponentChangeError('CONFLICT', 'Discard or publish pending drafts before removing or rewriting their component definitions.');
  }
  for (const key of Object.keys(changeIds)) {
    LocalComponentReferenceSchema.parse(key);
    if (!changed.has(key)) throw new SharedComponentChangeError('CONFLICT', 'Change IDs must describe exactly the rewritten surviving definitions.');
  }
  const usedIds = new Set([
    ...parsed.drafts.map((draft) => draft.id),
    ...parsed.history.flatMap((entry) => entry.changeId === null ? [] : [entry.changeId]),
  ]);
  for (const componentRef of changed) {
    const id = Object.hasOwn(changeIds, componentRef) ? changeIds[componentRef] : undefined;
    if (id === undefined) throw new SharedComponentChangeError('CONFLICT', `A stable change ID is required for ${componentRef}.`);
    DesignEntityIdSchema.parse(id);
    if (usedIds.has(id)) throw new SharedComponentChangeError('CONFLICT', 'Registry rewrite change IDs cannot collide with pending or published changes.');
    usedIds.add(id);
  }
  for (const componentRef of affected) assertRevision(before, parsed, componentRef, findDefinition(before, componentRef)!.revision);
  const projectComponents = ProjectComponentRegistrySchema.parse({ ...afterRegistry, components });
  const resolved = resolveProjectDocument(contextWithDocument({ ...after, projectComponents }), limits);
  if (resolved.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new SharedComponentChangeError('VALIDATION_FAILED', 'Registry rewrite is blocked by final project validation errors.', { diagnostics: resolved.diagnostics });
  }
  const history = [...parsed.history];
  for (const componentRef of [...affected].sort(compareDesignRuntimeKeys)) {
    const old = findDefinition(before, componentRef)!;
    if (!history.some((entry) => entry.componentRef === componentRef && entry.definition.revision === old.revision)) {
      history.push({ schemaVersion: 1, componentRef, definition: old, changeId: null });
    }
    const current = projectComponents.components.find((definition) => componentRef === `local:${definition.id}`);
    if (current) history.push({ schemaVersion: 1, componentRef, definition: current, changeId: changeIds[componentRef]! });
  }
  history.sort((a, b) => compareDesignRuntimeKeys(a.componentRef, b.componentRef) || a.definition.revision - b.definition.revision);
  return SharedComponentRegistryChangeResultSchema.parse({ schemaVersion: 1, projectComponents, changes: { ...parsed, history }, resolved });
}
