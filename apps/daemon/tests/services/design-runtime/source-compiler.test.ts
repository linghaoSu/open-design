import { describe, expect, it } from 'vitest';
import { compileSourceComponent, extractSourceCodeComponent } from '../../../src/services/design-runtime/source-compiler.js';
import { resolveComponentBinding } from '../../../src/services/design-runtime/binding-resolver.js';

const sourceText = `import type { ReactNode as Child } from 'react';
type Props = { elevated?: boolean; children: Child };
export function Card({ elevated = false, children }: Props) { return <section>{children}</section>; }
export const CardPolicy = { component: Card, slots: {
  body: { codeSlot: 'children', accepts: ['text', 'ds:test/Button'], required: true, multiple: true }
} } as const;`;
const input = { framework: 'react' as const, sourceText, sourcePath: 'src/Card.tsx', exportName: 'Card', codeComponentId: 'code/card' };
const designInput = { ...input, designSystemId: 'test', componentId: 'card', metadataExportName: 'CardPolicy' };

describe('source compiler proof boundary', () => {
  it('extracts source-proven code slots independently from explicit semantic acceptance policy', () => {
    const code = extractSourceCodeComponent(input);
    expect(code.props).toEqual({ elevated: expect.objectContaining({ type: 'boolean', default: false, required: false }) });
    expect(code.slots).toEqual({ children: { kind: 'react-node', required: true, multiple: true, source: expect.objectContaining({ kind: 'typescript', sourcePath: input.sourcePath }) } });
    expect(() => compileSourceComponent({ ...input, designSystemId: 'test', componentId: 'card' })).toThrow(/Required code slot children/);
    const result = compileSourceComponent(designInput);
    expect(result.registry.components[0]!.slots).toEqual({ body: {
      accepts: ['text', 'ds:test/Button'], required: true, multiple: true,
      source: expect.objectContaining({ kind: 'manual', sourcePath: input.sourcePath, exportName: 'CardPolicy' }),
    } });
    expect(result.binding.slotMappings).toEqual([{ designSlot: 'body', codeSlot: 'children', source: expect.objectContaining({ kind: 'manual' }) }]);
    expect(resolveComponentBinding(result.binding, result.registry, [code]).ok).toBe(true);
    expect(compileSourceComponent(designInput)).toEqual(result);
  });

  it('preserves stable identities across component, metadata export and display renames', () => {
    const first = compileSourceComponent(designInput);
    const renamed = compileSourceComponent({ ...designInput, sourceText: sourceText.replaceAll('Card', 'Panel'), exportName: 'Panel', metadataExportName: 'PanelPolicy' });
    expect(renamed.registry.components[0]!.id).toBe(first.registry.components[0]!.id);
    expect(renamed.codeComponent.id).toBe(first.codeComponent.id);
    expect(renamed.binding.id).toBe(first.binding.id);
    expect(renamed.registry.components[0]!.name).toBe('Panel');
  });

  it.each([
    ['wrong import', sourceText.replace("from 'react'", "from './pretend-react'")],
    ['unmapped required slot', sourceText.replace('body:', 'another:').replace("codeSlot: 'children'", "codeSlot: 'missing'")],
    ['optional design slot for required code slot', sourceText.replace('required: true', 'required: false')],
    ['wrong component identity', sourceText.replace('component: Card', 'component: Other')],
    ['computed accepts', sourceText.replace("['text', 'ds:test/Button']", 'getAcceptedChildren()')],
    ['spread policy', sourceText.replace("codeSlot: 'children'", "...base, codeSlot: 'children'")],
    ['slot default', sourceText.replace('false, children }', "false, children = 'fallback' }")],
    ['duplicate target mapping', sourceText.replace("body: {", "other: { codeSlot: 'children', accepts: ['text'], required: true, multiple: false }, body: {")],
    ['mutated selected policy', `${sourceText}\nCardPolicy.slots.body.accepts = [];`],
    ['shadowed React namespace', sourceText.replace("import type { ReactNode as Child } from 'react';", "import type * as React from 'react'; namespace React { export type ReactNode = () => void; } type Child = React.ReactNode;")],
  ])('rejects %s without returning partial slot contracts', (_name, source) => {
    expect(() => compileSourceComponent({ ...designInput, sourceText: source })).toThrow();
  });

  it('requires an explicit slot mapping even when the design and code names match', () => {
    const result = compileSourceComponent(designInput);
    delete result.binding.slotMappings;
    result.registry.components[0]!.slots = { children: result.registry.components[0]!.slots!.body! };
    expect(resolveComponentBinding(result.binding, result.registry, [result.codeComponent])).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'ODDS3001', path: ['slotMappings'] })] });
  });
});
