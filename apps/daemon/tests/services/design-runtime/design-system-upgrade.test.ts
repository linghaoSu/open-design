import { describe, expect, it } from 'vitest';
import type { DesignSystemMigrationPlan, DesignSystemUpgradeContext, DesignSystemUpgradeReview, UIIRNode } from '@open-design/contracts';
import { applyDesignSystemUpgrade, reviewDesignSystemUpgrade } from '../../../src/services/design-runtime/design-system-upgrade.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../../src/services/design-runtime/design-system-version.js';
import { recordSharedComponentRegistryChange, recordSharedComponentDesignSystemUpgrade, stageSharedComponentChange } from '../../../src/services/design-runtime/shared-component-changes.js';
import { upgradeFixture, upgradeVersion } from '../../fixtures/design-runtime/design-system-upgrade.js';
const request = (review: DesignSystemUpgradeReview) => ({ reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, plan: review.plan });
function plain(context: DesignSystemUpgradeContext, children: UIIRNode[]): DesignSystemUpgradeContext {
  return { ...context, projectComponents: { ...context.projectComponents, components: [] }, document: { schemaVersion: 1 as const, id: 'design', screens: [{ schemaVersion: 1 as const, type: 'screen' as const, id: 'Applications', children }] } };
}

describe('reviewed exact design-system upgrades', () => {
  it('migrates nested local public domains, inherited defaults and explicit overrides without expanding authored instances', () => {
    const { context, from, to, plan } = upgradeFixture();
    const before = structuredClone({ context, from, to, plan });
    const review = reviewDesignSystemUpgrade(context, from, to, plan);
    expect(review.diagnostics).toEqual([]);
    expect(review.canApply).toBe(true);
    expect(review.affectedScreens.map((screen) => screen.screenId)).toEqual(['Applications', 'Dashboard']);
    expect(review.bindingTransitions).toHaveLength(1);
    const applied = applyDesignSystemUpgrade(context, from, to, request(review));
    expect(applied.projectComponents.components.map((entry) => [entry.id, entry.revision])).toEqual([['LocalButton', 2], ['Card', 4]]);
    for (const definition of applied.projectComponents.components) expect(definition.props.tone).toMatchObject({ values: ['ghost', 'secondary'], default: 'ghost' });
    expect(applied.document!.screens[0]!.children[0]).toEqual(context.document!.screens[0]!.children[0]);
    expect(applied.document!.screens[0]!.children[1]).toMatchObject({ id: 'custom-card', type: 'instance', overrides: [{ path: ['props', 'tone'], value: 'ghost' }] });
    expect(applied.document!.screens[1]!.children[0]).toEqual(context.document!.screens[1]!.children[0]);
    expect(applied.sharedChanges.history.map((entry) => [entry.componentRef, entry.definition.revision])).toEqual([['local:Card', 3], ['local:Card', 4], ['local:LocalButton', 1], ['local:LocalButton', 2]]);
    expect(applied.lock.dependencies[0]).toEqual(plan.to);
    expect(applied.dependencies.dependencies[0]?.version).toBe('^2.0.0');
    expect({ context, from, to, plan }).toEqual(before);
    expect(reviewDesignSystemUpgrade(context, from, to, plan)).toEqual(review);
  });

  it('applies compatible minor upgrades with an explicit revalidation against the target index', () => {
    const { context, from } = upgradeFixture();
    const to = upgradeVersion('1.1.0', 'primary', '; disabled?: boolean');
    const plan: DesignSystemMigrationPlan = { schemaVersion: 1, id: 'minor', from: context.lock.dependencies[0]!, to: createProjectDesignSystemLock('project', [to]).dependencies[0]!, targetRange: '^1.0.0', rules: [], bindingDecisions: [] };
    expect(reviewDesignSystemUpgrade(context, from, to, plan).canApply).toBe(false);
    plan.bindingDecisions = [{ type: 'revalidate', bindingId: context.bindings.bindings[0]!.id }];
    const review = reviewDesignSystemUpgrade(context, from, to, plan);
    expect(review.diagnostics).toEqual([]);
    expect(review.canApply).toBe(true);
    const applied = applyDesignSystemUpgrade(context, from, to, request(review));
    expect(applied.bindings.bindings[0]?.status).toBe('bound');
    expect(applied.projectComponents).toEqual(context.projectComponents);
    expect(applied.sharedChanges).toEqual(context.sharedChanges);
    expect(applied.document).toEqual(context.document);
  });

  it('shows current invalid overrides without blocking a valid proposed repair', () => {
    const { context, from, plan } = upgradeFixture();
    const to = upgradeVersion('2.0.0', 'obsolete');
    plan.to = createProjectDesignSystemLock('project', [to]).dependencies[0]!;
    plan.rules = [];
    const broken = plain(context, [{ schemaVersion: 1, type: 'instance', id: 'broken', ref: 'ds:acme/Button', overrides: [{ schemaVersion: 1, path: ['props', 'variant'], value: 'obsolete' }] }]);
    const review = reviewDesignSystemUpgrade(broken, from, to, plan);
    expect(review.current.document).toBeNull();
    expect(review.current.diagnostics.some((entry) => entry.code === 'ODDS1003')).toBe(true);
    expect(review.proposed.document).not.toBeNull();
    expect(review.canApply).toBe(true);
  });

  it('binds apply to exact package, plan and full current state with no stale application', () => {
    const { context, from, to, plan } = upgradeFixture();
    const review = reviewDesignSystemUpgrade(context, from, to, plan);
    expect(() => applyDesignSystemUpgrade({ ...context, revision: 9 }, from, to, request(review))).toThrow('changed after review');
    const altered = structuredClone(context); altered.document!.screens[0]!.name = 'Renamed';
    expect(() => applyDesignSystemUpgrade(altered, from, to, request(review))).toThrow('changed after review');
    expect(() => applyDesignSystemUpgrade(context, from, to, { ...request(review), plan: { ...plan, targetRange: '2.0.0' } })).toThrow('changed after review');
    const tampered = structuredClone(to); tampered.package.name = 'Tampered';
    expect(() => reviewDesignSystemUpgrade(context, from, tampered, plan)).toThrow('cannot be verified');
    const bad = { ...plan, bindingDecisions: [] };
    const invalid = reviewDesignSystemUpgrade(context, from, to, bad);
    expect(invalid.canApply).toBe(false);
    expect(() => applyDesignSystemUpgrade(context, from, to, request(invalid))).toThrow('unresolved');
  });

  it('keeps manual overlays until an explicit binding decision and preserves explicit unbinds', () => {
    const { context, from, to, plan } = upgradeFixture();
    const binding = context.bindings.bindings[0]!;
    if (binding.status !== 'bound') throw new Error('fixture');
    binding.source = { kind: 'manual', sourcePath: 'src/Button.tsx' };
    const untouched = reviewDesignSystemUpgrade(context, from, to, { ...plan, bindingDecisions: [] });
    expect(untouched.canApply).toBe(false);
    const explicit = reviewDesignSystemUpgrade(context, from, to, { ...plan, bindingDecisions: [{ type: 'unbind', bindingId: binding.id }] });
    expect(explicit.canApply).toBe(true);
    const applied = applyDesignSystemUpgrade(context, from, to, request(explicit));
    expect(applied.bindings.bindings[0]).toMatchObject({ status: 'unbound', source: binding.source });
    expect(explicit.bindingTransitions[0]?.before).toEqual(binding);
    expect(explicit.bindingTransitions[0]?.after?.status).toBe('unbound');
  });

  it('includes potentially affected DS screens for unindexed source and token changes', () => {
    const { context, from } = upgradeFixture();
    for (const kind of ['source', 'token'] as const) {
      const pkg = structuredClone(from.package); pkg.version = '1.0.1';
      if (kind === 'source') pkg.source.files.find((entry) => entry.path === 'DESIGN.md')!.content += '\nGlobal style guidance changed.';
      else { const token = pkg.tokens.tokens[0]!; if (token.type !== 'color') throw new Error('fixture'); token.value = '#ff0000'; }
      const to = createDesignSystemVersion(pkg);
      const plan: DesignSystemMigrationPlan = { schemaVersion: 1, id: kind, from: context.lock.dependencies[0]!, to: createProjectDesignSystemLock('project', [to]).dependencies[0]!, targetRange: '^1.0.0', rules: [], bindingDecisions: [] };
      const review = reviewDesignSystemUpgrade(context, from, to, plan);
      expect(review.canApply).toBe(true);
      expect(review.affectedScreens.map((screen) => screen.screenId)).toEqual(['Applications', 'Dashboard']);
      expect(review.tokenUsageCoverage).toBe('not-indexed');
      expect(review.codeImpact.coverage).toBe('registered-bindings');
      expect(review.codeImpact.sourceFiles).toEqual(['src/Button.tsx']);
    }
  });

  it('rejects conflicting local fan-out and keeps pending drafts and history immutable', () => {
    const { context, from, to, plan } = upgradeFixture();
    const button = context.projectComponents.components.find((entry) => entry.id === 'LocalButton')!;
    const staged = stageSharedComponentChange({ registry: from.package.registry, projectComponents: context.projectComponents, document: context.document }, context.sharedChanges, { draftId: 'pending', expectedDefinitionRevision: 1, definition: { ...button, revision: 2, name: 'Pending' } });
    const withDraft = { ...context, sharedChanges: staged.changes };
    const before = structuredClone(withDraft);
    const review = reviewDesignSystemUpgrade(withDraft, from, to, plan);
    expect(review.canApply).toBe(false);
    expect(review.diagnostics.some((entry) => entry.message.includes('pending'))).toBe(true);
    expect(withDraft).toEqual(before);
    button.template = { schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Frame', slots: { header: [{ schemaVersion: 1, type: 'text', id: 'header', text: '' }], body: [{ schemaVersion: 1, type: 'component', id: 'button-template', ref: 'ds:acme/Button' }] } };
    button.propMappings.push({ prop: 'tone', nodeId: 'header', path: ['text'] });
    expect(reviewDesignSystemUpgrade(context, from, to, plan).diagnostics.some((entry) => entry.message.includes('fan-out'))).toBe(true);
  });

  it('detects draft invalidation even when its live definition does not change', () => {
    const { context, from, to, plan } = upgradeFixture();
    const local = { schemaVersion: 1 as const, id: 'Label', name: 'Label', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1 as const, type: 'text' as const, id: 'text', text: 'Live' } };
    context.projectComponents.components.push(local);
    const staged = stageSharedComponentChange({ registry: from.package.registry, projectComponents: context.projectComponents, document: context.document }, context.sharedChanges, { draftId: 'future-button', expectedDefinitionRevision: 1, definition: { ...local, revision: 2, template: { schemaVersion: 1, type: 'component', id: 'draft-button', ref: 'ds:acme/Button', props: { variant: 'primary' } } } });
    expect(staged.impact.diagnostics).toEqual([]);
    const review = reviewDesignSystemUpgrade({ ...context, sharedChanges: staged.changes }, from, to, plan);
    expect(review.canApply).toBe(false);
    expect(review.diagnostics.some((entry) => entry.message.includes('future-button'))).toBe(true);
  });

  it('retains the ordinary shared rewrite guard while allowing an explicit same-DS upgrade', () => {
    const { context, from, to } = upgradeFixture();
    const before = { registry: from.package.registry, projectComponents: { ...context.projectComponents, components: [] }, document: null };
    const after = { ...before, registry: to.package.registry };
    expect(() => recordSharedComponentRegistryChange(before, after, context.sharedChanges, {})).toThrow('cannot change');
    expect(recordSharedComponentDesignSystemUpgrade(before, after, context.sharedChanges, {}).projectComponents).toEqual(before.projectComponents);
    expect(() => recordSharedComponentDesignSystemUpgrade(before, { ...after, registry: null }, context.sharedChanges, {})).toThrow('nonnull');
  });
});

