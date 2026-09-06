import {
  DesignGenerationReportSchema,
  DesignGenerationTaskProjectionSchema,
  type ChatMessage,
  type ChatRunStatus,
  type ChatRunStatusResponse,
  type DesignGenerationReport,
  type DesignGenerationTaskProjection,
  type StrategyTaskProjectionV2,
} from '@open-design/contracts';

export class DesignGenerationProtocolError extends Error {}

export interface DesignGenerationUpdate {
  task?: DesignGenerationTaskProjection;
  report?: DesignGenerationReport;
}

/** Validate daemon facts at the stream/recovery boundary before using run IDs. */
export function readDesignGenerationUpdate(input: {
  task?: unknown; report?: unknown; runId: string;
  projectId?: string | null; conversationId?: string | null;
  previousTask?: DesignGenerationTaskProjection; authoritative?: boolean;
}): DesignGenerationUpdate {
  const parsedTask = input.task === undefined ? undefined : DesignGenerationTaskProjectionSchema.safeParse(input.task);
  const parsedReport = input.report === undefined ? undefined : DesignGenerationReportSchema.safeParse(input.report);
  if (parsedTask && !parsedTask.success || parsedReport && !parsedReport.success) throw new DesignGenerationProtocolError('The daemon returned an invalid design generation report or task.');
  const task = parsedTask?.success ? parsedTask.data : undefined;
  const report = parsedReport?.success ? parsedReport.data : undefined;
  if (task) {
    if (task.projectId !== input.projectId || task.conversationId !== (input.conversationId ?? null)) {
      throw new DesignGenerationProtocolError('Design generation task does not belong to this project and conversation.');
    }
    const previous = input.previousTask;
    if (previous && (task.executionId !== previous.executionId || task.initialRunId !== previous.initialRunId
      || input.authoritative !== false && task.attempt < previous.attempt)) {
      throw new DesignGenerationProtocolError('Design generation task identity or repair attempt changed unexpectedly.');
    }
  }
  if (report && (report.runId !== input.runId
    || (task ?? input.previousTask) && report.executionId !== (task ?? input.previousTask)!.executionId)) {
    throw new DesignGenerationProtocolError('Design generation report does not belong to this physical Run.');
  }
  return { ...(task ? { task } : {}), ...(report ? { report } : {}) };
}

/** Only an end/status projection authorizes following; diagnostic frames do not. */
export function designGenerationSuccessor(task: DesignGenerationTaskProjection, runId: string, strategy?: StrategyTaskProjectionV2): string | undefined {
  if (task.activeRunId !== runId && task.nextRunId !== task.activeRunId) throw new DesignGenerationProtocolError('Design generation omitted its authorized successor.');
  const successor = task.nextRunId ?? undefined;
  if (successor === runId) throw new DesignGenerationProtocolError('Design generation task returned the current Run as its successor.');
  if (strategy) {
    if (strategy.activeRunId !== task.activeRunId || (strategy.nextRunId ?? null) !== task.nextRunId) {
      throw new DesignGenerationProtocolError('Design generation and strategy task successors disagree.');
    }
  }
  if (task.status === 'awaiting_input' && (!strategy || strategy.terminal !== false || strategy.outcome !== 'clarification_required')) {
    throw new DesignGenerationProtocolError('Waiting for input requires the matching strategy clarification state.');
  }
  return successor;
}

export function designGenerationRunStatus(task: DesignGenerationTaskProjection): ChatRunStatus {
  return task.status === 'blocked' ? 'failed'
    : task.status === 'canceled' ? 'canceled'
      : task.status === 'succeeded' || task.status === 'awaiting_input' ? 'succeeded' : 'running';
}

export function readDesignGenerationRunStatus(status: ChatRunStatusResponse | null, runId: string, scope: {
  projectId?: string | null; conversationId?: string | null; previousTask?: DesignGenerationTaskProjection;
}): DesignGenerationUpdate & { task: DesignGenerationTaskProjection } {
  if (!status || status.id !== runId || status.projectId !== scope.projectId || status.conversationId !== (scope.conversationId ?? null)) {
    throw new DesignGenerationProtocolError('Design generation Run identity or scope could not be authenticated.');
  }
  if (!status.designGenerationTask) throw new DesignGenerationProtocolError('The daemon omitted the logical design generation outcome.');
  const update = readDesignGenerationUpdate({ ...scope, runId, task: status.designGenerationTask, report: status.designGeneration });
  designGenerationSuccessor(update.task!, runId, status.strategyTask);
  if (update.task!.status === 'awaiting_input' && update.task!.activeRunId === runId && status.status !== 'succeeded') {
    throw new DesignGenerationProtocolError('Waiting for input requires a successfully completed physical clarification Run.');
  }
  return { ...update, task: update.task! };
}

export function designGenerationMessageFields(message: ChatMessage, update: DesignGenerationUpdate): Partial<ChatMessage> {
  const { task, report } = update;
  return {
    ...(task ? { designGenerationTask: task } : {}),
    ...(report ? { designGeneration: report } : {}),
    ...(!message.designGenerationExecutionId && (task || report)
      ? { designGenerationExecutionId: (task ?? report)!.executionId } : {}),
    ...(message.designGenerationAttempt === undefined && (report || task)
      ? { designGenerationAttempt: report?.attempt ?? (task!.initialRunId === message.runId ? 0 : task!.attempt) } : {}),
  };
}

/** Persisted physical identity, never analytics lineage or mutable task attempt. */
export function logicalMessagePosition(message: ChatMessage): { id: string; index: number } | null {
  if (message.strategyTaskExecutionId) return { id: `strategy:${message.strategyTaskExecutionId}`, index: message.strategyTaskRunIndex ?? 0 };
  if (message.designGenerationExecutionId && message.designGenerationAttempt !== undefined) {
    return { id: `generation:${message.designGenerationExecutionId}`, index: message.designGenerationAttempt };
  }
  return null;
}

export function designGenerationAllowsDelivery(message: Pick<ChatMessage, 'designGenerationTask' | 'designGeneration'>): boolean {
  if (message.designGenerationTask) return message.designGenerationTask.status === 'succeeded';
  return !message.designGeneration || ['accepted', 'advisory', 'not_applicable'].includes(message.designGeneration.decision);
}

export function applicableDesignGenerationReport(message: Pick<ChatMessage, 'designGenerationTask' | 'designGeneration'>): DesignGenerationReport | null {
  const report = message.designGenerationTask?.latestReport ?? message.designGeneration;
  return report && report.decision !== 'not_applicable' ? report : null;
}
