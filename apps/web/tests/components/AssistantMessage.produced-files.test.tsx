// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ProjectFile } from '@open-design/contracts';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import { foldStrategyTaskTurns } from '../../src/components/ChatPane';
import { deriveFileOps } from '../../src/runtime/file-ops';

afterEach(cleanup);

function file(path: string, size = 100): ProjectFile {
  return { name: path, path, type: 'file', size, mtime: size, kind: 'html', mime: 'text/html' };
}

function physicalRun(attempt: 0 | 1, produced: ProjectFile, withToolCalls: boolean): ChatMessage {
  const id = `run-${attempt}`;
  return {
    id, role: 'assistant', content: attempt === 0 ? 'Initial artifact.' : 'Repaired artifact.',
    runId: id, runStatus: 'succeeded',
    designGenerationExecutionId: 'generation', designGenerationAttempt: attempt,
    producedFiles: [produced],
    events: withToolCalls ? [
      { kind: 'tool_use', id, name: 'Write', input: { file_path: 'canary.html', content: `Attempt ${attempt}` } },
      { kind: 'tool_result', toolUseId: id, content: 'Written.', isError: false },
    ] : [{ kind: 'text', text: `Attempt ${attempt}` }],
  };
}

describe('AssistantMessage produced files across physical runs', () => {
  it.each([false, true])('shows a repaired file once with tracked tool calls = %s', (withToolCalls) => {
    const messages = [
      physicalRun(0, file('./canary.html'), withToolCalls),
      physicalRun(1, file('canary.html', 250), withToolCalls),
    ];
    const original = structuredClone(messages);
    const [folded] = foldStrategyTaskTurns(messages);
    expect(folded).toBeDefined();
    // The view keeps both physical records and all their operation evidence.
    expect(folded!.producedFiles).toHaveLength(2);
    expect(folded!.events).toEqual(messages.flatMap((message) => message.events ?? []));

    const view = render(<AssistantMessage message={folded!} streaming={false} projectId="project" />);
    const assertSingleFile = () => {
      if (withToolCalls) {
        expect(screen.getAllByTestId('file-ops-row-canary.html')).toHaveLength(1);
        expect(screen.queryByTestId('file-ops-toggle')).toBeNull();
        expect(deriveFileOps(folded!.events)[0]?.opCounts.write).toBe(2);
      } else {
        expect(view.container.querySelectorAll('.produced-file')).toHaveLength(1);
        expect(view.container.querySelector('.produced-file-name')?.textContent).toBe('canary.html');
        expect(view.container.querySelector('.produced-file-size')?.textContent).toBe('250 B');
      }
    };
    assertSingleFile();

    // Reloaded physical messages fold to the same single delivered-file card.
    view.rerender(<AssistantMessage message={foldStrategyTaskTurns(structuredClone(messages))[0]!} streaming={false} projectId="project" />);
    assertSingleFile();
    expect(messages).toEqual(original);
    expect(folded!.producedFiles).toHaveLength(2);
  });

  it('preserves distinct project paths with the same basename', () => {
    const [folded] = foldStrategyTaskTurns([
      physicalRun(0, file('first/index.html'), false),
      physicalRun(1, file('second/index.html'), false),
    ]);
    const view = render(<AssistantMessage message={folded!} streaming={false} projectId="project" />);
    expect([...view.container.querySelectorAll('.produced-file-name')].map((entry) => entry.textContent))
      .toEqual(['first/index.html', 'second/index.html']);
  });
});
