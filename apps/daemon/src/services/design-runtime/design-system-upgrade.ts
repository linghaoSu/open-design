import { createHash } from 'node:crypto';
import {
  ApplyDesignSystemUpgradeRequestSchema, ComponentBindingRegistrySchema, ComponentBindingSchema,
  DesignSystemMigrationPlanSchema, DesignSystemUpgradeContextSchema, DesignSystemUpgradeReviewSchema, DesignSystemUpgradeResultSchema,
  type ApplyDesignSystemUpgradeRequest, type ComponentPropDefinition, type ComponentBinding, type ComponentBindingRegistry, type ComponentReferenceOwner,
  type DesignSystemMigrationPlan, type DesignSystemUpgradeContext, type DesignSystemUpgradeReview, type DesignSystemUpgradeResult,
  type DesignSystemVersion, type ProjectComponentRegistry, type ReferenceUsage, type ResolvedUIIRResult, type UIIRNode, type ValidationDiagnostic,
} from '@open-design/contracts';
import { canonicalDesignSystemJson, createProjectDesignSystemLock, resolveLockedDesignSystemsSync, satisfiesDesignSystemRange } from './design-system-version.js';
import { diffDesignSystemVersions } from './design-system-diff.js';
import { resolveProjectDocument } from './project-components.js';
import { buildReferenceGraph, compareDesignRuntimeKeys, queryReferenceGraph, resolveRuntimeLimits, type DesignRuntimeLimits, type ProjectComponentContext } from './reference-graph.js';
import { inspectSharedComponentChange, recordSharedComponentDesignSystemUpgrade, SharedComponentChangeError } from './shared-component-changes.js';
import { reindexComponentBindings, revalidateComponentBinding, unbindComponent } from './code-component-index.js';
import { resolveComponentBinding } from './binding-resolver.js';
import { validateComponentProperties } from './component-validator.js';
import { migrateUpgradeSource, type UpgradeMigrationResult } from './upgrade-migration.js';

