import { describe, expect, it } from 'vitest';
import { DesignPatternInstantiationResultSchema, type DesignPatternRuntimeContext, type InstantiateDesignPatternRequest, type UIIRNode } from '@open-design/contracts';
import { createDesignSystemVersion, createProjectDesignSystemLock, DesignSystemVersionError } from '../../../src/services/design-runtime/design-system-version.js';
import { getDesignPattern, instantiateDesignPattern, searchDesignPatterns } from '../../../src/services/design-runtime/pattern-runtime.js';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';

function fixture() {
  const pkg = packageFixture(); const version = createDesignSystemVersion(pkg);
  const context: DesignPatternRuntimeContext = { lock: createProjectDesignSystemLock('project', [version]),
    projectComponents: { schemaVersion: 1, id: 'project', components: [{ schemaVersion: 1, id: 'Action', name: 'Action', revision: 1,
      props: { tone: { type: 'enum', required: false, values: ['primary', 'secondary'], default: 'primary' } },
      template: { schemaVersion: 1, type: 'component', id: 'action', ref: 'ds:acme/Button' }, propMappings: [{ prop: 'tone', nodeId: 'action', path: ['props', 'variant'] }] }] },
    document: { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, type: 'screen', id: 'applications', name: 'Applications', children: [] }, { schemaVersion: 1, type: 'screen', id: 'dashboard', children: [] }] } };
  const request: InstantiateDesignPatternRequest = { patternId: 'ResourceList', instanceId: 'resource-list', destinationScreenId: 'applications', props: {},
    slots: { actions: [{ schemaVersion: 1, type: 'instance', id: 'action', ref: 'local:Action', overrides: [{ schemaVersion: 1, path: ['props', 'tone'], value: 'secondary' }] }] } };
  return { pkg, version, context, request };
}
function nodes(root: UIIRNode): UIIRNode[] { return [root, ...(root.type === 'component' ? Object.values(root.slots ?? {}).flatMap((children) => children.flatMap(nodes)) : [])]; }
function frozen(value: ReturnType<typeof fixture>) {
  const version = createDesignSystemVersion(value.pkg);
  return { version, context: { ...value.context, lock: createProjectDesignSystemLock('project', [version]) } };
}

