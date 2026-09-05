// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemUpgradeReviewSchema, type DesignSystemMigrationPlan, type ProjectDesignRuntimeState } from '@open-design/contracts';
import { DesignRuntimeUpgrades } from '../../src/components/DesignRuntimeUpgrades';
import * as provider from '../../src/providers/design-runtime';
import { designRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'), reviewProjectDesignRuntimeUpgrade: vi.fn(), applyProjectDesignRuntimeUpgrade: vi.fn() }));
const digest = `sha256:${'a'.repeat(64)}`;
const sourceDigest = `sha256:${'b'.repeat(64)}`;
const scope = { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'team-a', workspaceMemberId: 'member-a' }) };
const target = { id: 'test', name: 'Test UI', version: '2.0.0', digest, sourceDigest };
const catalog = [target, { ...target, version: '3.0.0' }, { ...target, id: 'other', name: 'Other UI' }];
const key = (version = '2.0.0') => JSON.stringify(['test', version, digest, sourceDigest]);
function lockedState() {
  const state = designRuntimeState();
  state.lock.dependencies = [{ designSystemId: 'test', version: '1.0.0', digest, source: { type: 'bundle', digest: sourceDigest } }];
  state.dependencies.dependencies = [{ designSystemId: 'test', version: '^1.0.0' }]; return state;
}
function review(plan: DesignSystemMigrationPlan, canApply = true) {
  const diagnostic = { schemaVersion: 1, severity: 'error', code: 'ODDS5002', message: 'Pending draft uses a removed variant; repair or discard it.' };
  const resolved = { schemaVersion: 1, document: { schemaVersion: 1, id: 'design', screens: [{ schemaVersion: 1, type: 'screen', id: 'applications', name: 'Applications', children: [] }, { schemaVersion: 1, type: 'screen', id: 'dashboard', name: 'Dashboard', children: [] }] }, origins: [], diagnostics: [] };
  return DesignSystemUpgradeReviewSchema.parse({ schemaVersion: 1, id: 'reviewed-proof', projectId: 'project', baseRevision: 1, baseDigest: digest, planDigest: digest, plan,
    diff: { schemaVersion: 1, from: plan.from, to: plan.to, changes: [{ schemaVersion: 1, id: 'variant-change', entity: { kind: 'component', id: 'button' }, path: ['props', 'variant'], kind: 'changed', breaking: true, reason: 'The primary variant was removed.', before: { present: true, value: 'primary' }, after: { present: true, value: 'ghost' } }], recommendedBump: 'major' },
    current: { schemaVersion: 1, document: null, origins: [], diagnostics: [{ schemaVersion: 1, severity: 'error', code: 'ODDS1003', message: 'The old value is invalid.' }] }, proposed: resolved,
    affectedScreens: [{ kind: 'screen', documentId: 'design', screenId: 'applications' }, { kind: 'screen', documentId: 'design', screenId: 'dashboard' }],
    affectedUsages: [{ schemaVersion: 1, owner: { kind: 'component', componentRef: 'local:Card' }, nodeId: 'button', target: 'ds:test/button', path: ['template'] }],
    invalidOverrides: [], codeImpact: { bindings: lockedState().bindings.bindings, sourceFiles: ['src/Button.tsx'], coverage: 'registered-bindings' },
    bindingTransitions: [{ bindingId: 'button-binding', before: lockedState().bindings.bindings[0], after: { schemaVersion: 1, id: 'button-binding', componentRef: 'ds:test/button', framework: 'react', status: 'unbound', verified: false } }],
    tokenUsageCoverage: 'not-indexed', sourceUsageCoverage: 'conservative-design-system-screens', diagnostics: canApply ? [] : [diagnostic], canApply });
}
const choices = { rules: [{ id: 'variant', type: 'transform-prop', componentRef: 'ds:test/button', fromProp: 'variant', toProp: 'variant', valueMap: [{ from: 'primary', to: 'ghost' }] }], bindingDecisions: [{ type: 'use-target-package', bindingId: 'button-binding', targetBindingId: 'button-binding' }] };
const element = (id: string) => screen.getByTestId(id) as HTMLInputElement;
function selectTarget() { fireEvent.change(element('upgrade-target'), { target: { value: key() } }); }
function choosePlan() { selectTarget(); fireEvent.change(element('upgrade-editor'), { target: { value: JSON.stringify(choices) } }); }
async function reviewed() { fireEvent.click(element('upgrade-review')); await screen.findByTestId('upgrade-impact'); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(provider.reviewProjectDesignRuntimeUpgrade).mockImplementation(async (_scope, input) => ({ revision: 1, review: review(input.plan, input.plan.rules.length > 0) }));
});
afterEach(cleanup);

