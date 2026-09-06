// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesignGenerationReportCard } from '../../src/components/DesignGenerationReportCard';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { generationReport, generationTask } from '../helpers/design-generation-fixtures';
import { artifactValidationFixture } from '../helpers/design-validation-fixtures';
import { DesignGenerationReportSchema } from '@open-design/contracts';
import { designGenerationAllowsDelivery } from '../../src/runtime/design-generation';
import type { ChatMessage } from '@open-design/contracts';
afterEach(cleanup);

describe('design generation report', () => {
  it('keeps a passing physical report unconfirmed without a logical success projection', () => {
    render(<DesignGenerationReportCard message={{ id: 'message', role: 'assistant', content: '', designGeneration: { ...generationReport('initial', 0, 'advisory'), mode: 'explore' } }} />);
    expect(screen.getByTestId('design-generation-status').dataset.status).toBe('unconfirmed');
    expect(screen.queryByText('Generation completed')).toBeNull();
  });

  it('keeps normal question and planning turns free of validation cards and retains their existing footer', () => {
    const message: ChatMessage = { id: 'question', role: 'assistant', content: 'Which audience should this serve?', runId: 'initial', runStatus: 'succeeded', endedAt: 12345,
      designGenerationTask: generationTask({ status: 'succeeded', latestReport: generationReport() }) };
    const view = render(<AssistantMessage message={message} streaming={false} />);
    expect(screen.queryByTestId('design-generation-report')).toBeNull();
    expect(view.container.querySelector('.assistant-footer')).not.toBeNull();
    const footer = view.container.querySelector('.assistant-footer')!.innerHTML;
    view.rerender(<AssistantMessage message={{ ...message, designGenerationTask: undefined }} streaming={false} />);
    expect(view.container.querySelector('.assistant-footer')!.innerHTML).toBe(footer);
    view.rerender(<AssistantMessage message={{ ...message, runStatus: 'running', designGenerationTask: generationTask() }} streaming />);
    expect(screen.queryByTestId('design-generation-report')).toBeNull();
  });

  it('shows the current repair while preserving the prior physical report and exact evidence', () => {
    const report = generationReport('initial', 0, 'repair_required');
    report.diagnostics = [{ schemaVersion: 1, code: 'ODDS3001', severity: 'error', message: 'Unknown component', location: { sourcePath: 'Screen.tsx', line: 3, column: 5 } }];
    const task = generationTask({ activeRunId: 'repair', nextRunId: 'repair', status: 'repairing', attempt: 1, latestReport: report });
    render(<DesignGenerationReportCard message={{ id: 'message', role: 'assistant', content: '', designGeneration: report, designGenerationTask: task }} />);
    expect(screen.getByTestId('design-generation-status').dataset.status).toBe('repairing');
    expect(screen.getByTestId('design-generation-attempt').dataset.attempt).toBe('1');
    expect(screen.getByTestId('design-generation-diagnostics').textContent).toContain('Screen.tsx:3:5');
    fireEvent.click(screen.getByTestId('design-generation-expand'));
    const evidence = JSON.parse(screen.getByTestId('design-generation-report-json').textContent!);
    expect(evidence.report.attempt).toBe(0);
    expect(evidence.task.attempt).toBe(1);
  });

  it('shows nested source validation diagnostics and deduplicates an issue present in both evidence layers', () => {
    const validation = artifactValidationFixture();
    validation.mode = 'guided'; validation.accepted = false;
    validation.diagnostics[0]!.severity = 'error';
    const report = DesignGenerationReportSchema.parse({ ...generationReport('repair', 1, 'blocked'), validation });
    expect(report.diagnostics).toEqual([]);
    const message: ChatMessage = { id: 'message', role: 'assistant', content: '',
      designGenerationTask: generationTask({ activeRunId: 'repair', nextRunId: 'repair', status: 'blocked', attempt: 1, latestReport: report }) };
    const view = render(<DesignGenerationReportCard message={message} />);
    expect(screen.getByTestId('design-generation-diagnostics').textContent).toContain('ODDS2002');
    expect(screen.getByTestId('design-generation-diagnostics').textContent).toContain('screen.html:3:4');
    expect(screen.getByTestId('design-generation-diagnostics').querySelector('[data-severity="error"]')).not.toBeNull();
    report.diagnostics = structuredClone(validation.diagnostics);
    view.rerender(<DesignGenerationReportCard message={message} />);
    expect(screen.getByTestId('design-generation-diagnostics').querySelectorAll('li')).toHaveLength(1);
  });

  it('hides an inapplicable waiting card and labels validated planning edits as needing input without delivery', () => {
    const report = generationReport('initial', 0);
    const message: ChatMessage = { id: 'waiting', role: 'assistant', content: 'Which layout?',
      designGenerationTask: generationTask({ status: 'awaiting_input', latestReport: report }) };
    const view = render(<DesignGenerationReportCard message={message} />);
    expect(screen.queryByTestId('design-generation-report')).toBeNull();
    const validated = DesignGenerationReportSchema.parse({ ...report, decision: 'accepted',
      validation: { ...artifactValidationFixture(), mode: 'guided', diagnostics: [], accepted: true } });
    message.designGenerationTask!.latestReport = validated;
    view.rerender(<DesignGenerationReportCard message={message} />);
    expect(screen.getByTestId('design-generation-status').dataset.status).toBe('awaiting_input');
    expect(screen.getByTestId('design-generation-status').textContent).toBe('Needs input');
    expect(designGenerationAllowsDelivery(message)).toBe(false);
  });

  it.each(['blocked', 'repairing'] as const)('suppresses successful delivery affordances for %s even with stale physical success', status => {
    const report = generationReport('initial', 0, status === 'blocked' ? 'blocked' : 'repair_required');
    const message: ChatMessage = { id: 'message', role: 'assistant', content: 'Created the screen.', runStatus: 'succeeded', endedAt: 12345,
      designGenerationTask: generationTask({ status, attempt: 1, activeRunId: 'repair', latestReport: report }),
      producedFiles: [{ name: 'screen.html', size: 10, mtime: 1, kind: 'html', mime: 'text/html' }] };
    const { container } = render(<AssistantMessage message={message} streaming={false} projectId="project" conversationId="conversation" isLast
      onShareToOpenDesign={vi.fn()} onFeedback={vi.fn()} onNextStepCreateDesignSystem={vi.fn()} />);
    expect(screen.getByTestId('design-generation-status').dataset.status).toBe(status);
    expect(container.querySelector('.next-step-actions')).toBeNull();
    expect(screen.queryByText('Generation completed')).toBeNull();
  });
});
