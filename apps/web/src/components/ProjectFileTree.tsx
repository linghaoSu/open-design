import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@open-design/components';
import type { ProjectFile, ProjectFolder } from '../types';
import { useT } from '../i18n';
import { Icon } from './Icon';
import styles from './ProjectFileTree.module.css';

export interface ProjectFileTreeProps {
  files: ProjectFile[];
  folders?: ProjectFolder[];
  renderFile: (file: ProjectFile) => ReactNode;
  label: string;
  initialCollapsedPaths?: readonly string[];
  onCollapsedPathsChange?: (paths: string[]) => void;
}

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: Map<string, ProjectFile>;
}

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const compareNames = (left: string, right: string) => naturalOrder.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
const folderNode = (name: string, path: string): FolderNode => ({ name, path, folders: new Map(), files: new Map() });
const EMPTY_FOLDERS: ProjectFolder[] = [];

function buildTree(files: ProjectFile[], folders: ProjectFolder[]) {
  const root = folderNode('', '');
  const allFolders = new Map<string, FolderNode>();
  const uniqueFiles = new Map<string, ProjectFile>();
  const addFolders = (parts: string[]): FolderNode => {
    let parent = root;
    for (const name of parts) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let node = parent.folders.get(name);
      if (!node) { node = folderNode(name, path); parent.folders.set(name, node); allFolders.set(path, node); }
      parent = node;
    }
    return parent;
  };
  for (const folder of folders) if (folder.path) addFolders(folder.path.split('/'));
  for (const file of files) {
    // name is the project-relative file API identity. localPath is never a tree root.
    if (file.type === 'dir') { if (file.name) addFolders(file.name.split('/')); continue; }
    uniqueFiles.set(file.name, file);
  }
  for (const [path, file] of uniqueFiles) {
    const parts = path.split('/'); const name = parts.pop()!;
    addFolders(parts).files.set(name, file);
  }
  return { root, folderPaths: [...allFolders.keys()].sort(compareNames), fileCount: uniqueFiles.size };
}

/** A project-root overview. Parent-owned compact rows retain all file actions. */
export function ProjectFileTree({ files, folders = EMPTY_FOLDERS, renderFile, label, initialCollapsedPaths, onCollapsedPathsChange }: ProjectFileTreeProps) {
  const t = useT();
  const tree = useMemo(() => buildTree(files, folders), [files, folders]);
  const [expansion, setExpansion] = useState(() => ({
    policy: initialCollapsedPaths === undefined ? 'auto' as const : 'expanded' as const,
    overrides: new Map((initialCollapsedPaths ?? []).map((path) => [path, true])),
  } as { policy: 'auto' | 'expanded' | 'collapsed'; overrides: Map<string, boolean> }));
  // Large projects start with folders closed and mount descendants only on demand.
  // Auto also applies when an initially empty file response finishes loading.
  const defaultCollapsed = expansion.policy === 'collapsed' || expansion.policy === 'auto' && tree.fileCount > 200;
  const collapsed = (path: string) => expansion.overrides.get(path) ?? defaultCollapsed;
  const collapsedPaths = tree.folderPaths.filter(collapsed);
  const snapshot = JSON.stringify(collapsedPaths);
  const lastReported = useRef<string>();
  useEffect(() => {
    if (!onCollapsedPathsChange || lastReported.current === snapshot) return;
    lastReported.current = snapshot;
    onCollapsedPathsChange(JSON.parse(snapshot) as string[]);
  }, [onCollapsedPathsChange, snapshot]);

  const toggle = (path: string) => setExpansion((previous) => {
    const overrides = new Map(previous.overrides);
    overrides.set(path, !(previous.overrides.get(path) ?? defaultCollapsed));
    return { ...previous, overrides };
  });
  const renderChildren = (parent: FolderNode, nested: boolean): ReactNode => <ul className={nested ? styles.children : styles.list}>
    {[...parent.folders.values()].sort((left, right) => compareNames(left.name, right.name)).map((folder) => {
      const expanded = !collapsed(folder.path);
      return <li key={`folder:${folder.path}`} className={styles.folder}>
        <Button variant="ghost" className={styles.folderButton} aria-expanded={expanded} title={folder.path}
          data-testid={`project-file-tree-folder-${folder.path}`} onClick={() => toggle(folder.path)}>
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
          <Icon name={expanded ? 'folder-filled' : 'folder'} size={16} />
          <span className={styles.name}>{folder.name}</span>
        </Button>
        {expanded && renderChildren(folder, true)}
      </li>;
    })}
    {[...parent.files.entries()].sort(([left], [right]) => compareNames(left, right)).map(([name, file]) =>
      <li key={`file:${name}`} className={styles.file} data-file-path={file.name}>{renderFile(file)}</li>)}
  </ul>;

  return <section className={styles.tree} aria-label={label} data-testid="project-file-tree">
    {tree.folderPaths.length > 0 ? <div className={styles.actions}>
      <Button variant="ghost" className={styles.action} disabled={collapsedPaths.length === 0}
        data-testid="project-file-tree-expand-all" onClick={() => setExpansion({ policy: 'expanded', overrides: new Map() })}>{t('designFiles.expandAll')}</Button>
      <Button variant="ghost" className={styles.action} disabled={collapsedPaths.length === tree.folderPaths.length}
        data-testid="project-file-tree-collapse-all" onClick={() => setExpansion({ policy: 'collapsed', overrides: new Map() })}>{t('designFiles.collapseAll')}</Button>
    </div> : null}
    {renderChildren(tree.root, false)}
  </section>;
}
