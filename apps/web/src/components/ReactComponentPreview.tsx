import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import {
  ComponentPreviewPropsSchema, type ComponentPreviewControl, type ComponentPreviewResponse,
  type DesignPreviewBundle, type JsonValue, type WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { createReactComponentPreview } from '../providers/react-component-preview';
import { useT } from '../i18n';
import { PreviewDrawOverlay } from './PreviewDrawOverlay';
import { COMPONENT_PREVIEW_CHANNEL, reactComponentPreviewFrameDocument } from './react-component-preview-frame';
import styles from './ReactComponentPreview.module.css';

type PreviewProps = Record<string, JsonValue>;
interface Props {
  projectId: string;
  sourcePath: string;
  sourceIdentity: string;
  workspaceContext: WorkspaceCollabContext | null;
  componentPreviewRequest?: { exportName?: string; nonce: number } | null;
  layout?: 'workspace' | 'component';
}

function RuntimeFrame({ bundle, values, retry, title, onRetry, onEditProps }: { bundle: DesignPreviewBundle; values: PreviewProps; retry: number; title: string; onRetry?: () => void; onEditProps: () => void }) {
  const t = useT();
  const ref = useRef<HTMLIFrameElement>(null);
  const nonce = useMemo(() => crypto.randomUUID(), []);
  const srcDoc = useMemo(() => reactComponentPreviewFrameDocument(bundle, nonce, window.location.origin), [bundle, nonce]);
  const current = useRef({ revision: 0, props: values });
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<'loading' | 'rendered' | 'error'>('loading');
  const [error, setError] = useState('');
  const send = () => ref.current?.contentWindow?.postMessage({ channel: COMPONENT_PREVIEW_CHANNEL, nonce, type: 'props', ...current.current }, '*');

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.source !== ref.current?.contentWindow || event.origin !== 'null' || !data || typeof data !== 'object') return;
      const value = data as Record<string, unknown>;
      if (value.channel !== COMPONENT_PREVIEW_CHANNEL || value.nonce !== nonce || value.revision !== current.current.revision) return;
      if (value.status === 'error') {
        setStatus('error'); setError(typeof value.message === 'string' ? value.message.slice(0, 2000) : t('reactPreview.runtimeError'));
      } else if (value.status === 'rendered') setStatus((old) => old === 'error' ? old : 'rendered');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [nonce, t]);
  useEffect(() => {
    current.current = { revision: current.current.revision + 1, props: values };
    setRevision(current.current.revision); setStatus('loading'); setError(''); send();
  }, [values, retry]);
  useEffect(() => {
    if (status !== 'loading') return;
    const timer = window.setTimeout(() => { setStatus('error'); setError(t('reactPreview.timeout')); }, 15000);
    return () => window.clearTimeout(timer);
  }, [revision, status, t]);

  return <div className={styles.runtime}>
    <p className={styles.status} role="status" data-testid="react-component-preview-status" data-status={status}>{t(`reactPreview.${status}`)}</p>
    {error ? <div className={styles.runtimeError}><p className={styles.error} role="alert">{error}</p><p className={styles.recoveryHint}>{t('reactPreview.recoveryHint')}</p><Button className={styles.compactAction} onClick={onEditProps}>{t('reactPreview.editJson')}</Button>{onRetry ? <Button className={styles.compactAction} onClick={onRetry}>{t('reactPreview.retry')}</Button> : null}</div> : null}
    <div className={styles.canvas}><PreviewDrawOverlay><iframe ref={ref} title={title}
      data-testid="react-component-preview-frame" sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer"
      className={styles.frame} srcDoc={srcDoc} onLoad={send} /></PreviewDrawOverlay></div>
  </div>;
}

