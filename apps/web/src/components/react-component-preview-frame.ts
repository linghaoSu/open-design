import type { DesignPreviewBundle } from '@open-design/contracts';

export const COMPONENT_PREVIEW_CHANNEL = 'od-component-preview';
const encode = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return btoa(binary);
};
const decode = 'value=>new TextDecoder().decode(Uint8Array.from(atob(value),character=>character.charCodeAt(0)))';

/** Only JSON props cross the two opaque sandboxes. Project code never receives host objects. */
export function reactComponentPreviewFrameDocument(bundle: DesignPreviewBundle, nonce: string, parentOrigin: string): string {
  if (!/^[a-zA-Z0-9_-]{16,}$/.test(nonce)) throw new Error('Invalid component preview identity.');
  const channel = JSON.stringify(COMPONENT_PREVIEW_CHANNEL);
  const identity = JSON.stringify(nonce);
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'`;
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`;
  const envelope = `value&&value.channel===${channel}&&value.nonce===${identity}`;
  const report = `const report=(status,message)=>parent.postMessage({channel:${channel},nonce:${identity},revision,status,message:String(message??'').slice(0,2000)},'*');`;
  const inner = `<!doctype html><html><head>${head}<style>html,body{margin:0;min-height:100%}body{padding:16px;box-sizing:border-box}</style></head><body><div id="od-preview-root"></div><script nonce="${nonce}">
let revision=0;${report}
Object.defineProperty(globalThis,'__OD_PREVIEW_REPORT__',{value:report,writable:false,configurable:false});
addEventListener('message',event=>{const value=event.data;if(event.source!==parent||event.origin!=='null'||!(${envelope})||value.type!=='props'||!Number.isSafeInteger(value.revision)||value.revision<=revision||!value.props||typeof value.props!=='object'||Array.isArray(value.props))return;revision=value.revision;try{globalThis.__OD_COMPONENT_PREVIEW_UPDATE_PROPS__(JSON.parse(JSON.stringify(value.props)));}catch(error){report('error',error instanceof Error?error.message:String(error));}});
addEventListener('error',event=>report('error',event.message||'A preview resource could not be loaded.'),true);
addEventListener('unhandledrejection',event=>report('error',String(event.reason)));
addEventListener('securitypolicyviolation',event=>report('error','Blocked preview capability: '+event.violatedDirective));
const decode=${decode};const style=document.createElement('style');style.textContent=decode(${JSON.stringify(encode(bundle.css))});document.head.appendChild(style);
const script=document.createElement('script');script.nonce=${identity};script.textContent=decode(${JSON.stringify(encode(bundle.javascript))});document.body.appendChild(script);
report('ready');
</script></body></html>`;
  return `<!doctype html><html><head>${head}<style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><iframe data-preview-renderer sandbox="allow-scripts allow-downloads" title="Component renderer" referrerpolicy="no-referrer"></iframe><script nonce="${nonce}">
let revision=0;${report}
const frame=document.querySelector('iframe');let ready=false;let pending=null;
const parentOrigin=(${decode})(${JSON.stringify(encode(parentOrigin))});
addEventListener('message',event=>{const value=event.data;if(!(${envelope}))return;
if(event.source===parent&&event.origin===parentOrigin&&value.type==='props'&&Number.isSafeInteger(value.revision)&&value.revision>revision&&value.props&&typeof value.props==='object'&&!Array.isArray(value.props)){revision=value.revision;pending=value;if(ready)frame.contentWindow.postMessage(value,'*');return;}
if(event.source!==frame.contentWindow||event.origin!=='null')return;
if(value.status==='ready'){ready=true;if(pending)frame.contentWindow.postMessage(pending,'*');return;}
if(value.revision===revision&&['rendered','error'].includes(value.status))report(value.status,value.message);
});
addEventListener('securitypolicyviolation',event=>report('error','Blocked preview capability: '+event.violatedDirective));
let loads=0;frame.addEventListener('load',()=>{if(++loads>1)report('error','Preview navigation was blocked.');});
frame.srcdoc=(${decode})(${JSON.stringify(encode(inner))});
</script></body></html>`;
}
