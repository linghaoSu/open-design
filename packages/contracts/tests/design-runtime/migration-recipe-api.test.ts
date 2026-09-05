import { describe, expect, it } from 'vitest';
import { ProjectDesignRuntimeMigrationRecipesResponseSchema, ProjectDesignRuntimeInstantiateMigrationRecipeRequestSchema, ProjectDesignRuntimeMigrationRecipeResponseSchema } from '../../src/api/design-runtime.js';

const digest = `sha256:${'a'.repeat(64)}`;
const from = { designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } };
const to = { ...from, version: '2.0.0' };
const recipe = { schemaVersion: 1, id: 'button-v2', name: 'Button v2', from: { version: from.version, digest }, rules: [], packageBindingDecisions: [] };
const request = { expectedRevision: 3, designSystemId: 'acme', version: '2.0.0', recipeId: recipe.id, planId: 'chosen', targetRange: '^2.0.0' };
const plan = { schemaVersion: 1, id: 'chosen', from, to, targetRange: '^2.0.0', rules: [], bindingDecisions: [] };

describe('public migration recipe contracts', () => {
  it('requires exact catalog identity and revision while rejecting client-supplied recipe content and proof', () => {
    expect(ProjectDesignRuntimeInstantiateMigrationRecipeRequestSchema.parse(request)).toEqual(request);
    for (const input of [
      { ...request, expectedRevision: -1 }, { ...request, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...request, version: 'latest' }, { ...request, version: '^2.0.0' }, { ...request, targetRange: '*' },
      { ...request, recipe }, { ...request, plan }, { ...request, rules: [] }, { ...request, from },
    ]) expect(ProjectDesignRuntimeInstantiateMigrationRecipeRequestSchema.safeParse(input).success).toBe(false);
  });
  it('returns an editable normal plan with explicit skipped-binding diagnostics without any applied state', () => {
    const response = { revision: 3, schemaVersion: 1, recipeId: recipe.id, plan, skippedBindingDecisions: [{ type: 'unbind', bindingId: 'manual' }],
      diagnostics: [{ schemaVersion: 1, code: 'ODDS5002', severity: 'warning', message: 'The manual binding was preserved.' }] };
    expect(ProjectDesignRuntimeMigrationRecipeResponseSchema.parse(response)).toEqual(response);
    expect(ProjectDesignRuntimeMigrationRecipesResponseSchema.parse({ revision: 3, recipes: [recipe] })).toEqual({ revision: 3, recipes: [recipe] });
    for (const changed of [{ ...response, state: {} }, { ...response, applied: true }, { ...response, plan: { ...plan, bindingDecisions: [{ type: 'unknown', bindingId: 'manual' }] } }]) expect(ProjectDesignRuntimeMigrationRecipeResponseSchema.safeParse(changed).success).toBe(false);
    expect(ProjectDesignRuntimeMigrationRecipesResponseSchema.safeParse({ revision: 3, recipes: [{ ...recipe, from: { version: 'latest', digest } }] }).success).toBe(false);
  });
});
