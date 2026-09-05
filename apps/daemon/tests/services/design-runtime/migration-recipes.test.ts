import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DesignSystemMigrationRecipe } from '@open-design/contracts';
import { upgradeFixture } from '../../fixtures/design-runtime/design-system-upgrade.js';
import { canonicalDesignSystemJson, createDesignSystemVersion, createProjectDesignSystemLock, verifyDesignSystemVersion } from '../../../src/services/design-runtime/design-system-version.js';
import { diffDesignSystemVersions } from '../../../src/services/design-runtime/design-system-diff.js';
import { applyDesignSystemUpgrade, reviewDesignSystemUpgrade } from '../../../src/services/design-runtime/design-system-upgrade.js';
import { instantiateDesignSystemMigrationRecipe } from '../../../src/services/design-runtime/migration-recipes.js';
const request = { recipeId: 'button-v2', planId: 'chosen-recipe', targetRange: '2.0.0' };
function fixture() {
  const base = upgradeFixture();
  const recipe: DesignSystemMigrationRecipe = { schemaVersion: 1, id: request.recipeId, name: 'Button v2', from: { version: base.from.package.version, digest: base.from.digest }, rules: base.plan.rules,
    packageBindingDecisions: [{ type: 'use-target-package', bindingId: base.from.package.bindings.bindings[0]!.id, targetBindingId: base.to.package.bindings.bindings[0]!.id }] };
  const to = createDesignSystemVersion({ ...base.to.package, migrations: [recipe] });
  return { ...base, to, recipe };
}

