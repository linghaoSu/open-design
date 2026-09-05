import {
  ComponentDetachRequestSchema,
  ComponentInstanceSchema,
  ComponentRegistrySchema,
  ProjectComponentDeleteRequestSchema,
  ProjectComponentRegistrySchema,
  UIIRDocumentSchema,
  type ComponentDefinition,
  type ComponentDetachRequest,
  type ComponentInstance,
  type ComponentPropDefinition,
  type JsonValue,
  type ProjectComponentDefinition,
  type ProjectComponentDeleteRequest,
  type ProjectComponentRegistry,
  type ResolvedInstanceFrame,
  type ResolvedNodeOrigin,
  type ResolvedUIIRResult,
  type UIIRDocument,
  type UIIRNode,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { validateComponentProperties } from './component-validator.js';
import {
  analyzeComponentDeletion,
  buildReferenceGraph,
  compareDesignRuntimeKeys,
  resolveRuntimeLimits,
  type DesignRuntimeLimits,
  type ProjectComponentContext,
} from './reference-graph.js';

type Definition = ComponentDefinition | ProjectComponentDefinition;

function diagnostic(code: ValidationDiagnostic['code'], message: string, nodeId?: string, componentRef?: string): ValidationDiagnostic {
  return { schemaVersion: 1, severity: 'error', code, message, ...(nodeId === undefined ? {} : { nodeId }), ...(componentRef === undefined ? {} : { componentRef }) };
}

function hasErrors(diagnostics: ValidationDiagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}

function getDefinition(input: ProjectComponentContext, ref: string): Definition | undefined {
  if (ref.startsWith('local:')) return input.projectComponents.components.find((entry) => ref === `local:${entry.id}`);
  return input.registry?.components.find((entry) => ref === `ds:${input.registry!.id}/${entry.id}`);
}

function withDefaults(definition: Definition, explicit: Record<string, JsonValue>): Record<string, JsonValue> {
  const props: Record<string, JsonValue> = {};
  for (const name of Object.keys(definition.props).sort()) {
    const value = definition.props[name]!.default;
    if (value !== undefined) props[name] = value;
  }
  return { ...props, ...explicit };
}

function overrideProps(instance: ComponentInstance): Record<string, JsonValue> {
  return Object.fromEntries(instance.overrides.map((override) => [override.path[1], override.value]));
}

function walk(node: UIIRNode, visitor: (node: UIIRNode) => void): void {
  visitor(node);
  if (node.type === 'component') {
    for (const name of Object.keys(node.slots ?? {}).sort()) for (const child of node.slots![name]!) walk(child, visitor);
  }
}

/** The entire source value domain must fit, not just the current default or one sample. */
function acceptsMapping(source: ComponentPropDefinition, target: ComponentPropDefinition): boolean {
  if (!source.required && source.default === undefined && target.required && target.default === undefined) return false;
  if (source.type === 'enum') {
    return source.values.every((value) => target.type === 'enum' ? target.values.includes(value) : typeof value === target.type);
  }
  return source.type === target.type;
}

function mappingDiagnostics(input: ProjectComponentContext): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const definition of input.projectComponents.components) {
    const nodes = new Map<string, UIIRNode>();
    walk(definition.template, (node) => nodes.set(node.id, node));
    definition.propMappings.forEach((mapping, index) => {
      if (mapping.path[0] === 'text') return; // The canonical schema proves the string domain and presence.
      const node = nodes.get(mapping.nodeId)!;
      const targetProps = node.type === 'text' ? undefined : getDefinition(input, node.ref)?.props;
      const target = targetProps && Object.hasOwn(targetProps, mapping.path[1]) ? targetProps[mapping.path[1]] : undefined;
      const source = definition.props[mapping.prop]!;
      if (!target || !acceptsMapping(source, target)) {
        diagnostics.push({
          ...diagnostic('ODDS4005', `Public prop ${mapping.prop} cannot safely map to ${mapping.path[1]} on ${mapping.nodeId}.`, mapping.nodeId, `local:${definition.id}`),
          path: ['propMappings', index],
        });
      }
    });
  }
  return diagnostics;
}