function editorText(control: ComponentPreviewControl, value: JsonValue | undefined): string {
  if (value === undefined) return '';
  return control.kind === 'string' || control.kind === 'react-node' ? String(value) : control.kind === 'enum' ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

function editorDrafts(controls: ComponentPreviewControl[], values: PreviewProps): Record<string, string> {
  return Object.fromEntries(controls.filter((control) => Object.hasOwn(values, control.name)).map((control) => [control.name, editorText(control, values[control.name])]));
}

export function ReactComponentPreview(props: Props) {
  const identity = JSON.stringify([props.projectId, workspaceAccountScopedCacheKey(props.workspaceContext), props.sourcePath, props.sourceIdentity, props.componentPreviewRequest?.nonce, props.componentPreviewRequest?.exportName]);
  return <PreviewContent key={identity} {...props} />;
}

function PreviewContent({ projectId, sourcePath, workspaceContext, componentPreviewRequest, layout = 'workspace' }: Props) {
  const t = useT();
  const editorId = useId();
  const [exportName, setExportName] = useState<string | undefined>(componentPreviewRequest?.exportName);
  const [result, setResult] = useState<ComponentPreviewResponse | null>(null);
  const [values, setValues] = useState<PreviewProps>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const [invalidJson, setInvalidJson] = useState(false);
  const lastValidJson = useRef<string | null>(null);
  const previewDetails = useRef<HTMLDetailsElement>(null);
  const jsonEditor = useRef<HTMLTextAreaElement>(null);
  const [failure, setFailure] = useState('');
  const [retry, setRetry] = useState(0);
  const [buildRetry, setBuildRetry] = useState(0);
  const [busy, setBusy] = useState(true);
  const scopeRef = useRef(workspaceContext); scopeRef.current = workspaceContext;

  useEffect(() => {
    const controller = new AbortController(); let canceled = false;
    setBusy(true); setFailure(''); setResult(null); setDrafts({}); setInvalid({}); setJsonDraft(null); setInvalidJson(false);
    lastValidJson.current = null;
    void createReactComponentPreview({ projectId, workspaceContext: scopeRef.current, signal: controller.signal }, { sourcePath, ...(exportName ? { exportName } : {}) })
      .then((response) => { if (!canceled) { setResult(response); setValues(response.effectiveProps); } })
      .catch((error: unknown) => { if (!canceled) setFailure(error instanceof Error ? error.message : t('reactPreview.failed')); })
      .finally(() => { if (!canceled) setBusy(false); });
    return () => { canceled = true; controller.abort(); };
  }, [projectId, sourcePath, exportName, buildRetry, t]);

  function change(control: ComponentPreviewControl, text: string) {
    if (invalidJson) return;
    setJsonDraft(null); setInvalidJson(false);
    lastValidJson.current = null;
    setDrafts((old) => ({ ...old, [control.name]: text }));
    try {
      let value: JsonValue;
      if (control.kind === 'string' || control.kind === 'react-node') value = text;
      else {
        value = JSON.parse(text) as JsonValue;
        if (control.kind === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error();
        if (control.kind === 'boolean' && typeof value !== 'boolean') throw new Error();
      }
      const parsed = ComponentPreviewPropsSchema.parse({ [control.name]: value });
      setInvalid((old) => ({ ...old, [control.name]: false }));
      setValues((old) => ({ ...old, ...parsed }));
    } catch { setInvalid((old) => ({ ...old, [control.name]: true })); }
  }
  function resetProp(name: string) {
    if (invalidJson) return;
    setJsonDraft(null); setInvalidJson(false);
    lastValidJson.current = null;
    setDrafts((old) => { const next = { ...old }; delete next[name]; return next; });
    setInvalid((old) => ({ ...old, [name]: false }));
    setValues((old) => { const next = { ...old }; if (result && Object.hasOwn(result.effectiveProps, name)) next[name] = result.effectiveProps[name]!; else delete next[name]; return next; });
  }
  const reset = () => { setValues({ ...result?.effectiveProps }); setDrafts({}); setInvalid({}); setJsonDraft(null); setInvalidJson(false); lastValidJson.current = null; setRetry((old) => old + 1); };
  function changeJson(text: string) {
    setJsonDraft(text);
    try {
      const parsed = ComponentPreviewPropsSchema.parse(JSON.parse(text));
      setValues(parsed); setInvalidJson(false); setInvalid({});
      lastValidJson.current = text;
      setDrafts(editorDrafts(result?.controls ?? [], parsed));
    } catch { setInvalidJson(true); }
  }
  const restoreJson = () => {
    setJsonDraft(lastValidJson.current ?? JSON.stringify(values, null, 2)); setInvalidJson(false);
    setDrafts(editorDrafts(result?.controls ?? [], values)); setInvalid({});
    jsonEditor.current?.focus();
  };
  const editJson = () => { if (previewDetails.current) previewDetails.current.open = true; jsonEditor.current?.focus(); };
  const retryPreview = () => result?.bundle ? setRetry((old) => old + 1) : setBuildRetry((old) => old + 1);
  const valueOrigin = (control: ComponentPreviewControl) => control.hasDefault && !Object.hasOwn(values, control.name) ? t('reactPreview.sourceDefault') : Object.hasOwn(drafts, control.name) ? t('reactPreview.edited') : Object.hasOwn(values, control.name) ? t('reactPreview.sample') : t('reactPreview.unset');
  const exportSelector = <label className={styles.export}>{t('reactPreview.export')}<select aria-label={t('reactPreview.export')} value={exportName ?? result?.selectedExport ?? ''} disabled={busy || invalidJson || !result?.exports.length} onChange={(event) => { if (!invalidJson) setExportName(event.target.value); }}>
    {exportName && !result?.exports.includes(exportName) ? <option value={exportName}>{exportName}</option> : null}
    {!result?.exports.length ? <option value="">—</option> : result.exports.map((name) => <option key={name} value={name}>{name}</option>)}
  </select></label>;

  return <section className={`${styles.panel}${layout === 'component' ? ` ${styles.component}` : ''}`} data-testid="react-component-preview" data-layout={layout}>
    {layout === 'workspace' ? <div className={styles.toolbar}>
      {exportSelector}
      <Button disabled={!result?.bundle} onClick={reset}>{t('reactPreview.reset')}</Button>
      <Button disabled={busy} onClick={retryPreview}>{t('reactPreview.retry')}</Button>
    </div> : null}
    {busy ? <p role="status">{t('reactPreview.building')}</p> : null}
    {failure ? <p role="alert" className={styles.error}>{failure}</p> : null}
    {result ? <>
      {layout === 'workspace' ? <p className={styles.hint}>{t('reactPreview.mockHint')}</p> : null}
      {layout === 'workspace' && result.diagnostics.length ? <details className={styles.diagnostics} open={!result.bundle}><summary>{t('reactPreview.diagnostics')}</summary><ul>{result.diagnostics.map((item, index) => <li key={index}>{item.message}</li>)}</ul></details> : null}
      <div className={styles.content}>
        <aside className={styles.props} aria-label={t('reactPreview.props')}>
          {layout === 'component' ? <>
            <div className={styles.propsHeading}><h3>{t('reactPreview.props')}</h3><Button variant="ghost" className={styles.compactAction} disabled={!result.bundle} onClick={reset}>{t('reactPreview.reset')}</Button></div>
            <p className={`${styles.hint} ${styles.mockHint}`}>{t('reactPreview.mockHint')}</p>
          </> : <h3>{t('reactPreview.props')}</h3>}
          {!result.controls.length ? <p>{t('reactPreview.noProps')}</p> : null}
          {result.controls.map((control) => {
            const sourceDefault = control.hasDefault && !Object.hasOwn(values, control.name);
            const hasCallbackMock = result.callbacks.some((callback) => callback.path[0] === control.name);
            const value = Object.hasOwn(values, control.name) ? values[control.name] : sourceDefault ? control.defaultValue : undefined;
            const text = Object.hasOwn(drafts, control.name) ? drafts[control.name]! : editorText(control, value);
            const options = control.kind === 'boolean' ? [true, false] : control.kind === 'enum' ? control.options ?? [] : undefined;
            const undeclared = Boolean(options && text !== '' && !options.some((option) => editorText(control, option) === text));
            const invalidValue = Object.hasOwn(invalid, control.name) && invalid[control.name] === true;
            const id = `${editorId}-prop-${control.name}`;
            return <div className={styles.prop} key={control.name}>
              <label htmlFor={id}><code>{control.name}</code>{layout === 'workspace' && control.required ? <span className={styles.badge}>{t('reactPreview.required')}</span> : null}</label>
              {layout === 'workspace' ? <>
                <span className={styles.hint}>{t('reactPreview.type', { kind: control.kind })} · {t(`reactPreview.provenance.${control.provenance}`)}</span>
                <span className={styles.hint}>{valueOrigin(control)}</span>
              </> : null}
              {control.kind === 'function' ? <p className={styles.hint}>{sourceDefault ? t('reactPreview.sourceDefault') : hasCallbackMock ? t('reactPreview.callback') : t('reactPreview.unset')}</p>
                : options ? <select id={id} aria-label={control.name} aria-describedby={undeclared ? `${id}-undeclared` : undefined} value={text} disabled={invalidJson} onChange={(event) => change(control, event.target.value)}>
                  <option value="" disabled>{t('reactPreview.unset')}</option>
                  {undeclared ? <option value={text} disabled>{t('reactPreview.undeclaredOption', { value: JSON.stringify(value) })}</option> : null}
                  {options.map((option, index) => <option key={index} value={editorText(control, option)}>{typeof option === 'string' ? option : JSON.stringify(option)}</option>)}
                </select>
                : ['object', 'array', 'unknown'].includes(control.kind) ? <textarea id={id} aria-label={control.name} rows={4} spellCheck={false} value={text} disabled={invalidJson} placeholder={sourceDefault ? t('reactPreview.sourceDefault') : 'JSON'} aria-invalid={invalidValue || undefined} onChange={(event) => change(control, event.target.value)} />
                : <input id={id} aria-label={control.name} type={control.kind === 'number' ? 'number' : 'text'} step={control.kind === 'number' ? 'any' : undefined} value={text} disabled={invalidJson} placeholder={sourceDefault ? t('reactPreview.sourceDefault') : undefined} aria-invalid={invalidValue || undefined} onChange={(event) => change(control, event.target.value)} />}
              {undeclared ? <p id={`${id}-undeclared`} className={styles.hint}>{t('reactPreview.undeclaredHint')}</p> : null}
              {hasCallbackMock && control.kind !== 'function' ? <p className={styles.hint}>{t('reactPreview.callback')}</p> : null}
              {invalidValue ? <p role="alert" className={styles.error}>{t('reactPreview.invalidValue')}</p> : null}
              {control.kind !== 'function' && Object.hasOwn(drafts, control.name) ? <Button variant="ghost" className={styles.resetProp} disabled={invalidJson} onClick={() => resetProp(control.name)}>{control.hasDefault ? t('reactPreview.useDefault') : t('reactPreview.resetProp')}</Button> : null}
            </div>;
          })}
        </aside>
        {result.bundle ? <RuntimeFrame key={JSON.stringify([result.sourceDigest, result.selectedExport, result.bundle.digest])} bundle={result.bundle} values={values} retry={retry} title={sourcePath} onRetry={layout === 'component' ? retryPreview : undefined} onEditProps={editJson} /> : <p className={styles.unavailable}>{t('reactPreview.unavailable')}</p>}
      </div>
    </> : null}
    <details ref={previewDetails} className={styles.previewDetails} open={layout === 'component' && Boolean(failure || (result && !result.bundle))}>
      <summary>{t(layout === 'component' ? 'reactPreview.diagnostics' : 'reactPreview.jsonProps')}</summary>
      {layout === 'component' ? <div className={styles.toolbar}>{exportSelector}<Button className={styles.compactAction} disabled={busy} onClick={retryPreview}>{t('reactPreview.retry')}</Button></div> : null}
      {result ? <label className={styles.jsonProps}>{t('reactPreview.jsonProps')}<textarea ref={jsonEditor} aria-label={t('reactPreview.jsonProps')} aria-describedby={`${editorId}-json-hint`} rows={6} spellCheck={false} disabled={!result.bundle} value={jsonDraft ?? JSON.stringify(values, null, 2)} aria-invalid={invalidJson || undefined} onChange={(event) => changeJson(event.target.value)} /><span id={`${editorId}-json-hint`} className={styles.hint}>{t('reactPreview.jsonHint')}</span></label> : null}
      {invalidJson ? <div className={styles.jsonRecovery}><p role="alert" className={styles.error}>{t('reactPreview.invalidJson')}</p><Button variant="ghost" className={styles.compactAction} onClick={restoreJson}>{t('reactPreview.restoreJson')}</Button></div> : null}
      {layout === 'component' && result?.diagnostics.length ? <ul>{result.diagnostics.map((item, index) => <li key={index}>{item.message}</li>)}</ul> : null}
      {layout === 'component' && result?.controls.length ? <dl className={styles.propDetails}>{result.controls.map((control) => <div key={control.name}>
        <dt><code>{control.name}</code>{control.required ? <span className={styles.badge}>{t('reactPreview.required')}</span> : null}</dt>
        <dd><span>{t('reactPreview.type', { kind: control.kind })} · {t(`reactPreview.provenance.${control.provenance}`)}</span><span>{valueOrigin(control)}</span></dd>
      </div>)}</dl> : null}
    </details>
  </section>;
}
