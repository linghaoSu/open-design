import { describe, expect, it } from 'vitest';
import { analyzeDesignSources, type SourceAnalysisContext } from '../../../src/services/design-runtime/design-source-analysis.js';
import { compileReactComponent } from '../../../src/services/design-runtime/react-compiler.js';
import { validateStructuredDesign } from '../../../src/services/design-runtime/design-validation.js';
import { registerLocalComponentBinding } from '../../../src/services/design-runtime/local-component-binding.js';
import { validationFixture } from '../../fixtures/design-runtime/validation-benchmark.js';

const sourcePath = 'ui/Button.tsx';
const codeComponentId = 'ui/button';
const propsFiles = new Map([['ui/types.ts', "export interface Props { label?: string; disabled?: boolean }"]]);
const imports = "import { memo, forwardRef, useState } from 'react'; import type { Props } from './types';";
const render = "({ label = 'Save', disabled = false }: Props) => <button disabled={disabled}>{label}</button>";
const memoSource = `${imports} export const Button = memo(${render});`;

function fixture(sourceText = memoSource) {
  const compiled = compileReactComponent({ sourceText, sourcePath, exportName: 'Button', codeComponentId, componentId: 'button', designSystemId: 'fixture', sourceFiles: propsFiles });
  const context: SourceAnalysisContext = {
    sources: [
      { sourcePath: 'Screen.tsx', language: 'tsx', sourceText: "import { Button } from './ui/Button'; export function Screen() { return <Button label=\"Updated\" disabled={true}/>; }" },
      { sourcePath, language: 'tsx', sourceText },
    ],
    codes: [compiled.codeComponent],
    provenCodeSources: new Map([[codeComponentId, sourceText]]),
    provenCodeSourceFiles: new Map([[codeComponentId, propsFiles]]),
    frozenSources: new Map(),
  };
  return context;
}

function analyze(context: SourceAnalysisContext) {
  return analyzeDesignSources(context, [{ sourcePath: 'Screen.tsx', exportName: 'Screen' }]);
}

