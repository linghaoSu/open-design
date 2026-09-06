import type { DesignGenerationReport, DesignGenerationTaskProjection, StrategyTaskProjectionV2 } from '@open-design/contracts';

export function generationReport(runId = 'initial', attempt: 0 | 1 = 0, decision: DesignGenerationReport['decision'] = 'not_applicable'): DesignGenerationReport {
  return { schemaVersion: 1, executionId: 'execution', runId, attempt, mode: 'guided', policyDigest: 'sha256:' + 'a'.repeat(64),
    projectRevision: 3, decision, reasonCodes: [], diagnostics: [],
    inventory: { baselineDigest: 'sha256:' + 'b'.repeat(64), sourceDigest: 'sha256:' + 'c'.repeat(64), complete: true, changed: ['Screen.tsx'], deleted: [] },
    outputs: [{ sourcePath: 'Screen.tsx', exportName: 'Screen', screenId: 'main' }], validation: null };
}
export function generationTask(overrides: Partial<DesignGenerationTaskProjection> = {}): DesignGenerationTaskProjection {
  return { schemaVersion: 1, executionId: 'execution', projectId: 'project', conversationId: 'conversation',
    initialRunId: 'initial', activeRunId: 'initial', nextRunId: null, attempt: 0, repairLimit: 1,
    status: 'running', latestReport: null, ...overrides };
}
export function generationStrategy(activeRunId: string, nextRunId?: string): StrategyTaskProjectionV2 {
  return { taskExecutionId: 'strategy', strategy: { id: 'od-next-strategy', version: '1', packageHash: 'd'.repeat(64), snapshotId: 'snapshot' },
    inputStage: 'production', outcome: 'running', route: 'full_plan', executionMode: 'complex', activeRunId, terminal: false,
    ...(nextRunId ? { nextRunId } : {}) } as StrategyTaskProjectionV2;
}
