import type {
  ComponentDeletionAnalysis,
  ComponentReferenceOwner,
  ComponentReferenceScreenOwner,
  ComponentRegistry,
  ProjectComponentRegistry,
  ReferenceGraph,
  ReferenceGraphQueryResult,
  ReferenceUsage,
  UIIRDocument,
  UIIRNode,
  ValidationDiagnostic,
} from '@open-design/contracts';

export interface ProjectComponentContext {
  registry: ComponentRegistry | null;
  projectComponents: ProjectComponentRegistry;
  document: UIIRDocument;
}

export interface DesignRuntimeLimits {
  maxNodes?: number;
  maxChains?: number;
  maxDepth?: number;
}

export function resolveRuntimeLimits(options: DesignRuntimeLimits = {}): Required<DesignRuntimeLimits> {
  const limits = { maxNodes: options.maxNodes ?? 10_000, maxChains: options.maxChains ?? 1_000, maxDepth: options.maxDepth ?? 128 };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return limits;
}

export function compareDesignRuntimeKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ownerKey(owner: ComponentReferenceOwner): string {
  return JSON.stringify(owner.kind === 'component' ? ['component', owner.componentRef] : ['screen', owner.documentId, owner.screenId]);
}

function edgeKey(edge: ReferenceUsage): string {
  return JSON.stringify([ownerKey(edge.owner), edge.nodeId]);
}

function error(code: ValidationDiagnostic['code'], message: string, componentRef?: string): ValidationDiagnostic {
  return { schemaVersion: 1, severity: 'error', code, message, ...(componentRef === undefined ? {} : { componentRef }) };
}

function knownReferences(input: ProjectComponentContext): Set<string> {
  return new Set([
    ...input.projectComponents.components.map((component) => `local:${component.id}`),
    ...(input.registry?.components.map((component) => `ds:${input.registry!.id}/${component.id}`) ?? []),
  ]);
}

/** Cycles are deterministic witnesses, not an exponential enumeration of all simple cycles. */
function findCycles(edges: ReferenceUsage[], limits: Required<DesignRuntimeLimits>): { cycles: string[][]; diagnostics: ValidationDiagnostic[] } {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.owner.kind !== 'component' || !edge.target.startsWith('local:')) continue;
    const targets = adjacency.get(edge.owner.componentRef) ?? new Set<string>();
    targets.add(edge.target);
    adjacency.set(edge.owner.componentRef, targets);
  }
  const cycles = new Map<string, string[]>();
  const done = new Set<string>();
  const active = new Set<string>();
  let limited = false;
  const visit = (ref: string, path: string[]): void => {
    if (path.length >= limits.maxDepth) { limited = true; return; }
    active.add(ref);
    const nextPath = [...path, ref];
    for (const target of [...(adjacency.get(ref) ?? [])].sort()) {
      if (active.has(target)) {
        const cycle = nextPath.slice(nextPath.indexOf(target));
        const smallest = cycle.reduce((best, value, index) => value < cycle[best]! ? index : best, 0);
        const rotated = [...cycle.slice(smallest), ...cycle.slice(0, smallest)];
        rotated.push(rotated[0]!);
        cycles.set(JSON.stringify(rotated), rotated);
      } else if (!done.has(target)) visit(target, nextPath);
    }
    active.delete(ref);
    done.add(ref);
  };
  for (const ref of [...adjacency.keys()].sort()) if (!done.has(ref)) visit(ref, []);
  const values = [...cycles.entries()].sort(([a], [b]) => compareDesignRuntimeKeys(a, b)).map(([, cycle]) => cycle);
  return {
    cycles: values,
    diagnostics: [
      ...values.map((cycle) => error('ODDS4003', `Component reference cycle: ${cycle.join(' → ')}.`, cycle[0])),
      ...(limited ? [error('ODDS4007', 'Reference cycle traversal exceeded its depth limit; graph completeness is unknown.')] : []),
    ],
  };
}