describe('immutable package-authored migration recipes', () => {
  it('verifies legacy package bytes and digests without silently adding an empty recipe field', () => {
    const { from } = upgradeFixture();
    const bytes = canonicalDesignSystemJson(from.package);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    expect(from.digest).toBe(digest);
    expect(verifyDesignSystemVersion({ ...from, digest, package: JSON.parse(bytes) })).toEqual([]);
    expect(Object.hasOwn(createDesignSystemVersion(from.package).package, 'migrations')).toBe(false);
    expect(createDesignSystemVersion({ ...from.package, migrations: [] }).digest).not.toBe(digest);
  });
  it('instantiates a deterministic normal plan without mutation and still requires review and apply', () => {
    const { context, from, to, recipe } = fixture();
    const before = structuredClone({ context, from, to });
    const result = instantiateDesignSystemMigrationRecipe(context, from, to, request);
    expect(result.plan).toMatchObject({ id: request.planId, rules: recipe.rules, bindingDecisions: recipe.packageBindingDecisions, targetRange: '2.0.0' });
    expect(result.plan.to).toEqual(createProjectDesignSystemLock(context.projectId, [to]).dependencies[0]);
    expect(result.diagnostics).toEqual([]); expect(result.skippedBindingDecisions).toEqual([]);
    expect(instantiateDesignSystemMigrationRecipe(context, from, to, request)).toEqual(result);
    expect({ context, from, to }).toEqual(before);
    const review = reviewDesignSystemUpgrade(context, from, to, result.plan);
    expect(review.canApply).toBe(true);
    const applied = applyDesignSystemUpgrade(context, from, to, { plan: result.plan, reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest });
    expect(applied.projectComponents.components[0]?.props.tone?.default).toBe('ghost');
    expect({ context, from, to }).toEqual(before);
  });
  it('never takes over manual, unbound, absent or local project bindings', () => {
    const { context, from, to, recipe } = fixture();
    const original = context.bindings.bindings[0]!;
    const { source: _source, ...withoutSource } = original;
    for (const bindings of [[], [{ schemaVersion: 1 as const, id: original.id, componentRef: original.componentRef, framework: original.framework, status: 'unbound' as const, verified: false as const }], [{ schemaVersion: 1 as const, id: original.id, componentRef: 'local:Card', framework: original.framework, status: 'unbound' as const, verified: false as const }], [withoutSource]]) {
      const customized = { ...context, bindings: { ...context.bindings, bindings } };
      const before = structuredClone(customized);
      const result = instantiateDesignSystemMigrationRecipe(customized, from, to, request);
      expect(result.plan.bindingDecisions).toEqual([]); expect(result.skippedBindingDecisions).toEqual(recipe.packageBindingDecisions);
      expect(result.diagnostics[0]).toMatchObject({ severity: 'warning' }); expect(customized).toEqual(before);
    }
  });
  it('requires exact source version and digest, verified target bytes and declared target intent', () => {
    const { context, from, to, recipe } = fixture();
    for (const fromProof of [{ ...recipe.from, version: '1.0.1' }, { ...recipe.from, digest: `sha256:${'a'.repeat(64)}` }]) {
      const wrong = createDesignSystemVersion({ ...to.package, migrations: [{ ...recipe, from: fromProof }] });
      expect(() => instantiateDesignSystemMigrationRecipe(context, from, wrong, request)).toThrow(/different exact source/);
    }
    const tampered = structuredClone(to); tampered.package.migrations![0]!.name = 'Changed after publication';
    expect(verifyDesignSystemVersion(tampered).map((entry) => entry.code)).toContain('ODDS5004');
    expect(() => instantiateDesignSystemMigrationRecipe(context, from, tampered, request)).toThrow(/digest/);
    expect(() => instantiateDesignSystemMigrationRecipe(context, from, to, { ...request, targetRange: '^1.0.0' })).toThrow(/range/);
    expect(() => instantiateDesignSystemMigrationRecipe(context, from, to, { ...request, recipeId: 'missing' })).toThrow(/does not provide/);
    expect(() => instantiateDesignSystemMigrationRecipe({ ...context, projectId: 'other' }, from, to, request)).toThrow(/project dependency/);
  });
  it('verifies target members at publication and all old members and scalar entries at instantiation', () => {
    const { context, from, to, recipe } = fixture();
    const rule = recipe.rules[0]!;
    expect(() => createDesignSystemVersion({ ...to.package, migrations: [{ ...recipe, rules: [{ ...rule, type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'missing' }] }] })).toThrow(/target property/);
    expect(() => createDesignSystemVersion({ ...to.package, migrations: [{ ...recipe, packageBindingDecisions: [{ type: 'use-target-package', bindingId: 'old', targetBindingId: 'missing' }] }] })).toThrow(/target binding/);
    const variants = [
      { ...rule, type: 'transform-prop' as const, componentRef: 'ds:acme/Button', fromProp: 'missing', toProp: 'variant' },
      { ...rule, type: 'transform-prop' as const, componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'variant', valueMap: [{ from: 'impossible', to: 'ghost' }] },
    ];
    for (const variant of variants) {
      const pkg = createDesignSystemVersion({ ...to.package, migrations: [{ ...recipe, rules: [variant] }] });
      expect(() => instantiateDesignSystemMigrationRecipe(context, from, pkg, request)).toThrow();
    }
    const missingBinding = createDesignSystemVersion({ ...to.package, migrations: [{ ...recipe, packageBindingDecisions: [{ type: 'revalidate', bindingId: 'missing-old' }] }] });
    expect(() => instantiateDesignSystemMigrationRecipe(context, from, missingBinding, request)).toThrow(/exact source package/);
  });
  it('reports recipe-only semantic changes without invented screen impact until a transforming recipe is selected', () => {
    const { context, from } = upgradeFixture();
    const recipe: DesignSystemMigrationRecipe = { schemaVersion: 1, id: request.recipeId, name: 'Choose secondary', from: { version: from.package.version, digest: from.digest }, rules: [{ id: 'secondary', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'variant', valueMap: [{ from: 'primary', to: 'secondary' }] }], packageBindingDecisions: [] };
    const to = createDesignSystemVersion({ ...from.package, version: '2.0.0', migrations: [recipe] });
    const diff = diffDesignSystemVersions(from, to); expect(diff.ok).toBe(true);
    if (!diff.ok) throw new Error('Expected verified diff');
    expect(diff.diff.changes).toHaveLength(1); expect(diff.diff.changes[0]?.entity).toEqual({ kind: 'migration', id: recipe.id });
    const result = instantiateDesignSystemMigrationRecipe(context, from, to, request);
    const unused = reviewDesignSystemUpgrade(context, from, to, { ...result.plan, rules: [] });
    expect(unused.canApply).toBe(true); expect(unused.affectedScreens).toEqual([]);
    const selected = reviewDesignSystemUpgrade(context, from, to, result.plan);
    expect(selected.canApply).toBe(true); expect(selected.affectedScreens.map((entry) => entry.screenId)).toEqual(['Applications', 'Dashboard']);
    expect(selected.diff.changes[0]?.entity.kind).toBe('migration');
  });
});
