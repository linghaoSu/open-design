import {
  ComponentBindingRegistrySchema, DesignSystemMigrationRecipePlanResultSchema, InstantiateDesignSystemMigrationRecipeRequestSchema,
  ProjectDesignSystemLockSchema, type DesignSystemMigrationRecipePlanResult, type DesignSystemUpgradeContext,
  type DesignSystemUpgradeBindingDecision, type DesignSystemVersion, type InstantiateDesignSystemMigrationRecipeRequest,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { canonicalDesignSystemJson, createProjectDesignSystemLock, DesignSystemVersionError, satisfiesDesignSystemRange, verifyDesignSystemVersion } from './design-system-version.js';
import { validateDesignSystemMigrationRules } from './migration-rule-validation.js';

const diagnostic = (message: string): ValidationDiagnostic => ({ schemaVersion: 1, code: 'ODDS5002', severity: 'error', message });
const same = (a: unknown, b: unknown) => canonicalDesignSystemJson(a) === canonicalDesignSystemJson(b);
type Context = Pick<DesignSystemUpgradeContext, 'projectId' | 'lock' | 'bindings'>;

/** Pure selection: only untouched published bindings may receive proposed package decisions. */
export function instantiateDesignSystemMigrationRecipe(context: Context, from: DesignSystemVersion, to: DesignSystemVersion, input: InstantiateDesignSystemMigrationRecipeRequest): DesignSystemMigrationRecipePlanResult {
  const request = InstantiateDesignSystemMigrationRecipeRequestSchema.parse(input);
  const lock = ProjectDesignSystemLockSchema.parse(context.lock);
  const bindings = ComponentBindingRegistrySchema.parse(context.bindings);
  const fail = (message: string): never => { throw new DesignSystemVersionError([diagnostic(message)]); };
  for (const version of [from, to]) {
    const diagnostics = verifyDesignSystemVersion(version);
    if (diagnostics.length) throw new DesignSystemVersionError(diagnostics);
  }
  if (lock.id !== context.projectId || bindings.id !== context.projectId || lock.dependencies.length !== 1) fail('Recipe instantiation requires one exact project dependency.');
  const before = createProjectDesignSystemLock(context.projectId, [from]).dependencies[0]!;
  const after = createProjectDesignSystemLock(context.projectId, [to]).dependencies[0]!;
  if (!same(lock.dependencies[0], before) || before.designSystemId !== after.designSystemId) fail('Recipe packages must match the active project dependency and retain its design-system identity.');
  const recipe = to.package.migrations?.find((entry) => entry.id === request.recipeId);
  if (!recipe) return fail('The exact target package does not provide this migration recipe.');
  if (recipe.from.version !== from.package.version || recipe.from.digest !== from.digest) fail('This migration recipe requires a different exact source version or digest.');
  if (!satisfiesDesignSystemRange(to.package.version, request.targetRange)) fail('The exact target version does not satisfy the requested dependency range.');
  const errors = validateDesignSystemMigrationRules(from.package.registry, to.package.registry, recipe.rules);
  if (errors.length) throw new DesignSystemVersionError(errors);
  const replacements = new Map(recipe.rules.flatMap((rule) => rule.type === 'replace-component' ? [[rule.fromRef, rule.toRef] as const] : []));
  const decisions: DesignSystemUpgradeBindingDecision[] = [];
  const skipped: DesignSystemMigrationRecipePlanResult['skippedBindingDecisions'] = [];
  const diagnostics: ValidationDiagnostic[] = [];
  for (const decision of recipe.packageBindingDecisions) {
    const published = from.package.bindings.bindings.find((entry) => entry.id === decision.bindingId);
    if (!published || !published.componentRef.startsWith(`ds:${from.package.id}/`)) fail(`Recipe binding ${decision.bindingId} is absent from the exact source package.`);
    if (decision.type === 'use-target-package') {
      const target = to.package.bindings.bindings.find((entry) => entry.id === decision.targetBindingId);
      if (!target || target.status !== 'bound' || target.framework !== published!.framework || target.componentRef !== (replacements.get(published!.componentRef) ?? published!.componentRef)) fail(`Recipe binding ${decision.bindingId} cannot change its component relationship or framework implicitly.`);
    }
    const live = bindings.bindings.find((entry) => entry.id === decision.bindingId);
    if (!same(live, published)) {
      skipped.push(decision);
      diagnostics.push({ ...diagnostic(`Recipe decision for ${decision.bindingId} was skipped because the project binding differs from the exact published source. Review the project mapping explicitly.`), severity: 'warning' });
      continue;
    }
    decisions.push(decision);
  }
  return DesignSystemMigrationRecipePlanResultSchema.parse({ schemaVersion: 1, recipeId: recipe.id,
    plan: { schemaVersion: 1, id: request.planId, from: before, to: after, targetRange: request.targetRange, rules: recipe.rules, bindingDecisions: decisions },
    skippedBindingDecisions: skipped, diagnostics,
  });
}
