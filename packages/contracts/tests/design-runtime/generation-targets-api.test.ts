import { describe, expect, it } from 'vitest';
import { ProjectDesignRuntimeGenerationTargetsRequestSchema, ProjectDesignRuntimeGenerationTargetsResponseSchema } from '../../src/api/design-runtime.js';
const targets = { schemaVersion: 1, outputs: [{ sourcePath: 'future/Applications.tsx', exportName: 'Applications', screenId: 'new-screen' }] };
describe('generation target authoring DTOs', () => {
  it('accepts explicit future paths and screens without readiness evidence', () => {
    expect(ProjectDesignRuntimeGenerationTargetsRequestSchema.parse({ expectedRevision: 0, targets })).toEqual({ expectedRevision: 0, targets });
    expect(ProjectDesignRuntimeGenerationTargetsResponseSchema.parse({ revision: 3, targets })).toEqual({ revision: 3, targets });
    expect(ProjectDesignRuntimeGenerationTargetsRequestSchema.parse({ expectedRevision: 3, targets: { schemaVersion: 1, outputs: [] } }).targets.outputs).toEqual([]);
  });
  it('rejects injected proof/authority, unsafe revisions, paths and duplicate output/screen identities', () => {
    for (const extra of [{ expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { mode: 'strict' }, { ready: true }, { lock: {} }, { sources: [] }]) expect(ProjectDesignRuntimeGenerationTargetsRequestSchema.safeParse({ expectedRevision: 0, targets, ...extra }).success).toBe(false);
    for (const outputs of [[{ sourcePath: '../outside.tsx' }], [targets.outputs[0], targets.outputs[0]], [targets.outputs[0], { ...targets.outputs[0], sourcePath: 'another.tsx' }], Array.from({ length: 501 }, (_, at) => ({ sourcePath: `file${at}.tsx` }))]) expect(ProjectDesignRuntimeGenerationTargetsRequestSchema.safeParse({ expectedRevision: 0, targets: { schemaVersion: 1, outputs } }).success).toBe(false);
    expect(ProjectDesignRuntimeGenerationTargetsResponseSchema.safeParse({ revision: 3, targets, ready: true }).success).toBe(false);
  });
});
