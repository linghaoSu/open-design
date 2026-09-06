import { describe, expect, it, vi } from 'vitest';
import { componentPreviewFiles } from '../../fixtures/design-runtime/component-preview.js';
import { createComponentPreviewService } from '../../../src/services/design-runtime/component-preview.js';

function setup() {
  const files = componentPreviewFiles(); let identity = 'first';
  const read = vi.fn(async (path: string) => { const file = files.get(path); if (!file) throw new Error('Missing file'); return structuredClone(file); });
  const service = createComponentPreviewService({ acquireAuthority: async () => {
    const captured = identity; const assertCurrentSync = () => { if (identity !== captured) throw new Error('Authority changed'); };
    return { readSourceFile: read, assertCurrent: async () => assertCurrentSync(), assertCurrentSync };
  } });
  return { files, read, service, drift: () => { identity = 'second'; } };
}

describe('standalone project component preview', () => {
  it('infers missing props, preserves explicit values and builds local code/CSS/assets with one shared byte snapshot and no structured state', async () => {
    const { files, read, service } = setup(); const original = structuredClone(files);
    const reauthorize = vi.fn(async () => {});
    const result = await service.componentPreview('project', { sourcePath: 'Card.tsx', props: { title: 'Explicit' } }, reauthorize);
    expect(result.selectedExport).toBe('default'); expect(result.bundle).not.toBeNull();
    expect(result.effectiveProps.title).toBe('Explicit'); expect(Array.isArray(result.effectiveProps.items)).toBe(true);
    expect(result.callbacks).toContainEqual({ path: ['onSelect'], async: false });
    expect(result.evidence.some((entry) => entry.sourcePath === 'logo.png' && entry.byteLength === 7)).toBe(true);
    expect(result.bundle!.css).toContain('data:image/png;base64,');
    expect(read.mock.calls.map(([path]) => path).sort()).toEqual([...files.keys(), ...files.keys()].sort());
    expect(reauthorize).toHaveBeenCalledTimes(1); expect(files).toEqual(original);
    const repeated = await service.componentPreview('project', { sourcePath: 'Card.tsx', props: { title: 'Explicit' } });
    expect(repeated).toEqual(result);
  });

  it('returns export-selection and missing-dependency diagnostics without a partial runnable bundle', async () => {
    const { files, service } = setup();
    const missing = await service.componentPreview('project', { sourcePath: 'Card.tsx', exportName: 'Missing' });
    expect(missing.bundle).toBeNull(); expect(missing.selectedExport).toBeNull(); expect(missing.exports).toContain('default');
    expect(missing.diagnostics.some((entry) => entry.severity === 'error')).toBe(true);
    files.delete('format.ts');
    const dependency = await service.componentPreview('project', { sourcePath: 'Card.tsx' });
    expect(dependency.bundle).toBeNull(); expect(dependency.diagnostics.some((entry) => entry.message.includes('format.ts'))).toBe(true);
  });

  it('detects changed and newly appearing import bytes after bundling', async () => {
    const { files, read, service } = setup(); const original = read.getMockImplementation()!; const counts = new Map<string, number>();
    read.mockImplementation(async (path) => { const value = await original(path); const count = (counts.get(path) ?? 0) + 1; counts.set(path, count); return path === 'format.ts' && count === 2 ? { ...value, content: 'export const format=()=>"Changed";' } : value; });
    await expect(service.componentPreview('project', { sourcePath: 'Card.tsx' })).rejects.toMatchObject({ code: 'CONFLICT' });
    read.mockImplementation(original);
    files.set('Card.tsx', { ...files.get('Card.tsx')!, content: 'import {format} from "./format"; export default function Card(){return <p>{format("name")}</p>}' });
    let misses = 0;
    read.mockImplementation(async (path) => { if (path === 'format' && ++misses === 2) return { path, encoding: 'utf8', content: 'export const format=()=>"New shadow";' }; return original(path); });
    await expect(service.componentPreview('project', { sourcePath: 'Card.tsx' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rechecks scoped authority after final authorization and bounds source reads', async () => {
    const { files, service, drift } = setup();
    await expect(service.componentPreview('project', { sourcePath: 'Card.tsx' }, async () => drift())).rejects.toThrow('Authority changed');
    files.set('Card.tsx', { path: 'Card.tsx', encoding: 'utf8', content: 'x'.repeat(4 * 1024 * 1024 + 1) });
    await expect(service.componentPreview('project', { sourcePath: 'Card.tsx' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
