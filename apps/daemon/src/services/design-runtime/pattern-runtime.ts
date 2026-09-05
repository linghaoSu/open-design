import {
  DesignEntityIdSchema, DesignPatternRuntimeContextSchema, InstantiateDesignPatternRequestSchema, ProjectDesignSystemLockSchema,
  type DesignPatternInstantiationResult, type DesignPatternNodeOrigin, type DesignPatternReadResult, type DesignPatternRuntimeContext,
  type DesignPatternSearchResult, type DesignSystemVersion, type InstantiateDesignPatternRequest, type ProjectDesignSystemLock,
  type UIIRNode, type ValidationDiagnostic,
} from '@open-design/contracts';
import { validateComponentProperties } from './component-validator.js';
import { DesignSystemVersionError, resolveLockedDesignSystemsSync } from './design-system-version.js';
import { resolveProjectDocument } from './project-components.js';
import { compareDesignRuntimeKeys, resolveRuntimeLimits, type DesignRuntimeLimits } from './reference-graph.js';
import { materializeComponentProperties, materializeTemplateProperties } from './template-properties.js';

function diagnostic(code: ValidationDiagnostic['code'], message: string, path?: (string | number)[], nodeId?: string): ValidationDiagnostic {
  return { schemaVersion: 1, severity: 'error', code, message, ...(path === undefined ? {} : { path }), ...(nodeId === undefined ? {} : { nodeId }) };
}

/** The shared exact-lock evaluator verifies the full frozen package and bundled source. */
function exactPackage(rawLock: ProjectDesignSystemLock, version: DesignSystemVersion) {
  const lock = ProjectDesignSystemLockSchema.parse(rawLock);
  if (lock.dependencies.length !== 1) throw new DesignSystemVersionError([diagnostic('ODDS5001', 'Patterns require one active exact design-system dependency.')]);
  const resolved = resolveLockedDesignSystemsSync({ schemaVersion: 1, id: lock.id, dependencies: lock.dependencies.map((entry) => ({ designSystemId: entry.designSystemId, version: entry.version })) }, lock, () => version);
  if (!resolved.ok) throw new DesignSystemVersionError(resolved.diagnostics);
  return { dependency: lock.dependencies[0]!, pkg: resolved.versions[0]!.package };
}

export function searchDesignPatterns(lock: ProjectDesignSystemLock, version: DesignSystemVersion, query = ''): DesignPatternSearchResult {
  const { dependency, pkg } = exactPackage(lock, version);
  const needle = query.trim().toLowerCase();
  const patterns = pkg.patterns.patterns.filter((pattern) => [pattern.id, pattern.name, pattern.description ?? ''].some((value) => value.toLowerCase().includes(needle)))
    .sort((a, b) => compareDesignRuntimeKeys(a.id, b.id));
  return { schemaVersion: 1, dependency, patterns };
}

export function getDesignPattern(lock: ProjectDesignSystemLock, version: DesignSystemVersion, patternId: string): DesignPatternReadResult {
  const { dependency, pkg } = exactPackage(lock, version);
  const id = DesignEntityIdSchema.parse(patternId); const pattern = pkg.patterns.patterns.find((entry) => entry.id === id);
  if (!pattern) throw new DesignSystemVersionError([diagnostic('ODDS4002', `Pattern ${id} does not exist in the locked design system.`)]);
  return { schemaVersion: 1, dependency, pattern };
}

