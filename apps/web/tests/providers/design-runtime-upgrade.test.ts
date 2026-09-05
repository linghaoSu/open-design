import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemUpgradeReviewSchema, type ProjectDesignRuntimeApplyUpgradeRequest } from '@open-design/contracts';
import { reviewProjectDesignRuntimeUpgrade, applyProjectDesignRuntimeUpgrade, ProjectDesignRuntimeError } from '../../src/providers/design-runtime';
import { designRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

const digest = `sha256:${'a'.repeat(64)}`;
function reviewedUpgrade() {
  const from = { designSystemId: 'test', version: '1.0.0', digest, source: { type: 'bundle', digest } };
  const to = { ...from, version: '2.0.0' };
  const plan = { schemaVersion: 1, id: 'reviewed', from, to, targetRange: '^2.0.0', rules: [], bindingDecisions: [] };
  const resolved = { schemaVersion: 1, document: { schemaVersion: 1, id: 'design', screens: [] }, origins: [], diagnostics: [] };
  return DesignSystemUpgradeReviewSchema.parse({ schemaVersion: 1, id: 'review', projectId: 'project', baseRevision: 1, baseDigest: digest, planDigest: digest, plan,
    diff: { schemaVersion: 1, from, to, changes: [], recommendedBump: 'none' }, current: resolved, proposed: resolved,
    affectedUsages: [], affectedScreens: [], invalidOverrides: [], codeImpact: { bindings: [], sourceFiles: [], coverage: 'registered-bindings' }, bindingTransitions: [],
    tokenUsageCoverage: 'not-indexed', sourceUsageCoverage: 'conservative-design-system-screens', diagnostics: [], canApply: true });
}
afterEach(() => vi.unstubAllGlobals());

describe('reviewed upgrade provider', () => {
  it('carries canonical plan/proofs, exact workspace headers and cancellation through both HTTP endpoints', async () => {
    const review = reviewedUpgrade();
    const scope = { projectId: 'project / one', workspaceContext: workspaceContextFixture({ workspaceId: 'team-a', workspaceMemberId: 'member-a' }), signal: new AbortController().signal };
    const input = { expectedRevision: 1, plan: review.plan };
    const proof = { ...input, reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest };
    const state = designRuntimeState(2);
    state.lock.dependencies = [review.plan.to]; state.dependencies.dependencies = [{ designSystemId: 'test', version: '^2.0.0' }];
    for (const entry of [
      { run: () => reviewProjectDesignRuntimeUpgrade(scope, input), path: '/upgrades/review', body: input, response: { revision: 1, review } },
      { run: () => applyProjectDesignRuntimeUpgrade(scope, proof), path: '/upgrades/apply', body: proof, response: { state, review } },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry.response), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await expect(entry.run()).resolves.toEqual(entry.response);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/projects/project%20%2F%20one/design-runtime${entry.path}`);
      expect(init.method).toBe('POST'); expect(init.cache).toBe('no-store'); expect(init.signal).toBe(scope.signal);
      expect(JSON.parse(String(init.body))).toEqual(entry.body);
      const headers = new Headers(init.headers);
      expect(headers.get('x-od-workspace-id')).toBe('team-a'); expect(headers.get('x-od-workspace-member-id')).toBe('member-a');
    }
  });
  it('retains nonapplicable review diagnostics and rejects a response claiming a different applied lock', async () => {
    const review = reviewedUpgrade(); const scope = { projectId: 'project', workspaceContext: null };
    const diagnostic = { schemaVersion: 1 as const, severity: 'error' as const, code: 'ODDS5002' as const, message: 'Review the removed property.' };
    const blocked = { revision: 1, review: { ...review, canApply: false, diagnostics: [diagnostic] } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(blocked), { status: 200 })));
    await expect(reviewProjectDesignRuntimeUpgrade(scope, { expectedRevision: 1, plan: review.plan })).resolves.toEqual(blocked);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: designRuntimeState(2), review }), { status: 200 })));
    await expect(applyProjectDesignRuntimeUpgrade(scope, { expectedRevision: 1, plan: review.plan, reviewId: review.id, baseDigest: digest, planDigest: digest })).rejects.toThrow();
  });
  it('preserves canonical conflict details and refuses incomplete proof before fetching', async () => {
    const scope = { projectId: 'project', workspaceContext: null }; const review = reviewedUpgrade();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(() => applyProjectDesignRuntimeUpgrade(scope, { expectedRevision: 1, plan: review.plan } as ProjectDesignRuntimeApplyUpgradeRequest)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    const details = { diagnostics: [{ schemaVersion: 1, severity: 'error', code: 'ODDS5002', message: 'Create a fresh review.' }], review };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'DESIGN_RUNTIME_UPGRADE_CONFLICT', message: 'The state changed.', details } }), { status: 409 }));
    const result = await applyProjectDesignRuntimeUpgrade(scope, { expectedRevision: 1, plan: review.plan, reviewId: review.id, baseDigest: digest, planDigest: digest }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ProjectDesignRuntimeError);
    expect(result).toMatchObject({ status: 409, diagnostics: details.diagnostics, apiError: { details } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