export class DesignSystemUpgradeError extends Error {
  constructor(readonly code: 'CONFLICT' | 'VALIDATION_FAILED', message: string, readonly diagnostics: ValidationDiagnostic[], readonly review?: DesignSystemUpgradeReview) {
    super(message); this.name = 'DesignSystemUpgradeError';
  }
}
const digest = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalDesignSystemJson(value)).digest('hex')}`;
const equal = (a: unknown, b: unknown) => canonicalDesignSystemJson(a) === canonicalDesignSystemJson(b);
const failure = (message: string): ValidationDiagnostic => ({ schemaVersion: 1, code: 'ODDS5002', severity: 'error', message });
function unique<T>(entries: T[]): T[] {
  return [...new Map(entries.map((entry) => [canonicalDesignSystemJson(entry), entry])).entries()].sort(([a], [b]) => compareDesignRuntimeKeys(a, b)).map(([, value]) => value);
}
function resolution(context: ProjectComponentContext, limits: DesignRuntimeLimits): ResolvedUIIRResult {
  try { return resolveProjectDocument(context, limits); }
  catch (error) { return { schemaVersion: 1, document: null, origins: [], diagnostics: [failure(error instanceof Error ? error.message : 'Proposed source cannot be validated.')] }; }
}
function contextWithDocument(context: DesignSystemUpgradeContext, version: DesignSystemVersion): ProjectComponentContext {
  return { registry: version.package.registry, projectComponents: context.projectComponents, document: context.document ?? { schemaVersion: 1, id: context.projectId, screens: [] } };
}

function migrateBindings(context: DesignSystemUpgradeContext, target: DesignSystemVersion, plan: DesignSystemMigrationPlan, migration: UpgradeMigrationResult, diagnostics: ValidationDiagnostic[], projectComponents: ProjectComponentRegistry): ComponentBindingRegistry {
  // Manual bindings remain exactly authored until an explicit binding decision replaces them.
  // Source prop transforms do not imply a production mapping transform: that would silently alter code contracts.
  let bindings = reindexComponentBindings(context.bindings, context.codeIndex, { ...target.package.codeIndex, id: context.projectId }, target.package.registry, projectComponents);
  for (const decision of plan.bindingDecisions) {
    const previous = bindings.bindings.find((entry) => entry.id === decision.bindingId);
    if (decision.type === 'remove') {
      if (!previous) diagnostics.push(failure(`Binding ${decision.bindingId} does not exist to remove.`));
      bindings = { ...bindings, bindings: bindings.bindings.filter((entry) => entry.id !== decision.bindingId) };
    } else if (decision.type === 'use-target-package' || decision.type === 'set-binding') {
      const proposed = decision.type === 'use-target-package' ? target.package.bindings.bindings.find((entry) => entry.id === decision.targetBindingId) : decision.binding;
      if (!proposed) { diagnostics.push(failure(`Target package binding ${decision.type === 'use-target-package' ? decision.targetBindingId : decision.bindingId} does not exist.`)); continue; }
      if (previous && (proposed.framework !== previous.framework || proposed.componentRef !== (migration.replacements.get(previous.componentRef) ?? previous.componentRef))) {
        diagnostics.push(failure(`Binding ${decision.bindingId} must retain its framework and migrated design-component identity.`)); continue;
      }
      const next = ComponentBindingSchema.parse({ ...proposed, id: decision.bindingId });
      bindings = ComponentBindingRegistrySchema.parse({ ...bindings, bindings: [...bindings.bindings.filter((entry) => entry.id !== decision.bindingId), next] });
    } else {
      const result = decision.type === 'unbind' ? unbindComponent(bindings, decision.bindingId)
        : revalidateComponentBinding(bindings, decision.bindingId, target.package.registry, target.package.codeIndex, projectComponents);
      if (!result.ok) diagnostics.push(...result.diagnostics);
      else bindings = result.bindings;
    }
  }
  for (const binding of bindings.bindings) {
    const exists = binding.componentRef.startsWith('local:')
      ? projectComponents.components.some((entry) => binding.componentRef === `local:${entry.id}`)
      : target.package.registry.components.some((entry) => binding.componentRef === `ds:${target.package.id}/${entry.id}`);
    if (!exists) { diagnostics.push(failure(`Binding ${binding.id} references a removed component; choose an explicit replacement or remove the binding.`)); continue; }
    if (binding.status === 'unbound') continue;
    const checked = resolveComponentBinding(binding, target.package.registry, target.package.codeIndex.components, projectComponents);
    if (!checked.ok) diagnostics.push(...checked.diagnostics);
  }
  return { ...bindings, bindings: [...bindings.bindings].sort((a, b) => compareDesignRuntimeKeys(a.id, b.id)) };
}

function invalidOverrides(context: ProjectComponentContext, limits: DesignRuntimeLimits): DesignSystemUpgradeReview['invalidOverrides'] {
  const result: DesignSystemUpgradeReview['invalidOverrides'] = [];
  const bound = resolveRuntimeLimits(limits); let visited = 0;
  function visit(node: UIIRNode, owner: ComponentReferenceOwner, depth = 0): void {
    if (++visited > bound.maxNodes || depth > bound.maxDepth) return;
    if (node.type === 'instance') {
      const definition = node.ref.startsWith('local:') ? context.projectComponents.components.find((entry) => node.ref === `local:${entry.id}`)
        : context.registry?.components.find((entry) => node.ref === `ds:${context.registry!.id}/${entry.id}`);
      for (const override of node.overrides) {
        const property = override.path[1];
        const diagnostics = definition ? validateComponentProperties(definition, { component: node.ref, nodeId: node.id, props: { [property]: override.value } }).filter((entry) => entry.path?.[1] === property)
          : [failure(`Instance ${node.id} references unavailable ${node.ref}.`)];
        if (diagnostics.length) result.push({ owner, nodeId: node.id, property, diagnostics });
      }
    } else if (node.type === 'component') Object.values(node.slots ?? {}).forEach((children) => children.forEach((child) => visit(child, owner, depth + 1)));
  }
  for (const definition of context.projectComponents.components) visit(definition.template, { kind: 'component', componentRef: `local:${definition.id}` });
  for (const screen of context.document.screens) screen.children.forEach((node) => visit(node, { kind: 'screen', documentId: context.document.id, screenId: screen.id }));
  return unique(result);
}

function compute(input: DesignSystemUpgradeContext, from: DesignSystemVersion, to: DesignSystemVersion, rawPlan: DesignSystemMigrationPlan, limits: DesignRuntimeLimits) {
  const context = DesignSystemUpgradeContextSchema.parse(input);
  const plan = DesignSystemMigrationPlanSchema.parse(rawPlan);
  const checked = diffDesignSystemVersions(from, to);
  if (!checked.ok) throw new DesignSystemUpgradeError('VALIDATION_FAILED', 'Exact upgrade packages cannot be verified.', checked.diagnostics);
  if (!equal(plan.from, checked.diff.from) || !equal(plan.to, checked.diff.to) || !equal(context.lock.dependencies[0], plan.from)) throw new DesignSystemUpgradeError('CONFLICT', 'Migration plan does not match the active lock and exact package snapshots.', [failure('Review the current exact dependency before preparing an upgrade.')]);
  const loaded = resolveLockedDesignSystemsSync(context.dependencies, context.lock, () => from);
  if (!loaded.ok) throw new DesignSystemUpgradeError('VALIDATION_FAILED', 'Current dependency cannot be verified.', loaded.diagnostics);
  if (!equal(context.codeIndex, { ...from.package.codeIndex, id: context.projectId })) throw new DesignSystemUpgradeError('CONFLICT', 'The project code index does not match its frozen source.', [failure('Upgrade requires the exact active code index.')]);
  const diagnostics: ValidationDiagnostic[] = [];
  if (!satisfiesDesignSystemRange(to.package.version, plan.targetRange)) diagnostics.push(failure('The target version does not satisfy the explicitly selected dependency range.'));
  const currentContext = contextWithDocument(context, from);
  const current = resolution(currentContext, limits);
  const migration = migrateUpgradeSource(context.projectComponents, context.document, plan, limits);
  diagnostics.push(...migration.diagnostics);
  const admits = (prop: ComponentPropDefinition, value: unknown) => prop.type === 'enum' ? prop.values.includes(value as never) : typeof value === prop.type;
  for (const rule of plan.rules) {
    const oldRef = rule.type === 'replace-component' ? rule.fromRef : rule.componentRef;
    const old = from.package.registry.components.find((entry) => oldRef === `ds:${from.package.id}/${entry.id}`);
    const targetRef = migration.replacements.get(oldRef) ?? oldRef;
    const target = to.package.registry.components.find((entry) => targetRef === `ds:${to.package.id}/${entry.id}`);
    if (!old) diagnostics.push(failure(`Migration rule ${rule.id} has no source component in the active package.`));
    if (!target) diagnostics.push(failure(`Migration rule ${rule.id} has no component target in the selected package.`));
    if (rule.type === 'transform-prop' || rule.type === 'drop-prop') {
      const sourceName = rule.type === 'transform-prop' ? rule.fromProp : rule.prop;
      const source = old && Object.hasOwn(old.props, sourceName) ? old.props[sourceName] : undefined;
      if (!source) diagnostics.push(failure(`Migration rule ${rule.id} has no source property ${sourceName}.`));
      if (rule.type === 'transform-prop') {
        const output = target && Object.hasOwn(target.props, rule.toProp) ? target.props[rule.toProp] : undefined;
        if (!output) diagnostics.push(failure(`Migration rule ${rule.id} has no target property ${rule.toProp}.`));
        for (const entry of rule.valueMap ?? []) {
          if (source && !admits(source, entry.from)) diagnostics.push(failure(`Migration rule ${rule.id} maps an impossible source property value.`));
          if (output && !admits(output, entry.to)) diagnostics.push(failure(`Migration rule ${rule.id} maps to a value outside the target property domain.`));
        }
      }
    } else if (rule.type === 'rename-slot' || rule.type === 'drop-slot') {
      const sourceName = rule.type === 'rename-slot' ? rule.fromSlot : rule.slot;
      if (!old || !Object.hasOwn(old.slots ?? {}, sourceName)) diagnostics.push(failure(`Migration rule ${rule.id} has no source slot ${sourceName}.`));
      if (rule.type === 'rename-slot' && (!target || !Object.hasOwn(target.slots ?? {}, rule.toSlot))) diagnostics.push(failure(`Migration rule ${rule.id} has no target slot ${rule.toSlot}.`));
    }
  }
  const proposedContext = contextWithDocument({ ...context, projectComponents: migration.projectComponents, document: migration.document }, to);
  let proposed = resolution(proposedContext, limits);
  diagnostics.push(...proposed.diagnostics);
  let projectComponents = migration.projectComponents; let sharedChanges = context.sharedChanges;
  // Pending drafts are never edited implicitly. A target package cannot silently strand a draft.
  for (const draft of context.sharedChanges.drafts) {
    try {
      const impact = inspectSharedComponentChange({ ...proposedContext, document: migration.document }, context.sharedChanges, draft.id, limits);
      if (impact.diagnostics.some((entry) => entry.severity === 'error')) diagnostics.push(failure(`Pending draft ${draft.id} becomes invalid under the target design system; repair or discard it explicitly.`), ...impact.diagnostics);
    } catch (error) { diagnostics.push(failure(`Pending draft ${draft.id} cannot retain its base snapshot: ${error instanceof Error ? error.message : 'invalid draft'}`)); }
  }
  if (!diagnostics.some((entry) => entry.severity === 'error')) {
    const changeIds = Object.fromEntries(migration.projectComponents.components.filter((definition) => {
      const previous = context.projectComponents.components.find((entry) => entry.id === definition.id);
      return !equal(previous, definition);
    }).map((definition) => [`local:${definition.id}`, `upgrade${digest([plan, context.revision, definition.id]).slice(7)}`]));
    try {
      const recorded = recordSharedComponentDesignSystemUpgrade({ ...currentContext, document: context.document }, { ...proposedContext, document: migration.document }, context.sharedChanges, changeIds, limits);
      projectComponents = recorded.projectComponents; sharedChanges = recorded.changes; proposed = recorded.resolved;
    } catch (error) {
      if (error instanceof SharedComponentChangeError) diagnostics.push(...error.diagnostics, failure(error.message));
      else throw error;
    }
  }
  let bindings = context.bindings;
  try { bindings = migrateBindings(context, to, plan, migration, diagnostics, projectComponents); }
  catch (error) { diagnostics.push(failure(error instanceof Error ? error.message : 'Binding decisions conflict.')); }
  const changedRefs = new Set(checked.diff.changes.filter((change) => change.entity.kind === 'component').map((change) => `ds:${from.package.id}/${'id' in change.entity ? change.entity.id : ''}`));
  const changedBindingIds = new Set(checked.diff.changes.filter((change) => change.entity.kind === 'binding').map((change) => 'id' in change.entity ? change.entity.id : ''));
  const changedCodeIds = new Set(checked.diff.changes.filter((change) => change.entity.kind === 'code-component').map((change) => 'id' in change.entity ? change.entity.id : ''));
  const explicitBindingIds = new Set(plan.bindingDecisions.map((entry) => entry.bindingId));
  for (const binding of [...from.package.bindings.bindings, ...to.package.bindings.bindings, ...context.bindings.bindings, ...bindings.bindings]) {
    if (changedBindingIds.has(binding.id) || explicitBindingIds.has(binding.id) || (binding.status !== 'unbound' && changedCodeIds.has(binding.codeComponentId))) changedRefs.add(binding.componentRef);
  }
  const conservative = checked.diff.changes.some((change) => ['source', 'token', 'constraint', 'code-compatibility', 'design-system'].includes(change.entity.kind));
  const edges = buildReferenceGraph(currentContext, limits);
  const nextEdges = proposed.document === null ? { edges: [], diagnostics: [] } : buildReferenceGraph({ ...proposedContext, projectComponents }, limits);
  // An incomplete bounded traversal cannot certify a complete impact preview.
  diagnostics.push(...[...edges.diagnostics, ...nextEdges.diagnostics].filter((entry) => entry.code === 'ODDS4007'));
  if (conservative) for (const edge of [...edges.edges, ...nextEdges.edges]) if (edge.target.startsWith(`ds:${from.package.id}/`)) changedRefs.add(edge.target);
  const affectedUsages: ReferenceUsage[] = []; const affectedScreens: DesignSystemUpgradeReview['affectedScreens'] = [];
  for (const ref of [...changedRefs].sort(compareDesignRuntimeKeys)) for (const source of [currentContext, ...(proposed.document === null ? [] : [{ ...proposedContext, projectComponents }])]) {
    const usages = queryReferenceGraph(source, ref, limits);
    affectedUsages.push(...usages.directUsages, ...usages.chains.flat()); affectedScreens.push(...usages.affectedScreens);
    diagnostics.push(...usages.diagnostics.filter((entry) => entry.code === 'ODDS4007'));
  }
  const transitions = unique([...context.bindings.bindings.map((entry) => entry.id), ...bindings.bindings.map((entry) => entry.id)]).flatMap((id) => {
    const before = context.bindings.bindings.find((entry) => entry.id === id) ?? null;
    const after = bindings.bindings.find((entry) => entry.id === id) ?? null;
    return equal(before, after) && !plan.bindingDecisions.some((entry) => entry.bindingId === id) ? [] : [{ bindingId: id, before, after }];
  });
  const affectedBindings = unique([...transitions.flatMap((entry) => [entry.before, entry.after].filter((value): value is ComponentBinding => value !== null)), ...context.bindings.bindings.filter((entry) => conservative || changedRefs.has(entry.componentRef))]);
  const sourceFiles = unique(affectedBindings.flatMap((entry) => entry.status === 'unbound' ? [] : [...from.package.codeIndex.components, ...to.package.codeIndex.components].filter((code) => code.id === entry.codeComponentId).map((code) => code.sourcePath)));
  const baseDigest = digest(context); const planDigest = digest(plan);
  const review = DesignSystemUpgradeReviewSchema.parse({
    schemaVersion: 1, id: `review${digest([baseDigest, planDigest]).slice(7)}`, projectId: context.projectId, baseRevision: context.revision, baseDigest, planDigest,
    plan, diff: checked.diff, current, proposed, affectedUsages: [...new Map(affectedUsages.map((entry) => [canonicalDesignSystemJson([entry.owner, entry.nodeId]), entry])).entries()].sort(([a], [b]) => compareDesignRuntimeKeys(a, b)).map(([, entry]) => entry), affectedScreens: unique(affectedScreens),
    invalidOverrides: invalidOverrides({ ...proposedContext, projectComponents }, limits),
    codeImpact: { bindings: affectedBindings, sourceFiles, coverage: 'registered-bindings' }, bindingTransitions: transitions,
    tokenUsageCoverage: 'not-indexed', sourceUsageCoverage: 'conservative-design-system-screens',
    diagnostics: unique(diagnostics), canApply: !diagnostics.some((entry) => entry.severity === 'error') && proposed.document !== null,
  });
  return { review, projectComponents, sharedChanges, document: migration.document, bindings,
    codeIndex: { ...to.package.codeIndex, id: context.projectId }, lock: createProjectDesignSystemLock(context.projectId, [to]),
    dependencies: { ...context.dependencies, dependencies: [{ designSystemId: to.package.id, version: plan.targetRange }] },
  };
}

export function reviewDesignSystemUpgrade(context: DesignSystemUpgradeContext, from: DesignSystemVersion, to: DesignSystemVersion, plan: DesignSystemMigrationPlan, limits: DesignRuntimeLimits = {}): DesignSystemUpgradeReview {
  return compute(context, from, to, plan, limits).review;
}

/** No I/O: callers persist this reviewed result and their aggregate CAS in one transaction. */
export function applyDesignSystemUpgrade(context: DesignSystemUpgradeContext, from: DesignSystemVersion, to: DesignSystemVersion, input: ApplyDesignSystemUpgradeRequest, limits: DesignRuntimeLimits = {}): DesignSystemUpgradeResult {
  const request = ApplyDesignSystemUpgradeRequestSchema.parse(input);
  const result = compute(context, from, to, request.plan, limits);
  if (result.review.id !== request.reviewId || result.review.baseDigest !== request.baseDigest || result.review.planDigest !== request.planDigest) throw new DesignSystemUpgradeError('CONFLICT', 'The project or migration plan changed after review.', [failure('Create a fresh impact review before applying the upgrade.')], result.review);
  if (!result.review.canApply) throw new DesignSystemUpgradeError('VALIDATION_FAILED', 'The proposed upgrade has unresolved diagnostics.', result.review.diagnostics, result.review);
  return DesignSystemUpgradeResultSchema.parse({ schemaVersion: 1, ...result });
}