function materializeTemplate(definition: ProjectComponentDefinition, props: Record<string, JsonValue>): UIIRNode {
  const template = structuredClone(definition.template);
  const nodes = new Map<string, UIIRNode>();
  walk(template, (node) => nodes.set(node.id, node));
  for (const mapping of definition.propMappings) {
    if (!Object.hasOwn(props, mapping.prop)) continue;
    const node = nodes.get(mapping.nodeId)!;
    const value = props[mapping.prop]!;
    if (mapping.path[0] === 'text' && node.type === 'text') node.text = value as string;
    else if (mapping.path[0] === 'props' && node.type === 'component') node.props = { ...node.props, [mapping.path[1]]: value };
    else if (mapping.path[0] === 'props' && node.type === 'instance') node.overrides.push({ schemaVersion: 1, path: ['props', mapping.path[1]], value });
  }
  return template;
}

function sampleProps(definition: ProjectComponentDefinition): Record<string, JsonValue> {
  const props: Record<string, JsonValue> = {};
  for (const [name, prop] of Object.entries(definition.props)) {
    if (prop.default !== undefined) props[name] = prop.default;
    else if (prop.required) props[name] = prop.type === 'enum' ? prop.values[0]! : prop.type === 'string' ? '' : prop.type === 'number' ? 0 : false;
  }
  return props;
}

function parseContext(input: ProjectComponentContext): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  for (const [result, code] of [
    [ProjectComponentRegistrySchema.safeParse(input.projectComponents), 'ODDS4005'],
    [UIIRDocumentSchema.safeParse(input.document), 'ODDS4001'],
    ...(input.registry ? [[ComponentRegistrySchema.safeParse(input.registry), 'ODDS1001']] as const : []),
  ] as const) {
    if (!result.success) for (const issue of result.error.issues) diagnostics.push({ ...diagnostic(code, issue.message), path: issue.path.map((part) => typeof part === 'symbol' ? String(part) : part) });
  }
  return diagnostics;
}

/** No source mutation: inherited values exist only inside this derived document and its origin map. */
export function resolveProjectDocument(input: ProjectComponentContext, options: DesignRuntimeLimits = {}): ResolvedUIIRResult {
  return resolveDocument(input, options, 'project');
}

interface ExpansionBudget { visited: number; limited: boolean }

