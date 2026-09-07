import type { ChatMessage } from '@open-design/contracts';
import { isRetryableAssistantTerminalFailure } from './design-delivery';
import { logicalMessagePosition } from './design-generation';

export interface LogicalAssistantTurn {
  head: ChatMessage;
  messages: ChatMessage[];
}

/** The same immutable physical lineage determines folding and error ownership. */
export function logicalAssistantTurns(messages: ChatMessage[]) {
  const turns: LogicalAssistantTurn[] = [];
  const byMessageId = new Map<string, LogicalAssistantTurn>();
  const activeByTask = new Map<string, LogicalAssistantTurn>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const position = logicalMessagePosition(message);
    let turn = position && position.index > 0 ? activeByTask.get(position.id) : undefined;
    if (!turn) {
      turn = { head: message, messages: [] };
      turns.push(turn);
      if (position) activeByTask.set(position.id, turn);
    }
    turn.messages.push(message);
    byMessageId.set(message.id, turn);
  }
  return { turns, byMessageId };
}

/** Keep the displayed head stable while diagnostics identify the actual Run. */
export function physicalTurnMessage(turn: LogicalAssistantTurn): ChatMessage {
  const latest = turn.messages[turn.messages.length - 1]!;
  const task = latest.designGenerationTask;
  if (task) {
    for (let index = turn.messages.length - 1; index >= 0; index--) {
      const candidate = turn.messages[index]!;
      if (candidate.runId === task.activeRunId && candidate.designGenerationExecutionId === task.executionId) return candidate;
    }
  }
  return latest;
}

export function lastAssistantRunError(message: ChatMessage | null | undefined) {
  const events = message?.events ?? [];
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind === 'status' && event.label === 'error') return event;
  }
  return null;
}

function ownsRunError(source: ChatMessage, turn: LogicalAssistantTurn, error: string): boolean {
  const current = physicalTurnMessage(turn);
  return lastAssistantRunError(source)?.detail?.trim() === error.trim()
    || isRetryableAssistantTerminalFailure(source)
    || isRetryableAssistantTerminalFailure(current)
    || source.designGeneration?.decision === 'blocked'
    || source.designGeneration?.decision === 'repair_required'
    || current.designGenerationTask?.status === 'blocked';
}

function turnDelivered(turn: LogicalAssistantTurn): boolean {
  const current = physicalTurnMessage(turn);
  if (isRetryableAssistantTerminalFailure(current)) return false;
  // An accepted stage report or successful predecessor process cannot settle
  // a Full Plan/repair task. The daemon's logical outcome remains authoritative.
  if (current.designGenerationTask) return current.designGenerationTask.status === 'succeeded';
  if (turn.head.strategyTaskExecutionId) return current.strategyTaskDelivered === true && current.runStatus === 'succeeded';
  return current.runStatus === 'succeeded';
}

/** Unknown or unproved owners remain pane errors; never classify by copy alone. */
export function resolveRunErrorOwnership(
  messages: ChatMessage[], error: string | null, sourceAssistantId: string | null | undefined,
) {
  if (!error?.trim() || !sourceAssistantId) return null;
  const { turns, byMessageId } = logicalAssistantTurns(messages);
  const turn = byMessageId.get(sourceAssistantId);
  const source = turn?.messages.find(message => message.id === sourceAssistantId);
  if (!turn || !source || !ownsRunError(source, turn, error)) return null;
  const physicalSource = physicalTurnMessage(turn);
  const successorHasOwnError = physicalSource.id !== source.id
    && Boolean(lastAssistantRunError(physicalSource)?.detail?.trim());
  const laterTurnStarted = turns.slice(turns.indexOf(turn) + 1).some(later => {
    const current = physicalTurnMessage(later);
    return Boolean(current.designGenerationTask || current.runStatus);
  });
  return {
    source,
    physicalSource,
    turnHeadId: turn.head.id,
    // Starting a different request moves the old failure into history; this
    // says nothing about the newer request's success, validation or delivery.
    // Within one chain, a later physical failure also supersedes its
    // predecessor's copy. Its own persisted diagnostic stays current.
    historical: laterTurnStarted || turnDelivered(turn) || successorHasOwnError,
  };
}