describe('DesignRuntimeUpgrades', () => {
  it('selects only exact versions of the active design system and shows blocked draft, semantic, usage and code impact', async () => {
    render(<StrictMode><DesignRuntimeUpgrades scope={scope} state={lockedState()} catalog={catalog} catalogRevision={1} viewerOnly={false} onState={vi.fn()} /></StrictMode>);
    expect(screen.queryByRole('option', { name: /Other UI/ })).toBeNull();
    selectTarget(); expect(element('upgrade-range').value).toBe('2.0.0');
    await reviewed();
    expect(element('upgrade-apply').disabled).toBe(true);
    expect(screen.getByText(/Pending draft uses a removed variant/)).toBeTruthy();
    expect(screen.getByText(/The old value is invalid/)).toBeTruthy();
    expect(screen.getByText(/Breaking change/)).toBeTruthy();
    expect(screen.getByText('Button · props.variant')).toBeTruthy();
    const screens = within(screen.getByTestId('upgrade-affected-screens'));
    expect(screens.getByText('Applications')).toBeTruthy(); expect(screens.getByText('Dashboard')).toBeTruthy(); expect(screens.getByText('design / applications')).toBeTruthy();
    expect(screen.getByText(/local:Card · button/)).toBeTruthy();
    expect(screen.getAllByText('src/Button.tsx').length).toBeGreaterThan(0);
    expect(screen.getByText(/token usage is not indexed/)).toBeTruthy();
    expect(provider.applyProjectDesignRuntimeUpgrade).not.toHaveBeenCalled();
  });
  it('applies exactly the reviewed proof once and adopts returned state while current errors remain informational', async () => {
    const state = lockedState(); const accepted = vi.fn();
    vi.mocked(provider.applyProjectDesignRuntimeUpgrade).mockImplementation(async (_scope, input) => ({ state: { ...state, revision: 2, lock: { ...state.lock, dependencies: [input.plan.to] } }, review: review(input.plan) }));
    render(<DesignRuntimeUpgrades scope={scope} state={state} catalog={catalog} catalogRevision={1} viewerOnly={false} onState={accepted} />);
    choosePlan(); await reviewed();
    expect(element('upgrade-apply').disabled).toBe(false);
    const submitted = vi.mocked(provider.reviewProjectDesignRuntimeUpgrade).mock.calls[0]![1];
    fireEvent.click(element('upgrade-apply')); fireEvent.click(element('upgrade-apply'));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(provider.applyProjectDesignRuntimeUpgrade).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(scope), { expectedRevision: 1, plan: submitted.plan, reviewId: 'reviewed-proof', baseDigest: digest, planDigest: digest });
    expect(accepted.mock.calls[0]![0].lock.dependencies[0]).toEqual(submitted.plan.to);
    expect(element('upgrade-apply').disabled).toBe(true);
  });
  it('invalidates reviews on rule, range, target, state refresh and catalog refresh changes', async () => {
    const state = lockedState(); const props = { scope, state, catalog, catalogRevision: 1, viewerOnly: false, onState: vi.fn() };
    const mounted = render(<DesignRuntimeUpgrades {...props} />);
    choosePlan(); await reviewed();
    fireEvent.change(element('upgrade-editor'), { target: { value: `${JSON.stringify(choices)}\n` } });
    expect(element('upgrade-apply').disabled).toBe(true); expect(screen.queryByTestId('upgrade-impact')).toBeNull();
    await reviewed(); fireEvent.change(element('upgrade-range'), { target: { value: '^2.0.0' } }); expect(element('upgrade-apply').disabled).toBe(true);
    await reviewed(); fireEvent.change(element('upgrade-target'), { target: { value: key('3.0.0') } }); expect(element('upgrade-apply').disabled).toBe(true);
    await reviewed(); mounted.rerender(<DesignRuntimeUpgrades {...props} state={{ ...state }} />); expect(element('upgrade-apply').disabled).toBe(true);
    await reviewed(); mounted.rerender(<DesignRuntimeUpgrades {...props} state={{ ...state }} catalog={[...catalog]} />); expect(element('upgrade-apply').disabled).toBe(true);
    mounted.rerender(<DesignRuntimeUpgrades {...props} state={{ ...state, revision: 2 }} />); expect(element('upgrade-review').disabled).toBe(true);
    expect(screen.getByText(/Refresh Versions/)).toBeTruthy();
  });
  it('aborts and ignores a late review when project authority changes', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof provider.reviewProjectDesignRuntimeUpgrade>>) => void;
    vi.mocked(provider.reviewProjectDesignRuntimeUpgrade).mockReturnValue(new Promise((done) => { resolve = done; }));
    const props = { scope, state: lockedState(), catalog, catalogRevision: 1, viewerOnly: false, onState: vi.fn() };
    const mounted = render(<DesignRuntimeUpgrades {...props} />); choosePlan(); fireEvent.click(element('upgrade-review'));
    const [authority, input] = vi.mocked(provider.reviewProjectDesignRuntimeUpgrade).mock.calls[0]!;
    mounted.rerender(<DesignRuntimeUpgrades {...props} scope={{ ...scope, workspaceContext: workspaceContextFixture({ workspaceId: 'team-b', workspaceMemberId: 'member-b' }) }} />);
    expect(authority.signal?.aborted).toBe(true);
    await act(async () => { resolve({ revision: 1, review: review(input.plan) }); });
    expect(screen.queryByTestId('upgrade-impact')).toBeNull(); expect(element('upgrade-apply').disabled).toBe(true);
  });
  it('supports read-only reviews, rejects malformed rules before HTTP and blocks stale proof retries', async () => {
    const state = lockedState(); const props = { scope, state, catalog, catalogRevision: 1, viewerOnly: true, onState: vi.fn() };
    const mounted = render(<DesignRuntimeUpgrades {...props} />); choosePlan(); await reviewed(); expect(element('upgrade-apply').disabled).toBe(true);
    mounted.rerender(<DesignRuntimeUpgrades {...props} viewerOnly={false} />); choosePlan();
    fireEvent.change(element('upgrade-editor'), { target: { value: JSON.stringify({ ...choices, from: 'injected' }) } });
    expect(element('upgrade-review').disabled).toBe(true);
    choosePlan(); await reviewed();
    vi.mocked(provider.applyProjectDesignRuntimeUpgrade).mockRejectedValue(new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_UPGRADE_CONFLICT', message: 'The project changed. Review again.' }));
    fireEvent.click(element('upgrade-apply')); await screen.findByText('The project changed. Review again.');
    expect(element('upgrade-apply').disabled).toBe(true); expect(screen.queryByTestId('upgrade-impact')).toBeNull();
    expect(provider.applyProjectDesignRuntimeUpgrade).toHaveBeenCalledOnce();
  });
  it('does not offer an upgrade without an active exact dependency', () => {
    render(<DesignRuntimeUpgrades scope={scope} state={designRuntimeState()} catalog={catalog} catalogRevision={1} viewerOnly={false} onState={vi.fn()} />);
    expect(screen.getByText(/Activate an exact design system version/)).toBeTruthy(); expect(screen.queryByTestId('upgrade-review')).toBeNull();
  });
});
