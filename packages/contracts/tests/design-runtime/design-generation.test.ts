import { describe, expect, it } from 'vitest';
import { DesignGenerationInventorySchema, DesignGenerationReportSchema, DesignGenerationTargetsSchema } from '../../src/design-runtime/design-generation.js';

const digest = `sha256:${'a'.repeat(64)}`;
const report = () => ({ schemaVersion: 1, executionId: 'execution', runId: 'run', attempt: 0, mode: 'strict', policyDigest: digest,
  projectRevision: 0, decision: 'blocked', reasonCodes: ['missing_source'], diagnostics: [],
  inventory: { baselineDigest: digest, sourceDigest: digest, complete: true, changed: [], deleted: [] }, outputs: [], validation: null });
describe('host generation authority contracts', () => {
  it('accepts authoring targets without treating paths as existing files or accepting source bytes', () => {
    const value = { schemaVersion: 1, outputs: [{ sourcePath: 'future/Screen.tsx', exportName: 'Screen', screenId: 'future-screen' }] };
    expect(DesignGenerationTargetsSchema.parse(value)).toEqual(value);
    expect(DesignGenerationTargetsSchema.safeParse({ ...value, outputs: [{ ...value.outputs[0], sourceText: 'claimed' }] }).success).toBe(false);
    expect(DesignGenerationTargetsSchema.safeParse({ ...value, outputs: [...value.outputs, { ...value.outputs[0], sourcePath: 'other.tsx' }] }).success).toBe(false);
  });
  it('cannot certify incomplete inventories or unvalidated successful delivery', () => {
    expect(DesignGenerationInventorySchema.safeParse({ schemaVersion: 1, digest, complete: true, diagnostics: [], files: [{ path: 'Screen.vue', digest: null, size: 1, language: 'vue' }] }).success).toBe(false);
    expect(DesignGenerationReportSchema.parse(report()).decision).toBe('blocked');
    expect(DesignGenerationReportSchema.safeParse({ ...report(), decision: 'accepted' }).success).toBe(false);
  });
  it('reserves advisory delivery for Explore and bounds design repairs to one', () => {
    expect(DesignGenerationReportSchema.safeParse({ ...report(), decision: 'advisory' }).success).toBe(false);
    expect(DesignGenerationReportSchema.safeParse({ ...report(), decision: 'advisory', mode: 'explore' }).success).toBe(true);
    expect(DesignGenerationReportSchema.safeParse({ ...report(), decision: 'repair_required', attempt: 1 }).success).toBe(false);
  });
});
