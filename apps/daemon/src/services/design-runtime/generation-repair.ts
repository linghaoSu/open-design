import { composeOdNextStrategyContinuationV2, type DesignRepairTurnV1 } from '@open-design/contracts';
import type Database from 'better-sqlite3';
import type { InternalRunCreateInput, InternalPhysicalRun, InternalRunCreationService } from '../internal-run-service.js';
import type { createDesignGenerationService, DesignGenerationAuthority } from './generation-execution.js';
import { finalizeStrategyPlanningResult } from '../../strategies/od-next/coordinator.js';
import type { StrategyTaskExecutionRecord } from '../../strategies/task-store.js';
import type { OdNextMachineProtocolStream } from '../../strategies/od-next/protocol.js';
import type { OdNextExecutionPreflightInput } from '../../strategies/od-next/resolver.js';
import { evaluateOdNextComplexProduction, type OdNextComplexRuntimeEvidence } from '../../strategies/od-next/complex-production.js';
import { createOdNextNativeBuildPackageBindings } from '../../strategies/od-next/native-build-package.js';

/** One existing physical-Run claim transaction owns both logical mappings. */
export function prepareDesignGenerationRepair<TMeta extends InternalRunCreateInput, TRun extends InternalPhysicalRun>(input: {
  db: Database.Database; runs: InternalRunCreationService<TMeta, TRun>; generation: ReturnType<typeof createDesignGenerationService>;
  sourceContext?: DesignRepairTurnV1['context'];
  sourceRunId: string; authority: DesignGenerationAuthority; canceled(): boolean; createMeta(text: string): TMeta;
  strategy?: { task: StrategyTaskExecutionRecord; parsed: ReturnType<OdNextMachineProtocolStream['finish']>; toolUseCount: number;
    deliverableValid: boolean; executionPreflight?: OdNextExecutionPreflightInput; complexRuntimeEvidence?: OdNextComplexRuntimeEvidence };
}) {
  if (input.canceled()) throw new Error('Generation repair was canceled before claim.');
  const task = input.strategy?.task;
  const bindings = task?.executionMode === 'complex' && task.selectedAgentId === 'claude' && task.planContract && task.planContractHash
    ? createOdNextNativeBuildPackageBindings({ taskExecutionId: task.taskExecutionId, taskRunIndex: task.runs.length, plan: task.planContract, planContractHash: task.planContractHash }) : [];
  const { execution, text } = input.generation.repairText(input.sourceRunId, input.authority, task ? {
    taskExecutionId: task.taskExecutionId, inputStage: task.inputStage, taskRunIndex: task.runs.length, planContractHash: task.planContractHash ?? null,
    frozenInputIdentity: task.frozenInputIdentity, productionContinuation: task.inputStage === 'production' ? composeOdNextStrategyContinuationV2({ stage: 'production', nativeSessionResume: true,
      taskExecutionId: task.taskExecutionId, taskRunIndex: task.runs.length, planContractHash: task.planContractHash!, ...(bindings.length ? { nativeBuildPackageBindings: bindings } : {}) }) : null,
  } : null, input.sourceContext ?? null);
  let strategyTask: StrategyTaskExecutionRecord | undefined;
  const meta = input.createMeta(text);
  if (meta.projectId !== execution.projectId || meta.conversationId !== execution.conversationId || !meta.conversationId || !meta.assistantMessageId || !meta.clientRequestId) throw new Error('Repair requires the original scoped conversation and a new assistant claim identity.');
  const prepared = input.runs.prepare({ meta, beforeClaimCommit: (child) => {
    if (input.canceled()) throw new Error('Generation repair was canceled before atomic claim.');
    if (input.strategy) {
      const { task, parsed, complexRuntimeEvidence } = input.strategy;
      const complexReasons = task.executionMode === 'complex' && task.planContract ? evaluateOdNextComplexProduction({ plan: task.planContract,
        selectedAgentId: task.selectedAgentId, taskExecutionId: task.taskExecutionId, runId: task.latestRunId, taskRunIndex: task.runs.length - 1,
        ...(complexRuntimeEvidence ? { evidence: complexRuntimeEvidence } : {}) }).reasonCodes : [];
      const transitioned = finalizeStrategyPlanningResult(input.db, { taskExecutionId: task.taskExecutionId, runId: input.sourceRunId, parsed,
        designRepairRun: { sourceRunId: input.sourceRunId, runId: child.id, finalText: text }, toolUseCount: input.strategy.toolUseCount,
        completionEvidence: { physicalStatus: 'succeeded', deliverableValid: input.strategy.deliverableValid },
        ...(input.strategy.executionPreflight ? { executionPreflight: input.strategy.executionPreflight } : {}), productionEnforcementReasonCodes: complexReasons });
      if (transitioned.action !== 'design_repair') throw new Error(`OD Next production proof rejected host repair: ${transitioned.reasonCodes.join(', ')}`);
      strategyTask = transitioned.task;
    }
    input.generation.claimRepair(input.sourceRunId, child.id, input.authority, execution.revision, text);
  } });
  if (prepared.kind !== 'ready') throw new Error(`The authorized repair Run was not newly claimed (${prepared.kind}).`);
  return { prepared, text, strategyTask };
}