describe('exact locked pattern instantiation', () => {
  it('configures a deterministic semantic subtree, keeps local overrides sparse, and records every source without mutating inputs', () => {
    const { context, version, request } = fixture(); const before = structuredClone({ context, version, request });
    const result = DesignPatternInstantiationResultSchema.parse(instantiateDesignPattern(context, version, request));
    expect(result.diagnostics).toEqual([]); expect(result.dependency).toEqual(context.lock.dependencies[0]);
    expect(result.node).toMatchObject({ type: 'component', ref: 'ds:acme/Frame', slots: { header: [{ text: 'Resources' }], body: [{ type: 'instance', ref: 'local:Action', overrides: request.slots.actions![0]!.type === 'instance' ? request.slots.actions![0]!.overrides : [] }] } });
    expect(result.origins).toHaveLength(nodes(result.node!).length);
    expect(result.origins).toContainEqual(expect.objectContaining({ source: { kind: 'pattern', patternId: 'ResourceList', sourceNodeId: 'title' } }));
    expect(result.origins).toContainEqual(expect.objectContaining({ source: { kind: 'slot', slot: 'actions', sourceNodeId: 'action', path: [0] } }));
    expect(instantiateDesignPattern(context, version, request)).toEqual(result);
    expect({ context, version, request }).toEqual(before);
  });
  it('uses the shared property validator without casting values and accepts required defaults', () => {
    const value = fixture();
    for (const props of [{ title: 5 }, { invented: 'value' }, { constructor: 'value' }]) {
      const result = instantiateDesignPattern(value.context, value.version, { ...value.request, props });
      expect(result.node).toBeNull(); expect(result.origins).toEqual([]); expect(result.diagnostics.some((entry) => entry.path?.[0] === 'props')).toBe(true);
    }
    delete value.pkg.patterns.patterns[0]!.props.title!.default;
    const { context, version } = frozen(value);
    expect(instantiateDesignPattern(context, version, value.request).diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS1006', path: ['props', 'title'] }));
    expect(instantiateDesignPattern(context, version, { ...value.request, props: { title: 'Applications' } }).node).not.toBeNull();
  });
  it('maps a public default into a DS instance override without expanding its inherited content', () => {
    const value = fixture();
    value.pkg.patterns.patterns = [{ schemaVersion: 1, id: 'ButtonPreset', name: 'Button preset', props: { tone: { type: 'enum', values: ['primary', 'secondary'], required: false, default: 'secondary' } },
      template: { schemaVersion: 1, type: 'instance', id: 'button', ref: 'ds:acme/Button', overrides: [] }, propMappings: [{ prop: 'tone', nodeId: 'button', path: ['props', 'variant'] }], slots: {}, slotMappings: [] }];
    const { context, version } = frozen(value);
    expect(instantiateDesignPattern(context, version, { ...value.request, patternId: 'ButtonPreset', slots: {} }).node).toMatchObject({ type: 'instance', ref: 'ds:acme/Button', overrides: [{ schemaVersion: 1, path: ['props', 'variant'], value: 'secondary' }] });
  });
  it('requires declared slots and respects own property names and cardinality', () => {
    const value = fixture();
    for (const slots of [{}, { actions: [] }, { actions: value.request.slots.actions!, constructor: [] }]) {
      expect(instantiateDesignPattern(value.context, value.version, { ...value.request, slots }).diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS1004' }));
    }
    const pattern = value.pkg.patterns.patterns[0]!;
    pattern.slots = Object.fromEntries([['constructor', { ...pattern.slots.actions!, multiple: false }]]); pattern.slotMappings[0]!.slot = 'constructor';
    const { context, version } = frozen(value);
    expect(instantiateDesignPattern(context, version, { ...value.request, slots: {} }).node).toBeNull();
    expect(instantiateDesignPattern(context, version, { ...value.request, slots: { constructor: value.request.slots.actions! } }).node).not.toBeNull();
    expect(instantiateDesignPattern(context, version, { ...value.request, slots: { constructor: [...value.request.slots.actions!, ...value.request.slots.actions!] } }).node).toBeNull();
  });
  it('enforces narrower public slot acceptance through the actual resolved local root', () => {
    const value = fixture(); const frame = value.pkg.registry.components.find((entry) => entry.id === 'Frame')!;
    frame.slots!.body!.accepts.push('text', 'ds:acme/Frame'); const { context, version } = frozen(value);
    expect(instantiateDesignPattern(context, version, value.request).node).not.toBeNull();
    expect(instantiateDesignPattern(context, version, { ...value.request, slots: { actions: [{ schemaVersion: 1, type: 'text', id: 'text', text: 'No' }] } }).node).toBeNull();
    context.projectComponents.components[0] = { schemaVersion: 1, id: 'Action', name: 'Changed action', revision: 2, props: {}, propMappings: [],
      template: { schemaVersion: 1, type: 'component', id: 'changed-frame', ref: 'ds:acme/Frame', slots: { header: [{ schemaVersion: 1, type: 'text', id: 'title', text: 'Wrong root' }], body: [{ schemaVersion: 1, type: 'component', id: 'button', ref: 'ds:acme/Button' }] } } };
    const result = instantiateDesignPattern(context, version, { ...value.request, slots: { actions: [{ schemaVersion: 1, type: 'instance', id: 'changed', ref: 'local:Action', overrides: [] }] } });
    expect(result).toMatchObject({ node: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS1004' })]) });
  });
  it('validates the complete destination and even unused local definitions, terminating cycles and limits', () => {
    const value = fixture();
    value.context.projectComponents.components.push({ schemaVersion: 1, id: 'Unused', name: 'Unused', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, type: 'instance', id: 'loop', ref: 'local:Unused', overrides: [] } });
    expect(instantiateDesignPattern(value.context, value.version, value.request).diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4003' }));
    value.context.projectComponents.components.pop(); value.context.document.screens[1]!.children.push({ schemaVersion: 1, type: 'instance', id: 'dangling', ref: 'local:Missing', overrides: [] });
    expect(instantiateDesignPattern(value.context, value.version, value.request).node).toBeNull();
    value.context.document.screens[1]!.children = [];
    expect(instantiateDesignPattern(value.context, value.version, value.request, { maxNodes: 2 }).diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4007' }));
  });
  it('encodes repeated and nested configured IDs injectively and rejects any destination document collision', () => {
    const value = fixture(); value.pkg.registry.components.find((entry) => entry.id === 'Frame')!.slots!.body!.accepts.push('ds:acme/Frame'); value.pkg.patterns.patterns[0]!.slots.actions!.accepts.push('ds:acme/Frame');
    const { context, version } = frozen(value);
    const button: UIIRNode = { schemaVersion: 1, type: 'component', id: 'repeat', ref: 'ds:acme/Button' };
    const nested: UIIRNode = { schemaVersion: 1, type: 'component', id: 'repeat', ref: 'ds:acme/Frame', slots: { header: [{ schemaVersion: 1, type: 'text', id: 'repeat', text: 'Nested' }], body: [button] } };
    const request = { ...value.request, slots: { actions: [nested, button] } };
    const result = DesignPatternInstantiationResultSchema.parse(instantiateDesignPattern(context, version, request));
    const ids = nodes(result.node!).map((entry) => entry.id); expect(new Set(ids).size).toBe(ids.length);
    expect(result.origins.filter((origin) => origin.source.sourceNodeId === 'repeat')).toHaveLength(4);
    context.document.screens[1]!.children.push({ schemaVersion: 1, type: 'text', id: ids[ids.length - 1]!, text: 'Existing node in another screen' });
    expect(instantiateDesignPattern(context, version, request)).toMatchObject({ node: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4001' })]) });
    expect(instantiateDesignPattern(context, version, { ...request, instanceId: 'another-instance' }).node).not.toBeNull();
  });
  it('fails on absent/tampered/exactly different frozen versions and rejects a missing destination or pattern', () => {
    const value = fixture();
    expect(() => instantiateDesignPattern({ ...value.context, lock: { ...value.context.lock, dependencies: [] } }, value.version, value.request)).toThrow(DesignSystemVersionError);
    const tampered = structuredClone(value.version); tampered.package.source.files[0]!.content += '\n// changed';
    expect(() => instantiateDesignPattern(value.context, tampered, value.request)).toThrow(DesignSystemVersionError);
    expect(() => instantiateDesignPattern(value.context, createDesignSystemVersion({ ...value.pkg, version: '1.0.1' }), value.request)).toThrow(DesignSystemVersionError);
    for (const request of [{ ...value.request, destinationScreenId: 'missing' }, { ...value.request, patternId: 'Missing' }]) expect(instantiateDesignPattern(value.context, value.version, request).node).toBeNull();
  });
  it('searches verified patterns deterministically and returns isolated metadata', () => {
    const value = fixture(); value.pkg.patterns.patterns.push({ ...structuredClone(value.pkg.patterns.patterns[0]!), id: 'Dashboard', name: 'Dashboard overview', description: 'Resource summary' });
    const { context, version } = frozen(value);
    expect(searchDesignPatterns(context.lock, version, ' resource ').patterns.map((entry) => entry.id)).toEqual(['Dashboard', 'ResourceList']);
    const selected = getDesignPattern(context.lock, version, 'ResourceList'); selected.pattern.name = 'Client edit';
    expect(getDesignPattern(context.lock, version, 'ResourceList').pattern.name).toBe('Resource list');
    expect(() => getDesignPattern(context.lock, version, 'unknown')).toThrow(DesignSystemVersionError);
  });
});
