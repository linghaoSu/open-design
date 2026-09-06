import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { bundleComponentPreview } from '../../../src/services/design-runtime/preview-bundler.js';

// The daemon's existing DOM test runtime ships without TypeScript declarations.
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const source = `import {format} from './format'; import './card.css'; import logo from './logo.png';
type Props={user:{name:string};items:{label:string}[];onSelect:()=>void};
export default function Card({user,items,onSelect}:Props){return <button onClick={onSelect}><img src={logo}/>{format(user.name)}:{items.map(i=>i.label).join(',')}</button>}`;
const sources = new Map<string, Uint8Array>([
  ['src/Card.tsx', Buffer.from(source)], ['src/format.ts', Buffer.from('export const format=(value:string)=>value.toUpperCase()')],
  ['src/card.css', Buffer.from('button{color:red;background-image:url(./logo.png)}')], ['src/logo.png', Buffer.from([137,80,78,71,0,255,1])],
]);
const read = async (path: string) => { const value = sources.get(path); if (!value) throw new Error('Missing'); return value; };

describe('standalone component preview bundle', () => {
  it('provides the legacy React global before project top-level hooks and classes initialize', async () => {
    const sourceText = `const {useState}=React; class Label extends React.Component { render(){return <strong>{this.props.label}</strong>} }
export default function Card(){const [label]=useState('Global React');return <Label label={label}/>}`;
    const built = await bundleComponentPreview({ sourcePath: 'Global.jsx', sourceText, exportName: 'default', props: {}, callbacks: [] }, { readProjectSource: async () => { throw new Error('No imports'); } });
    expect(built.diagnostics).toEqual([]);
    const dom = new JSDOM('<div id="od-preview-root"></div>', { runScripts: 'outside-only' });
    try { dom.window.eval(built.bundle!.javascript); await vi.waitFor(() => expect(dom.window.document.querySelector('strong')?.textContent).toBe('Global React')); }
    finally { dom.window.close(); }
  });

  it('bundles actual local imports, CSS and binary assets without a registry or lock, then edits props and recovers from render errors', async () => {
    const built = await bundleComponentPreview({ sourcePath: 'src/Card.tsx', sourceText: source, exportName: 'default',
      props: { user: { name: 'Ada' }, items: [{ label: 'First' }], onSelect: null }, callbacks: [{ path: ['onSelect'], async: false }] },
    { readProjectSource: async (path) => Buffer.from(await read(path)).toString('utf8'), readProjectFile: read });
    expect(built.diagnostics).toEqual([]); expect(built.bundle).not.toBeNull();
    expect(built.sourceEvidence.some((item) => item.sourcePath === 'src/logo.png' && item.origin === 'current-project')).toBe(true);
    expect(built.bundle!.css).toContain('data:image/png;base64,');
    const dom = new JSDOM('<div id="od-preview-root"></div>', { runScripts: 'outside-only' });
    const report = vi.fn(); (dom.window as any).__OD_PREVIEW_REPORT__ = report;
    const log = vi.spyOn(dom.window.console, 'error').mockImplementation(() => {});
    try {
      dom.window.eval(built.bundle!.javascript);
      await vi.waitFor(() => expect(dom.window.document.querySelector('button')?.textContent).toBe('ADA:First'));
      dom.window.document.querySelector('button')!.click(); expect(report.mock.calls.some(([status]) => status === 'error')).toBe(false);
      (dom.window as any).__OD_COMPONENT_PREVIEW_UPDATE_PROPS__({ user: null, items: [], onSelect: null });
      await vi.waitFor(() => expect(report.mock.calls.some(([status]) => status === 'error')).toBe(true));
      (dom.window as any).__OD_COMPONENT_PREVIEW_UPDATE_PROPS__({ user: { name: 'Grace' }, items: [{ label: 'Second' }], onSelect: null });
      await vi.waitFor(() => expect(dom.window.document.querySelector('button')?.textContent).toBe('GRACE:Second'));
      expect(report.mock.calls.at(-1)?.[0]).toBe('rendered');
    } finally { log.mockRestore(); dom.window.close(); }
  });

  it('keeps prototype-named fields as own data and materializes only null callback paths, never source in the daemon', async () => {
    const component = `globalThis.__OD_COMPONENT_DAEMON_PROBE__='executed';
export function Named(props){return <p>{props.constructor.title}:{props.toString()}:{props.items[0].onValue()}</p>}`;
    const built = await bundleComponentPreview({ sourcePath: 'Named.jsx', sourceText: component, exportName: 'Named',
      props: JSON.parse('{"constructor":{"title":"Own"},"toString":null,"items":[{"onValue":null}]}'),
      callbacks: [{ path: ['toString'], async: false, returnValue: 'Callback' }, { path: ['items', 0, 'onValue'], async: false, returnValue: 7 }] },
    { readProjectSource: async () => { throw new Error('No imports'); } });
    expect(built.diagnostics).toEqual([]); expect((globalThis as any).__OD_COMPONENT_DAEMON_PROBE__).toBeUndefined();
    const dom = new JSDOM('<div id="od-preview-root"></div>', { runScripts: 'outside-only' });
    try { dom.window.eval(built.bundle!.javascript); await vi.waitFor(() => expect(dom.window.document.querySelector('p')?.textContent).toBe('Own:Callback:7')); }
    finally { dom.window.close(); }
  });
});
