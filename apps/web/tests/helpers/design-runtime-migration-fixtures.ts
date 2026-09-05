import { DesignSystemMigrationPlanSchema, DesignSystemMigrationRecipeSchema, DesignSystemMigrationRecipePlanResultSchema } from '@open-design/contracts';
import { designRuntimeState } from './design-runtime-fixtures';
export function migrationFixture() {
  const digest = `sha256:${'a'.repeat(64)}`; const sourceDigest = `sha256:${'b'.repeat(64)}`;
  const state = designRuntimeState();
  state.lock.dependencies = [{ designSystemId: 'test', version: '1.0.0', digest, source: { type: 'bundle', digest: sourceDigest } }];
  state.dependencies.dependencies = [{ designSystemId: 'test', version: '^1.0.0' }];
  const target = { id: 'test', name: 'Test UI', version: '2.0.0', digest: `sha256:${'c'.repeat(64)}`, sourceDigest: `sha256:${'d'.repeat(64)}` };
  const recipe = DesignSystemMigrationRecipeSchema.parse({ schemaVersion: 1, id: 'primary-solid', name: 'Primary to solid', from: { version: '1.0.0', digest }, rules: [{ id: 'variant', type: 'transform-prop', componentRef: 'ds:test/button', fromProp: 'variant', toProp: 'variant', valueMap: [{ from: 'primary', to: 'solid' }] }], packageBindingDecisions: [] });
  const plan = DesignSystemMigrationPlanSchema.parse({ schemaVersion: 1, id: 'reviewed-upgrade', from: state.lock.dependencies[0], to: { designSystemId: target.id, version: target.version, digest: target.digest, source: { type: 'bundle', digest: target.sourceDigest } }, targetRange: '2.0.0', rules: recipe.rules, bindingDecisions: [] });
  const result = { revision: state.revision, ...DesignSystemMigrationRecipePlanResultSchema.parse({ schemaVersion: 1, recipeId: recipe.id, plan, skippedBindingDecisions: [], diagnostics: [] }) };
  const request = { expectedRevision: state.revision, designSystemId: target.id, version: target.version, recipeId: recipe.id, planId: plan.id, targetRange: plan.targetRange };
  return { state, target, recipe, plan, result, request };
}
