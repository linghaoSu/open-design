import type { DesignPreviewBundle } from '@open-design/contracts';

export const DESIGN_PREVIEW_CHANNEL = 'od-design-preview';
export type DesignPreviewRenderStatus = 'loading' | 'rendered' | 'error';
const encode = (value: string) => {
  const bytes = new TextEncoder().encode(value); let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
};
const decode = 'value=>new TextDecoder().decode(Uint8Array.from(atob(value),character=>character.charCodeAt(0)))';

/** The trusted outer frame's frame-src policy also blocks inner self-navigation.
 * Both frames remain opaque-origin sandboxes; runtime messages are telemetry only.
 */
export function designPreviewFrameDocument(bundle: DesignPreviewBundle, nonce: string): string {
  if (!/^[a-zA-Z0-9_-]{16,}$/.test(nonce)) throw new Error('Invalid preview frame identity.');
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'`;
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`;
  const message = `const report=(status,message)=>parent.postMessage({channel:${JSON.stringify(DESIGN_PREVIEW_CHANNEL)},nonce:${JSON.stringify(nonce)},status,message:String(message??'').slice(0,2000)},'*');`;
  const inner = `<!doctype html><html><head>${head}<style>html,body{margin:0;min-height:100%;}body{padding:16px;box-sizing:border-box}</style></head><body><div id="od-preview-root"></div><script nonce="${nonce}">
${message}
Object.defineProperty(globalThis,'__OD_PREVIEW_REPORT__',{value:report,writable:false,configurable:false});
addEventListener('error',event=>report('error',event.message||'A preview resource could not be loaded.'),true);
addEventListener('unhandledrejection',event=>report('error',String(event.reason)));
addEventListener('securitypolicyviolation',event=>report('error','Blocked preview capability: '+event.violatedDirective));
const decode=${decode};const style=document.createElement('style');style.textContent=decode(${JSON.stringify(encode(bundle.css))});document.head.appendChild(style);
const script=document.createElement('script');script.nonce=${JSON.stringify(nonce)};script.textContent=decode(${JSON.stringify(encode(bundle.javascript))});document.body.appendChild(script);
</script></body></html>`;
  return `<!doctype html><html><head>${head}<style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe data-preview-renderer sandbox="allow-scripts" title="Component renderer" referrerpolicy="no-referrer"></iframe><script nonce="${nonce}">
${message}
const frame=document.querySelector('iframe');
addEventListener('message',event=>{const value=event.data;if(event.source!==frame.contentWindow||event.origin!=='null'||!value||value.channel!==${JSON.stringify(DESIGN_PREVIEW_CHANNEL)}||value.nonce!==${JSON.stringify(nonce)}||!['rendered','error'].includes(value.status))return;report(value.status,value.message);});
addEventListener('securitypolicyviolation',event=>report('error','Blocked preview capability: '+event.violatedDirective));
let loads=0;frame.addEventListener('load',()=>{if(++loads>1)report('error','Preview navigation was blocked.');});
frame.srcdoc=(${decode})(${JSON.stringify(encode(inner))});
</script></body></html>`;
}
