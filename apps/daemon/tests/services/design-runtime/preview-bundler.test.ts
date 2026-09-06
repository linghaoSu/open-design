import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '@babel/parser';
import { bundleDesignPreview } from '../../../src/services/design-runtime/preview-bundler.js';
import { prepareDesignPreview } from '../../../src/services/design-runtime/preview-preparation.js';
import { previewFixture } from '../../fixtures/design-runtime/preview.js';
import { localHandoffFixture } from '../../fixtures/design-runtime/handoff.js';
import { createHandoff } from '../../../src/services/design-runtime/handoff.js';
import { emitHandoffCode } from '../../../src/services/design-runtime/handoff-emitter.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const unavailable = async () => { throw new Error('Unavailable project source'); };
// The daemon's existing DOM test runtime ships without TypeScript declarations.
const { JSDOM } = createRequire(import.meta.url)('jsdom');

describe('verified preview bundling', () => {
  it('renders CSS Module mappings in actual emitted production handoff code', async () => {
    const input = localHandoffFixture(); const { snapshot } = input;
    const path = snapshot.projectCodeIndex.components[0]!.sourcePath;
    const source = `import styles from './card.module.css';\n${snapshot.projectSources[0]!.sourceText.replace('<article>', '<article className={styles.card}>')}`;
    snapshot.projectSources[0]!.sourceText = source;
    const manifest = createHandoff(input).manifest!; expect(manifest.ready).toBe(true);
    const file = emitHandoffCode({ manifest, outputs: [{ screenId: 'main', sourcePath: 'src/Screen.tsx', exportName: 'Screen' }] }).files[0]!;
    const cssPath = 'src/components/card.module.css';
    const result = await bundleDesignPreview(file, snapshot, 'production-handoff', { readProjectSource: async (candidate) => candidate === path ? source : candidate === cssPath ? '.card{display:grid;padding:12px;color:rgb(40,50,60)}' : unavailable() });
    expect(result.diagnostics).toEqual([]); expect(result.bundle).not.toBeNull();
    const dom = new JSDOM('<div id="od-preview-root"></div>', { runScripts: 'outside-only' });
    try {
      const style = dom.window.document.createElement('style'); style.textContent = result.bundle!.css; dom.window.document.head.append(style);
      dom.window.eval(result.bundle!.javascript);
      await vi.waitFor(() => expect(dom.window.document.querySelectorAll('article')).toHaveLength(2));
      const card = dom.window.document.querySelector('article')!;
      expect(card.textContent).toBe('filled'); expect(card.className).not.toBe('');
      expect(dom.window.getComputedStyle(card).display).toBe('grid');
      expect(dom.window.getComputedStyle(card).padding).toBe('12px');
      expect(dom.window.getComputedStyle(card).color).toBe('rgb(40, 50, 60)');
      expect(result.sourceEvidence.some((entry) => entry.sourcePath === cssPath && entry.origin === 'current-project')).toBe(true);
    } finally { dom.window.close(); }
  });

  it.each(['react', 'vue'] as const)('bundles actual frozen %s source with explicitly identified tool runtime, without executing source', async (framework) => {
    const { input, request } = previewFixture(framework); input.targetPackages = [{ name: '@acme/ui', installation: { status: 'unknown' } }];
    const side = prepareDesignPreview(input, request).sides[0]!;
    expect(side.diagnostics).toEqual([]); expect(side.files).toHaveLength(1);
    const result = await bundleDesignPreview(side.files[0]!, side.snapshot, request.kind, { readProjectSource: unavailable });
    expect(result.diagnostics).toEqual([]); expect(result.bundle).not.toBeNull();
    expect(parse(result.bundle!.javascript).errors).toEqual([]);
    expect(result.sourceEvidence.some((entry) => entry.origin === 'frozen-design-system')).toBe(true);
    expect(result.sourceEvidence.some((entry) => entry.origin === 'tool-runtime' && entry.packageName === framework)).toBe(true);
    expect(result.targetPackages).toEqual([]);
    expect(await result.verifyInstalledSources()).toBe(true);
  });

  it('uses current transitive project bytes when a frozen DS file has the same path', async () => {
    const input = localHandoffFixture(); const snapshot = input.snapshot;
    const code = snapshot.projectCodeIndex.components[0]!;
    const original = snapshot.projectSources[0]!.sourceText;
    const source = `import {Button} from './Button';\n${original.replace('<article>{appearance}</article>', '<article><Button/>{appearance}</article>')}`;
    snapshot.projectSources[0]!.sourceText = source;
    snapshot.versions[0]!.package.source.files.push({ path: 'src/components/Button.tsx', encoding: 'utf8', content: 'export function Button(){return <b>Frozen button</b>}' });
    // The source collision witness tests loader authority after canonical emission;
    // immutable version verification remains the preparation service's responsibility.
    const manifest = createHandoff({ ...input, snapshot: { ...snapshot, versions: localHandoffFixture().snapshot.versions } }).manifest!;
    expect(manifest.ready).toBe(true);
    const file = emitHandoffCode({ manifest, outputs: [{ screenId: 'main', sourcePath: 'src/Screen.tsx', exportName: 'Screen' }] }).files[0]!;
    const current = 'export function Button(){return <b>Current project button</b>}';
    const result = await bundleDesignPreview(file, snapshot, 'production-handoff', { readProjectSource: async (path) => path === code.sourcePath ? source : path === 'src/components/Button.tsx' ? current : unavailable() });
    expect(result.diagnostics).toEqual([]); expect(result.bundle?.javascript).toContain('Current project button');
    expect(result.bundle?.javascript).not.toContain('Frozen button');
    expect(result.sourceEvidence.find((entry) => entry.sourcePath === 'src/components/Button.tsx')?.origin).toBe('current-project');
  });

  it('compiles template-only Vue and component CSS through the actual SFC compiler', async () => {
    const { input, request } = previewFixture('vue');
    input.state.registry = null; input.state.codeIndex.components = []; input.state.bindings.bindings = [];
    input.state.lock.dependencies = []; input.state.dependencies.dependencies = []; input.versions = [];
    input.state.document!.screens[0]!.children = [{ schemaVersion: 1, id: 'label', type: 'text', text: 'Text-only screen' }];
    const side = prepareDesignPreview(input, request).sides[0]!;
    const file = { ...side.files[0]!, content: '<template><p>Template-only screen</p></template><style scoped>p{color:red}</style>' };
    const result = await bundleDesignPreview(file, side.snapshot, 'semantic-design', { readProjectSource: unavailable });
    expect(result.diagnostics).toEqual([]); expect(result.bundle?.javascript).toContain('Template-only screen');
    expect(result.bundle?.css).toContain('color:red');
  });

  it('bundles Vue relative frozen assets with explicit source evidence', async () => {
    const { input, request } = previewFixture('vue'); const side = prepareDesignPreview(input, request).sides[0]!;
    const source = side.snapshot.versions[0]!.package.source.files[0]!;
    source.content = source.content.replace('<section>', '<section><img src="./badge.svg"/>');
    side.snapshot.versions[0]!.package.source.files.push({ path: 'src/components/badge.svg', encoding: 'utf8', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>' });
    const result = await bundleDesignPreview(side.files[0]!, side.snapshot, request.kind, { readProjectSource: unavailable });
    expect(result.diagnostics).toEqual([]); expect(result.bundle?.javascript).toContain('data:image/svg+xml');
    expect(result.sourceEvidence.some((entry) => entry.sourcePath === 'src/components/badge.svg' && entry.origin === 'frozen-design-system')).toBe(true);
  });

  it('proves installed package bytes and detects later source drift', async () => {
    const { input, request } = previewFixture(); request.kind = 'production-handoff';
    const root = await mkdtemp(join(tmpdir(), 'od-preview-')); directories.push(root);
    const directory = join(root, 'node_modules/@acme/ui'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@acme/ui', version: '1.2.0', main: 'index.js' }));
    const path = join(directory, 'index.js'); await writeFile(path, 'export function Panel(){return "Installed panel"}');
    const side = prepareDesignPreview(input, request).sides[0]!;
    const result = await bundleDesignPreview(side.files[0]!, side.snapshot, request.kind, { readProjectSource: unavailable, projectRoot: root });
    expect(result.diagnostics).toEqual([]); expect(result.bundle?.javascript).toContain('Installed panel');
    expect(result.targetPackages).toEqual(input.targetPackages); expect(await result.verifyInstalledSources()).toBe(true);
    await writeFile(path, 'export function Panel(){return "Changed panel"}');
    expect(await result.verifyInstalledSources()).toBe(false);
  });

  it.each([
    ['a network import', 'import "https://example.invalid/remote.js";'],
    ['a Node builtin', 'import "node:fs";'],
    ['a dynamic runtime import', 'const path=globalThis.name; import(path);'],
    ['a source escape', 'import "../../../../../../private.ts";'],
  ])('diagnoses %s without producing a partial executable bundle', async (_name, source) => {
    const { input, request } = previewFixture(); const side = prepareDesignPreview(input, request).sides[0]!;
    const file = { ...side.files[0]!, content: `${source}\nexport function PreviewScreen(){return null;}` };
    const result = await bundleDesignPreview(file, side.snapshot, request.kind, { readProjectSource: unavailable });
    expect(result.bundle).toBeNull(); expect(result.diagnostics[0]?.code).toBe('ODDS8002');
  });

  it('treats top-level project statements only as source data during bundling', async () => {
    const { input, request } = previewFixture(); const side = prepareDesignPreview(input, request).sides[0]!;
    const file = { ...side.files[0]!, content: 'globalThis.__OD_PREVIEW_DAEMON_PROBE__ = "executed"; export function PreviewScreen(){return null;}' };
    const result = await bundleDesignPreview(file, side.snapshot, request.kind, { readProjectSource: unavailable });
    expect(result.diagnostics).toEqual([]);
    expect((globalThis as Record<string, unknown>).__OD_PREVIEW_DAEMON_PROBE__).toBeUndefined();
    expect(result.bundle?.javascript).toContain('__OD_PREVIEW_DAEMON_PROBE__');
  });
});
