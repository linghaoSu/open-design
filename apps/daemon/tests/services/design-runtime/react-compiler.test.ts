import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compileReactComponent,
  CompilerError,
  type CompileReactComponentInput,
} from '../../../src/services/design-runtime/react-compiler.js';

const sourcePath = 'fixture/Button.tsx';
const fixtureSource = readFileSync(new URL('./fixtures/Button.tsx', import.meta.url), 'utf8');

function compile(sourceText = fixtureSource, overrides: Partial<CompileReactComponentInput> = {}) {
  return compileReactComponent({
    sourceText,
    sourcePath,
    exportName: 'Button',
    componentId: 'Button',
    codeComponentId: 'fixture/Button',
    designSystemId: 'test',
    ...overrides,
  });
}

describe('compileReactComponent', () => {
  it('resolves bounded supplied local type imports with isolated module scopes and exact source locations', () => {
    const sourceFiles = new Map([
      ['fixture/types.ts', "import type {Tone} from './tone'; export interface Props {label:string;tone?:Tone}"],
      ['fixture/tone.ts', "export type Tone='quiet'|'loud'"],
    ]);
    const source = "import type {Props as ButtonProps} from './types'; type Tone='wrong'; export const Button=({label,tone='quiet'}:ButtonProps)=><button>{label}</button>";
    const compiled = compile(source, { sourceFiles });
    expect(compiled.codeComponent.props.tone).toMatchObject({ type: 'enum', values: ['quiet', 'loud'], default: 'quiet', source: { sourcePath: 'fixture/types.ts' } });
    expect(() => compile(source, { sourceFiles: new Map([['fixture/types.ts', "export interface Props {label:string;tone:{value:string}}"]]) })).toThrow(/TSTypeLiteral/);
    expect(() => compile(source, { sourceFiles: new Map([['fixture/types.ts', 'interface Props {label:string}']]) })).toThrow(/same source/);
    expect(() => compile(source, { sourceFiles: new Map([['fixture/types.ts', "export type Props=Props"]]) })).toThrow(/Cyclic/);
  });
  it.each([
    ["import {memo as keep} from 'react'; const Inner = ({label='Ready'}:{label?:string}) => <button>{label}</button>; export const Button=keep(Inner);", 'Button'],
    ["import React from 'react'; export const Button=React.forwardRef<HTMLButtonElement,{label?:string}>(({label='Ready'},ref)=><button ref={ref}>{label}</button>);", 'Button'],
    ["const Inner=({label='Ready'}:{label?:string})=><button>{label}</button>;export {Inner as Button};", 'Button'],
    ["export default function Button({label='Ready'}:{label?:string}){return <button>{label}</button>}", 'default'],
  ])('proves the actual contract behind a stable local React export %s', (source, exportName) => {
    const result = compile(source, { exportName });
    expect(result.codeComponent.props.label).toMatchObject({ type: 'string', required: false, default: 'Ready' });
    expect(result.binding).toMatchObject({ status: 'bound', verified: true });
    expect(result.codeComponent.exportName).toBe(exportName);
  });

  it.each([
    "import {forwardRef,memo} from 'react';export const Button=forwardRef(memo((props:{label:string})=><p/>));",
    "import type React from 'react';export const Button=React.memo((props:{label:string})=><p/>);",
    "import {memo} from 'other';export const Button=memo((props:{label:string})=><p/>);",
    "import {memo} from 'react';let Inner=(props:{label:string})=><p/>;export const Button=memo(Inner);",
    "import {memo} from 'react';const Inner=(props:{label:string})=><p/>;Inner.defaultProps={label:'changed'};export const Button=memo(Inner);",
    "import React from 'react';React.memo=(value)=>value;export const Button=React.memo((props:{label:string})=><p/>);",
  ])('rejects unproved wrappers or mutations in the selected local export chain', (source) => {
    expect(() => compile(source)).toThrow(CompilerError);
  });

  it('keeps memo around a forwardRef render function and identifies unsupported imported fields at their actual source location', () => {
    expect(compile("import {forwardRef,memo} from 'react';export const Button=memo(forwardRef<HTMLButtonElement,{label:string}>((props,ref)=><button ref={ref}>{props.label}</button>));").binding.status).toBe('bound');
    for (const declaration of ['export interface Props{\n\nrun():void\n}', 'interface Base{label:string}\n\nexport interface Props extends Base{}', 'export type Props<T>={label:T}']) {
      try {
        compile("import type {Props} from './types';export function Button(props:Props){return null}", { sourceFiles: new Map([['fixture/types.ts', declaration]]) });
        expect.fail('Expected unsupported imported contract');
      } catch (error) {
        expect(error).toBeInstanceOf(CompilerError);
        expect(error).toMatchObject({ sourcePath: 'fixture/types.ts', line: declaration.startsWith('export type') ? 1 : 3 });
      }
    }
  });
  it('extracts the acceptance fixture and establishes its explicit code binding', () => {
    const result = compile();
    expect(result.registry).toMatchObject({
      schemaVersion: 1,
      id: 'test',
      components: [{
        schemaVersion: 1,
        id: 'Button',
        name: 'Button',
        props: {
          variant: { type: 'enum', values: ['primary', 'secondary', 'danger'], required: false },
          size: { type: 'enum', values: ['sm', 'md', 'lg'], required: false },
          disabled: { type: 'boolean', required: false },
        },
      }],
    });
    expect(result.codeComponent).toMatchObject({
      schemaVersion: 1,
      id: 'fixture/Button',
      framework: 'react',
      exportName: 'Button',
      sourcePath,
      props: result.registry.components[0]!.props,
    });
    expect(result.binding).toMatchObject({
      schemaVersion: 1,
      componentRef: 'ds:test/Button',
      codeComponentId: 'fixture/Button',
      framework: 'react',
      status: 'bound',
      verified: true,
    });
    expect(result.registry.components[0]!.props.variant!.source).toEqual({
      kind: 'typescript', sourcePath, exportName: 'Button', line: 2, confidence: 1,
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('extracts arrow props, aliases, required fields, and literal defaults without executing source', () => {
    const result = compile(`
      throw new Error('This source must never execute');
      type Variant = 'primary' | 'secondary';
      type Props = {
        variant?: Variant;
        disabled?: boolean;
        label: string;
        count?: number;
        level?: -1 | 0 | 1;
      };
      export const Button = ({ variant: appearance = 'primary', disabled = false,
        label = 'Continue', count = 0, level = -1, ...rest }: Props) => <button>{label}</button>;
    `, { packageName: '@fixture/ui' });
    const props = result.registry.components[0]!.props;
    expect(props.variant).toMatchObject({ type: 'enum', values: ['primary', 'secondary'], default: 'primary', required: false });
    expect(props.disabled).toMatchObject({ type: 'boolean', default: false, required: false });
    expect(props.label).toMatchObject({ type: 'string', default: 'Continue', required: true });
    expect(props.count).toMatchObject({ type: 'number', default: 0, required: false });
    expect(props.level).toMatchObject({ type: 'enum', values: [-1, 0, 1], default: -1 });
    expect(result.codeComponent.packageName).toBe('@fixture/ui');
  });

  it('supports inline type literals and no-props components', () => {
    expect(compile('export function Button({ disabled = true }: { disabled?: boolean }) {}')
      .registry.components[0]!.props.disabled).toMatchObject({ type: 'boolean', default: true });
    expect(compile('export const Button = () => null').registry.components[0]!.props).toEqual({});
  });

  it('preserves explicit identity across display/export renames and has deterministic output', () => {
    const first = compile();
    const renamed = compile(fixtureSource.replace('function Button(', 'function RenamedButton('), { exportName: 'RenamedButton' });
    expect(compile()).toEqual(first);
    expect(renamed.registry.components[0]!.name).toBe('RenamedButton');
    expect(renamed.registry.components[0]!.id).toBe(first.registry.components[0]!.id);
    expect(renamed.codeComponent.id).toBe(first.codeComponent.id);
    expect(renamed.binding.id).toBe(first.binding.id);
    expect(renamed.binding.componentRef).toBe(first.binding.componentRef);
  });

  it.each([
    ['imported props', "import type { Props } from './other'; export function Button(props: Props) {}", /same source/],
    ['inherited props', 'interface Base { label: string }; interface Props extends Base {}; export function Button(props: Props) {}', /inheritance/],
    ['merged interfaces', 'interface Props { a: string }; interface Props { b: string }; export function Button(props: Props) {}', /Merged or ambiguous/],
    ['generic props', 'type Props<T> = { value: T }; export function Button(props: Props<string>) {}', /generic type references/],
    ['generic component', 'export function Button<T>(props: { label: string }) {}', /Generic/],
    ['overloaded component', "export function Button(props: { size: 'sm' }): any; export function Button(props: { size: string }) {}", /Overloaded/],
    ['intersections', 'type Props = { a: string } & { b: string }; export function Button(props: Props) {}', /TSIntersectionType/],
    ['callback prop', 'export function Button(props: { onClick?: () => void }) {}', /TSFunctionType/],
    ['any prop', 'export function Button(props: { value: any }) {}', /TSAnyKeyword/],
    ['object prop', 'export function Button(props: { options: { size: string } }) {}', /TSTypeLiteral/],
    ['array prop', 'export function Button(props: { items: string[] }) {}', /TSArrayType/],
    ['open union', "export function Button(props: { value: 'primary' | string }) {}", /unions of scalar literals/],
    ['method', 'export function Button(props: { onClick(): void }) {}', /methods and index signatures/],
    ['index signature', 'export function Button(props: { [key: string]: string }) {}', /methods and index signatures/],
    ['cyclic alias', 'type Value = Value; export function Button(props: { value: Value }) {}', /Cyclic type/],
    ['untyped props', 'export function Button(props) {}', /explicit TypeScript type/],
    ['optional parameter', 'export function Button(props?: { label: string }) {}', /required identifier/],
    ['receiver annotation', 'export function Button(this: { disabled: boolean }) {}', /receiver annotations/],
    ['whole-object default', 'export function Button(props: { label?: string } = {}) {}', /required identifier/],
    ['extra parameter', 'export function Button(props: {}, context: {}) {}', /at most one/],
    ['mutable export', 'export let Button = (props: {}) => null', /const arrow/],
    ['wrapped export', 'export const Button = memo((props: {}) => null)', /const arrow/],
    ['function type annotation', 'export const Button: React.FC<{}> = () => null', /type on the props parameter/],
    ['re-export', "export { Button } from './other'", /re-export/],
    ['missing export', 'function Button(props: {}) {}', /found 0/],
    ['default export', 'export default function Button(props: {}) {}', /found 0/],
    ['computed default', "export function Button({ label = getLabel() }: { label?: string }) {}", /computed defaults/],
    ['mismatched default', "export function Button({ disabled = 'yes' }: { disabled?: boolean }) {}", /does not match/],
    ['invalid enum default', "export function Button({ variant = 'filled' }: { variant?: 'primary' }) {}", /outside its declared enum/],
    ['undeclared destructuring', 'export function Button({ extra }: { label: string }) {}', /absent from the declared/],
    ['duplicate destructuring', 'export function Button({ label: a, label: b }: { label: string }) {}', /Duplicate props destructuring/],
    ['duplicate prop', 'export function Button(props: { label: string; label: number }) {}', /Duplicate prop/],
    ['syntax error', 'export function Button( {', /Invalid TypeScript source/],
  ])('rejects %s rather than producing a partial permissive contract', (_name, source, message) => {
    expect(() => compile(source)).toThrow(CompilerError);
    expect(() => compile(source)).toThrow(message);
  });

  it('reports source location for unsupported fields', () => {
    try {
      compile('export function Button(props: {\n  onClick: () => void;\n}) {}');
      expect.fail('Expected unsupported callback prop to fail compilation');
    } catch (error) {
      expect(error).toBeInstanceOf(CompilerError);
      expect(error).toMatchObject({ sourcePath, exportName: 'Button', line: 2, column: 12 });
      expect((error as Error).message).toContain('fixture/Button.tsx:2:12 (Button)');
    }
  });

  it('rejects invalid explicit identity through canonical contract validation', () => {
    expect(() => compile(fixtureSource, { componentId: 'invalid/id' })).toThrow(/Invalid component metadata/);
  });
});
