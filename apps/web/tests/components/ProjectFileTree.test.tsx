// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile, ProjectFolder } from '../../src/types';
import { ProjectFileTree } from '../../src/components/ProjectFileTree';

vi.mock('../../src/i18n', () => ({ useT: () => (key: string) => new Map([['designFiles.expandAll', 'Expand all'], ['designFiles.collapseAll', 'Collapse all']]).get(key) ?? key }));
afterEach(cleanup);
const file = (name: string, kind: ProjectFile['kind'] = 'code'): ProjectFile => ({ name, path: name, size: 10, mtime: 1, kind, mime: 'text/plain' });
const folder = (path: string): ProjectFolder => ({ path, name: path.split('/').at(-1)!, type: 'dir', size: 0, mtime: 1 });
const renderFile = (entry: ProjectFile) => <button type="button">{entry.name}</button>;

describe('project file overview tree', () => {
  it('shows mixed types once in folders-first natural order, including nested empty directories', () => {
    const original = file('src/file2.ts'); const latest = { ...original, size: 99 };
    const rows = vi.fn(renderFile);
    const { container } = render(<ProjectFileTree label="Project files" files={[
      file('z10.png', 'image'), file('src/file10.html', 'html'), original, file('z2.md', 'document'), latest,
      file('src/icons/logo.svg', 'image'), file('src/file1.css'),
    ]} folders={[folder('empty/nested'), folder('src'), folder('src/icons')]} renderFile={rows} />);
    const tree = screen.getByRole('region', { name: 'Project files' });
    expect(within(tree).getAllByRole('button').filter((entry) => entry.hasAttribute('aria-expanded')).map((entry) => entry.textContent)).toEqual(['empty', 'nested', 'src', 'icons']);
    expect([...container.querySelectorAll('[data-file-path]')].map((entry) => entry.getAttribute('data-file-path'))).toEqual(['src/icons/logo.svg', 'src/file1.css', 'src/file2.ts', 'src/file10.html', 'z2.md', 'z10.png']);
    expect(screen.getAllByRole('button', { name: 'src/file2.ts' })).toHaveLength(1);
    expect(rows.mock.calls.find(([entry]) => entry.name === 'src/file2.ts')?.[0]).toBe(latest);
    expect(screen.getByTestId('project-file-tree-folder-empty/nested').getAttribute('aria-expanded')).toBe('true');
  });

  it('toggles inline without remapping file actions and supports expand/collapse all', () => {
    const open = vi.fn(); const rename = vi.fn();
    render(<ProjectFileTree label="Project files" files={[file('src/a.ts'), file('root.md', 'document')]}
      renderFile={(entry) => <div><button type="button" onClick={() => open(entry.name)}>{entry.name}</button><button type="button" aria-label={`Rename ${entry.name}`} onClick={() => rename(entry.name)}>Rename</button></div>} />);
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename src/a.ts' }));
    expect(open).toHaveBeenCalledWith('src/a.ts'); expect(rename).toHaveBeenCalledWith('src/a.ts');
    fireEvent.click(screen.getByTestId('project-file-tree-folder-src'));
    expect(screen.getByTestId('project-file-tree-folder-src').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'src/a.ts' })).toBeNull();
    expect(screen.getByRole('button', { name: 'root.md' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByRole('button', { name: 'src/a.ts' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByRole('button', { name: 'src/a.ts' })).toBeNull();
  });

  it('reports collapse snapshots that restore when opening a file unmounts the overview', () => {
    const snapshot = vi.fn(); const files = [file('src/a.ts'), file('assets/icons/a.svg', 'image')];
    const first = render(<ProjectFileTree label="Project files" files={files} renderFile={renderFile} onCollapsedPathsChange={snapshot} />);
    expect(snapshot).toHaveBeenLastCalledWith([]);
    fireEvent.click(screen.getByTestId('project-file-tree-folder-assets/icons'));
    fireEvent.click(screen.getByTestId('project-file-tree-folder-src'));
    const saved = snapshot.mock.lastCall![0] as string[];
    expect(saved).toEqual(['assets/icons', 'src']);
    first.unmount();
    render(<ProjectFileTree label="Project files" files={files} renderFile={renderFile} initialCollapsedPaths={saved} />);
    expect(screen.getByTestId('project-file-tree-folder-assets').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('project-file-tree-folder-assets/icons').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('project-file-tree-folder-src').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'src/a.ts' })).toBeNull();
  });

  it('mounts large-project descendants on demand, including when files arrive after the initial empty response', () => {
    const rows = vi.fn(renderFile);
    const { rerender } = render(<ProjectFileTree label="Project files" files={[]} renderFile={rows} />);
    const files = Array.from({ length: 201 }, (_, index) => file(`pages/page${index}.html`, 'html'));
    rerender(<ProjectFileTree label="Project files" files={files} renderFile={rows} />);
    expect(rows).not.toHaveBeenCalled();
    expect(screen.getByTestId('project-file-tree-folder-pages').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('project-file-tree-folder-pages'));
    expect(screen.getAllByRole('button', { name: /^pages\/page\d+\.html$/ })).toHaveLength(201);
    expect(document.querySelectorAll('img,iframe')).toHaveLength(0);
  });

  it('keeps same basenames in distinct directories and preserves explicit expansion through refresh', () => {
    const files = [file('src/README.md', 'document'), file('docs/README.md', 'document')];
    const { rerender } = render(<ProjectFileTree label="Project files" files={files} renderFile={renderFile} />);
    fireEvent.click(screen.getByTestId('project-file-tree-folder-src'));
    rerender(<ProjectFileTree label="Project files" files={[...files, file('docs/new.md', 'document')]} renderFile={renderFile} />);
    expect(screen.queryByRole('button', { name: 'src/README.md' })).toBeNull();
    expect(screen.getByRole('button', { name: 'docs/README.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'docs/new.md' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByRole('button', { name: 'src/README.md' })).toBeTruthy();
  });
});
