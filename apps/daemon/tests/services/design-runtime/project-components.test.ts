import { describe, expect, it } from 'vitest';
import { ProjectComponentRegistrySchema, ResolvedUIIRResultSchema, UIIRDocumentSchema, type ComponentInstance, type UIIRNode } from '@open-design/contracts';
import { deleteProjectComponent, detachComponentInstance, resetComponentInstance, resolveProjectDocument, validateProjectComponentDefinitions } from '../../../src/services/design-runtime/project-components.js';
import { flattenNodes, instance, projectComponentFixture } from '../../fixtures/design-runtime/project-components.js';

function buttonProps(nodes: UIIRNode[]) {
  return flattenNodes(nodes).filter((node) => node.type === 'component' && node.ref === 'ds:acme/Button').map((node) => node.type === 'component' ? node.props : undefined);
}

describe('project component inheritance', () => {
  it('resolves Button -> ApplicationCard -> both screens, keeps one override, and resets back to inheritance', () => {
    const input = projectComponentFixture();
    const original = structuredClone(input);
    const before = ResolvedUIIRResultSchema.parse(resolveProjectDocument(input));
    expect(before.diagnostics).toEqual([]);
    expect(before.document!.screens.map((screen) => buttonProps(screen.children)[0]?.variant)).toEqual(['primary', 'secondary']);
    expect(input).toEqual(original);
    const button = input.projectComponents.components[0]!;
    button.props.variant!.default = 'secondary';
    button.props.label!.default = 'Submit';
    button.revision++;
    const after = ResolvedUIIRResultSchema.parse(resolveProjectDocument(input));
    expect(after.document!.screens.map((screen) => buttonProps(screen.children)[0])).toEqual([
      { variant: 'secondary', label: 'Submit', disabled: false },
      { variant: 'secondary', label: 'Submit', disabled: false },
    ]);
    expect(after.origins.map((origin) => origin.nodeId)).toEqual(before.origins.map((origin) => origin.nodeId));
    expect(after.origins.filter((origin) => origin.sourceNodeId === 'button-root').map((origin) => origin.instancePath.map((frame) => [frame.componentRef, frame.definitionRevision]))).toEqual([
      [['local:ApplicationCard', 1], ['local:Button', 2]], [['local:ApplicationCard', 1], ['local:Button', 2]],
    ]);
    const dashboard = input.document.screens[1]!.children[0] as ComponentInstance;
    input.document.screens[1]!.children[0] = resetComponentInstance(dashboard, 'variant');
    expect(dashboard.overrides).toHaveLength(1);
    expect(input.document.screens[1]!.children[0]).toMatchObject({ overrides: [] });
    button.props.variant!.default = 'primary';
    expect(resolveProjectDocument(input).document!.screens.map((screen) => buttonProps(screen.children)[0]?.variant)).toEqual(['primary', 'primary']);
  });

  it('applies text mappings, accepts required public inputs, and rejects missing/invalid overrides', () => {
    const input = projectComponentFixture();
    delete input.projectComponents.components[1]!.props.title!.default;
    expect(validateProjectComponentDefinitions(input)).toEqual([]);
    expect(resolveProjectDocument(input)).toMatchObject({ document: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS1006', path: ['props', 'title'] })]) });
    for (const screen of input.document.screens) (screen.children[0] as ComponentInstance).overrides.push({ schemaVersion: 1, path: ['props', 'title'], value: screen.id });
    const result = resolveProjectDocument(input);
    expect(result.document!.screens.map((screen) => flattenNodes(screen.children).find((node) => node.type === 'text'))).toMatchObject([{ text: 'Applications' }, { text: 'Dashboard' }]);
    (input.document.screens[0]!.children[0] as ComponentInstance).overrides.push({ schemaVersion: 1, path: ['props', 'variant'], value: 'danger' });
    expect(resolveProjectDocument(input).diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS1003' }));
  });

  it('checks unused definitions, full mapping domains, and absence compatibility', () => {
    const input = projectComponentFixture();
    input.document.screens = [];
    input.projectComponents.components[0]!.props.variant = { type: 'enum', values: ['primary', 'danger'], required: false, default: 'primary' };
    expect(validateProjectComponentDefinitions(input)).toContainEqual(expect.objectContaining({ code: 'ODDS4005' }));
    input.projectComponents.components[0]!.props.variant = { type: 'enum', values: ['primary', 'secondary'], required: false };
    delete input.registry!.components[0]!.props.variant!.default;
    expect(validateProjectComponentDefinitions(input)).toContainEqual(expect.objectContaining({ code: 'ODDS4005' }));
  });

  it.each(['constructor', 'toString'])('reports an unknown slot %s without consulting Object.prototype', (name) => {
    const input = projectComponentFixture();
    input.document.screens[0]!.children = [{ schemaVersion: 1, type: 'component', id: 'slot-test', ref: 'ds:acme/Button', slots: { [name]: [] } }];
    expect(resolveProjectDocument(input)).toMatchObject({ document: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS1004', path: ['slots', name] })]) });
    input.projectComponents.components[0]!.propMappings[0]!.path = ['props', name];
    expect(resolveProjectDocument(input).diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4005' }));
  });


  it('requires an own value for a declared constructor slot when slots are omitted or empty', () => {
    for (const slots of [undefined, {}]) {
      const input = projectComponentFixture();
      input.projectComponents.components = [];
      input.registry!.components[0]!.slots = { constructor: { accepts: ['text'], required: true, multiple: false } };
      input.document.screens = [{ schemaVersion: 1, type: 'screen', id: 'screen', children: [{ schemaVersion: 1, type: 'component', id: 'button', ref: 'ds:acme/Button', ...(slots === undefined ? {} : { slots }) }] }];
      expect(resolveProjectDocument(input)).toMatchObject({ document: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS1004', path: ['slots', 'constructor'] })]) });
    }
  });

  it('validates nested slot membership, required slots, cardinality, and inherited property types', () => {
    const input = projectComponentFixture();
    const template = input.projectComponents.components[1]!.template;
    if (template.type !== 'component') throw new Error('fixture');
    template.slots!.body!.push({ schemaVersion: 1, type: 'text', id: 'bad-child', text: 'no' });
    input.registry!.components[1]!.slots!.footer = { accepts: ['text'], required: true, multiple: false };
    const result = resolveProjectDocument(input);
    expect(result.document).toBeNull();
    expect(result.diagnostics.filter((entry) => entry.code === 'ODDS1004')).toHaveLength(3);
  });


  it('accepts local roots through portable DS slot grammar and rejects an incompatible root change', () => {
    const input = projectComponentFixture();
    input.projectComponents.components = [{ ...input.projectComponents.components[0]!, props: {}, propMappings: [] }];
    const frame = (id: string, child: UIIRNode): UIIRNode => ({ schemaVersion: 1, type: 'component', id, ref: 'ds:acme/Frame', slots: { heading: [{ schemaVersion: 1, type: 'text', id: `${id}-title`, text: 'Frame' }], body: [child] } });
    input.document.screens = [{ schemaVersion: 1, type: 'screen', id: 'screen', children: [frame('outer', instance('wrapped', 'local:Button'))] }];
    expect(resolveProjectDocument(input).diagnostics).toEqual([]);
    input.projectComponents.components[0]!.template = frame('changed', { schemaVersion: 1, type: 'component', id: 'inner-button', ref: 'ds:acme/Button' });
    expect(resolveProjectDocument(input)).toMatchObject({ document: null, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS1004', nodeId: 'wrapped' })]) });
  });

  it('terminates cycles and bounds expanded nodes with diagnostics and no partial output', () => {
    const input = projectComponentFixture();
    input.projectComponents.components[0]!.template = instance('loop', 'local:Button');
    input.projectComponents.components[0]!.props = {};
    input.projectComponents.components[0]!.propMappings = [];
    expect(ResolvedUIIRResultSchema.parse(resolveProjectDocument(input))).toMatchObject({ document: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4003' })]) });
    expect(ResolvedUIIRResultSchema.parse(resolveProjectDocument(projectComponentFixture(), { maxNodes: 14 }))).toMatchObject({ document: null, origins: [], diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4007' })]) });
  });

  it('uses injective lineage IDs for delimiter-looking names and remains stable across runs', () => {
    const input = projectComponentFixture();
    input.document.screens[0]!.children = [instance('a-b', 'local:Button'), instance('a', 'local:Button')];
    input.projectComponents.components[0]!.template.id = 'b-button-root';
    input.projectComponents.components[0]!.propMappings.forEach((mapping) => { mapping.nodeId = 'b-button-root'; });
    const result = ResolvedUIIRResultSchema.parse(resolveProjectDocument(input));
    expect(new Set(result.origins.map((entry) => entry.nodeId)).size).toBe(result.origins.length);
    expect(resolveProjectDocument(input)).toEqual(result);
  });
});

describe('explicit detach and safe deletion', () => {
  it('detaches local inheritance into a copy; DS detach retains its reference and strict mode forbids it', () => {
    const input = projectComponentFixture();
    const original = structuredClone(input);
    const detached = detachComponentInstance(input, { instance: input.document.screens[1]!.children[0] as ComponentInstance, mode: 'strict' });
    expect(detached.diagnostics).toEqual([]);
    expect(buttonProps([detached.node!])[0]).toEqual({ variant: 'secondary', label: 'Apply', disabled: false });
    expect(flattenNodes([detached.node!]).every((node) => node.type !== 'instance')).toBe(true);
    expect(input).toEqual(original);
    const ds = instance('detach', 'ds:acme/Button', 'secondary');
    const dsResult = detachComponentInstance(input, { instance: ds, mode: 'guided' });
    expect(dsResult.node).toMatchObject({ type: 'component', ref: ds.ref, props: { variant: 'secondary' } });
    expect(dsResult.origins[0]!.instancePath).toEqual([{ instanceId: 'detach', componentRef: 'ds:acme/Button' }]);
    expect(detachComponentInstance(input, { instance: ds, mode: 'strict' })).toMatchObject({ node: null, diagnostics: [{ code: 'ODDS4006' }] });
  });

  it('blocks default deletion and allows explicit replacement without expanding persisted instances', () => {
    const input = projectComponentFixture();
    expect(deleteProjectComponent(input, { componentRef: 'local:Button', action: { type: 'reject' } })).toMatchObject({ ok: false, diagnostics: [{ code: 'ODDS4004' }] });
    const replacement = { ...structuredClone(input.projectComponents.components[0]!), id: 'Button2', name: 'Button 2' };
    input.projectComponents.components.push(replacement);
    const result = deleteProjectComponent(input, { componentRef: 'local:Button', action: { type: 'replace', replacementRef: 'local:Button2' } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('replace failed');
    ProjectComponentRegistrySchema.parse(result.projectComponents);
    expect(result.projectComponents.components.some((definition) => definition.id === 'Button')).toBe(false);
    expect(result.projectComponents.components[0]!.template).toMatchObject({ slots: { body: [{ type: 'instance', ref: 'local:Button2', overrides: [] }] } });
    expect(input.projectComponents.components).toHaveLength(3);
  });

  it('supports detach and delete-instances for screen usages and deletes genuinely unused definitions', () => {
    for (const type of ['detach', 'delete-instances'] as const) {
      const input = projectComponentFixture();
      const result = deleteProjectComponent(input, { componentRef: 'local:ApplicationCard', action: { type } });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('deletion failed');
      UIIRDocumentSchema.parse(result.document);
      expect(result.projectComponents.components.map((definition) => definition.id)).toEqual(['Button']);
      expect(result.document.screens.map((screen) => screen.children.length)).toEqual(type === 'detach' ? [1, 1] : [0, 0]);
      if (type === 'detach') expect(result.document.screens.map((screen) => buttonProps(screen.children)[0]?.variant)).toEqual(['primary', 'secondary']);
      const unused = deleteProjectComponent({ ...input, ...result }, { componentRef: 'local:Button', action: { type: 'reject' } });
      expect(unused.ok).toBe(true);
    }
  });

  it('rejects data-losing detach/delete and invalid replacement instead of dropping public mappings or slot constraints', () => {
    const input = projectComponentFixture();
    const original = structuredClone(input);
    for (const type of ['detach', 'delete-instances'] as const) expect(deleteProjectComponent(input, { componentRef: 'local:Button', action: { type } })).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4005' })]) });
    expect(deleteProjectComponent(input, { componentRef: 'local:Button', action: { type: 'replace', replacementRef: 'ds:acme/Frame' } }).ok).toBe(false);
    expect(input).toEqual(original);
    input.document.screens[0]!.children.push(instance('missing', 'local:Missing'));
    expect(deleteProjectComponent(input, { componentRef: 'local:ApplicationCard', action: { type: 'delete-instances' } })).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4002' })]) });
  });

  it('qualifies detached template IDs by their owners, independent of definition order', () => {
    const input = projectComponentFixture();
    input.document.screens = [];
    input.projectComponents.components = [input.projectComponents.components[0]!, ...['A', 'B'].map((id) => ({ schemaVersion: 1 as const, id, name: id, revision: 1, props: {}, propMappings: [], template: instance('shared-id', 'local:Button') }))];
    const request = { componentRef: 'local:Button', action: { type: 'detach' as const } };
    const before = deleteProjectComponent(input, request);
    input.projectComponents.components.reverse();
    const after = deleteProjectComponent(input, request);
    if (!before.ok || !after.ok) throw new Error('fixture detach failed');
    const ids = (result: typeof before) => Object.fromEntries(result.projectComponents.components.map((entry) => [entry.id, entry.template.id]));
    expect(ids(before)).toEqual(ids(after));
    expect(new Set(Object.values(ids(before))).size).toBe(2);
  });
});
