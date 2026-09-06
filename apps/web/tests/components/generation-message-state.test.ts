import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@open-design/contracts';
import { foldStrategyTaskTurns } from '../../src/components/ChatPane';
import { mergeServerMessagesIntoConversation } from '../../src/components/ProjectView';
import { designGenerationMessageFields, logicalMessagePosition } from '../../src/runtime/design-generation';
import { generationReport, generationTask } from '../helpers/design-generation-fixtures';

const initial = (): ChatMessage => ({ id: 'first', role: 'assistant', runId: 'initial', content: 'Initial output.',
  designGenerationExecutionId: 'execution', designGenerationAttempt: 0, designGeneration: generationReport('initial', 0, 'repair_required') });
const repair = (): ChatMessage => ({ id: 'second', role: 'assistant', runId: 'repair', content: 'Repaired output.', runStatus: 'succeeded',
  designGenerationExecutionId: 'execution', designGenerationAttempt: 1, designGeneration: generationReport('repair', 1),
  designGenerationTask: generationTask({ activeRunId: 'repair', attempt: 1, status: 'succeeded', latestReport: generationReport('repair', 1) }) });

describe('generation message state', () => {
  it('folds legacy repair rows once after authoritative reload replaces cumulative live content', () => {
    const live: ChatMessage = { ...initial(), runId: 'repair', content: 'Initial output.Repaired output.' };
    const merged = mergeServerMessagesIntoConversation([live], [initial(), repair()]);
    const folded = foldStrategyTaskTurns(merged);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.content).toBe('Initial output.\n\nRepaired output.');
    expect(folded[0]!.runId).toBe('repair');
    expect(folded[0]!.designGeneration?.runId).toBe('repair');
    expect(folded[0]!.designGenerationTask?.status).toBe('succeeded');
  });

  it('retains all Full Plan stages even though their generation attempts are both zero', () => {
    const messages: ChatMessage[] = [
      { ...initial(), content: 'Plan.', strategyTaskExecutionId: 'strategy', strategyTaskRunIndex: 0 },
      { ...initial(), id: 'stage', runId: 'production', content: 'Production.', strategyTaskExecutionId: 'strategy', strategyTaskRunIndex: 1 },
      { ...repair(), strategyTaskExecutionId: 'strategy', strategyTaskRunIndex: 2 },
    ];
    expect(foldStrategyTaskTurns(messages)[0]!.content).toBe('Plan.\n\nProduction.\n\nRepaired output.');
    expect(logicalMessagePosition(messages[1]!)).toEqual({ id: 'strategy:strategy', index: 1 });
  });

  it('uses immutable physical attempt when a parent row carries the current repair projection', () => {
    const row = { ...initial(), designGenerationTask: repair().designGenerationTask };
    expect(logicalMessagePosition(row)).toEqual({ id: 'generation:execution', index: 0 });
    expect(designGenerationMessageFields(row, { task: generationTask({ attempt: 1 }) })).not.toHaveProperty('designGenerationAttempt');
  });

  it('preserves distinct requests and projects the final blocked verdict over physical success', () => {
    const blocked = { ...repair(), designGenerationTask: generationTask({ activeRunId: 'repair', attempt: 1, status: 'blocked', latestReport: generationReport('repair', 1, 'blocked') }) };
    const other: ChatMessage = { ...initial(), id: 'other', designGenerationExecutionId: 'other', content: 'Other request.' };
    const folded = foldStrategyTaskTurns([initial(), blocked, { id: 'user', role: 'user', content: 'Another request' }, other]);
    expect(folded).toHaveLength(3);
    expect(folded[0]!.runStatus).toBe('failed');
    expect(folded[2]!.content).toBe('Other request.');
  });
});
