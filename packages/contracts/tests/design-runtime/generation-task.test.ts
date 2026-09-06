import { describe, expect, it } from 'vitest';
import { DesignGenerationTaskProjectionSchema, type DesignGenerationTaskProjection } from '../../src/design-runtime/generation-task.js';
import type { StructuredDesignValidationResult } from '../../src/design-runtime/design-validation.js';

const passingValidation = (): StructuredDesignValidationResult => {
  const ratio = { reused: 0, total: 0, rate: null };
  return { schemaVersion: 1, mode: 'guided', policySource: 'project', diagnostics: [], accepted: true, strictReady: false,
    coverage: { semantic: false, source: true, imports: true, styles: true, bindings: true, conformance: false },
    semanticReuse: ratio, metrics: { componentReuse: ratio, bindingReuse: ratio, unknownComponents: 0, unknownTokens: 0,
      rawColors: 0, rawSpacing: 0, rawRadius: 0, intrinsicControls: 0, duplicateControls: 0, duplicateStructures: 0, unsupported: 0, unresolvedImports: 0 } };
};

const task = (): DesignGenerationTaskProjection => ({ schemaVersion: 1, executionId: 'execution', projectId: 'project', conversationId: 'conversation',
  initialRunId: 'source', activeRunId: 'repair', nextRunId: 'repair', attempt: 1, repairLimit: 1, status: 'repairing', latestReport: {
    schemaVersion: 1, executionId: 'execution', runId: 'source', attempt: 0, mode: 'guided', policyDigest: `sha256:${'a'.repeat(64)}`, projectRevision: 1,
    decision: 'repair_required', reasonCodes: ['DESIGN_GENERATION_VALIDATION_FAILED'], diagnostics: [],
    inventory: { baselineDigest: `sha256:${'b'.repeat(64)}`, sourceDigest: `sha256:${'c'.repeat(64)}`, complete: true, changed: ['index.html'], deleted: [] }, outputs: [], validation: null,
  } });
describe('daemon-issued generation task projection', () => {
  it('keeps the parent report at physical attempt zero while the authorized repair runs at one', () => {
    expect(DesignGenerationTaskProjectionSchema.parse(task())).toMatchObject({ attempt: 1, latestReport: { attempt: 0, runId: 'source' } });
  });
  it('rejects foreign successors, reports, resets and premature success', () => {
    expect(DesignGenerationTaskProjectionSchema.safeParse({ ...task(), nextRunId: 'foreign' }).success).toBe(false);
    expect(DesignGenerationTaskProjectionSchema.safeParse({ ...task(), latestReport: { ...task().latestReport, executionId: 'foreign' } }).success).toBe(false);
    expect(DesignGenerationTaskProjectionSchema.safeParse({ ...task(), attempt: 0 }).success).toBe(false);
    expect(DesignGenerationTaskProjectionSchema.safeParse({ ...task(), status: 'succeeded' }).success).toBe(false);
  });
  it('does not let a predecessor passing report certify repaired delivery', () => {
    const passing = { ...task(), status: 'succeeded', latestReport: { ...task().latestReport!, runId: 'repair', attempt: 1, decision: 'accepted', validation: passingValidation() } };
    expect(DesignGenerationTaskProjectionSchema.safeParse(passing).success).toBe(true);
    for (const overrides of [{ runId: 'source', attempt: 1 }, { runId: 'repair', attempt: 0 }]) {
      expect(DesignGenerationTaskProjectionSchema.safeParse({ ...passing, latestReport: { ...passing.latestReport, ...overrides } }).success).toBe(false);
    }
  });
  it('represents a validated pause for user input without implying delivery or a child', () => {
    for (const decision of ['not_applicable', 'accepted', 'advisory'] as const) {
      const value = { ...task(), nextRunId: null, status: 'awaiting_input', latestReport: { ...task().latestReport!, runId: 'repair', attempt: 1, decision,
        mode: decision === 'advisory' ? 'explore' : 'guided', validation: decision === 'accepted' ? passingValidation() : null } };
      expect(DesignGenerationTaskProjectionSchema.safeParse(value).success).toBe(true);
      expect(DesignGenerationTaskProjectionSchema.safeParse({ ...value, nextRunId: 'repair' }).success).toBe(true);
      expect(DesignGenerationTaskProjectionSchema.safeParse({ ...value, nextRunId: 'unclaimed' }).success).toBe(false);
    }
  });
  it('retains an authorized successor on historical Run lookup after final completion', () => {
    const value = task(); value.status = 'succeeded'; value.latestReport = { ...value.latestReport!, runId: 'repair', attempt: 1, mode: 'explore', decision: 'advisory' };
    expect(DesignGenerationTaskProjectionSchema.parse(value).nextRunId).toBe('repair');
  });
});