describe('simultaneous replacement and removal rules', () => {
  function frameFixture() {
    const { context, from: base } = upgradeFixture();
    const pkg = structuredClone(base.package); pkg.patterns.patterns = [];
    const frame = pkg.registry.components.find((entry) => entry.id === 'Frame')!;
    frame.props = { old: { type: 'boolean', required: false, default: true }, obsolete: { type: 'string', required: false } };
    const from = createDesignSystemVersion(pkg);
    const next = structuredClone(pkg); next.version = '2.0.0';
    const target = next.registry.components.find((entry) => entry.id === 'Frame')!;
    target.id = 'Panel'; target.props = { appearance: { type: 'enum', required: false, values: ['outline', 'plain'], default: 'outline' } };
    target.slots = { caption: { accepts: ['text'], required: true, multiple: false } };
    const to = createDesignSystemVersion(next);
    const active = { ...context, codeIndex: { ...from.package.codeIndex, id: 'project' }, bindings: { ...from.package.bindings, id: 'project' }, lock: createProjectDesignSystemLock('project', [from]) };
    const plan: DesignSystemMigrationPlan = { schemaVersion: 1, id: 'replace-frame', from: active.lock.dependencies[0]!, to: createProjectDesignSystemLock('project', [to]).dependencies[0]!, targetRange: '^2.0.0', bindingDecisions: [], rules: [
      { id: 'replace', type: 'replace-component', fromRef: 'ds:acme/Frame', toRef: 'ds:acme/Panel' },
      { id: 'appearance', type: 'transform-prop', componentRef: 'ds:acme/Frame', fromProp: 'old', toProp: 'appearance', valueMap: [{ from: true, to: 'outline' }, { from: false, to: 'plain' }] },
      { id: 'obsolete', type: 'drop-prop', componentRef: 'ds:acme/Frame', prop: 'obsolete' },
      { id: 'caption', type: 'rename-slot', componentRef: 'ds:acme/Frame', fromSlot: 'header', toSlot: 'caption' },
      { id: 'body', type: 'drop-slot', componentRef: 'ds:acme/Frame', slot: 'body', children: 'delete' },
    ] };
    return { context: active, from, to, plan };
  }
  it('replaces removed components, renames props/slots and explicitly drops props/slot children while preserving surviving IDs', () => {
    const { context, from, to, plan } = frameFixture();
    const input = plain(context, [{ schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Frame', props: { old: false, obsolete: 'remove me' }, slots: {
      header: [{ schemaVersion: 1, type: 'text', id: 'heading', text: 'Heading' }], body: [{ schemaVersion: 1, type: 'component', id: 'action', ref: 'ds:acme/Button' }],
    } }]);
    const review = reviewDesignSystemUpgrade(input, from, to, plan);
    expect(review.diagnostics).toEqual([]);
    const applied = applyDesignSystemUpgrade(input, from, to, request(review));
    expect(applied.document!.screens[0]!.children).toEqual([{ schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Panel', props: { appearance: 'plain' }, slots: { caption: [{ schemaVersion: 1, type: 'text', id: 'heading', text: 'Heading' }] } }]);
    const identities = review.affectedUsages.map((usage) => JSON.stringify([usage.owner, usage.nodeId]));
    expect(new Set(identities).size).toBe(identities.length);
  });

  it('drops local public props only after every mapped destination disappears, including nested instance overrides', () => {
    const { context, from, to, plan } = frameFixture();
    context.projectComponents.components = [{ schemaVersion: 1, id: 'Wrapper', name: 'Wrapper', revision: 4,
      props: { flag: { type: 'boolean', required: false, default: true }, trash: { type: 'string', required: false, default: 'old' }, action: { type: 'enum', required: false, values: ['primary', 'secondary'], default: 'primary' } },
      template: { schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Frame', slots: { header: [{ schemaVersion: 1, type: 'text', id: 'title', text: 'Title' }], body: [{ schemaVersion: 1, type: 'component', id: 'button', ref: 'ds:acme/Button' }] } },
      propMappings: [{ prop: 'flag', nodeId: 'frame', path: ['props', 'old'] }, { prop: 'trash', nodeId: 'frame', path: ['props', 'obsolete'] }, { prop: 'action', nodeId: 'button', path: ['props', 'variant'] }],
    }];
    context.projectComponents.components.push({ schemaVersion: 1, id: 'Outer', name: 'Outer', revision: 2, props: { ...context.projectComponents.components[0]!.props }, template: { schemaVersion: 1, type: 'instance', id: 'inner', ref: 'local:Wrapper', overrides: [] }, propMappings: ['flag', 'trash', 'action'].map((prop) => ({ prop, nodeId: 'inner', path: ['props', prop] })) });
    context.document = { schemaVersion: 1, id: 'design', screens: [{ schemaVersion: 1, type: 'screen', id: 'Applications', children: [{ schemaVersion: 1, type: 'instance', id: 'outer', ref: 'local:Outer', overrides: [{ schemaVersion: 1, path: ['props', 'flag'], value: false }, { schemaVersion: 1, path: ['props', 'trash'], value: 'remove' }, { schemaVersion: 1, path: ['props', 'action'], value: 'secondary' }] }] }] };
    const review = reviewDesignSystemUpgrade(context, from, to, plan);
    expect(review.diagnostics).toEqual([]);
    const applied = applyDesignSystemUpgrade(context, from, to, request(review));
    expect(applied.projectComponents.components.map((definition) => Object.keys(definition.props))).toEqual([['flag'], ['flag']]);
    expect(applied.document!.screens[0]!.children[0]).toMatchObject({ overrides: [{ path: ['props', 'flag'], value: 'plain' }] });
    expect(applied.sharedChanges.history).toHaveLength(4);
  });

  it('preserves public props on partial drop fan-out', () => {
    const { context, from, to, plan } = frameFixture();
    const input = plain(context, []);
    input.projectComponents.components = [{ schemaVersion: 1, id: 'Label', name: 'Label', revision: 1, props: { title: { type: 'string', required: true, default: 'Title' } },
      template: { schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Frame', slots: { header: [{ schemaVersion: 1, type: 'text', id: 'text', text: '' }], body: [{ schemaVersion: 1, type: 'component', id: 'action', ref: 'ds:acme/Button' }] } },
      propMappings: [{ prop: 'title', nodeId: 'frame', path: ['props', 'obsolete'] }, { prop: 'title', nodeId: 'text', path: ['text'] }],
    }];
    const review = reviewDesignSystemUpgrade(input, from, to, plan);
    expect(review.diagnostics).toEqual([]);
    const applied = applyDesignSystemUpgrade(input, from, to, request(review));
    expect(applied.projectComponents.components[0]!.props.title).toEqual(input.projectComponents.components[0]!.props.title);
    expect(applied.projectComponents.components[0]!.propMappings).toEqual([{ prop: 'title', nodeId: 'text', path: ['text'] }]);
  });

  it('supports simultaneous swaps but rejects target collisions and inherited Object.prototype members', () => {
    const { context, from: base } = upgradeFixture();
    const pkg = structuredClone(base.package); pkg.patterns.patterns = [];
    const frame = pkg.registry.components.find((entry) => entry.id === 'Frame')!;
    frame.props = { a: { type: 'string', required: false }, b: { type: 'string', required: false }, constructor: { type: 'string' as const, required: false } }; frame.slots = {};
    const from = createDesignSystemVersion(pkg); const to = createDesignSystemVersion({ ...pkg, version: '1.1.0' });
    const input = plain({ ...context, lock: createProjectDesignSystemLock('project', [from]) }, [{ schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Frame', props: { a: 'A', b: 'B' } }]);
    const plan: DesignSystemMigrationPlan = { schemaVersion: 1, id: 'swap', from: input.lock.dependencies[0]!, to: createProjectDesignSystemLock('project', [to]).dependencies[0]!, targetRange: '^1.0.0', bindingDecisions: [], rules: [{ id: 'a', type: 'transform-prop', componentRef: 'ds:acme/Frame', fromProp: 'a', toProp: 'b' }, { id: 'b', type: 'transform-prop', componentRef: 'ds:acme/Frame', fromProp: 'b', toProp: 'a' }] };
    let review = reviewDesignSystemUpgrade(input, from, to, plan);
    expect(review.canApply).toBe(true);
    expect(applyDesignSystemUpgrade(input, from, to, request(review)).document!.screens[0]!.children[0]).toMatchObject({ props: { a: 'B', b: 'A' } });
    review = reviewDesignSystemUpgrade(input, from, to, { ...plan, rules: [plan.rules[0]!] });
    expect(review.canApply).toBe(false);
    expect(review.diagnostics.some((entry) => entry.message.includes('collides'))).toBe(true);
    review = reviewDesignSystemUpgrade(input, from, to, { ...plan, rules: [{ id: 'constructor', type: 'transform-prop', componentRef: 'ds:acme/Frame', fromProp: 'a', toProp: 'constructor' }] });
    expect(review.canApply).toBe(true);
    expect(applyDesignSystemUpgrade(input, from, to, request(review)).document!.screens[0]!.children[0]).toMatchObject({ props: { constructor: 'A', b: 'B' } });
    review = reviewDesignSystemUpgrade(input, from, to, { ...plan, rules: [{ id: 'slot', type: 'rename-slot', componentRef: 'ds:acme/Frame', fromSlot: 'a', toSlot: 'constructor' }] });
    expect(review.canApply).toBe(false);
    expect(review.diagnostics.some((entry) => entry.message.includes('no target slot'))).toBe(true);
  });

  it('fails explicitly on safety limits instead of certifying partial impact', () => {
    const { context, from, to, plan } = upgradeFixture();
    const review = reviewDesignSystemUpgrade(context, from, to, plan, { maxNodes: 1 });
    expect(review.canApply).toBe(false);
    expect(review.diagnostics.some((entry) => entry.code === 'ODDS4007')).toBe(true);
  });
});

describe('upgrade review semantic coverage', () => {
  it('finds screens affected by binding-only and code-import-only package changes', () => {
    const { context, from } = upgradeFixture();
    for (const kind of ['binding', 'code-component'] as const) {
      const pkg = structuredClone(from.package); pkg.version = '1.1.0';
      if (kind === 'binding') {
        const binding = pkg.bindings.bindings[0]!;
        binding.propMappings = [{ designProp: 'variant', codeProp: 'variant', values: { primary: 'secondary', secondary: 'primary' } }];
      } else pkg.codeIndex.components[0]!.packageName = '@acme/next';
      const to = createDesignSystemVersion(pkg);
      const plan: DesignSystemMigrationPlan = { schemaVersion: 1, id: kind, from: context.lock.dependencies[0]!, to: createProjectDesignSystemLock('project', [to]).dependencies[0]!, targetRange: '^1.0.0', rules: [], bindingDecisions: kind === 'binding' ? [] : [{ type: 'revalidate', bindingId: context.bindings.bindings[0]!.id }] };
      const review = reviewDesignSystemUpgrade(context, from, to, plan);
      expect(review.diff.changes.some((entry) => entry.entity.kind === 'source')).toBe(false);
      expect(review.diff.changes.some((entry) => entry.entity.kind === 'component')).toBe(false);
      expect(review.diff.changes.some((entry) => entry.entity.kind === kind)).toBe(true);
      expect(review.affectedScreens.map((screen) => screen.screenId)).toEqual(['Applications', 'Dashboard']);
      expect(review.codeImpact.sourceFiles).toEqual(['src/Button.tsx']);
      expect(review.canApply).toBe(true);
    }
  });

  it('rejects unknown old refs/members and impossible unused map entries', () => {
    const { context, from, to, plan } = upgradeFixture();
    const rules: DesignSystemMigrationPlan['rules'] = [
      { id: 'missing-ref', type: 'replace-component', fromRef: 'ds:acme/Missing', toRef: 'ds:acme/Button' },
      { id: 'missing-prop', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'typo', toProp: 'variant' },
      { id: 'drop-typo', type: 'drop-prop', componentRef: 'ds:acme/Button', prop: 'typo' },
      { id: 'slot-typo', type: 'drop-slot', componentRef: 'ds:acme/Frame', slot: 'typo', children: 'delete' },
      { id: 'map-source', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'variant', valueMap: [{ from: 'impossible', to: 'ghost' }] },
      { id: 'map-target', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'variant', valueMap: [{ from: 'primary', to: 'impossible' }] },
    ];
    const empty = plain(context, []);
    for (const rule of rules) {
      const review = reviewDesignSystemUpgrade(empty, from, to, { ...plan, rules: [rule] });
      expect(review.canApply, rule.id).toBe(false);
      expect(review.diagnostics.some((entry) => entry.message.includes(rule.id)), rule.id).toBe(true);
    }
  });
});

describe('local binding transitions during upgrades', () => {
  it('stales bindings after migrated local definition revisions and requires explicit verification of the new revision', () => {
    const { context, from, to, plan } = upgradeFixture();
    context.bindings.bindings.push({ schemaVersion: 1, id: 'local/card-production', componentRef: 'local:Card', framework: 'react', status: 'bound', verified: true, definitionRevision: 3, codeComponentId: 'ui/Button', propMappings: [{ designProp: 'tone', codeProp: 'variant' }] });
    const stale = reviewDesignSystemUpgrade(context, from, to, plan);
    expect(stale.canApply).toBe(false);
    expect(stale.bindingTransitions.find((entry) => entry.bindingId === 'local/card-production')?.after?.status).toBe('stale');
    plan.bindingDecisions.push({ type: 'revalidate', bindingId: 'local/card-production' });
    const reviewed = reviewDesignSystemUpgrade(context, from, to, plan);
    expect(reviewed.diagnostics).toEqual([]);
    const applied = applyDesignSystemUpgrade(context, from, to, request(reviewed));
    expect(applied.bindings.bindings.find((entry) => entry.id === 'local/card-production')).toMatchObject({ status: 'bound', verified: true, definitionRevision: 4 });
  });
});
