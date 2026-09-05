import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CompileComponentRegistryResultSchema,
  type CompileComponentRegistryRequest,
} from '@open-design/contracts';
import { resolveComponentBinding } from '../../../src/services/design-runtime/binding-resolver.js';
import { validateComponentUsage } from '../../../src/services/design-runtime/component-validator.js';
import { CompilerError } from '../../../src/services/design-runtime/react-compiler.js';
import { compileComponentRegistry } from '../../../src/services/design-runtime/registry-compiler.js';

const fixtureSources = {
  'Button.tsx': readFileSync(new URL('./fixtures/Button.tsx', import.meta.url), 'utf8'),
  'Card.tsx': readFileSync(new URL('./fixtures/Card.tsx', import.meta.url), 'utf8'),
  'TextInput.tsx': readFileSync(new URL('./fixtures/TextInput.tsx', import.meta.url), 'utf8'),
};

function fixture(): CompileComponentRegistryRequest {
  const selection = (file: keyof typeof fixtureSources, exportName: string, componentId: string) => ({
    sourceText: fixtureSources[file],
    sourcePath: `fixture/${file}`,
    exportName,
    componentId,
    codeComponentId: `fixture/${exportName}`,
    packageName: '@fixture/ui',
  });
  return {
    designSystemId: 'test',
    selections: [
      selection('TextInput.tsx', 'TextInput', 'input'),
      selection('Card.tsx', 'Card', 'card'),
      selection('Button.tsx', 'Button', 'button'),
      selection('TextInput.tsx', 'TextArea', 'area'),
    ],
  };
}

