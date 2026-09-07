import { describe, expect, it } from 'vitest';
import type { ChatMessage, ProjectFile } from '@open-design/contracts';
import { DesignGenerationReportSchema, DesignGenerationTaskProjectionSchema } from '@open-design/contracts';

import { foldStrategyTaskTurns } from '../../src/components/ChatPane';
import { designGenerationAllowsDelivery } from '../../src/runtime/design-generation';
import { generationReport, generationTask } from '../helpers/design-generation-fixtures';

function assistant(over: Record<string, unknown>): ChatMessage {
  return {
    id: 'm', role: 'assistant', content: '', ...over,
  } as ChatMessage;
}

describe('foldStrategyTaskTurns', () => {
  it('renders one turn for a Full Plan task without duplicating its output', () => {
    const folded = foldStrategyTaskTurns([
      { id: 'u1', role: 'user', content: '做一个原型' } as ChatMessage,
      assistant({
        id: 'a-plan',
        content: 'PLAN_TEXT',
        runId: 'run-request',
        runStatus: 'succeeded',
        events: [{ kind: 'status', label: 'planning' }],
        producedFiles: [{ name: 'plan.md' } as ProjectFile],
        strategyTaskExecutionId: 'odnext_1',
        strategyTaskRunIndex: 0,
      }),
      assistant({
        id: 'a-production',
        content: 'PRODUCTION_TEXT',
        runId: 'run-production',
        runStatus: 'running',
        events: [{ kind: 'status', label: 'building' }],
        producedFiles: [{ name: 'index.html' } as ProjectFile],
        strategyTaskExecutionId: 'odnext_1',
        strategyTaskRunIndex: 1,
      }),
    ]);

    // One user turn, one assistant turn.
    expect(folded.filter((m) => m.role === 'assistant')).toHaveLength(1);
    const turn = folded.find((m) => m.role === 'assistant')!;

    // Both halves are present exactly once — the regression that shipped
    // before was the production half rendering twice.
    expect(turn.content.split('PRODUCTION_TEXT')).toHaveLength(2);
    expect(turn.content.split('PLAN_TEXT')).toHaveLength(2);
    expect(turn.content.indexOf('PLAN_TEXT')).toBeLessThan(turn.content.indexOf('PRODUCTION_TEXT'));

    // Events and files accumulate without loss or repetition.
    expect(turn.events).toHaveLength(2);
    expect(turn.producedFiles?.map((f) => f.name)).toEqual(['plan.md', 'index.html']);

    // The turn tracks the latest Run: an intermediate Run finishing is not the
    // turn finishing.
    expect(turn.runId).toBe('run-production');
    expect(turn.runStatus).toBe('running');
  });

  it('leaves Direct Edit and ordinary turns untouched', () => {
    const input = [
      assistant({
        id: 'a-direct', content: 'ONE_SHOT', runId: 'r1',
        strategyTaskExecutionId: 'odnext_2', strategyTaskRunIndex: 0,
      }),
      assistant({ id: 'a-plain', content: 'ORDINARY', runId: 'r2' }),
    ];
    expect(foldStrategyTaskTurns(input)).toEqual(input);
  });

  it('keeps a question form and its answer as two turns', () => {
    // `buildRecoveryTaskAnalytics` deliberately carries the asking turn's
    // `taskExecutionId` onto the answer (analytics lineage spans retries,
    // resumes and clarifications), so an off-mode chain looks like one task in
    // analytics while being two things the user asked for. Folding on that
    // lineage would merge a form with the work its answer requested — the
    // "must not wrongly merge different follow-up requests" case. Only the
    // daemon-issued `strategyTaskRunIndex`, which off-mode never emits above
    // 0, marks a continuation that carries no prompt of its own.
    const input = [
      { id: 'u1', role: 'user', content: '生成一个旅游app原型' } as ChatMessage,
      assistant({
        id: 'a-brief',
        content: 'BRIEF_FORM',
        runId: 'run-1',
        taskAnalytics: { taskExecutionId: 'u1', taskRunIndex: 0 },
      }),
      { id: 'u2', role: 'user', content: '- 受众: 设计师' } as ChatMessage,
      assistant({
        id: 'a-answer',
        content: 'ANSWER_WORK',
        runId: 'run-2',
        taskAnalytics: {
          taskExecutionId: 'u1',
          taskRunIndex: 1,
          recoveryActionType: 'question_answer',
        },
      }),
    ];
    expect(foldStrategyTaskTurns(input)).toEqual(input);
  });

  it('keeps separate tasks as separate turns', () => {
    const folded = foldStrategyTaskTurns([
      assistant({ id: 'a1', content: 'T1_PLAN', strategyTaskExecutionId: 'odnext_a', strategyTaskRunIndex: 0 }),
      assistant({ id: 'a2', content: 'T1_PROD', strategyTaskExecutionId: 'odnext_a', strategyTaskRunIndex: 1 }),
      { id: 'u2', role: 'user', content: '再改一处' } as ChatMessage,
      assistant({ id: 'a3', content: 'T2_PLAN', strategyTaskExecutionId: 'odnext_b', strategyTaskRunIndex: 0 }),
      assistant({ id: 'a4', content: 'T2_PROD', strategyTaskExecutionId: 'odnext_b', strategyTaskRunIndex: 1 }),
    ]);
    const assistants = folded.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.content).toContain('T1_PROD');
    expect(assistants[1]!.content).toContain('T2_PROD');
    expect(assistants[0]!.content).not.toContain('T2_');
  });
});

