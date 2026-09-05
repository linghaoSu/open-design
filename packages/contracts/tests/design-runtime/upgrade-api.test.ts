import { defaultProjectDesignValidationSettings } from '../../src/api/design-runtime.js';
import { describe, expect, it } from 'vitest';
import { ProjectDesignRuntimeReviewUpgradeRequestSchema, ProjectDesignRuntimeReviewUpgradeResponseSchema, ProjectDesignRuntimeApplyUpgradeRequestSchema, ProjectDesignRuntimeApplyUpgradeResponseSchema } from '../../src/api/design-runtime.js';

const digest = `sha256:${'a'.repeat(64)}`;
const from = { designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } };
const to = { ...from, version: '2.0.0' };
const plan = { schemaVersion: 1, id: 'upgrade', from, to, targetRange: '^2.0.0', rules: [], bindingDecisions: [] };
const resolved = { schemaVersion: 1, document: { schemaVersion: 1, id: 'project', screens: [] }, origins: [], diagnostics: [] };
const review = { schemaVersion: 1, id: 'review', projectId: 'project', baseRevision: 3, baseDigest: digest, planDigest: digest, plan,
  diff: { schemaVersion: 1, from, to, changes: [], recommendedBump: 'none' }, current: resolved, proposed: resolved,
  affectedUsages: [], affectedScreens: [], invalidOverrides: [], codeImpact: { bindings: [], sourceFiles: [], coverage: 'registered-bindings' }, bindingTransitions: [],
  tokenUsageCoverage: 'not-indexed', sourceUsageCoverage: 'conservative-design-system-screens', diagnostics: [], canApply: true };
const state = { schemaVersion: 1, revision: 4, validationSettings: defaultProjectDesignValidationSettings(), generationTargets: { schemaVersion: 1 as const, outputs: [] }, registry: { schemaVersion: 1, id: 'acme', components: [] },
  codeIndex: { schemaVersion: 1, id: 'project', components: [] }, bindings: { schemaVersion: 1, id: 'project', bindings: [] },
  projectCodeIndex: { schemaVersion: 1, id: 'project', components: [] },
  projectComponents: { schemaVersion: 1, id: 'project', components: [] }, document: null, sharedChanges: { schemaVersion: 1, id: 'project', drafts: [], history: [] },
  dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^2.0.0' }] }, lock: { schemaVersion: 1, id: 'project', dependencies: [to] } };

describe('public upgrade contracts', () => {
  it('requires a revision and complete review proof without accepting client-supplied snapshots', () => {
    const request = { expectedRevision: 3, plan };
    expect(ProjectDesignRuntimeReviewUpgradeRequestSchema.parse(request)).toEqual(request);
    const apply = { ...request, reviewId: review.id, baseDigest: digest, planDigest: digest };
    expect(ProjectDesignRuntimeApplyUpgradeRequestSchema.parse(apply)).toEqual(apply);
    for (const value of [{ plan }, { ...request, expectedRevision: -1 }, { ...request, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...request, state }]) expect(ProjectDesignRuntimeReviewUpgradeRequestSchema.safeParse(value).success).toBe(false);
    for (const value of [request, { ...apply, baseDigest: 'unverified' }, { ...apply, state }, { ...apply, review }]) expect(ProjectDesignRuntimeApplyUpgradeRequestSchema.safeParse(value).success).toBe(false);
  });
  it('accepts a nonapplicable review but never claims it was applied', () => {
    const blocked = { ...review, canApply: false, diagnostics: [{ schemaVersion: 1, severity: 'error', code: 'ODDS5002', message: 'Invalid proposed rule.' }] };
    expect(ProjectDesignRuntimeReviewUpgradeResponseSchema.parse({ revision: 3, review: blocked }).review.canApply).toBe(false);
    expect(ProjectDesignRuntimeReviewUpgradeResponseSchema.safeParse({ revision: 4, review }).success).toBe(false);
    expect(ProjectDesignRuntimeApplyUpgradeResponseSchema.safeParse({ state, review: blocked }).success).toBe(false);
  });
  it('binds applied response to the project, next revision and exact target digest', () => {
    expect(ProjectDesignRuntimeApplyUpgradeResponseSchema.parse({ state, review })).toEqual({ state, review });
    for (const changed of [{ ...state, revision: 3 }, { ...state, lock: { ...state.lock, dependencies: [from] } }, { ...state, lock: { ...state.lock, dependencies: [{ ...to, source: { ...to.source, digest: `sha256:${'b'.repeat(64)}` } }] } }]) expect(ProjectDesignRuntimeApplyUpgradeResponseSchema.safeParse({ state: changed, review }).success).toBe(false);
    expect(ProjectDesignRuntimeApplyUpgradeResponseSchema.safeParse({ state, review: { ...review, projectId: 'other' } }).success).toBe(false);
  });
});