describe('compileComponentRegistry', () => {
  it('compiles selected exports from several source files into a complete resolvable snapshot', () => {
    const result = compileComponentRegistry(fixture());
    expect(result.registry.id).toBe('test');
    expect(result.registry.components.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'area', name: 'TextArea' },
      { id: 'button', name: 'Button' },
      { id: 'card', name: 'Card' },
      { id: 'input', name: 'TextInput' },
    ]);
    expect(result.codeIndex).toMatchObject({ schemaVersion: 1, id: 'test' });
    expect(result.codeIndex.components.map(({ id }) => id)).toEqual([
      'fixture/Button', 'fixture/Card', 'fixture/TextArea', 'fixture/TextInput',
    ]);
    expect(result.bindings.map(({ componentRef }) => componentRef)).toEqual([
      'ds:test/area', 'ds:test/button', 'ds:test/card', 'ds:test/input',
    ]);
    for (const binding of result.bindings) {
      expect(resolveComponentBinding(binding, result.registry, result.codeIndex.components))
        .toMatchObject({ ok: true, codeComponent: { id: binding.status === 'bound' ? binding.codeComponentId : '' } });
    }
    expect(result.registry.components.find(({ id }) => id === 'card')?.props.elevation)
      .toMatchObject({ type: 'enum', values: [0, 1, 2], default: 0 });
    expect(result.registry.components.find(({ id }) => id === 'area')?.props.rows)
      .toMatchObject({ type: 'number', default: 3 });
    expect(validateComponentUsage(result.registry, {
      component: 'ds:test/button', props: { variant: 'primary' },
    })).toEqual([]);
    expect(validateComponentUsage(result.registry, {
      component: 'ds:test/button', props: { variant: 'filled' },
    })).toMatchObject([{ code: 'ODDS1003', allowedValues: ['primary', 'secondary', 'danger'] }]);
    expect(CompileComponentRegistryResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('produces identical serialized output on repeat and every input permutation without changing input', () => {
    const request = fixture();
    const original = JSON.stringify(request);
    for (const selection of request.selections) Object.freeze(selection);
    Object.freeze(request.selections);
    Object.freeze(request);
    const expected = JSON.stringify(compileComponentRegistry(request));
    const permutations = <T>(items: readonly T[]): T[][] => items.length === 0 ? [[]]
      : items.flatMap((item, index) => permutations(items.filter((_, position) => position !== index))
        .map((rest) => [item, ...rest]));
    for (const selections of permutations(request.selections)) {
      expect(JSON.stringify(compileComponentRegistry({ ...request, selections }))).toBe(expected);
    }
    expect(JSON.stringify(compileComponentRegistry(request))).toBe(expected);
    expect(JSON.stringify(request)).toBe(original);
  });

  it.each([{}, { packageName: undefined }])('supports omitted package metadata %j', (packageMetadata) => {
    const { packageName: _packageName, ...selection } = fixture().selections[2]!;
    const result = compileComponentRegistry({
      designSystemId: 'test',
      selections: [{ ...selection, ...packageMetadata }],
    });
    expect(result.codeIndex.components[0]!.id).toBe('fixture/Button');
    expect(Object.hasOwn(result.codeIndex.components[0]!, 'packageName')).toBe(false);
  });

  it.each(['componentId', 'codeComponentId', 'exportName'] as const)(
    'rejects duplicate %s selections before parsing any source',
    (field) => {
      const request = fixture();
      const first = request.selections[0]!;
      const second = request.selections[1]!;
      first.sourceText = 'invalid TypeScript (';
      second[field] = first[field];
      if (field === 'exportName') second.sourcePath = first.sourcePath;
      expect(() => compileComponentRegistry(request)).toThrow(`Duplicate component selection ${field}`);
    },
  );

  it.each(['sourceText', 'packageName'] as const)(
    'rejects conflicting %s for exports sharing a source path before extraction',
    (field) => {
      const request = fixture();
      const first = request.selections[0]!;
      const second = request.selections[3]!;
      first.sourceText = 'invalid TypeScript (';
      second.sourceText = first.sourceText;
      second[field] = field === 'sourceText' ? 'another invalid snapshot (' : '@other/ui';
      expect(() => compileComponentRegistry(request)).toThrow(CompilerError);
      expect(() => compileComponentRegistry(request)).toThrow(/share identical source text and package metadata/);
    },
  );

  it('fails the whole compilation when a later selection is unsupported and leaves previous snapshots intact', () => {
    const request = fixture();
    const previous = compileComponentRegistry(request);
    const before = JSON.stringify(previous);
    const failingRequest = fixture();
    failingRequest.selections.find(({ componentId }) => componentId === 'card')!.sourceText =
      'export function Card(props: { onClick: () => void }) {}';
    const inputBefore = JSON.stringify(failingRequest);
    expect(() => compileComponentRegistry(failingRequest)).toThrow(CompilerError);
    expect(() => compileComponentRegistry(failingRequest)).toThrow(/fixture\/Card.tsx.*Unsupported prop type TSFunctionType/);
    expect(JSON.stringify(failingRequest)).toBe(inputBefore);
    expect(JSON.stringify(previous)).toBe(before);
    expect(compileComponentRegistry(request)).toEqual(previous);
  });

  it('preserves explicit identities after an export rename and never executes supplied source', () => {
    const request = fixture();
    const previous = compileComponentRegistry(request);
    const button = request.selections.find(({ componentId }) => componentId === 'button')!;
    button.sourceText = `throw new Error('Source must not execute');\n${button.sourceText.replace('function Button(', 'function RenamedButton(')}`;
    button.exportName = 'RenamedButton';
    const result = compileComponentRegistry(request);
    expect(result.registry.components.find(({ id }) => id === 'button')?.name).toBe('RenamedButton');
    expect(result.codeIndex.components.map(({ id }) => id)).toEqual(previous.codeIndex.components.map(({ id }) => id));
    expect(result.bindings.map(({ id, componentRef }) => ({ id, componentRef })))
      .toEqual(previous.bindings.map(({ id, componentRef }) => ({ id, componentRef })));
    result.registry.components[0]!.name = 'Locally changed result';
    expect(previous.registry.components[0]!.name).toBe('TextArea');
  });
});