describe('foldStrategyTaskTurns settlement', () => {
  it('keeps the failed repair report and prior events on its historical turn after another request succeeds', () => {
    const report = DesignGenerationReportSchema.parse({ ...generationReport('repair', 1, 'blocked'),
      diagnostics: [{ schemaVersion: 1, code: 'ODDS2002', severity: 'error', message: 'Use the saved color token.', location: { sourcePath: 'Page.tsx', line: 7, column: 3 } }],
    });
    const task = DesignGenerationTaskProjectionSchema.parse(generationTask({ activeRunId: 'repair', status: 'blocked', attempt: 1, latestReport: report }));
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Create the page.' },
      assistant({ id: 'initial-message', runId: 'initial', runStatus: 'succeeded', content: 'Initial output.',
        designGenerationExecutionId: 'execution', designGenerationAttempt: 0,
        events: [{ kind: 'status', label: 'thinking', detail: 'Initial source analysis.' }],
        designGeneration: generationReport('initial', 0, 'repair_required'), designGenerationTask: { ...task, nextRunId: 'repair' },
      }),
      assistant({ id: 'repair-message', runId: 'repair', runStatus: 'failed', content: 'Repair output.',
        designGenerationExecutionId: 'execution', designGenerationAttempt: 1,
        events: [{ kind: 'status', label: 'thinking', detail: 'Repair source analysis.' }],
        designGeneration: report, designGenerationTask: task,
      }),
      { id: 'u2', role: 'user', content: 'Make a new version.' },
      assistant({ id: 'new-message', runId: 'new-run', runStatus: 'succeeded', content: 'New version completed.' }),
    ];
    const original = structuredClone(messages);
    const folded = foldStrategyTaskTurns(messages);
    const historical = folded[1]!;

    expect(folded.map(message => message.id)).toEqual(['u1', 'initial-message', 'u2', 'new-message']);
    expect(historical.content).toBe('Initial output.\n\nRepair output.');
    expect(historical.events).toEqual([...messages[1]!.events!, ...messages[2]!.events!]);
    expect(historical.designGeneration).toEqual(report);
    expect(historical.designGenerationTask?.status).toBe('blocked');
    expect(historical.runStatus).toBe('failed');
    expect(designGenerationAllowsDelivery(historical)).toBe(false);
    expect(folded[3]).toEqual(messages[4]);
    expect(messages).toEqual(original);
  });

  it.each(['full-plan', 'repair'] as const)('does not announce delivery when a %s predecessor physically succeeds', (stage) => {
    const runId = stage === 'repair' ? 'production' : 'planning';
    const activeRunId = stage === 'repair' ? 'repair' : 'production';
    const report = generationReport(runId, 0, stage === 'repair' ? 'repair_required' : 'not_applicable');
    const task = DesignGenerationTaskProjectionSchema.parse(generationTask({ activeRunId, nextRunId: activeRunId,
      status: stage === 'repair' ? 'repairing' : 'running', attempt: stage === 'repair' ? 1 : 0, latestReport: report,
    }));
    const folded = foldStrategyTaskTurns([
      assistant({ id: 'first-message', runId: 'initial', runStatus: 'succeeded', content: 'Request complete.',
        strategyTaskExecutionId: 'strategy', strategyTaskRunIndex: 0, designGenerationExecutionId: 'execution', designGenerationAttempt: 0,
      }),
      assistant({ id: 'stage-message', runId, runStatus: 'succeeded', content: 'Physical stage complete.',
        strategyTaskExecutionId: 'strategy', strategyTaskRunIndex: 1, designGenerationExecutionId: 'execution', designGenerationAttempt: 0,
        designGeneration: report, designGenerationTask: task,
      }),
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0]!.id).toBe('first-message');
    expect(folded[0]!.runStatus).toBe('running');
    expect(folded[0]!.strategyTaskDelivered).toBeUndefined();
    expect(folded[0]!.designGenerationTask?.activeRunId).toBe(activeRunId);
    expect(designGenerationAllowsDelivery(folded[0]!)).toBe(false);
  });

  it('carries the final Run\'s delivered verdict onto the folded turn', () => {
    // Only the production Run settles the task, but the pinned todo card reads
    // the folded turn — so without this the card keeps offering "continue" on
    // work the daemon already verified as delivered.
    const folded = foldStrategyTaskTurns([
      assistant({
        id: 'a-plan',
        content: 'PLAN',
        strategyTaskExecutionId: 'odnext_1',
        strategyTaskRunIndex: 0,
      }),
      assistant({
        id: 'a-production',
        content: 'BUILT',
        strategyTaskExecutionId: 'odnext_1',
        strategyTaskRunIndex: 1,
        strategyTaskDelivered: true,
      }),
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0]!.strategyTaskDelivered).toBe(true);
  });

  it('leaves the turn unsettled while the task is still running', () => {
    const folded = foldStrategyTaskTurns([
      assistant({
        id: 'a-plan',
        content: 'PLAN',
        strategyTaskExecutionId: 'odnext_1',
        strategyTaskRunIndex: 0,
      }),
      assistant({
        id: 'a-production',
        content: 'BUILDING',
        strategyTaskExecutionId: 'odnext_1',
        strategyTaskRunIndex: 1,
      }),
    ]);

    expect(folded[0]!.strategyTaskDelivered).toBeUndefined();
  });
});
