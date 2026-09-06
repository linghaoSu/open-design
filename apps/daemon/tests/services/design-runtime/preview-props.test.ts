import { describe, expect, it } from 'vitest';
import { analyzeComponentPreviewSource } from '../../../src/services/design-runtime/preview-props.js';

const analyze = (sourceText: string, extra: { exportName?: string; props?: Record<string, import('@open-design/contracts').JsonValue> } = {}) => analyzeComponentPreviewSource({ sourceText, sourcePath: 'Card.tsx', ...extra });

describe('preview-only static prop analysis', () => {
  it('selects JSX component exports instead of preceding metadata and respects explicit named selection', () => {
    const source = `export const metadata = { name: 'card' }; export function Card({title = 'Hello'}) { return <h1>{title}</h1>; } export const Other = ({count = 2}) => <p>{count}</p>;`;
    expect(analyze(source)).toMatchObject({ exports: ['Card', 'Other'], selectedExport: 'Card', mockProps: {}, controls: [{ name: 'title', hasDefault: true, defaultValue: 'Hello', provenance: 'default' }] });
    expect(analyze(source, { exportName: 'Other' }).selectedExport).toBe('Other');
    expect(analyze(source, { exportName: 'metadata' })).toMatchObject({ selectedExport: null, diagnostics: [{ severity: 'error' }] });
  });

  it.each(['', ': {title:string;count:number;active:boolean;onAction:()=>void}'])('allows source-defaulted preview inputs to be omitted with annotation %s', (annotation) => {
    const result = analyze(`export function PlainCard({title='JSX default title',count=2,active=true,onAction}${annotation}) { return <article><h1>{title}</h1><p>Count {count} {active ? 'Active' : 'Inactive'}</p><button onClick={()=>onAction()}>Run action</button></article>; }`);
    expect(result.controls.filter((entry) => entry.hasDefault).map(({ name, required, defaultValue }) => ({ name, required, defaultValue }))).toEqual([
      { name: 'title', required: false, defaultValue: 'JSX default title' },
      { name: 'count', required: false, defaultValue: 2 },
      { name: 'active', required: false, defaultValue: true },
    ]);
    expect(result.controls.find((entry) => entry.name === 'onAction')).toMatchObject({ required: true, hasDefault: false });
    expect(result.effectiveProps).toEqual({ onAction: null });
  });

  it('mocks typed interfaces, nested arrays/objects and callbacks while preserving enum and parameter defaults', () => {
    const source = `interface Order { id:string; label:string; amount:number } type Props = { title:string; user:{name:string;online:boolean}; items:Order[]; variant?:'compact'|'comfortable'; count?:number; onSelect:(id:string)=>void };
      export default function Orders({title,user,items,variant='comfortable',count=3,onSelect}:Props) {return <article><h1>{title}</h1><p>{user.name}</p>{items.map(item=><button onClick={()=>onSelect(item.id)}>{item.label}</button>)}</article>}`;
    const result = analyze(source);
    expect(result.selectedExport).toBe('default'); expect(result.diagnostics).toEqual([]);
    expect(result.mockProps).toMatchObject({ title: 'Preview title', user: { name: 'Preview user name', online: true }, items: [{ id: 'Preview items 0 id', amount: 1 }, { id: 'Preview items 1 id', amount: 1 }], onSelect: null });
    expect(result.mockProps).not.toHaveProperty('variant'); expect(result.mockProps).not.toHaveProperty('count');
    expect(result.controls.find((entry) => entry.name === 'variant')).toMatchObject({ kind: 'enum', options: ['compact', 'comfortable'], hasDefault: true, defaultValue: 'comfortable' });
    expect(result.callbacks).toEqual([{ path: ['onSelect'], async: false }]);
  });

  it('recognizes same-file named/default export aliases without evaluating source', () => {
    const result = analyze(`throw new Error('do not execute'); const Card = ({label = globalThis.neverCall()}) => <h1>{label}</h1>; export {Card as Named}; export default Card;`);
    expect(result.exports).toEqual(['Named', 'default']); expect(result.selectedExport).toBe('default'); expect(result.mockProps).toEqual({});
    expect(result.controls[0]).toMatchObject({ name: 'label', hasDefault: true });
    expect(result.diagnostics.some((entry) => entry.message.includes('never evaluated'))).toBe(true);
  });

  it('infers plain JSX nested object and map item fields from their bound usages, with actionable callbacks', () => {
    const result = analyze(`export function Card({user,items,onAction}) { return <article><h1>{user.name}</h1><p>{user.online ? 'yes':'no'}</p>{items.map(item=><span>{item.label} {item.amount.toFixed(2)}</span>)}<button onClick={()=>onAction('clicked')}>Act</button></article> }`);
    expect(result.diagnostics).toEqual([]);
    expect(result.mockProps).toMatchObject({ user: { name: 'Preview user name', online: true }, items: [{ label: 'Preview items 0 label', amount: 1 }, { label: 'Preview items 1 label', amount: 1 }], onAction: null });
    expect(result.controls.every((entry) => entry.provenance === 'usage')).toBe(true);
    expect(result.callbacks).toEqual([{ path: ['onAction'], async: false }]);
  });

  it('tracks parameter aliases and local object aliases without confusing shadowed callback parameters', () => {
    const result = analyze(`export const Card = ({user:person, unused}) => { const alias = person; function helper(unused) { return unused.dangerous(); } const local = [1].map(person => person.toFixed(2)); return <p>{alias.name}</p>; };`);
    expect(result.mockProps).toEqual({ user: { name: 'Preview user name' } });
    expect(result.controls.find((entry) => entry.name === 'unused')).toMatchObject({ kind: 'unknown', provenance: 'unknown' });
    expect(result.callbacks).toEqual([]);
  });

  it('extracts literal defaultProps and destructuring defaults but leaves them to the actual component runtime', () => {
    const result = analyze(`function Card({title, options = {dense:true}, list = ['a','b']}) { return <h1>{title}</h1>; } Card.defaultProps = { title:'Existing title' }; export default Card;`);
    expect(result.mockProps).toEqual({});
    expect(result.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'title', hasDefault: true, defaultValue: 'Existing title' }),
      expect.objectContaining({ name: 'options', kind: 'object', defaultValue: { dense: true } }),
      expect.objectContaining({ name: 'list', kind: 'array', defaultValue: ['a', 'b'] }),
    ]));
  });

  it('produces nested typed callback placeholders including an async static return shape', () => {
    const result = analyze(`type Props={api:{fetch:()=>Promise<{title:string}>, onDone:()=>boolean}, actions:Array<{run:()=>number}>}; export const Card=({api,actions}:Props)=><p>Card</p>`);
    expect(result.callbacks).toEqual([
      { path: ['api', 'fetch'], async: true, returnValue: { title: 'Preview api fetch returnValue title' } },
      { path: ['api', 'onDone'], async: false, returnValue: true },
      { path: ['actions', 0, 'run'], async: false, returnValue: 1 }, { path: ['actions', 1, 'run'], async: false, returnValue: 1 },
    ]);
    expect(result.mockProps.api).toEqual({ fetch: null, onDone: null });
  });

  it('lets explicit JSON override mocks and defaults, suppressing callbacks under complete replaced props', () => {
    const result = analyze(`type Props={title?:string; onClick:()=>void; api:{run:()=>boolean}}; export const Card=({title='Existing',onClick,api}:Props)=><p>{title}</p>`, { props: { title: 'Changed', onClick: null, api: { run: 'authored' }, custom: 42 } });
    expect(result.effectiveProps).toEqual({ title: 'Changed', onClick: null, api: { run: 'authored' }, custom: 42 });
    expect(result.callbacks).toEqual([]); expect(result.mockProps).toEqual({ onClick: null, api: { run: null } });
  });

  it('diagnoses unknown imported types and cycles without loading imports or pretending to know shapes', () => {
    const result = analyze(`import type {Unknown} from './no-read'; type Recursive={next:Recursive}; export const Card=({value,recursive}:{value:Unknown,recursive:Recursive})=><div/>;`);
    expect(result.diagnostics.filter((entry) => entry.message.includes('unresolved'))).toHaveLength(2);
    expect(result.controls.find((entry) => entry.name === 'value')).toMatchObject({ kind: 'unknown', provenance: 'unknown' });
    expect(result.mockProps).toEqual({ recursive: {} });
  });

  it('retains contradictory usage as unknown instead of fabricating a single safe type', () => {
    const result = analyze(`export function Card({data}) { data(); return <p>{data.name}</p>; }`);
    expect(result.controls[0]).toMatchObject({ kind: 'unknown', provenance: 'unknown' });
    expect(result.diagnostics.some((entry) => entry.message.includes('Conflicting'))).toBe(true);
  });

  it('preserves legal prototype-like own keys and rejects reserved paths and executable overrides', () => {
    const result = analyze(`export const Card=({constructor,toString}:{constructor:string,toString:()=>void})=><p>{constructor}</p>;`);
    expect(Object.hasOwn(result.effectiveProps, 'constructor')).toBe(true); expect(result.effectiveProps['constructor']).toBe('Preview constructor');
    expect(result.callbacks).toEqual([{ path: ['toString'], async: false }]);
    expect(() => analyze(`export const Card=()=> <p/>`, { props: JSON.parse('{"__proto__":{"polluted":true}}') })).toThrow();
    expect(analyze(`export const Card=()=> <p/>`, { props: { callback: 'globalThis.secret()' } }).effectiveProps.callback).toBe('globalThis.secret()');
  });

  it('returns an actionable parse/unavailable selection result without a manufactured component', () => {
    expect(analyze(`export const metadata = { title:'No component' };`)).toMatchObject({ exports: [], selectedExport: null, diagnostics: [{ severity: 'error' }] });
    expect(analyze(`export function Broken(`)).toMatchObject({ exports: [], selectedExport: null, diagnostics: [{ severity: 'error' }] });
  });

  it('discovers imported React wrapper aliases and typed React.FC without evaluating wrappers', () => {
    const source = `import React, {memo as keep, forwardRef as withRef} from 'react'; type Props={label:string,items:number[]};
      const Card: React.FC<Props> = ({label,items}) => <p>{label}</p>; export default keep(Card);
      export const RefCard = withRef<HTMLDivElement,Props>((props, ref) => <div ref={ref}>{props.label}</div>);`;
    const result = analyze(source);
    expect(result.exports).toEqual(['default', 'RefCard']); expect(result.mockProps).toEqual({ label: 'Preview label', items: [1, 1] });
    expect(result.controls.every((entry) => entry.provenance === 'typescript')).toBe(true);
    expect(analyze(source, { exportName: 'RefCard' }).controls).toEqual(result.controls);
    expect(analyze(`const memo = (value) => value; const Card = ()=> <p/>; export default memo(Card);`).selectedExport).toBeNull();
  });

  it('preserves standard typed React class and null/createElement callable exports', () => {
    const result = analyze(`import React,{PureComponent} from 'react'; type Props={title:string;user:{name:string}}; export default class Card extends PureComponent<Props> { render(){return <p>{this.props.title} {this.props.user.name}</p>;} }`);
    expect(result.mockProps).toEqual({ title: 'Preview title', user: { name: 'Preview user name' } });
    expect(result.diagnostics).toEqual([]);
    expect(analyze(`import React from 'react'; export const metadata = 2; export function Nothing(){ return null; } export default function Card(){ return React.createElement('p',null,'Card'); }`).exports).toEqual(['Nothing', 'default']);
    expect(analyze(`export default class Metadata {render(){return <p/>;}}`).selectedExport).toBeNull();
    expect(analyze(`export default class Card extends React.Component { static defaultProps={title:'Class default'}; render(){return <p>{this.props.title}</p>} }`)).toMatchObject({ selectedExport: 'default', mockProps: {}, controls: [{ name: 'title', hasDefault: true, defaultValue: 'Class default' }] });
    expect(analyze(`const React={Component:class{}}; export default class Card extends React.Component {render(){return <p/>}}`).selectedExport).toBeNull();
    expect(analyze(`const Card=({title='Parameter'})=><p>{title}</p>; Card.defaultProps={title:'First'}; Card.defaultProps={title:'Last'}; export default Card;`).controls[0]).toMatchObject({ defaultValue: 'Last' });
  });
});
