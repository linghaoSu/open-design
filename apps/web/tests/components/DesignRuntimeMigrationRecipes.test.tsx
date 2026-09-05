// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignRuntimeUpgrades } from '../../src/components/DesignRuntimeUpgrades';
import * as provider from '../../src/providers/design-runtime';
import { migrationFixture } from '../helpers/design-runtime-migration-fixtures';
vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'), listProjectDesignRuntimeMigrationRecipes: vi.fn(), instantiateProjectDesignRuntimeMigrationRecipe: vi.fn(), reviewProjectDesignRuntimeUpgrade: vi.fn(), applyProjectDesignRuntimeUpgrade: vi.fn() }));
const scope = { projectId: 'project', workspaceContext: null };
const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
function setup() {
  const fixture = migrationFixture(); const props = { scope, state: fixture.state, target: fixture.target, catalog: [fixture.target], catalogRevision: 1, viewerOnly: false, onState: vi.fn() };
  vi.mocked(provider.listProjectDesignRuntimeMigrationRecipes).mockResolvedValue({ revision: 1, recipes: [fixture.recipe] });
  vi.mocked(provider.instantiateProjectDesignRuntimeMigrationRecipe).mockResolvedValue(fixture.result);
  const mounted = render(<DesignRuntimeUpgrades {...props} />);
  fireEvent.change(input('upgrade-target'), { target: { value: JSON.stringify([fixture.target.id, fixture.target.version, fixture.target.digest, fixture.target.sourceDigest]) } });
  return { fixture, props, mounted };
}
async function choose() { fireEvent.click(input('upgrade-recipes-load')); await screen.findByTestId('upgrade-recipe-select'); fireEvent.change(input('upgrade-recipe-select'), { target: { value: 'primary-solid' } }); }
beforeEach(() => vi.resetAllMocks()); afterEach(cleanup);
describe('published recipe selection', () => {
  it('discovers exact recipes and only fills the editable plan after explicit use, without review or apply', async () => {
    const { fixture } = setup();
    expect(provider.listProjectDesignRuntimeMigrationRecipes).not.toHaveBeenCalled(); await choose();
    expect(provider.listProjectDesignRuntimeMigrationRecipes).toHaveBeenCalledWith(expect.objectContaining(scope), 'test', '2.0.0');
    expect(JSON.parse(input('upgrade-editor').value).rules).toEqual([]);
    fireEvent.click(input('upgrade-recipe-use')); await screen.findByText('Recipe added to the editable plan. Review it before applying.');
    expect(provider.instantiateProjectDesignRuntimeMigrationRecipe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(scope), fixture.request);
    expect(JSON.parse(input('upgrade-editor').value)).toEqual({ rules: fixture.plan.rules, bindingDecisions: fixture.plan.bindingDecisions });
    expect(provider.reviewProjectDesignRuntimeUpgrade).not.toHaveBeenCalled(); expect(provider.applyProjectDesignRuntimeUpgrade).not.toHaveBeenCalled(); expect(input('upgrade-apply').disabled).toBe(true);
  });
  it('filters recipes by both active version and digest and refuses a mismatched instantiated target', async () => {
    const { fixture } = setup();
    vi.mocked(provider.listProjectDesignRuntimeMigrationRecipes).mockResolvedValueOnce({ revision: 1, recipes: [{ ...fixture.recipe, from: { ...fixture.recipe.from, digest: fixture.target.digest } }] });
    fireEvent.click(input('upgrade-recipes-load')); await screen.findByText('This exact version has no recipe for the active dependency.');
    expect(screen.queryByTestId('upgrade-recipe-select')).toBeNull();
    await choose();
    vi.mocked(provider.instantiateProjectDesignRuntimeMigrationRecipe).mockResolvedValueOnce({ ...fixture.result, plan: { ...fixture.plan, to: { ...fixture.plan.to, digest: fixture.plan.from.digest } } });
    fireEvent.click(input('upgrade-recipe-use')); await screen.findByRole('alert');
    expect(JSON.parse(input('upgrade-editor').value).rules).toEqual([]); expect(input('upgrade-apply').disabled).toBe(true);
  });
  it('preserves skipped-manual-binding diagnostics for explicit follow-up after using a recipe', async () => {
    const { fixture } = setup();
    vi.mocked(provider.instantiateProjectDesignRuntimeMigrationRecipe).mockResolvedValue({ ...fixture.result, diagnostics: [{ schemaVersion: 1, code: 'ODDS5002', severity: 'warning', message: 'Manual binding preserved; choose a mapping explicitly.' }] });
    await choose(); fireEvent.click(input('upgrade-recipe-use')); await screen.findByText(/Manual binding preserved/);
    expect(provider.applyProjectDesignRuntimeUpgrade).not.toHaveBeenCalled();
  });
  it('aborts and ignores late recipe selection after authority changes', async () => {
    const { fixture, props, mounted } = setup();
    let resolve!: (value: typeof fixture.result) => void;
    vi.mocked(provider.instantiateProjectDesignRuntimeMigrationRecipe).mockReturnValue(new Promise((done) => { resolve = done; }));
    await choose(); fireEvent.click(input('upgrade-recipe-use'));
    const authority = vi.mocked(provider.instantiateProjectDesignRuntimeMigrationRecipe).mock.calls[0]![0];
    mounted.rerender(<DesignRuntimeUpgrades {...props} scope={{ projectId: 'other-project', workspaceContext: null }} />);
    expect(authority.signal?.aborted).toBe(true);
    await act(async () => resolve(fixture.result));
    await waitFor(() => expect(JSON.parse(input('upgrade-editor').value).rules).toEqual([]));
    expect(provider.reviewProjectDesignRuntimeUpgrade).not.toHaveBeenCalled();
  });
});