describe('verified React wrapper source analysis', () => {
  it.each([
    ['memo', memoSource],
    ['namespace memo', `import React from 'react'; import type { Props } from './types'; export const Button = React.memo(${render});`],
    ['forwardRef', `${imports} export const Button = forwardRef<HTMLButtonElement, Props>(({label='Save',disabled=false}, ref) => <button disabled={disabled}>{label}</button>);`],
    ['memo around forwardRef', `${imports} export const Button = memo(forwardRef<HTMLButtonElement, Props>(({label='Save',disabled=false}, ref) => <button disabled={disabled}>{label}</button>));`],
  ])('audits the actual %s implementation using exact imported props and caller values', (_name, sourceText) => {
    const result = analyze(fixture(sourceText));
    expect(result.diagnostics).toEqual([]);
    expect(result).toMatchObject({ complete: true, importsComplete: true, implementations: [{
      codeId: codeComponentId,
      props: { label: 'Updated', disabled: true },
      nodes: [{ type: 'element', tag: 'button', props: { disabled: true }, slots: { children: [{ type: 'text', text: 'Updated' }] } }],
    }] });
  });

  it('keeps unproven and stale wrappers outside the certified implementation tree', () => {
    const unproven = fixture();
    unproven.provenCodeSources = new Map();
    const stale = fixture();
    stale.sources = stale.sources.map((source) => source.sourcePath === sourcePath ? { ...source, sourceText: source.sourceText.replace('<button', '<button title="changed"') } : source);
    for (const context of [unproven, stale]) {
      const result = analyze(context);
      expect(result.complete).toBe(false);
      expect(result.implementations).toEqual([]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'ODDS6005', message: expect.stringContaining('does not match verified bytes') }),
        expect.objectContaining({ code: 'ODDS6002', message: expect.stringContaining('direct static function') }),
      ]));
    }
  });

  it.each([
    `import { memo } from 'other'; import type { Props } from './types'; export const Button = memo(${render});`,
    `import type { memo } from 'react'; import type { Props } from './types'; export const Button = memo(${render});`,
    `${imports} export const Button = forwardRef(memo(${render}));`,
    `${imports} export const Button = memo(${render}, () => true);`,
    `import React from 'react'; import type { Props } from './types'; React.memo = (value) => value; export const Button = React.memo(${render});`,
  ])('does not accept forged wrapper identity even when the caller supplies matching bytes', (sourceText) => {
    const context = fixture();
    context.sources = context.sources.map((source) => source.sourcePath === sourcePath ? { ...source, sourceText } : source);
    context.provenCodeSources = new Map([[codeComponentId, sourceText]]);
    const result = analyze(context);
    expect(result.complete).toBe(false);
    expect(result.implementations.flatMap((implementation) => implementation.nodes)).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS6002' })]));
  });

  it('requires the verified imported type bytes rather than trusting the wrapper annotation alone', () => {
    const context = fixture();
    context.provenCodeSourceFiles = new Map();
    const result = analyze(context);
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS6002', message: expect.stringContaining('ui/types.ts') })]));
  });

  it('keeps hooks and control flow unsupported while auditing visible raw style literals', () => {
    const context = fixture(`${imports} export const Button = memo((props: Props) => { const [value] = useState(props.label); return <button style={{color:'#f00'}}>{value}</button>; });`);
    const result = analyze(context);
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS6002', message: expect.stringContaining('one static return') })]));
    expect(result.styles).toContainEqual({ sourcePath, content: 'color:#f00', inline: true });
    expect(result.diagnostics.some((diagnostic) => diagnostic.message.includes('direct static function'))).toBe(false);
  });

  it('does not materialize a ref or computed prop as a statically known value', () => {
    const result = analyze(fixture(`${imports} export const Button = forwardRef<HTMLButtonElement, Props>((props, ref) => <button ref={ref} title={props.label?.toUpperCase()}/>);`));
    expect(result.complete).toBe(false);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.message === 'Computed property values cannot be statically certified.')).toHaveLength(2);
    expect(result.implementations[0]?.nodes[0]).toMatchObject({ props: {} });
  });

  it('certifies a registered memo adapter through full validation and rejects changed dependency contracts', () => {
    const request = validationFixture('react');
    request.snapshot.projectComponents.components = [{ schemaVersion: 1, id: 'card', name: 'Local card', revision: 1,
      props: { label: { type: 'string', required: false, default: 'Local label' } },
      template: { schemaVersion: 1, id: 'template-button', type: 'component', ref: 'ds:acme/button', props: { variant: 'primary' } },
      propMappings: [{ prop: 'label', nodeId: 'template-button', path: ['props', 'label'] }],
    }];
    request.snapshot.document!.screens[0]!.children = [{ schemaVersion: 1, id: 'local-use', type: 'instance', ref: 'local:card', overrides: [] }];
    const sourceText = "import { memo } from 'react'; import { Button } from '@fixture/ui'; import type { Props } from './types'; export const Card = memo(function Card({label='Local label'}: Props) { return <Button label={label}/>; });";
    const sourceFiles = new Map([['project/types.ts', 'export interface Props { label?: string }']]);
    const registered = registerLocalComponentBinding(request.snapshot, {
      source: { framework: 'react', sourceText, sourcePath: 'project/Card.tsx', exportName: 'Card', codeComponentId: 'project/card' },
      binding: { schemaVersion: 1, id: 'local-card', componentRef: 'local:card', framework: 'react', codeComponentId: 'project/card', definitionRevision: 1, status: 'bound', verified: true },
    }, sourceFiles);
    if (!registered.ok) throw new Error(JSON.stringify(registered.diagnostics));
    request.snapshot.projectCodeIndex = registered.projectCodeIndex;
    request.snapshot.bindings = registered.bindings;
    request.snapshot.projectSources = [{ codeComponentId: 'project/card', sourceText,
      sourceFiles: [...sourceFiles].map(([sourcePath, sourceText]) => ({ sourcePath, sourceText })),
    }];
    request.sources = [
      { sourcePath: request.outputs[0]!.sourcePath, language: 'tsx', sourceText: 'import { Card } from "../project/Card"; export function Screen(){ return <Card label="Local label"/>; }' },
      { sourcePath: 'project/Card.tsx', language: 'tsx', sourceText },
    ];
    const result = validateStructuredDesign(request);
    expect(result.diagnostics).toEqual([]);
    expect(result).toMatchObject({ accepted: true, strictReady: true, coverage: { source: true, imports: true, bindings: true, conformance: true } });

    request.snapshot.projectSources[0]!.sourceFiles![0]!.sourceText = "export interface Props { label?: 'Other' }";
    const changed = validateStructuredDesign(request);
    expect(changed).toMatchObject({ accepted: false, strictReady: false, coverage: { bindings: false, source: false } });
    expect(changed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ODDS7004' })]));
  });
});
