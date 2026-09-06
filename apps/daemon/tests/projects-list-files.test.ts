import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listFiles } from '../src/projects.js';

const tempRoots: string[] = [];

async function makeProjectsRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'od-project-files-'));
  tempRoots.push(root);
  return path.join(root, 'projects');
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listFiles', () => {
  it('classifies JSX components with the other scripts, including nested and uppercase extensions', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'react-project';
    const projectDir = path.join(projectsRoot, projectId);
    await mkdir(path.join(projectDir, 'components'), { recursive: true });
    const scripts = ['PlainCard.jsx', 'components/Upper.JSX', 'Orders.tsx', 'format.ts', 'helper.js'];
    await Promise.all(scripts.map((name) => writeFile(path.join(projectDir, name), 'export default () => null;')));
    await writeFile(path.join(projectDir, 'payload.bin'), new Uint8Array([0, 255]));

    const files = await listFiles(projectsRoot, projectId);

    expect(files.filter((file) => file.kind === 'code').map((file) => file.name).sort()).toEqual(scripts.sort());
    expect(files.find((file) => file.name === 'payload.bin')?.kind).toBe('binary');
    expect(files.find((file) => file.name === 'PlainCard.jsx')?.mime).toBe('text/javascript; charset=utf-8');
  });

  it('includes the absolute local path for each visible project file', async () => {
    const projectsRoot = await makeProjectsRoot();
    const projectId = 'project-1';
    const projectDir = path.join(projectsRoot, projectId);
    const filePath = path.join(projectDir, 'alpha.html');
    await mkdir(projectDir, { recursive: true });
    await writeFile(filePath, '<!doctype html>');

    const files = await listFiles(projectsRoot, projectId);

    expect(files).toEqual([
      expect.objectContaining({
        name: 'alpha.html',
        path: 'alpha.html',
        localPath: filePath,
      }),
    ]);
  });
});
