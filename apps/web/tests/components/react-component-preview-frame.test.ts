import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { COMPONENT_PREVIEW_CHANNEL, reactComponentPreviewFrameDocument } from '../../src/components/react-component-preview-frame';
import { componentPreviewFixture } from '../helpers/react-component-preview-fixtures';

const nonce = 'component-preview-test-identity';
const hostOrigin = 'https://preview-host.example';
const envelope = { channel: COMPONENT_PREVIEW_CHANNEL, nonce };
function bridgeHarness(documentText: string) {
  const listeners: Record<string, ((event: Record<string, unknown>) => void)[]> = {};
  const parent = { postMessage: vi.fn() };
  const renderer = { postMessage: vi.fn() };
  const frame = { srcdoc: '', contentWindow: renderer, addEventListener: vi.fn() };
  const context = createContext({ parent, TextDecoder, Uint8Array, atob, btoa,
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => (listeners[type] ??= []).push(listener),
    document: {
      querySelector: () => frame, createElement: (tag: string) => ({ tag, textContent: '' }),
      head: { appendChild: vi.fn() },
      body: { appendChild: (element: { tag: string; textContent: string }) => { if (element.tag === 'script') runInContext(element.textContent, context); } },
    },
  });
  const script = documentText.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]!;
  runInContext(script, context);
  return { context, parent, renderer, frame, message: (event: Record<string, unknown>) => listeners.message?.forEach((listener) => listener(event)) };
}

describe('component preview sandbox transport', () => {
  it('encodes project bytes and the host origin, preserves downloads, and prevents same-origin or network access', () => {
    const bundle = componentPreviewFixture().bundle!;
    bundle.javascript = 'globalThis.value="</script><img src=https://unsafe.example>你好";';
    const document = reactComponentPreviewFrameDocument(bundle, nonce, '</script><img src=https://unsafe-host.example>');
    expect(document).not.toContain('https://unsafe'); expect(document).not.toContain('</script><img');
    expect(document).toContain('sandbox="allow-scripts allow-downloads"'); expect(document).not.toContain('allow-same-origin');
    expect(document).toContain("connect-src 'none'"); expect(document).toContain("frame-src 'none'");
    expect(() => reactComponentPreviewFrameDocument(bundle, 'bad"nonce', hostOrigin)).toThrow();
  });
  it('authenticates both directions and queues the latest JSON props until the renderer is ready', () => {
    const bridge = bridgeHarness(reactComponentPreviewFrameDocument(componentPreviewFixture().bundle!, nonce, hostOrigin));
    const update = { ...envelope, type: 'props', revision: 1, props: { title: 'Latest' } };
    bridge.message({ source: {}, origin: hostOrigin, data: update });
    bridge.message({ source: bridge.parent, origin: 'null', data: update });
    bridge.message({ source: bridge.parent, origin: hostOrigin, data: { ...update, nonce: 'stale' } });
    bridge.message({ source: bridge.parent, origin: hostOrigin, data: update });
    expect(bridge.renderer.postMessage).not.toHaveBeenCalled();
    bridge.message({ source: {}, origin: 'null', data: { ...envelope, status: 'ready' } });
    expect(bridge.renderer.postMessage).not.toHaveBeenCalled();
    bridge.message({ source: bridge.renderer, origin: 'null', data: { ...envelope, status: 'ready' } });
    expect(bridge.renderer.postMessage).toHaveBeenCalledExactlyOnceWith(update, '*');
    bridge.message({ source: bridge.renderer, origin: 'null', data: { ...envelope, revision: 0, status: 'error' } });
    expect(bridge.parent.postMessage).not.toHaveBeenCalled();
    bridge.message({ source: bridge.renderer, origin: 'null', data: { ...envelope, revision: 1, status: 'rendered' } });
    expect(bridge.parent.postMessage).toHaveBeenCalledWith({ ...envelope, revision: 1, status: 'rendered', message: '' }, '*');
  });
  it('updates only from its opaque parent, passes data as JSON, and binds render status to the active update', () => {
    const bundle = { ...componentPreviewFixture().bundle!, javascript: 'globalThis.received=[];globalThis.__OD_COMPONENT_PREVIEW_UPDATE_PROPS__=props=>{received.push(props);__OD_PREVIEW_REPORT__("rendered")};' };
    const outer = bridgeHarness(reactComponentPreviewFrameDocument(bundle, nonce, hostOrigin));
    const inner = bridgeHarness(outer.frame.srcdoc);
    expect(inner.parent.postMessage).toHaveBeenCalledWith({ ...envelope, revision: 0, status: 'ready', message: '' }, '*');
    inner.parent.postMessage.mockClear();
    const update = { ...envelope, type: 'props', revision: 1, props: { value: '() => globalThis.executed = true', onClick: null } };
    inner.message({ source: {}, origin: 'null', data: update }); inner.message({ source: inner.parent, origin: hostOrigin, data: update });
    expect(inner.context.received).toEqual([]);
    inner.message({ source: inner.parent, origin: 'null', data: update });
    expect(inner.context.received).toEqual([update.props]); expect(inner.context.executed).toBeUndefined();
    inner.message({ source: inner.parent, origin: 'null', data: update });
    expect(inner.context.received).toHaveLength(1);
    expect(inner.parent.postMessage).toHaveBeenCalledExactlyOnceWith({ ...envelope, revision: 1, status: 'rendered', message: '' }, '*');
    expect(Object.getOwnPropertyDescriptor(inner.context, '__OD_PREVIEW_REPORT__')?.writable).toBe(false);
  });
});
