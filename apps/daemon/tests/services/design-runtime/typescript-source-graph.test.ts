import { describe, expect, it, vi } from 'vitest';
import { localTypeSourceCandidates, readTypeScriptSourceGraph } from '../../../src/services/design-runtime/typescript-source-graph.js';
import { compileReactComponent } from '../../../src/services/design-runtime/react-compiler.js';
import { readProjectCodeEvidence } from '../../../src/services/design-runtime/project-code.js';
import { verifyProjectCodeSources } from '../../../src/services/design-runtime/local-component-binding.js';

describe('bounded local TypeScript source proof', () => {
  it('reports syntax errors at the actual imported file and line', async () => {
    await expect(readTypeScriptSourceGraph(new Map([['src/Button.tsx', "import type {Props} from './types';export function Button(props:Props){}"]]), async () => '\n\nexport interface Props{broken:}'))
      .rejects.toMatchObject({ name: 'TypeScriptSourceGraphError', sourcePath: 'src/types.ts', line: 3 });
  });
  it('collects actual local imports, preserves module scopes, and detects a changed or missing imported contract', async () => {
    const source = "import type {Props} from './types';export function Button(props:Props){return null}";
    const files = new Map([['src/Button.tsx', source], ['src/types.ts', "import type {Tone} from './tone';export interface Props{tone:Tone}"], ['src/tone.ts', "export type Tone='quiet'|'loud'"]]);
    const read = vi.fn(async (path: string) => { const text = files.get(path); if (text === undefined) throw new Error('Missing'); return text; });
    const graph = await readTypeScriptSourceGraph(new Map([['src/Button.tsx', source]]), read);
    const result = compileReactComponent({ sourceText: source, sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'button', designSystemId: 'test', sourceFiles: graph });
    const index = { schemaVersion: 1 as const, id: 'project', components: [result.codeComponent] };
    expect(verifyProjectCodeSources(index, await readProjectCodeEvidence(index, read))).toEqual([]);
    files.set('src/tone.ts', 'export type Tone=number');
    expect(verifyProjectCodeSources(index, await readProjectCodeEvidence(index, read))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS7004', severity: 'error' })]));
    files.delete('src/types.ts');
    expect(verifyProjectCodeSources(index, await readProjectCodeEvidence(index, read))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS7004', severity: 'error' })]));
    graph.delete('src/tone.ts');
    expect(() => compileReactComponent({ sourceText: source, sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'button', designSystemId: 'test', sourceFiles: graph })).toThrow(/src\/types.ts.*Include the local type source imported from \.\/tone.*src\/tone.ts/);
  });

  it('never resolves external packages, aliases or namespace escapes and enforces its source budget', async () => {
    for (const specifier of ['../../outside', '@/types', 'https://example.com/types', 'some-package', './file?raw']) expect(localTypeSourceCandidates('src/Button.tsx', specifier)).toEqual([]);
    const read = vi.fn(async () => { throw new Error('Must not read'); });
    const source = "import type {A} from '../../outside';import type {B} from 'package';export function Button(props:A){}";
    await readTypeScriptSourceGraph(new Map([['src/Button.tsx', source]]), read);
    expect(read).not.toHaveBeenCalled();
    await expect(readTypeScriptSourceGraph(new Map([['Large.ts', ' '.repeat(4 * 1024 * 1024 + 1)]]), read)).rejects.toThrow('budget');
    await expect(readTypeScriptSourceGraph(new Map(Array.from({ length: 65 }, (_, index) => [`${index}.ts`, ''])), read)).rejects.toThrow('budget');
  });
});
