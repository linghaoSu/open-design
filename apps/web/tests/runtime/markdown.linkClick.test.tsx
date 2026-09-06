// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../../src/runtime/markdown';
import { resolveChatFileLink } from '../../src/runtime/in-project-link';

describe('renderMarkdown — onLinkClick option', () => {
  afterEach(() => cleanup());

  it('omits onClick when the option is absent (backwards-compat for existing callers)', () => {
    // Existing surfaces — file viewer, system reminders, anywhere that
    // just renders markdown for display — must keep their previous
    // target="_blank" behavior with no extra event wiring.
    const { container } = render(
      <div>{renderMarkdown('Click [here](https://example.com).')}</div>,
    );
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor!.dispatchEvent(clickEvent);
    expect(clickEvent.defaultPrevented).toBe(false);
  });

  it.each(['Page.tsx', 'report.md', 'screens/My Page (final).tsx', '页面/设计 (1).md'])(
    'routes CommonMark angle destination %s using the same parsed DOM href and click value', (filePath) => {
      const target = vi.fn();
      const onLinkClick = vi.fn((href: string, event: { preventDefault(): void }) => {
        event.preventDefault();
        target(resolveChatFileLink(href, new Set([filePath]), 'current-project'));
      });
      const { container } = render(<div>{renderMarkdown(`[Open](<./${filePath}>)`, { onLinkClick })}</div>);
      const anchor = container.querySelector('a')!;
      expect(anchor).toBeTruthy();
      expect(anchor.getAttribute('href')).toBe(`./${filePath}`);
      fireEvent.click(anchor);
      expect(onLinkClick.mock.calls[0]?.[0]).toBe(anchor.getAttribute('href'));
      expect(target).toHaveBeenCalledWith({ kind: 'workspace-file', filePath });
    },
  );

  it('preserves percent-encoded literal angle characters instead of treating them as Markdown delimiters', () => {
    const href = './%3CPage%3E.tsx';
    const target = vi.fn();
    const onLinkClick = vi.fn((value: string, event: { preventDefault(): void }) => {
      event.preventDefault(); target(resolveChatFileLink(value, new Set(['<Page>.tsx']), 'current-project'));
    });
    const { container } = render(<div>{renderMarkdown(`[Literal](${href}) [Wrapped](<${href}>)`, { onLinkClick })}</div>);
    const links = [...container.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute('href')).toBe(href);
      fireEvent.click(link);
    }
    expect(target).toHaveBeenCalledTimes(2);
    expect(target).toHaveBeenLastCalledWith({ kind: 'workspace-file', filePath: '<Page>.tsx' });
  });

  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,unsafe'])(
    'keeps an angle-wrapped unsafe scheme inert: %s', (destination) => {
      const onLinkClick = vi.fn();
      const { container } = render(<div>{renderMarkdown(`[Unsafe](<${destination}>)`, { onLinkClick })}</div>);
      expect(container.querySelector('a')).toBeNull();
      expect(container).toHaveTextContent('Unsafe');
      expect(onLinkClick).not.toHaveBeenCalled();
    },
  );

  it('fires onLinkClick on explicit [text](url) link click', () => {
    const onLinkClick = vi.fn();
    const { container } = render(
      <div>
        {renderMarkdown('Open [the file](template.html) to inspect.', { onLinkClick })}
      </div>,
    );
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('template.html');
    fireEvent.click(anchor!);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(onLinkClick.mock.calls[0]?.[0]).toBe('template.html');
  });

  it('fires onLinkClick on autolinked bare https URLs found inline', () => {
    // The bare-URL branch in `renderInline` (`m[6]`) — separate code
    // path from the explicit `[text](url)` branch, must wire onClick
    // the same way.
    const onLinkClick = vi.fn();
    const { container } = render(
      <div>{renderMarkdown('See https://example.com/page for context.', { onLinkClick })}</div>,
    );
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    fireEvent.click(anchor!);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(onLinkClick.mock.calls[0]?.[0]).toBe('https://example.com/page');
  });

  it('fires onLinkClick on URLs that fall to the pushText autolink path', () => {
    // Text emitted between other inline tokens flows through `pushText`,
    // which runs its own URL autolink scan. That third `<a>` creation
    // site needs the same onClick wiring as the other two.
    const onLinkClick = vi.fn();
    const { container } = render(
      <div>
        {renderMarkdown('**bold** https://example.com/page then more text.', { onLinkClick })}
      </div>,
    );
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    fireEvent.click(anchor!);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(onLinkClick.mock.calls[0]?.[0]).toBe('https://example.com/page');
  });

  it('passes the React MouseEvent so the caller can preventDefault()', () => {
    const onLinkClick = vi.fn<(href: string, event: { preventDefault(): void }) => void>(
      (_href, event) => {
        event.preventDefault();
      },
    );
    const { container } = render(
      <div>{renderMarkdown('Open [file](template.html).', { onLinkClick })}</div>,
    );
    const anchor = container.querySelector('a')!;
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(clickEvent);
    expect(onLinkClick).toHaveBeenCalledTimes(1);
    expect(clickEvent.defaultPrevented).toBe(true);
  });
});
