import { describe, expect, it } from 'vitest';
import {
  defaultProjectDesignValidationSettings, ProjectDesignRuntimeStateSchema,
  ProjectDesignRuntimeReviewLegacyMigrationRequestSchema, ProjectDesignRuntimeReviewLegacyMigrationResponseSchema,
  ProjectDesignRuntimeApplyLegacyMigrationRequestSchema, ProjectDesignRuntimeApplyLegacyMigrationResponseSchema,
} from '../../src/api/design-runtime.js';
import { LegacyDesignSystemMigrationPlanSchema, LegacyDesignSystemMigrationReviewSchema, type LegacyDesignSystemMigrationReview } from '../../src/design-runtime/legacy-migration.js';
import { DesignTokenSchema } from '../../src/design-runtime/design-tokens.js';

const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;
const constraints = defaultProjectDesignValidationSettings().projectConstraints;
const plan = { schemaVersion: 1, designSystemId: 'legacy', name: 'Legacy', version: '1.0.0', mode: 'guided',
  sourcePaths: ['tokens.css'], tokenStylesheet: 'tokens.css', selections: [], constraints, codeCompatibility: [] };
const token = DesignTokenSchema.parse({ schemaVersion: 1, id: 'bg', name: 'bg', cssVariable: '--bg', type: 'color', value: '#fff', source: { kind: 'manual', sourcePath: 'tokens.css', line: 1 } });
const candidate: NonNullable<LegacyDesignSystemMigrationReview['candidate']> = { schemaVersion: 1, digest, sourceDigest: digest,
  package: { schemaVersion: 1, id: 'legacy', name: 'Legacy', version: '1.0.0',
    registry: { schemaVersion: 1, id: 'legacy', components: [] }, codeIndex: { schemaVersion: 1, id: 'legacy', components: [] }, bindings: { schemaVersion: 1, id: 'legacy', bindings: [] },
    tokens: { schemaVersion: 1, id: 'legacy', tokens: [token] }, patterns: { schemaVersion: 1, id: 'legacy', patterns: [] }, constraints, codeCompatibility: [],
    source: { schemaVersion: 1, files: [{ path: 'tokens.css', encoding: 'utf8', content: ':root { --bg: #fff; }' }] },
  },
};
const review: LegacyDesignSystemMigrationReview = { schemaVersion: 1, id: 'review', projectId: 'project', baseRevision: 2, baseDigest: digest, planDigest: digest, sourceDigest: digest,
  files: [{ path: 'tokens.css', digest, byteLength: 21 }], candidate,
  tokens: [{ status: 'converted', cssVariable: '--bg', sourcePath: 'tokens.css', sourceValue: '#fff', line: 1, token }],
  compiledComponentRefs: [], preservedSourcePaths: ['tokens.css'], diagnostics: [], canApply: true };
const lockEntry = { designSystemId: 'legacy', version: '1.0.0', digest, source: { type: 'bundle', digest } };
const state = ProjectDesignRuntimeStateSchema.parse({ schemaVersion: 1, revision: 3, registry: candidate.package.registry,
  validationSettings: { ...defaultProjectDesignValidationSettings(), mode: 'guided' }, generationTargets: { schemaVersion: 1, outputs: [] },
  codeIndex: { schemaVersion: 1, id: 'project', components: [] }, projectCodeIndex: { schemaVersion: 1, id: 'project', components: [] }, bindings: { schemaVersion: 1, id: 'project', bindings: [] },
  projectComponents: { schemaVersion: 1, id: 'project', components: [] }, document: null, sharedChanges: { schemaVersion: 1, id: 'project', drafts: [], history: [] },
  dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'legacy', version: '1.0.0' }] }, lock: { schemaVersion: 1, id: 'project', dependencies: [lockEntry] },
});
const version = { id: 'legacy', name: 'Legacy', version: '1.0.0', digest, sourceDigest: digest };