function resolveDocument(input: ProjectComponentContext, options: DesignRuntimeLimits, scope: 'project' | 'instance', budget: ExpansionBudget = { visited: 0, limited: false }, rootNamespace?: string[]): ResolvedUIIRResult {
  const limits = resolveRuntimeLimits(options);
  const diagnostics = scope === 'project' ? parseContext(input) : [];
  const failed = (): ResolvedUIIRResult => ({ schemaVersion: 1, document: null, origins: [], diagnostics });
  if (hasErrors(diagnostics)) return failed();
  if (scope === 'project') {
    diagnostics.push(...buildReferenceGraph(input, limits).diagnostics);
    if (hasErrors(diagnostics)) return failed();
    diagnostics.push(...mappingDiagnostics(input));
  }
  if (hasErrors(diagnostics)) return failed();
  const origins: ResolvedNodeOrigin[] = [];
  const reservedIds = new Set(input.document.screens.map((screen) => screen.id));
  const makeId = (namespace: string[], sourceNodeId: string, frames: ResolvedInstanceFrame[]): string => {
    // Hex-encoded JSON tuples are injective and valid canonical IDs. Revisions do not change node identity.
    let id = `n${Buffer.from(JSON.stringify([namespace, frames.map((frame) => [frame.instanceId, frame.componentRef]), sourceNodeId]), 'utf8').toString('hex')}`;
    while (reservedIds.has(id)) id += '_';
    reservedIds.add(id);
    return id;
  };
  const resolve = (node: UIIRNode, namespace: string[], frames: ResolvedInstanceFrame[], depth: number): UIIRNode | null => {
    if (++budget.visited > limits.maxNodes || depth > limits.maxDepth) {
      if (!budget.limited || diagnostics.length === 0) diagnostics.push(diagnostic('ODDS4007', 'Component expansion exceeded its node or depth limit; resolution is incomplete.', node.id));
      budget.limited = true;
      return null;
    }
    if (node.type === 'instance') {
      const definition = getDefinition(input, node.ref);
      if (!definition) { diagnostics.push(diagnostic('ODDS4002', `Component ${node.ref} does not exist.`, node.id, node.ref)); return null; }
      const props = withDefaults(definition, overrideProps(node));
      const invalid = validateComponentProperties(definition, { component: node.ref, props, nodeId: node.id });
      if (invalid.length) {
        diagnostics.push(diagnostic('ODDS4001', 'Instance overrides do not satisfy the referenced component props.', node.id, node.ref), ...invalid);
        return null;
      }
      const nextFrames = [...frames, { instanceId: node.id, componentRef: node.ref, ...('revision' in definition ? { definitionRevision: definition.revision } : {}) }];
      if ('template' in definition) return resolve(materializeTemplate(definition, props), namespace, nextFrames, depth + 1);
      return resolve({ schemaVersion: 1, type: 'component', id: node.id, ref: node.ref, props }, namespace, nextFrames, depth + 1);
    }
    const id = makeId(namespace, node.id, frames);
    if (node.type === 'text') {
      origins.push({ nodeId: id, sourceNodeId: node.id, instancePath: frames });
      return { ...node, id };
    }
    const definition = getDefinition(input, node.ref);
    if (!definition || 'template' in definition) { diagnostics.push(diagnostic('ODDS4002', `Expected a design-system component at ${node.ref}.`, node.id, node.ref)); return null; }
    const props = withDefaults(definition, node.props ?? {});
    diagnostics.push(...validateComponentProperties(definition, { component: node.ref, props, nodeId: node.id }));
    const slots: Record<string, UIIRNode[]> = {};
    for (const name of Object.keys(node.slots ?? {}).sort()) {
      const children = node.slots![name]!;
      const slot = definition.slots && Object.hasOwn(definition.slots, name) ? definition.slots[name] : undefined;
      if (!slot || (!slot.multiple && children.length > 1)) diagnostics.push({ ...diagnostic('ODDS1004', `Slot ${name} is unknown or exceeds its allowed cardinality.`, node.id, node.ref), path: ['slots', name] });
      const resolvedChildren: UIIRNode[] = [];
      for (const child of children) {
        const childRef = child.type === 'text' ? 'text' : child.ref;
        const resolved = resolve(child, namespace, frames, depth + 1);
        // A local instance may satisfy portable DS slot grammar through its resolved root.
        // Explicit local references remain an additional nominal allowance.
        const resolvedRef = resolved?.type === 'text' ? 'text' : resolved?.ref;
        if (slot && !slot.accepts.includes(childRef) && (resolvedRef === undefined || !slot.accepts.includes(resolvedRef))) diagnostics.push({ ...diagnostic('ODDS1004', `Slot ${name} does not accept ${childRef}${resolvedRef ? ` (resolved as ${resolvedRef})` : ''}.`, child.id, node.ref), path: ['slots', name] });
        if (resolved) resolvedChildren.push(resolved);
      }
      slots[name] = resolvedChildren;
    }
    for (const [name, slot] of Object.entries(definition.slots ?? {})) {
      const children = node.slots && Object.hasOwn(node.slots, name) ? node.slots[name] : undefined;
      if (slot.required && !children?.length) diagnostics.push({ ...diagnostic('ODDS1004', `Required slot ${name} is empty.`, node.id, node.ref), path: ['slots', name] });
    }
    origins.push({ nodeId: id, sourceNodeId: node.id, instancePath: frames });
    return { schemaVersion: 1, type: 'component', id, ref: node.ref, props, ...(node.slots === undefined ? {} : { slots }) };
  };
  // Validate unused definitions as well. Domain checks above prove every mapped value; representative
  // required inputs allow the same resolver to check static props, nested defaults and slot grammar.
  for (const definition of scope === 'project' ? [...input.projectComponents.components].sort((a, b) => compareDesignRuntimeKeys(a.id, b.id)) : []) {
    resolve(materializeTemplate(definition, sampleProps(definition)), ['definition', definition.id], [], 0);
  }
  if (hasErrors(diagnostics)) return failed();
  origins.length = 0;
  const document: UIIRDocument = {
    ...structuredClone(input.document),
    screens: input.document.screens.map((screen) => ({
      ...screen,
      children: screen.children.flatMap((node) => {
        const resolved = resolve(node, rootNamespace ?? ['document', input.document.id, screen.id], [], 0);
        return resolved ? [resolved] : [];
      }),
    })),
  };
  if (hasErrors(diagnostics)) return failed();
  return { schemaVersion: 1, document, origins, diagnostics };
}

