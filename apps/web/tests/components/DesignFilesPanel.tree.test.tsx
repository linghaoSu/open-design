// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignFilesPanel } from '../../src/components/DesignFilesPanel';
import type { ProjectFile, ProjectFileKind } from '../../src/types';

function file(name: string, kind: ProjectFileKind = 'code'): ProjectFile {
  return { name, path: name, type: 'file', kind, size: 1024, mtime: 1700000000000, mime: 'text/plain' };
}

// Deliberately omit navState: these cases exercise the user-facing default,
// whereas the existing category/thumbnail suites opt into categories.
function renderPanel(files: ProjectFile[], overrides: Partial<ComponentProps<typeof DesignFilesPanel>> = {}) {
  const props: ComponentProps<typeof DesignFilesPanel> = {
    projectId: 'file-tree-project',
    projectKind: 'prototype',
    files,
    liveArtifacts: [],
    onRefreshFiles: vi.fn(),
    onOpenFile: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onRenameFile: vi.fn(),
    onDeleteFile: vi.fn(),
    onDeleteFiles: vi.fn(),
    onUpload: vi.fn(),
    onUploadFiles: vi.fn(),
    onPaste: vi.fn(),
    onNewSketch: vi.fn(),
    ...overrides,
  };
  return { ...render(<DesignFilesPanel {...props} />), props };
}

function row(name: string) {
  return screen.getByTestId(`design-file-row-${name}`);
}