/** Records actual references only; slot acceptance declarations are not usages. */
export function buildReferenceGraph(input: ProjectComponentContext, options: DesignRuntimeLimits = {}): ReferenceGraph {
  const limits = resolveRuntimeLimits(options);
  const known = knownReferences(input);
  const edges: ReferenceUsage[] = [];
  const diagnostics: ValidationDiagnostic[] = [];
  let visited = 0;
  let limited = false;
  const visit = (node: UIIRNode, owner: ComponentReferenceOwner, path: (string | number)[], depth: number): void => {
    if (++visited > limits.maxNodes || depth > limits.maxDepth) { limited = true; return; }
    if (node.type === 'text') return;
    edges.push({ schemaVersion: 1, owner, nodeId: node.id, target: node.ref, path });
    if (!known.has(node.ref)) diagnostics.push({ ...error('ODDS4002', `Component reference ${node.ref} does not exist.`, node.ref), nodeId: node.id, path });
    if (node.type === 'component') {
      if (node.ref.startsWith('local:')) diagnostics.push({ ...error('ODDS4001', 'Project-local references require an override-only instance node.', node.ref), nodeId: node.id, path });
      for (const slot of Object.keys(node.slots ?? {}).sort()) {
        node.slots![slot]!.forEach((child, index) => visit(child, owner, [...path, 'slots', slot, index], depth + 1));
      }
    }
  };
  for (const definition of [...input.projectComponents.components].sort((a, b) => compareDesignRuntimeKeys(a.id, b.id))) {
    visit(definition.template, { kind: 'component', componentRef: `local:${definition.id}` }, ['template'], 0);
  }
  for (const screen of input.document.screens) {
    screen.children.forEach((node, index) => visit(node, { kind: 'screen', documentId: input.document.id, screenId: screen.id }, ['children', index], 0));
  }
  if (limited) diagnostics.push(error('ODDS4007', 'Reference graph exceeded its node or depth limit; usage completeness is unknown.'));
  edges.sort((a, b) => compareDesignRuntimeKeys(edgeKey(a), edgeKey(b)));
  diagnostics.push(...findCycles(edges, limits).diagnostics);
  return { schemaVersion: 1, id: input.projectComponents.id, edges, diagnostics };
}

/** transitiveUsages is the reachable owner closure, including direct owners. Chains end at screens, unused definitions, or a cycle. */
export function queryReferenceGraph(input: ProjectComponentContext, target: string, options: DesignRuntimeLimits = {}): ReferenceGraphQueryResult {
  const limits = resolveRuntimeLimits(options);
  const graph = buildReferenceGraph(input, limits);
  const diagnostics = [...graph.diagnostics];
  if (!knownReferences(input).has(target)) diagnostics.push(error('ODDS4002', `Queried component ${target} does not exist.`, target));
  const reverse = new Map<string, ReferenceUsage[]>();
  for (const edge of graph.edges) {
    const entries = reverse.get(edge.target) ?? [];
    entries.push(edge);
    reverse.set(edge.target, entries);
  }
  const directUsages = reverse.get(target) ?? [];
  const owners = new Map<string, ComponentReferenceOwner>();
  const screens = new Map<string, ComponentReferenceScreenOwner>();
  const queue = [...directUsages];
  for (let index = 0; index < queue.length; index++) {
    const edge = queue[index]!;
    const key = ownerKey(edge.owner);
    if (owners.has(key)) continue;
    owners.set(key, edge.owner);
    if (edge.owner.kind === 'screen') screens.set(key, edge.owner);
    else queue.push(...(reverse.get(edge.owner.componentRef) ?? []));
  }
  const chains: ReferenceUsage[][] = [];
  const pending = directUsages.map((edge) => [edge]).reverse();
  let steps = 0;
  let limited = false;
  while (pending.length) {
    if (++steps > limits.maxNodes || chains.length >= limits.maxChains) { limited = true; break; }
    const chain = pending.pop()!;
    const last = chain.at(-1)!;
    const seen = new Set(chain.map(edgeKey));
    const next = last.owner.kind === 'component' ? (reverse.get(last.owner.componentRef) ?? []).filter((edge) => !seen.has(edgeKey(edge))) : [];
    if (!next.length) chains.push(chain);
    else if (chain.length >= limits.maxDepth) { limited = true; break; }
    else if (pending.length + next.length > limits.maxNodes) { limited = true; break; }
    else for (const edge of [...next].reverse()) pending.push([...chain, edge]);
  }
  if (limited) diagnostics.push(error('ODDS4007', 'Dependency chain enumeration exceeded its limit; returned chains are incomplete.', target));
  return {
    schemaVersion: 1, target, directUsages,
    transitiveUsages: [...owners.entries()].sort(([a], [b]) => compareDesignRuntimeKeys(a, b)).map(([, owner]) => owner),
    affectedScreens: [...screens.entries()].sort(([a], [b]) => compareDesignRuntimeKeys(a, b)).map(([, owner]) => owner),
    chains, cycles: findCycles(graph.edges, limits).cycles, diagnostics,
  };
}

export function analyzeComponentDeletion(input: ProjectComponentContext, componentRef: string, options: DesignRuntimeLimits = {}): ComponentDeletionAnalysis {
  const usages = queryReferenceGraph(input, componentRef, options);
  const diagnostics = [...usages.diagnostics];
  if (!componentRef.startsWith('local:')) diagnostics.push(error('ODDS4004', 'Only project-local component definitions can be deleted.', componentRef));
  return {
    schemaVersion: 1, componentRef,
    canDelete: !usages.directUsages.length && !usages.cycles.length && !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    usages, diagnostics,
  };
}
