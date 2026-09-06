import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { bundleComponentPreview } from '../../../src/services/design-runtime/preview-bundler.js';
import { createComponentPreviewService } from '../../../src/services/design-runtime/component-preview.js';

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
  it('renders CSS Module class mappings and keeps ordinary CSS global', async () => {
    const sourceText = `import {forwardRef} from 'react';import styles from './button.module.css';import other from './badge.module.css';import './global.css';
export const Button=forwardRef(function Button({children},ref){return <button ref={ref} className={styles.button+' '+styles.primary}><span className={other.button}>{children}</span></button>});`;
    const files = new Map([
      ['button.module.css', '.button{display:inline-flex;height:36px}.primary{background-color:rgb(30,40,50)}'],
      ['badge.module.css', '.button{color:rgb(70,80,90)}'],
      ['global.css', 'button{border-radius:7px}'],
    ]);
    const built = await bundleComponentPreview({ sourcePath: 'Button.tsx', sourceText, exportName: 'Button', props: { children: 'Styled button' }, callbacks: [] },
      { readProjectSource: async (path) => { const value = files.get(path); if (value === undefined) throw new Error('Missing'); return value; } });
    expect(built.diagnostics).toEqual([]); expect(built.bundle).not.toBeNull();
    const dom = new JSDOM('<div id="od-preview-root"></div>', { runScripts: 'outside-only' });
    try {
      const style = dom.window.document.createElement('style'); style.textContent = built.bundle!.css; dom.window.document.head.append(style);
      dom.window.eval(built.bundle!.javascript);
      await vi.waitFor(() => expect(dom.window.document.querySelector('button')?.textContent).toBe('Styled button'));
      const button = dom.window.document.querySelector('button')!; const badge = button.querySelector('span')!;
      expect(button.className).not.toContain('undefined'); expect(button.classList).toHaveLength(2);
      expect([...button.classList]).not.toContain(badge.className);
      expect(dom.window.getComputedStyle(button).display).toBe('inline-flex');
      expect(dom.window.getComputedStyle(button).height).toBe('36px');
      expect(dom.window.getComputedStyle(button).backgroundColor).toBe('rgb(30, 40, 50)');
      expect(dom.window.getComputedStyle(button).borderRadius).toBe('7px');
      expect(dom.window.getComputedStyle(badge).color).toBe('rgb(70, 80, 90)');
      for (const path of files.keys()) expect(built.sourceEvidence.some((item) => item.sourcePath === path && item.origin === 'current-project')).toBe(true);
    } finally { dom.window.close(); }
  });

  it('reports missing Provider context and renders a real local wrapper with imported props and editable JSON overrides', async () => {
    const files = new Map([
      ['types.ts', `export type CardProps={items:{label:string}[];variant:'compact'|'wide'};`],
      ['theme.ts', `import {createContext} from 'react';export const Theme=createContext<{color:string}|null>(null);`],
      ['Card.tsx', `import React,{memo,useContext} from 'react';import {Theme} from './theme';import type {CardProps} from './types';
export default memo(function Card(props:CardProps){const theme=useContext(Theme);if(!theme)throw new Error('Card requires ThemeProvider');return <p style={{color:theme.color}}>{props.items.map(item=>item.label).join(',')}:{props.variant}</p>});`],
      ['CardPreview.tsx', `import React from 'react';import Card from './Card';import {Theme} from './theme';import type {CardProps} from './types';
export default function CardPreview(props:CardProps){return <Theme.Provider value={{color:'red'}}><Card {...props}/></Theme.Provider>}`],
    ]);
    const service = createComponentPreviewService({ acquireAuthority: async () => ({
      readSourceFile: async (path) => { const content = files.get(path); if (content === undefined) throw new Error('Missing'); return { path, encoding: 'utf8', content }; },
      assertCurrent: async () => {}, assertCurrentSync: () => {},
    }) });
    const props = { items: [{ label: 'Actual item' }], variant: 'compact' };
    const naked = await service.componentPreview('project', { sourcePath: 'Card.tsx', props });
    const wrapped = await service.componentPreview('project', { sourcePath: 'CardPreview.tsx', props });
    expect(naked.bundle).not.toBeNull(); expect(wrapped.bundle).not.toBeNull();
    expect(wrapped.diagnostics.some((entry) => entry.message.includes('unresolved'))).toBe(true);
    const dom = new JSDOM('<div id="od-preview-root"></div>', { runScripts: 'outside-only' });
    const report = vi.fn(); dom.window.__OD_PREVIEW_REPORT__ = report;
    const log = vi.spyOn(dom.window.console, 'error').mockImplementation(() => {});
    try {
      dom.window.eval(naked.bundle!.javascript);
      await vi.waitFor(() => expect(report).toHaveBeenCalledWith('error', expect.stringContaining('ThemeProvider')));
      expect(report.mock.calls.some(([status]) => status === 'rendered')).toBe(false);
    } finally { log.mockRestore(); dom.window.close(); }
    const preview = new JSDOM('<div id="od-preview-root"></div>', { runScripts: 'outside-only' });
    const updates = vi.fn(); preview.window.__OD_PREVIEW_REPORT__ = updates;
    const quiet = vi.spyOn(preview.window.console, 'error').mockImplementation(() => {});
    try {
      preview.window.eval(wrapped.bundle!.javascript);
      await vi.waitFor(() => expect(preview.window.document.querySelector('p')?.textContent).toBe('Actual item:compact'));
      preview.window.__OD_COMPONENT_PREVIEW_UPDATE_PROPS__({ items: [null], variant: 'wide' });
      await vi.waitFor(() => expect(updates.mock.calls.some(([status]) => status === 'error')).toBe(true));
      preview.window.__OD_COMPONENT_PREVIEW_UPDATE_PROPS__({ items: [{ label: 'Recovered' }], variant: 'wide' });
      await vi.waitFor(() => expect(preview.window.document.querySelector('p')?.textContent).toBe('Recovered:wide'));
      expect(updates.mock.calls.at(-1)?.[0]).toBe('rendered');
    } finally { quiet.mockRestore(); preview.window.close(); }
  });
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
