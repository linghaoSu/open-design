import type { DesignSystemSourceFile } from '@open-design/contracts';
export const componentPreviewFiles = () => new Map<string, DesignSystemSourceFile>([
  ['Card.tsx', { path: 'Card.tsx', encoding: 'utf8', content: `import {format} from './format.ts'; import './card.css'; import logo from './logo.png';
export default function Card({title,items,onSelect}: {title:string;items:{name:string}[];onSelect:()=>void}){return <button onClick={onSelect}><img src={logo}/>{format(title)}:{items.map(item=>item.name).join(',')}</button>}` }],
  ['format.ts', { path: 'format.ts', encoding: 'utf8', content: 'export const format=(value:string)=>value.toUpperCase();' }],
  ['card.css', { path: 'card.css', encoding: 'utf8', content: 'button{color:red;background:url(./logo.png)}' }],
  ['logo.png', { path: 'logo.png', encoding: 'base64', content: Buffer.from([137,80,78,71,0,255,1]).toString('base64') }],
]);
