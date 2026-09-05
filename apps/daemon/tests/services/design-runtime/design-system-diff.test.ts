import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, DesignSystemPackage, DesignSystemSemanticDiff } from '@open-design/contracts';
import { diffDesignSystemVersions } from '../../../src/services/design-runtime/design-system-diff.js';
import { createDesignSystemVersion } from '../../../src/services/design-runtime/design-system-version.js';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';

function metadataPackage(): DesignSystemPackage {
  const pkg = packageFixture();
  pkg.registry.components = [{ schemaVersion: 1, id: 'Button', name: 'Button', props: { variant: { type: 'enum', required: false, values: ['primary', 'text'], default: 'primary' } } }];
  pkg.codeIndex.components = []; pkg.bindings.bindings = []; pkg.patterns.patterns = [];
  return pkg;
}
function compare(pkg: DesignSystemPackage, mutate: (next: DesignSystemPackage) => void): DesignSystemSemanticDiff {
  const next = structuredClone(pkg); next.version = '2.0.0'; mutate(next);
  const result = diffDesignSystemVersions(createDesignSystemVersion(pkg), createDesignSystemVersion(next));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.diff;
}

describe('semantic design-system diff', () => {
  it('preserves display-name identity, reports different IDs as remove/add, and retains exact full values', () => {
    const pkg = metadataPackage();
    const renamed = compare(pkg, (next) => { next.registry.components[0]!.name = 'Action'; });
    expect(renamed.recommendedBump).toBe('patch');
    expect(renamed.changes).toMatchObject([{ entity: { kind: 'component', id: 'Button' }, path: ['name'], kind: 'renamed', breaking: false, before: { present: true, value: 'Button' }, after: { present: true, value: 'Action' } }]);
    const replaced = compare(pkg, (next) => { next.registry.components[0]!.id = 'Action'; });
    expect(replaced.recommendedBump).toBe('major');
    expect(replaced.changes.map((change) => change.kind).sort()).toEqual(['added', 'removed']);
    expect(replaced.changes.find((change) => change.kind === 'removed')!.before).toEqual({ present: true, value: pkg.registry.components[0] });
  });

  it.each([
    { name: 'enum addition', bump: 'minor', mutate: (component: ComponentDefinition) => { const prop = component.props.variant!; if (prop.type === 'enum') prop.values.push('ghost'); } },
    { name: 'enum removal', bump: 'major', mutate: (component: ComponentDefinition) => { component.props.variant = { type: 'enum', required: false, values: ['primary'], default: 'primary' }; } },
    { name: 'enum to scalar widening', bump: 'minor', mutate: (component: ComponentDefinition) => { component.props.variant = { type: 'string', required: false }; } },
    { name: 'property removal', bump: 'major', mutate: (component: ComponentDefinition) => { delete component.props.variant; } },
    { name: 'required property without default', bump: 'major', mutate: (component: ComponentDefinition) => { component.props.label = { type: 'string', required: true }; } },
    { name: 'required property with default', bump: 'minor', mutate: (component: ComponentDefinition) => { component.props.label = { type: 'string', required: true, default: 'Apply' }; } },
    { name: 'requiredness with retained default', bump: 'patch', mutate: (component: ComponentDefinition) => { component.props.variant!.required = true; } },
    { name: 'requiredness without default', bump: 'major', mutate: (component: ComponentDefinition) => { component.props.variant!.required = true; delete component.props.variant!.default; } },
    { name: 'visual default', bump: 'patch', mutate: (component: ComponentDefinition) => { component.props.variant!.default = 'text'; } },
  ])('classifies $name from the complete old caller domain', ({ mutate, bump }) => {
    const diff = compare(metadataPackage(), (next) => mutate(next.registry.components[0]!));
    expect(diff.recommendedBump).toBe(bump);
    expect(diff.changes.some((change) => change.breaking)).toBe(bump === 'major');
    expect(diff.changes.every((change) => change.path[0] === 'props')).toBe(true);
  });

  it('handles default removal on already-required props and scalar narrowing without confusing absence with null', () => {
    const pkg = metadataPackage();
    pkg.registry.components[0]!.props = { label: { type: 'string', required: true, default: 'Apply' }, value: { type: 'enum', required: false, values: [null, 'x'], default: null } };
    const diff = compare(pkg, (next) => { delete next.registry.components[0]!.props.label!.default; delete next.registry.components[0]!.props.value!.default; });
    expect(diff.changes.find((change) => change.path[1] === 'label')).toMatchObject({ kind: 'removed', breaking: true, after: { present: false } });
    expect(diff.changes.find((change) => change.path[1] === 'value')).toMatchObject({ breaking: false, before: { present: true, value: null } });
    const narrowed = compare(pkg, (next) => { next.registry.components[0]!.props.label = { type: 'enum', required: true, values: ['Apply'], default: 'Apply' }; });
    expect(narrowed.recommendedBump).toBe('major');
  });

  it('reports slot narrowing, requiredness and cardinality separately and compatible widening as minor', () => {
    const pkg = metadataPackage();
    pkg.registry.components[0]!.slots = { content: { accepts: ['text', 'ds:acme/Button'], required: false, multiple: true } };
    const tightened = compare(pkg, (next) => { next.registry.components[0]!.slots!.content = { accepts: ['text'], required: true, multiple: false }; });
    expect(tightened.changes).toHaveLength(3);
    expect(tightened.changes.every((change) => change.breaking)).toBe(true);
    const wide = structuredClone(pkg); wide.registry.components[0]!.slots!.content = { accepts: ['text'], required: true, multiple: false };
    expect(compare(wide, (next) => { next.registry.components[0]!.slots = pkg.registry.components[0]!.slots; }).recommendedBump).toBe('minor');
    expect(compare(pkg, (next) => { delete next.registry.components[0]!.slots; }).recommendedBump).toBe('major');
  });

  it('compares legal constructor/toString properties and slots by own identity without prototype fallback', () => {
    const pkg = metadataPackage();
    const added = compare(pkg, (next) => {
      next.registry.components[0]!.props = { ...next.registry.components[0]!.props, ...Object.fromEntries(['constructor', 'toString'].map((name) => [name, { type: 'string', required: false }])) };
      next.registry.components[0]!.slots = Object.fromEntries(['constructor', 'toString'].map((name) => [name, { accepts: ['text'], required: false, multiple: true }]));
    });
    expect(added.recommendedBump).toBe('minor');
    expect(added.changes).toHaveLength(4);
    expect(added.changes.every((change) => change.kind === 'added' && !change.breaking && !change.before.present && change.after.present)).toBe(true);
    expect(added.changes.map((change) => change.path.join('.')).sort()).toEqual(['props.constructor', 'props.toString', 'slots.constructor', 'slots.toString']);
    const withMembers = metadataPackage();
    const component = withMembers.registry.components[0]!;
    component.props = Object.fromEntries(['constructor', 'toString'].map((name) => [name, { type: 'string' as const, required: false }]));
    component.slots = Object.fromEntries(['constructor', 'toString'].map((name) => [name, { accepts: ['text'], required: false, multiple: true }]));
    const removed = compare(withMembers, (next) => { next.registry.components[0]!.props = {}; next.registry.components[0]!.slots = {}; });
    expect(removed.recommendedBump).toBe('major');
    expect(removed.changes).toHaveLength(4);
    expect(removed.changes.every((change) => change.kind === 'removed' && change.breaking && change.before.present && !change.after.present)).toBe(true);
  });

  it('includes token identity, visual values, CSS contract, patterns and constraint changes', () => {
    const pkg = metadataPackage();
    pkg.patterns.patterns = [{ schemaVersion: 1, id: 'Heading', name: 'Heading', props: {}, propMappings: [], slots: {}, slotMappings: [], template: { schemaVersion: 1, id: 'text', type: 'text', text: 'Before' } }];
    const diff = compare(pkg, (next) => {
      next.tokens.tokens[0]!.name = 'Brand primary'; next.tokens.tokens[0]!.cssVariable = '--brand-primary';
      const spacing = next.tokens.tokens[1]!; if (spacing.type === 'spacing') spacing.value = 20;
      next.patterns.patterns[0]!.template = { schemaVersion: 1, id: 'text', type: 'text', text: 'After' };
      next.constraints.explore.rawCss.colors = 'error'; next.constraints.guided.rawCss.spacing = 'warning';
    });
    expect(diff.changes.find((change) => change.path[0] === 'cssVariable')).toMatchObject({ kind: 'changed', breaking: true });
    expect(diff.changes.find((change) => change.path[0] === 'template')).toMatchObject({ breaking: false, before: { present: true, value: { text: 'Before' } }, after: { present: true, value: { text: 'After' } } });
    expect(diff.changes.filter((change) => change.entity.kind === 'constraint').map((change) => change.breaking).sort()).toEqual([false, true]);
    expect(compare(pkg, (next) => { next.tokens.tokens.pop(); next.patterns.patterns = []; }).changes.every((change) => change.breaking)).toBe(true);
  });

  it('separates source-only edits/removal from production code imports, bindings and package compatibility', () => {
    const pkg = packageFixture();
    const visual = compare(pkg, (next) => { next.source.files.find((file) => file.path === 'src/Button.tsx')!.content += '\n// Body documentation'; next.source.files = next.source.files.filter((file) => file.path !== 'assets/pixel.bin'); });
    expect(visual.recommendedBump).toBe('patch');
    expect(visual.changes.every((change) => change.entity.kind === 'source' && !change.breaking)).toBe(true);
    expect(visual.changes.find((change) => change.kind === 'removed')!.reason).toContain('file removed');
    const imports = compare(pkg, (next) => {
      next.source.files.find((file) => file.path === 'src/Button.tsx')!.content = next.source.files[0]!.content.replace('function Button', 'function Action');
      next.codeIndex.components[0]!.exportName = 'Action';
      next.codeCompatibility[0]!.version = '^2.0.0';
      next.bindings.bindings[0]!.propMappings = [{ designProp: 'label', codeProp: 'label' }];
    });
    expect(imports.recommendedBump).toBe('major');
    for (const kind of ['code-component', 'binding', 'code-compatibility']) expect(imports.changes).toContainEqual(expect.objectContaining({ entity: expect.objectContaining({ kind }), breaking: true }));
  });

  it('produces deterministic stable IDs and order, ignores membership ordering and never mutates inputs', () => {
    const pkg = metadataPackage(); const original = structuredClone(pkg);
    const first = compare(pkg, (next) => { next.tokens.tokens[0]!.name = 'Brand'; next.registry.components[0]!.name = 'Action'; });
    const reordered = structuredClone(pkg); reordered.tokens.tokens.reverse(); reordered.registry.components[0]!.props = Object.fromEntries(Object.entries(reordered.registry.components[0]!.props).reverse());
    const second = compare(reordered, (next) => { next.tokens.tokens.find((token) => token.id === 'color.primary')!.name = 'Brand'; next.registry.components[0]!.name = 'Action'; });
    expect(second.changes).toEqual(first.changes);
    const renamedAgain = compare(pkg, (next) => { next.registry.components[0]!.name = 'Call to action'; });
    expect(renamedAgain.changes[0]!.id).toBe(first.changes.find((change) => change.entity.kind === 'component')!.id);
    expect(compare(pkg, (next) => { next.tokens.tokens.reverse(); const prop = next.registry.components[0]!.props.variant!; if (prop.type === 'enum') prop.values.reverse(); }).changes).toEqual([]);
    expect(pkg).toEqual(original);
    expect(compare(pkg, () => {}).recommendedBump).toBe('none');
  });

  it('treats mapping collections as unordered identities, including absent versus empty mappings', () => {
    const pkg = metadataPackage();
    pkg.bindings.bindings = [{ schemaVersion: 1, id: 'button-binding', componentRef: 'ds:acme/Button', framework: 'react', status: 'unbound', verified: false,
      propMappings: [{ designProp: 'variant', codeProp: 'variant' }, { designProp: 'label', codeProp: 'label' }],
      slotMappings: [{ designSlot: 'header', codeSlot: 'header' }, { designSlot: 'footer', codeSlot: 'footer' }],
    }];
    pkg.registry.components.push({ schemaVersion: 1, id: 'Frame', name: 'Frame', props: { title: { type: 'string', required: false }, subtitle: { type: 'string', required: false } }, slots: { header: { accepts: ['text'], required: false, multiple: true }, footer: { accepts: ['text'], required: false, multiple: true } } });
    pkg.patterns.patterns = [{ schemaVersion: 1, id: 'Card', name: 'Card', props: { title: { type: 'string', required: false }, subtitle: { type: 'string', required: false } }, template: { schemaVersion: 1, id: 'frame', type: 'component', ref: 'ds:acme/Frame' },
      propMappings: [{ prop: 'title', nodeId: 'frame', path: ['props', 'title'] }, { prop: 'subtitle', nodeId: 'frame', path: ['props', 'subtitle'] }],
      slots: { header: { accepts: ['text'], required: false, multiple: true }, footer: { accepts: ['text'], required: false, multiple: true } },
      slotMappings: [{ slot: 'header', nodeId: 'frame', targetSlot: 'header' }, { slot: 'footer', nodeId: 'frame', targetSlot: 'footer' }],
    }];
    expect(compare(pkg, (next) => {
      next.bindings.bindings[0]!.propMappings!.reverse(); next.bindings.bindings[0]!.slotMappings!.reverse();
      next.patterns.patterns[0]!.propMappings.reverse(); next.patterns.patterns[0]!.slotMappings.reverse();
    }).changes).toEqual([]);
    delete pkg.bindings.bindings[0]!.propMappings; delete pkg.bindings.bindings[0]!.slotMappings;
    expect(compare(pkg, (next) => { next.bindings.bindings[0]!.propMappings = []; next.bindings.bindings[0]!.slotMappings = []; }).changes).toEqual([]);
  });

  it('reports design/code slot and mapping source-only movement as nonbreaking while retaining provenance', () => {
    const pkg = metadataPackage(); const source = { kind: 'manual' as const, sourcePath: 'DESIGN.md', line: 1 };
    pkg.registry.components[0]!.slots = { body: { accepts: ['text'], required: false, multiple: true, source } };
    pkg.codeIndex.components = [{ schemaVersion: 1, id: 'ui/Button', framework: 'react', name: 'Button', exportName: 'Button', sourcePath: 'src/Button.tsx', props: {}, slots: { body: { kind: 'react-node', required: false, multiple: true, source } } }];
    pkg.bindings.bindings = [{ schemaVersion: 1, id: 'button-binding', componentRef: 'ds:acme/Button', framework: 'react', status: 'unbound', verified: false, slotMappings: [{ designSlot: 'body', codeSlot: 'body', source }] }];
    const diff = compare(pkg, (next) => {
      next.registry.components[0]!.slots!.body!.source!.line = 2;
      next.codeIndex.components[0]!.slots!.body!.source!.line = 2;
      next.bindings.bindings[0]!.slotMappings![0]!.source!.line = 2;
    });
    expect(diff.recommendedBump).toBe('patch');
    expect(diff.changes).toHaveLength(3);
    expect(diff.changes.every((change) => !change.breaking && change.reason.includes('provenance'))).toBe(true);
    expect(diff.changes.find((change) => change.entity.kind === 'component')).toMatchObject({ before: { present: true, value: { line: 1 } }, after: { present: true, value: { line: 2 } } });
  });

  it('compares stories by stable preset identity without treating args or annotations as production defaults', () => {
    const pkg = metadataPackage();
    const story = { id: 'Primary', name: 'Primary', exportName: 'Primary', args: { variant: 'primary' }, argTypes: {}, source: { kind: 'storybook' as const, sourcePath: 'DESIGN.md' } };
    const added = compare(pkg, (next) => { next.registry.components[0]!.stories = [story]; });
    expect(added.recommendedBump).toBe('minor');
    expect(added.changes).toMatchObject([{ entity: { kind: 'component', id: 'Button' }, path: ['stories', 'Primary'], kind: 'added', breaking: false, before: { present: false }, after: { present: true, value: story } }]);
    pkg.registry.components[0]!.stories = [story, { ...structuredClone(story), id: 'Secondary', name: 'Secondary', exportName: 'Secondary' }];
    expect(compare(pkg, (next) => { next.registry.components[0]!.stories!.reverse(); }).changes).toEqual([]);
    const changed = compare(pkg, (next) => {
      next.registry.components[0]!.stories![0]!.args.variant = 'text';
      next.registry.components[0]!.stories![0]!.name = 'Text preset';
      next.registry.components[0]!.stories![0]!.argTypes = { variant: { description: 'A story-only hint', options: ['text'], source: story.source } };
    });
    expect(changed.recommendedBump).toBe('patch');
    expect(changed.changes).toHaveLength(1);
    expect(changed.changes[0]).toMatchObject({ path: ['stories', 'Primary'], kind: 'changed', breaking: false, before: { present: true, value: story }, after: { present: true, value: { name: 'Text preset', args: { variant: 'text' } } } });
    const removed = compare(pkg, (next) => { next.registry.components[0]!.stories = []; });
    expect(removed.recommendedBump).toBe('patch');
    expect(removed.changes.every((change) => change.kind === 'removed' && !change.breaking)).toBe(true);
    expect(pkg.registry.components[0]!.props.variant!.default).toBe('primary');
  });

  it('fails closed on unknown schema, mismatched identities, divergent immutable versions and bad source/package integrity', () => {
    const pkg = metadataPackage(); const version = createDesignSystemVersion(pkg);
    const other = structuredClone(pkg); other.id = 'other'; for (const key of ['registry', 'codeIndex', 'bindings', 'tokens', 'patterns'] as const) other[key].id = other.id;
    expect(diffDesignSystemVersions(version, createDesignSystemVersion(other))).toMatchObject({ ok: false, diff: null, diagnostics: [{ code: 'ODDS5001' }] });
    const changed = structuredClone(pkg); changed.name = 'Changed';
    expect(diffDesignSystemVersions(version, createDesignSystemVersion(changed))).toMatchObject({ ok: false, diff: null, diagnostics: [{ code: 'ODDS5006' }] });
    const tampered = structuredClone(version); tampered.package.source.files[0]!.content += 'tampered';
    expect(diffDesignSystemVersions(version, tampered)).toMatchObject({ ok: false, diff: null, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS5004', path: ['to'] }), expect.objectContaining({ code: 'ODDS5005', path: ['to'] })]) });
    const unknown = { ...version, schemaVersion: 2 } as unknown as typeof version;
    expect(diffDesignSystemVersions(unknown, version)).toMatchObject({ ok: false, diff: null, diagnostics: [expect.objectContaining({ code: 'ODDS5004', path: ['from', 'schemaVersion'] })] });
  });
});
