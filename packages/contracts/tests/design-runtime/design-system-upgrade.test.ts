import { describe, expect, it } from 'vitest';
import { DesignSystemMigrationPlanSchema, DesignSystemUpgradeContextSchema, DesignSystemUpgradeReviewSchema, ApplyDesignSystemUpgradeRequestSchema } from '../../src/design-runtime/design-system-upgrade.js';

const digest = `sha256:${'a'.repeat(64)}`;
const from = { designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } };
const to = { ...from, version: '2.0.0' };
const plan = { schemaVersion: 1, id: 'upgrade', from, to, targetRange: '^2.0.0', rules: [
  { id: 'variant', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'appearance', valueMap: [{ from: true, to: 'outline' }, { from: 'true', to: 'plain' }, { from: null, to: false }] },
  { id: 'drop', type: 'drop-prop', componentRef: 'ds:acme/Button', prop: 'obsolete' },
  { id: 'replace', type: 'replace-component', fromRef: 'ds:acme/Button', toRef: 'ds:acme/Action' },
  { id: 'slot', type: 'rename-slot', componentRef: 'ds:acme/Button', fromSlot: 'header', toSlot: 'caption' },
  { id: 'children', type: 'drop-slot', componentRef: 'ds:acme/Button', slot: 'body', children: 'delete' },
], bindingDecisions: [{ type: 'revalidate', bindingId: 'binding/a' }, { type: 'use-target-package', bindingId: 'binding/b', targetBindingId: 'binding/next' }, { type: 'remove', bindingId: 'binding/c' }, { type: 'unbind', bindingId: 'binding/d' }] };
const context = { projectId: 'project', revision: 3,
  dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] },
  lock: { schemaVersion: 1, id: 'project', dependencies: [from] },
  projectComponents: { schemaVersion: 1, id: 'project', components: [] }, document: null,
  codeIndex: { schemaVersion: 1, id: 'project', components: [] }, bindings: { schemaVersion: 1, id: 'project', bindings: [] }, sharedChanges: { schemaVersion: 1, id: 'project', history: [], drafts: [] },
};
const resolved = { schemaVersion: 1, document: { schemaVersion: 1, id: 'project', screens: [] }, origins: [], diagnostics: [] };
const diagnostic = { schemaVersion: 1, severity: 'error', code: 'ODDS1003', message: 'Old value is invalid.' };
const review = { schemaVersion: 1, id: 'review', projectId: 'project', baseRevision: 3, baseDigest: digest, planDigest: digest, plan,
  diff: { schemaVersion: 1, from, to, changes: [], recommendedBump: 'none' },
  current: { schemaVersion: 1, document: null, origins: [], diagnostics: [diagnostic] }, proposed: resolved,
  affectedUsages: [], affectedScreens: [], invalidOverrides: [], codeImpact: { bindings: [], sourceFiles: [], coverage: 'registered-bindings' }, bindingTransitions: [],
  tokenUsageCoverage: 'not-indexed', sourceUsageCoverage: 'conservative-design-system-screens', diagnostics: [], canApply: true,
};

describe('reviewed design-system upgrade contracts', () => {
  it('round trips typed scalar rules, explicit removal, exact proofs and binding decisions', () => {
    expect(DesignSystemMigrationPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(DesignSystemUpgradeContextSchema.parse(context)).toEqual(context);
    expect(DesignSystemUpgradeReviewSchema.parse(review)).toEqual(review);
    const apply = { reviewId: 'review', baseDigest: digest, planDigest: digest, plan };
    expect(ApplyDesignSystemUpgradeRequestSchema.parse(apply)).toEqual(apply);
  });

  it('rejects rule identity/source/target collisions, duplicate typed values and prototype members', () => {
    const rule = plan.rules[0]!;
    for (const duplicate of [{ ...rule, id: 'other' }, { ...rule, id: 'other', fromProp: 'other' }]) expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, rules: [...plan.rules, duplicate] }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, rules: [{ ...rule, valueMap: [{ from: true, to: 'a' }, { from: true, to: 'b' }] }] }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, rules: [{ ...rule, toProp: '__proto__' }] }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, rules: [{ ...rule, componentRef: 'local:Button' }] }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, rules: [{ ...rule, componentRef: 'ds:other/Button' }] }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, rules: [{ id: 'drop', type: 'drop-slot', componentRef: 'ds:acme/Button', slot: 'body' }] }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, bindingDecisions: [...plan.bindingDecisions, plan.bindingDecisions[0]] }).success).toBe(false);
  });

  it('rejects mutable target intent, cross-project context and missing active locks', () => {
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, to: { ...to, version: 'latest' } }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, targetRange: '*' }).success).toBe(false);
    expect(DesignSystemMigrationPlanSchema.safeParse({ ...plan, to: { ...to, designSystemId: 'other' } }).success).toBe(false);
    expect(DesignSystemUpgradeContextSchema.safeParse({ ...context, codeIndex: { ...context.codeIndex, id: 'other' } }).success).toBe(false);
    expect(DesignSystemUpgradeContextSchema.safeParse({ ...context, lock: { ...context.lock, dependencies: [] } }).success).toBe(false);
  });

  it('allows current errors when repaired, but prohibits apply with proposed errors or mismatched review evidence', () => {
    expect(DesignSystemUpgradeReviewSchema.safeParse(review).success).toBe(true);
    expect(DesignSystemUpgradeReviewSchema.safeParse({ ...review, diagnostics: [diagnostic] }).success).toBe(false);
    expect(DesignSystemUpgradeReviewSchema.safeParse({ ...review, proposed: review.current }).success).toBe(false);
    expect(DesignSystemUpgradeReviewSchema.safeParse({ ...review, diff: { ...review.diff, to: { ...to, version: '3.0.0' } } }).success).toBe(false);
    expect(ApplyDesignSystemUpgradeRequestSchema.safeParse({ reviewId: 'review', planDigest: digest, plan }).success).toBe(false);
  });
});
