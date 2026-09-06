import { LegacyDesignSystemMigrationReviewSchema, type LegacyDesignSystemMigrationPlan } from '@open-design/contracts';
import { emptyDesignRuntimeState } from './design-runtime-fixtures';

export function legacyMigrationFixture(plan?: LegacyDesignSystemMigrationPlan, projectId = 'project', revision = 1, canApply = true) {
  const state = emptyDesignRuntimeState(revision);
  const input: LegacyDesignSystemMigrationPlan = plan ?? { schemaVersion: 1, designSystemId: 'legacy', name: 'Legacy UI', version: '1.0.0', mode: 'explore',
    sourcePaths: ['DESIGN.md', 'tokens.css'], tokenStylesheet: 'tokens.css', selections: [], constraints: state.validationSettings.projectConstraints, codeCompatibility: [] };
  const digest = `sha256:${'a'.repeat(64)}`; const sourceDigest = `sha256:${'b'.repeat(64)}`;
  const sourcePath = input.tokenStylesheet ?? input.sourcePaths[0]!;
  const token = { schemaVersion: 1, id: 'color-primary', name: 'Primary', cssVariable: '--color-primary', type: 'color', value: '#112233', source: { kind: 'manual', sourcePath, line: 1 } };
  const review = LegacyDesignSystemMigrationReviewSchema.parse({ schemaVersion: 1, id: 'legacy-review', projectId, baseRevision: revision, baseDigest: digest, planDigest: digest, sourceDigest,
    files: input.sourcePaths.map((path) => ({ path, digest, byteLength: 20 })), preservedSourcePaths: input.sourcePaths,
    candidate: canApply ? { schemaVersion: 1, digest, sourceDigest, package: { schemaVersion: 1, id: input.designSystemId, name: input.name, version: input.version,
      registry: { schemaVersion: 1, id: input.designSystemId, components: [] }, codeIndex: { schemaVersion: 1, id: input.designSystemId, components: [] }, bindings: { schemaVersion: 1, id: input.designSystemId, bindings: [] },
      tokens: { schemaVersion: 1, id: input.designSystemId, tokens: [token] }, patterns: { schemaVersion: 1, id: input.designSystemId, patterns: [] }, constraints: input.constraints, codeCompatibility: [],
      source: { schemaVersion: 1, files: input.sourcePaths.map((path) => ({ path, encoding: 'utf8', content: 'preserved source' })) },
    } } : null,
    tokens: [{ cssVariable: '--color-primary', sourcePath, line: 1, sourceValue: '#112233', status: 'converted', token },
      { cssVariable: '--shadow', sourcePath, line: 2, sourceValue: '0 2px 4px #000', status: 'unresolved', reason: 'unsupported-token' }],
    compiledComponentRefs: [], diagnostics: canApply ? [] : [{ schemaVersion: 1, severity: 'error', code: 'ODDS9001', message: 'No convertible facts.' }], canApply,
  });
  const version = { id: input.designSystemId, name: input.name, version: input.version, digest, sourceDigest };
  const applied = { state: { ...state, revision: revision + 1, registry: review.candidate?.package.registry ?? null, validationSettings: { ...state.validationSettings, mode: input.mode },
    dependencies: { schemaVersion: 1 as const, id: projectId, dependencies: [{ designSystemId: version.id, version: version.version }] },
    lock: { schemaVersion: 1 as const, id: projectId, dependencies: [{ designSystemId: version.id, version: version.version, digest, source: { type: 'bundle' as const, digest: sourceDigest } }] },
    codeIndex: { ...state.codeIndex, id: projectId },
  }, review, version };
  return { state, plan: input, review, applied, proof: { expectedRevision: revision, plan: input, reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, sourceDigest: review.sourceDigest } };
}