export function validateProjectComponentDefinitions(input: Omit<ProjectComponentContext, 'document'>, options: DesignRuntimeLimits = {}): ValidationDiagnostic[] {
  return resolveProjectDocument({ ...input, document: { schemaVersion: 1, id: input.projectComponents.id, screens: [] } }, options).diagnostics;
}

/** Reset removes the persisted override so later definition changes are inherited again. */
export function resetComponentInstance(instance: ComponentInstance, propName?: string): ComponentInstance {
  const result = ComponentInstanceSchema.parse(instance);
  return { ...result, overrides: propName === undefined ? [] : result.overrides.filter((override) => override.path[1] !== propName) };
}

export interface ComponentDetachResult {
  node: UIIRNode | null;
  origins: ResolvedNodeOrigin[];
  diagnostics: ValidationDiagnostic[];
}

/** DS detach preserves its DS reference; strict mode forbids detaching that instance relationship. */
export function detachComponentInstance(input: ProjectComponentContext, rawRequest: ComponentDetachRequest, options: DesignRuntimeLimits = {}): ComponentDetachResult {
  const request = ComponentDetachRequestSchema.parse(rawRequest);
  if (request.mode === 'strict' && request.instance.ref.startsWith('ds:')) {
    return { node: null, origins: [], diagnostics: [diagnostic('ODDS4006', 'Strict mode forbids detaching design-system instances.', request.instance.id, request.instance.ref)] };
  }
  const validation = resolveProjectDocument(input, options);
  if (!validation.document) return { node: null, origins: [], diagnostics: validation.diagnostics };
  return materializeInstance(input, request.instance, options);
}

/** Caller has validated the entire project once; only this subtree is expanded here. */
function materializeInstance(input: ProjectComponentContext, instance: ComponentInstance, options: DesignRuntimeLimits, budget?: ExpansionBudget, namespace?: string[]): ComponentDetachResult {
  let screenId = 'detach';
  while (screenId === instance.id) screenId += '_';
  const result = resolveDocument({ ...input, document: { schemaVersion: 1, id: input.document.id, screens: [{ schemaVersion: 1, type: 'screen', id: screenId, children: [instance] }] } }, options, 'instance', budget, namespace);
  return { node: result.document?.screens[0]?.children[0] ?? null, origins: result.origins, diagnostics: result.diagnostics };
}

export type ProjectComponentDeleteResult = {
  ok: true;
  projectComponents: ProjectComponentRegistry;
  document: UIIRDocument;
  diagnostics: ValidationDiagnostic[];
} | { ok: false; diagnostics: ValidationDiagnostic[] };