function openMenu(name: string) {
  fireEvent.click(screen.getByTestId(`design-file-menu-${name}`));
  return within(screen.getByTestId('design-file-menu-popover'));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DesignFilesPanel default file tree', () => {
  it('shows every mixed-type path once with basenames and opens distinct same-name files by full path', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const files = [
      file('index.html', 'html'),
      file('pages/index.html', 'html'),
      file('styles/theme.css', 'text'),
      file('src/Card.jsx'),
      file('assets/logo.png', 'image'),
      file('README.md', 'text'),
    ];
    const { container, props } = renderPanel(files);

    expect(screen.getByTestId('design-files-view-tree').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('design-files-view-categories').getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('.df-tabs')).toBeNull();
    expect(container.querySelectorAll('.df-file-row')).toHaveLength(files.length);
    for (const f of files) {
      expect(screen.getAllByTestId(`design-file-row-${f.name}`)).toHaveLength(1);
      const name = row(f.name).querySelector('.df-row-name');
      expect(name?.textContent).toBe(f.name.split('/').pop());
      expect(name?.getAttribute('title')).toBe(f.name);
    }
    fireEvent.click(row('index.html').querySelector('.df-row-name-btn')!);
    fireEvent.click(row('pages/index.html').querySelector('.df-row-name-btn')!);
    expect(props.onOpenFile).toHaveBeenNthCalledWith(1, 'index.html');
    expect(props.onOpenFile).toHaveBeenNthCalledWith(2, 'pages/index.html');
    expect(container.querySelector('.df-card-thumb')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('edits the basename while preserving the nested directory in the submitted rename', async () => {
    const original = file('src/Card.tsx');
    const renamed = file('src/Panel.tsx');
    const onRenameFile = vi.fn().mockResolvedValue(renamed);
    const { container, props } = renderPanel([original], { onRenameFile });

    fireEvent.click(openMenu(original.name).getByRole('button', { name: 'Rename' }));
    const input = container.querySelector<HTMLInputElement>('.df-rename-input')!;
    expect(input.value).toBe('Card.tsx');
    fireEvent.change(input, { target: { value: 'Panel.tsx' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onRenameFile).toHaveBeenCalledWith(original.name, renamed.name));
    expect(onRenameFile).toHaveBeenCalledTimes(1);
    expect(props.onOpenFile).not.toHaveBeenCalled();
  });

  it('deletes a nested file using its full identity without opening its sibling', () => {
    const { props } = renderPanel([file('src/index.ts'), file('test/index.ts')]);
    openMenu('test/index.ts');
    fireEvent.click(screen.getByTestId('design-file-delete-test/index.ts'));

    expect(props.onDeleteFile).toHaveBeenCalledExactlyOnceWith('test/index.ts');
    expect(props.onOpenFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('design-file-menu-popover')).toBeNull();
  });

  it('keeps separate selected paths across file types and prunes only removed files after batch delete', async () => {
    const files = [file('pages/index.html', 'html'), file('styles/index.css', 'text'), file('other/index.css', 'text')];
    const { props, rerender } = renderPanel(files);
    fireEvent.click(within(row(files[0]!.name)).getByRole('checkbox'));
    fireEvent.click(within(row(files[1]!.name)).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('design-files-batch-delete'));

    await waitFor(() => expect(props.onDeleteFiles).toHaveBeenCalledExactlyOnceWith(['pages/index.html', 'styles/index.css']));
    expect(within(row('pages/index.html')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    expect(within(row('other/index.css')).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');

    rerender(<DesignFilesPanel {...props} files={files.slice(1)} />);
    expect(screen.queryByTestId('design-file-row-pages/index.html')).toBeNull();
    expect(within(row('styles/index.css')).getByRole('checkbox').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('design-files-batch-delete'));
    await waitFor(() => expect(props.onDeleteFiles).toHaveBeenLastCalledWith(['styles/index.css']));
    expect(props.onOpenFile).not.toHaveBeenCalled();
  });

  it('lets a viewer open nested files while exposing no selection or mutation menu', () => {
    const { container, props } = renderPanel([file('src/Card.tsx'), file('assets/logo.png', 'image')], { viewerOnly: true });
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByTestId('design-file-menu-src/Card.tsx')).toBeNull();
    expect(screen.queryByTestId('design-files-batch-bar')).toBeNull();
    const check = row('src/Card.tsx').querySelector('.df-row-check')!;
    fireEvent.click(check);
    fireEvent.keyDown(check, { key: ' ' });
    expect(container.querySelector('.df-file-row.selected')).toBeNull();
    fireEvent.click(row('src/Card.tsx').querySelector('.df-row-name-btn')!);
    expect(props.onOpenFile).toHaveBeenCalledExactlyOnceWith('src/Card.tsx');
    expect(props.onRenameFile).not.toHaveBeenCalled();
    expect(props.onDeleteFile).not.toHaveBeenCalled();
    expect(props.onDeleteFiles).not.toHaveBeenCalled();
  });

  it('restores the root creation target and clears selection when returning from category folder navigation', () => {
    const onCurrentDirChange = vi.fn();
    const onNavStateChange = vi.fn();
    const { container } = renderPanel([file('src/Card.tsx'), file('README.md', 'text')], { onCurrentDirChange, onNavStateChange });
    expect(onCurrentDirChange).toHaveBeenLastCalledWith('');

    fireEvent.click(screen.getByTestId('design-files-view-categories'));
    fireEvent.click(screen.getByTestId('design-files-tab-folders'));
    fireEvent.click(container.querySelector('.df-dir-row .df-row-name-btn')!);
    expect(onCurrentDirChange).toHaveBeenLastCalledWith('src');
    fireEvent.click(within(row('src/Card.tsx')).getByRole('checkbox'));

    fireEvent.click(screen.getByTestId('design-files-view-tree'));
    expect(onCurrentDirChange).toHaveBeenLastCalledWith('');
    expect(onNavStateChange).toHaveBeenLastCalledWith(expect.objectContaining({ viewMode: 'tree', currentDir: '' }));
    expect(row('README.md')).toBeTruthy();
    expect(row('src/Card.tsx')).toBeTruthy();
    expect(screen.queryByTestId('design-files-batch-bar')).toBeNull();
    expect(container.querySelector('.df-breadcrumb-current')?.textContent).not.toBe('src');
    expect(container.querySelector('.df-breadcrumb-btn')).toBeNull();
  });
});
