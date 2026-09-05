import { describe, expect, it } from 'vitest';
import { DesignSystemMigrationRecipeSchema, DesignSystemPackageSchema, DesignSystemMigrationPlanSchema } from '../../src/design-runtime/index.js';
const digest = `sha256:${'a'.repeat(64)}`;
const recipe = { schemaVersion: 1, id: 'button-v2', name: 'Button v2', from: { version: '1.0.0', digest }, rules: [
  { id: 'variant', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'appearance', valueMap: [{ from: true, to: 'outline' }, { from: 'true', to: 'plain' }] },
], packageBindingDecisions: [{ type: 'use-target-package', bindingId: 'binding/Button', targetBindingId: 'binding/Button' }] };
const policy = { unknownComponents: 'error', unknownProps: 'error', invalidVariants: 'error', invalidSlots: 'error', tokens: { undeclared: 'error' }, rawCss: { colors: 'error', radius: 'error', spacing: 'error' }, interactiveHtml: { customControlsWhenBoundComponentExists: 'error' } };
const pkg = { schemaVersion: 1, id: 'acme', name: 'Acme', version: '2.0.0',
  registry: { schemaVersion: 1, id: 'acme', components: [] }, codeIndex: { schemaVersion: 1, id: 'acme', components: [] }, bindings: { schemaVersion: 1, id: 'acme', bindings: [] },
  tokens: { schemaVersion: 1, id: 'acme', tokens: [] }, patterns: { schemaVersion: 1, id: 'acme', patterns: [] }, constraints: { schemaVersion: 1, explore: policy, guided: policy, strict: policy },
  codeCompatibility: [], source: { schemaVersion: 1, files: [{ path: 'DESIGN.md', encoding: 'utf8', content: 'Published' }] } };

describe('immutable migration recipe contracts', () => {
  it('preserves absent migration bytes and allows explicit recipe metadata with an implicit target', () => {
    expect(DesignSystemPackageSchema.parse(pkg)).toEqual(pkg);
    expect(Object.hasOwn(DesignSystemPackageSchema.parse(pkg), 'migrations')).toBe(false);
    expect(DesignSystemMigrationRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(DesignSystemPackageSchema.parse({ ...pkg, migrations: [recipe] }).migrations).toEqual([recipe]);
    expect(DesignSystemMigrationRecipeSchema.safeParse({ ...recipe, to: '2.0.0' }).success).toBe(false);
  });
  it('requires exact source proofs and package-only binding decisions', () => {
    for (const from of [{ version: '^1.0.0', digest }, { version: '1.0.0', digest: 'sha256:unverified' }, { version: '1.0.0' }]) expect(DesignSystemMigrationRecipeSchema.safeParse({ ...recipe, from }).success).toBe(false);
    expect(DesignSystemMigrationRecipeSchema.safeParse({ ...recipe, packageBindingDecisions: [{ type: 'set-binding', bindingId: 'manual', binding: {} }] }).success).toBe(false);
    expect(DesignSystemMigrationRecipeSchema.safeParse({ ...recipe, rules: [{ ...recipe.rules[0], componentRef: 'local:Card' }] }).success).toBe(false);
  });
  it('shares simultaneous collision rules with plans and rejects duplicate recipes or cross-system targets', () => {
    const rules = [recipe.rules[0], { ...recipe.rules[0], id: 'duplicate' }];
    expect(DesignSystemMigrationRecipeSchema.safeParse({ ...recipe, rules }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ schemaVersion: 1, id: 'plan', from: { designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } }, to: { designSystemId: 'acme', version: '2.0.0', digest, source: { type: 'bundle', digest } }, targetRange: '2.0.0', rules, bindingDecisions: [] }).success).toBe(false);
    expect(DesignSystemPackageSchema.safeParse({ ...pkg, migrations: [recipe, recipe] }).success).toBe(false);
    expect(DesignSystemPackageSchema.safeParse({ ...pkg, migrations: [{ ...recipe, rules: [{ ...recipe.rules[0], componentRef: 'ds:other/Button' }] }] }).success).toBe(false);
    expect(DesignSystemMigrationRecipeSchema.safeParse({ ...recipe, packageBindingDecisions: [recipe.packageBindingDecisions[0], recipe.packageBindingDecisions[0]] }).success).toBe(false);
  });
});