/** Applies explicit deletion alternatives on copies and only returns a replacement source when fully valid. */
export function deleteProjectComponent(input: ProjectComponentContext, rawRequest: ProjectComponentDeleteRequest, options: DesignRuntimeLimits = {}): ProjectComponentDeleteResult {
  const request = ProjectComponentDeleteRequestSchema.parse(rawRequest);
  const validation = resolveProjectDocument(input, options);
  if (!validation.document) return { ok: false, diagnostics: validation.diagnostics };
  const analysis = analyzeComponentDeletion(input, request.componentRef, options);
  if (hasErrors(analysis.diagnostics)) return { ok: false, diagnostics: analysis.diagnostics };
  if (request.action.type === 'reject' && !analysis.canDelete) {
    return { ok: false, diagnostics: [diagnostic('ODDS4004', `Component ${request.componentRef} is referenced; choose an explicit deletion action.`, undefined, request.componentRef)] };
  }
  const projectComponents = structuredClone(input.projectComponents);
  const document = structuredClone(input.document);
  const diagnostics: ValidationDiagnostic[] = [];
  const action = request.action;
  if (action.type === 'replace' && !getDefinition(input, action.replacementRef)) {
    return { ok: false, diagnostics: [diagnostic('ODDS4002', `Replacement ${action.replacementRef} does not exist.`, undefined, action.replacementRef)] };
  }
  const reservedIds = new Set<string>(document.screens.map((screen) => screen.id));
  for (const screen of document.screens) for (const node of screen.children) walk(node, (entry) => reservedIds.add(entry.id));
  for (const definition of projectComponents.components) walk(definition.template, (entry) => reservedIds.add(entry.id));
  const expansionBudget: ExpansionBudget = { visited: 0, limited: false };
  const rewrite = (node: UIIRNode, namespace: string[], owner?: ProjectComponentDefinition): UIIRNode | null => {
    if (node.type === 'instance' && node.ref === request.componentRef) {
      if (action.type === 'replace') return { ...node, ref: action.replacementRef };
      if (action.type === 'reject') return node;
      if (owner?.propMappings.some((mapping) => mapping.nodeId === node.id)) {
        diagnostics.push(diagnostic('ODDS4005', `Deletion would discard public prop mappings in ${owner.name}; replace this instance or update its mappings first.`, node.id, `local:${owner.id}`));
        return node;
      }
      if (action.type === 'delete-instances') return null;
      const detached = materializeInstance(input, node, options, expansionBudget, namespace);
      diagnostics.push(...detached.diagnostics);
      if (!detached.node) return node;
      walk(detached.node, (entry) => {
        let id = entry.id;
        while (reservedIds.has(id)) id += '_';
        reservedIds.add(id);
        entry.id = id;
      });
      return detached.node;
    }
    if (node.type === 'component' && node.slots) {
      node.slots = Object.fromEntries(Object.keys(node.slots).sort().map((name) => [name, node.slots![name]!.flatMap((child) => {
        const result = rewrite(child, namespace, owner);
        return result ? [result] : [];
      })]));
    }
    return node;
  };
  projectComponents.components = projectComponents.components.filter((definition) => `local:${definition.id}` !== request.componentRef);
  for (const definition of projectComponents.components) {
    const template = rewrite(definition.template, ['definition', definition.id], definition);
    if (!template) diagnostics.push(diagnostic('ODDS4004', `Deleting this instance would remove the entire template of ${definition.name}.`, definition.template.id, `local:${definition.id}`));
    else definition.template = template;
  }
  for (const screen of document.screens) screen.children = screen.children.flatMap((node) => { const result = rewrite(node, ['document', document.id, screen.id]); return result ? [result] : []; });
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  const resolved = resolveProjectDocument({ ...input, projectComponents, document }, options);
  if (!resolved.document) return { ok: false, diagnostics: resolved.diagnostics };
  return { ok: true, projectComponents, document, diagnostics: resolved.diagnostics };
}
