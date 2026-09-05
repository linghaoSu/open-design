import { defaultDesignGenerationTargets, defaultProjectDesignValidationSettings, type DesignGenerationExecution, type DesignGenerationReport } from '@open-design/contracts';
import { generationDigest } from '../../../src/services/design-runtime/generation-inventory.js';

export function generationExecutionFixture(): DesignGenerationExecution {
  const digest = generationDigest('fixture');
  return { schemaVersion: 1, id: 'execution', projectId: 'project', conversationId: 'conversation', authorityKey: digest,
    initialRunId: 'run-first', latestRunId: 'run-first', attempt: 0, revision: 0, status: 'active', report: null,
    policy: { schemaVersion: 1, mode: 'strict', source: 'project', constraints: defaultProjectDesignValidationSettings().projectConstraints,
      dependencies: { schemaVersion: 1, id: 'project', dependencies: [] }, lock: { schemaVersion: 1, id: 'project', dependencies: [] }, digest },
    targets: defaultDesignGenerationTargets(), baselineStatus: 'ready', baseline: { schemaVersion: 1, digest, complete: true, files: [], diagnostics: [] }, semanticDigest: digest,
  };
}
export function generationReportFixture(execution = generationExecutionFixture()): DesignGenerationReport {
  return { schemaVersion: 1, executionId: execution.id, runId: execution.latestRunId, attempt: execution.attempt,
    mode: execution.policy.mode, policyDigest: execution.policy.digest, projectRevision: 0, decision: 'blocked', reasonCodes: ['DESIGN_GENERATION_INCOMPLETE'], diagnostics: [],
    inventory: { baselineDigest: execution.baseline.digest, sourceDigest: generationDigest('after'), complete: true, changed: [], deleted: [] }, outputs: [], validation: null };
}