describe('legacy migration contracts', () => {
  it('accepts token-only or source-only authoring without requiring DESIGN.md or asserting Strict verification', () => {
    expect(LegacyDesignSystemMigrationPlanSchema.parse(plan)).toEqual(plan);
    const { tokenStylesheet: _css, ...sourceOnly } = plan;
    const selection = { framework: 'react', sourcePath: 'Button.tsx', exportName: 'Button', componentId: 'Button', codeComponentId: 'legacy/Button' };
    expect(LegacyDesignSystemMigrationPlanSchema.safeParse({ ...sourceOnly, sourcePaths: ['Button.tsx'], selections: [selection] }).success).toBe(true);
    for (const changed of [
      { ...plan, mode: 'strict' }, { ...plan, sourcePaths: [] }, { ...plan, sourcePaths: ['other.css'] },
      { ...plan, sourcePaths: ['tokens.css', 'TOKENS.css'] }, { ...plan, sourcePaths: ['tokens.css', 'tokens.css/file'] },
      { ...plan, sourcePaths: ['../tokens.css'] },
      { ...sourceOnly, sourcePaths: ['Button.tsx'], selections: [{ ...selection, sourceText: 'forged' }] },
      { ...sourceOnly, sourcePaths: ['Button.tsx'], selections: [selection, { ...selection, exportName: 'Other' }] },
    ]) expect(LegacyDesignSystemMigrationPlanSchema.safeParse(changed).success).toBe(false);
  });

  it('requires every selected story source and rejects caller-claimed registry and binding snapshots', () => {
    const selection = { sourcePath: 'Button.tsx', exportName: 'Button', componentId: 'Button', codeComponentId: 'legacy/Button',
      storySources: [{ sourcePath: 'Button.stories.tsx', selections: [{ id: 'primary', exportName: 'Primary' }] }] };
    expect(LegacyDesignSystemMigrationPlanSchema.safeParse({ ...plan, sourcePaths: ['tokens.css', 'Button.tsx'], selections: [selection] }).success).toBe(false);
    expect(LegacyDesignSystemMigrationPlanSchema.safeParse({ ...plan, sourcePaths: ['tokens.css', 'Button.tsx', 'Button.stories.tsx'], selections: [selection] }).success).toBe(true);
    const request = { expectedRevision: 2, plan };
    const apply = { ...request, reviewId: 'review', baseDigest: digest, planDigest: digest, sourceDigest: digest };
    expect(ProjectDesignRuntimeApplyLegacyMigrationRequestSchema.parse(JSON.parse(JSON.stringify(apply)))).toEqual(apply);
    for (const changed of [{ ...request, candidate }, { ...request, plan: { ...plan, bindings: [] } }]) expect(ProjectDesignRuntimeReviewLegacyMigrationRequestSchema.safeParse(changed).success).toBe(false);
    for (const changed of [request, { ...apply, state }, { ...apply, sourceDigest: 'unknown' }]) expect(ProjectDesignRuntimeApplyLegacyMigrationRequestSchema.safeParse(changed).success).toBe(false);
  });

  it('keeps unresolved evidence reviewable but never certifies missing facts or contradictory package evidence', () => {
    expect(ProjectDesignRuntimeReviewLegacyMigrationResponseSchema.parse(JSON.parse(JSON.stringify({ revision: 2, review })))).toEqual({ revision: 2, review });
    const unresolved = { status: 'unresolved', cssVariable: '--bg', sourcePath: 'tokens.css', sourceValue: '#000', line: 2, reason: 'unsupported-context' };
    const warning = { schemaVersion: 1, code: 'ODDS9002', severity: 'warning', message: 'Dark theme remains reference material.' };
    expect(LegacyDesignSystemMigrationReviewSchema.safeParse({ ...review, tokens: [...review.tokens, unresolved], diagnostics: [warning] }).success).toBe(true);
    expect(LegacyDesignSystemMigrationReviewSchema.safeParse({ ...review, candidate: null, tokens: [], canApply: false }).success).toBe(true);
    for (const changed of [
      { ...review, candidate: null }, { ...review, tokens: [] }, { ...review, compiledComponentRefs: ['ds:legacy/Fake'] },
      { ...review, diagnostics: [{ ...warning, severity: 'error' }] }, { ...review, sourceDigest: otherDigest },
      { ...review, preservedSourcePaths: ['other.css'] }, { ...review, files: [...review.files, ...review.files] },
      { ...review, tokens: [{ ...review.tokens[0], line: 2 }] },
    ]) expect(LegacyDesignSystemMigrationReviewSchema.safeParse(changed).success).toBe(false);
  });

  it('requires an applied response to advance once and install the exact reviewed immutable lock', () => {
    const response = { state, review, version };
    expect(ProjectDesignRuntimeApplyLegacyMigrationResponseSchema.parse(response)).toEqual(response);
    for (const changed of [
      { ...response, review: { ...review, canApply: false } },
      { ...response, state: { ...state, revision: 2 } },
      { ...response, review: { ...review, projectId: 'other' } },
      { ...response, version: { ...version, digest: otherDigest } },
      { ...response, state: { ...state, lock: { ...state.lock, dependencies: [{ ...lockEntry, source: { type: 'bundle', digest: otherDigest } }] } } },
    ]) expect(ProjectDesignRuntimeApplyLegacyMigrationResponseSchema.safeParse(changed).success).toBe(false);
  });
});