/** Produces a semantic subtree only. Whole-project validation resolves copies; source instances stay sparse. */
export function instantiateDesignPattern(rawContext: DesignPatternRuntimeContext, version: DesignSystemVersion, rawRequest: InstantiateDesignPatternRequest, options: DesignRuntimeLimits = {}): DesignPatternInstantiationResult {
  const context = DesignPatternRuntimeContextSchema.parse(rawContext);
  const request = InstantiateDesignPatternRequestSchema.parse(rawRequest);
  const { dependency, pkg } = exactPackage(context.lock, version);
  const base = { schemaVersion: 1 as const, patternId: request.patternId, instanceId: request.instanceId, dependency };
  const diagnostics: ValidationDiagnostic[] = [];
  const failed = (): DesignPatternInstantiationResult => ({ ...base, node: null, origins: [], diagnostics });
  const pattern = pkg.patterns.patterns.find((entry) => entry.id === request.patternId);
  if (!pattern) { diagnostics.push(diagnostic('ODDS4002', `Pattern ${request.patternId} does not exist in the locked design system.`, ['patternId'])); return failed(); }
  const screen = context.document.screens.find((entry) => entry.id === request.destinationScreenId);
  if (!screen) { diagnostics.push(diagnostic('ODDS4001', `Destination screen ${request.destinationScreenId} does not exist.`, ['destinationScreenId'])); return failed(); }
  diagnostics.push(...validateComponentProperties(pattern, { component: `pattern:${pkg.id}/${pattern.id}`, props: request.props }));
  for (const name of Object.keys(request.slots).sort(compareDesignRuntimeKeys)) {
    if (!Object.hasOwn(pattern.slots, name)) diagnostics.push(diagnostic('ODDS1004', `Pattern ${pattern.id} has no slot ${name}.`, ['slots', name]));
  }
  for (const [name, slot] of Object.entries(pattern.slots).sort(([a], [b]) => compareDesignRuntimeKeys(a, b))) {
    const children = Object.hasOwn(request.slots, name) ? request.slots[name]! : [];
    if ((slot.required && !children.length) || (!slot.multiple && children.length > 1)) diagnostics.push(diagnostic('ODDS1004', `Pattern slot ${name} is empty or exceeds its allowed cardinality.`, ['slots', name]));
  }
  if (diagnostics.some((entry) => entry.severity === 'error')) return failed();

  const limits = resolveRuntimeLimits(options); let visited = 0;
  const origins: DesignPatternNodeOrigin[] = []; const templateNodes = new Map<string, UIIRNode>();
  const clone = (sourceNode: UIIRNode, source: DesignPatternNodeOrigin['source'], depth: number): UIIRNode | null => {
    if (++visited > limits.maxNodes || depth > limits.maxDepth) {
      if (!diagnostics.some((entry) => entry.code === 'ODDS4007')) diagnostics.push(diagnostic('ODDS4007', 'Pattern instantiation exceeded its node or depth limit.', undefined, sourceNode.id));
      return null;
    }
    const sourceIdentity = source.kind === 'pattern' ? ['pattern', source.sourceNodeId] : ['slot', source.slot, source.path, source.sourceNodeId];
    const id = `p${Buffer.from(JSON.stringify([context.lock.id, pkg.id, pattern.id, request.instanceId, sourceIdentity]), 'utf8').toString('hex')}`;
    const node = { ...sourceNode, id };
    origins.push({ nodeId: id, source });
    if (source.kind === 'pattern') templateNodes.set(source.sourceNodeId, node);
    if (node.type === 'component' && sourceNode.type === 'component' && sourceNode.slots !== undefined) {
      node.slots = Object.fromEntries(Object.keys(sourceNode.slots).sort(compareDesignRuntimeKeys).map((name) => [name, sourceNode.slots![name]!.flatMap((child, index) => {
        const nextSource: DesignPatternNodeOrigin['source'] = source.kind === 'pattern'
          ? { kind: 'pattern', patternId: pattern.id, sourceNodeId: child.id }
          : { kind: 'slot', slot: source.slot, sourceNodeId: child.id, path: [...source.path, 'slots', name, index] };
        const result = clone(child, nextSource, depth + 1); return result ? [result] : [];
      })]));
    }
    return node;
  };
  const template = materializeTemplateProperties(pattern.template, pattern.propMappings, materializeComponentProperties(pattern, request.props));
  const node = clone(template, { kind: 'pattern', patternId: pattern.id, sourceNodeId: template.id }, 0);
  for (const mapping of pattern.slotMappings) {
    const target = templateNodes.get(mapping.nodeId);
    if (target?.type !== 'component' || !Object.hasOwn(request.slots, mapping.slot)) continue;
    const children = request.slots[mapping.slot]!.flatMap((child, index) => {
      const result = clone(child, { kind: 'slot', slot: mapping.slot, sourceNodeId: child.id, path: [index] }, 1); return result ? [result] : [];
    });
    target.slots = { ...target.slots, [mapping.targetSlot]: children };
  }
  if (!node || diagnostics.some((entry) => entry.severity === 'error')) return failed();

  // Resolve the complete proposed composition once, including unused local definitions. The
  // canonical document parser diagnoses ID collisions across every screen before adoption.
  screen.children.push(node);
  const resolved = resolveProjectDocument({ registry: pkg.registry, projectComponents: context.projectComponents, document: context.document }, options);
  diagnostics.push(...resolved.diagnostics);
  if (!resolved.document) return failed();
  const resolvedNodes = new Map<string, UIIRNode>();
  const collect = (entry: UIIRNode): void => { resolvedNodes.set(entry.id, entry); if (entry.type === 'component') for (const children of Object.values(entry.slots ?? {})) children.forEach(collect); };
  for (const resultScreen of resolved.document.screens) resultScreen.children.forEach(collect);
  const directOrigins = new Map(resolved.origins.filter((entry) => !entry.instancePath.length).map((entry) => [entry.sourceNodeId, entry.nodeId]));
  for (const mapping of pattern.slotMappings) {
    const source = templateNodes.get(mapping.nodeId)!;
    const target = resolvedNodes.get(directOrigins.get(source.id) ?? '');
    if (target?.type !== 'component') continue; // Whole-document validation already rejects absent targets.
    const children = target.slots && Object.hasOwn(target.slots, mapping.targetSlot) ? target.slots[mapping.targetSlot]! : [];
    const slot = pattern.slots[mapping.slot]!;
    for (const [index, child] of children.entries()) {
      const ref = child.type === 'text' ? 'text' : child.ref;
      if (!slot.accepts.includes(ref)) diagnostics.push(diagnostic('ODDS1004', `Pattern slot ${mapping.slot} does not accept the resolved root ${ref}.`, ['slots', mapping.slot, index]));
    }
  }
  return diagnostics.some((entry) => entry.severity === 'error') ? failed() : { ...base, node, origins, diagnostics };
}
