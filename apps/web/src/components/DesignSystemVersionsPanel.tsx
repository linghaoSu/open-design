import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@open-design/components';
import { DesignSystemPackageSchema, type DesignSystemPackage, type DesignSystemVersion, type ProjectDesignRuntimeDependencyResponse,
  type ProjectDesignRuntimeState, type ProjectDesignRuntimeVersionSummary, type ValidationDiagnostic } from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { activateProjectDesignRuntimeDependency, clearProjectDesignRuntimeDependency, getProjectDesignRuntime,
  getProjectDesignRuntimeVersion, importProjectDesignRuntimeVersion, listProjectDesignRuntimeVersions,
  ProjectDesignRuntimeError, publishProjectDesignRuntimeVersion, resolveProjectDesignRuntimeDependency,
  restoreProjectDesignRuntimeAuthoringBase,
  type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
import { StructureDiagnostics } from './ProjectStructureReview';
import { DesignSystemVersionDetails, initialVersionConstraints, VersionConstraintFields } from './DesignSystemVersionDetails';
import { DesignRuntimeUpgrades } from './DesignRuntimeUpgrades';
import type { DesignPreviewSelection } from './DesignPreviewPanel';
import styles from './DesignSystemVersionsPanel.module.css';

interface Props {
  scope: ProjectDesignRuntimeScope;
  state: ProjectDesignRuntimeState | null;
  files: readonly { name: string }[];
  viewerOnly: boolean;
  externalBusy?: boolean;
  onState(state: ProjectDesignRuntimeState): void;
  onBusyChange?(busy: boolean): void;
  onPreview?(selection: DesignPreviewSelection): void;
}
const versionKey = (value: { id: string; version: string }) => JSON.stringify([value.id, value.version]);

export function DesignSystemVersionsPanel(props: Props) {
  return <VersionsContent key={JSON.stringify([props.scope.projectId, workspaceAccountScopedCacheKey(props.scope.workspaceContext)])} {...props} />;
}

function VersionsContent({ scope, state, files, viewerOnly, externalBusy = false, onState, onBusyChange, onPreview }: Props) {
  const t = useT();
  const upgradesId = useId();
  const [upgradesOpened, setUpgradesOpened] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [name, setName] = useState(state?.registry?.id ?? '');
  const [version, setVersion] = useState('1.0.0');
  const [sourcePaths, setSourcePaths] = useState<string[]>([]);
  const sourceSelectionDirty = useRef(false);
  const [constraints, setConstraints] = useState(initialVersionConstraints);
  const constraintsDirty = useRef(false);
  const [catalog, setCatalog] = useState<ProjectDesignRuntimeVersionSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<DesignSystemVersion | null>(null);
  const [range, setRange] = useState('^1.0.0');
  const [dependency, setDependency] = useState<ProjectDesignRuntimeDependencyResponse | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState<number | null>(null);
  const [imported, setImported] = useState<DesignSystemPackage | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [diagnostics, setDiagnostics] = useState<ValidationDiagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const stateRef = useRef(state); stateRef.current = state;
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const locked = busy || externalBusy || upgradeBusy;
  const integrityFailed = dependency?.resolution.ok === false;
  const disabled = viewerOnly || locked;
  const active = state?.lock.dependencies[0];
  const target = catalog.find((entry) => versionKey(entry) === selected);
  const requiresUpgrade = !!active && !!target && (active.designSystemId !== target.id || active.version !== target.version);
  const paths = [...new Set([...files.map((file) => file.name), ...sourcePaths])].sort();

  useEffect(() => {
    if (sourceSelectionDirty.current || snapshotRevision === null) return;
    // Only first publication gets source suggestions. Existing baselines retain
    // frozen bytes until the user explicitly selects files to update.
    const suggested = state && !state.lock.dependencies.length && !state.authoringBase && !catalog.length
      ? state.codeIndex.components.flatMap((code) => [code.sourcePath,
        ...Object.values(code.props).flatMap((prop) => prop.source ? [prop.source.sourcePath] : []),
        ...Object.values(code.slots ?? {}).flatMap((slot) => slot.source ? [slot.source.sourcePath] : []),
      ]) : [];
    setSourcePaths([...new Set(suggested)].sort());
  }, [state, snapshotRevision, catalog]);

  function acceptState(next: ProjectDesignRuntimeState) { stateRef.current = next; onState(next); }
  function report(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause));
    if (cause instanceof ProjectDesignRuntimeError) setDiagnostics(cause.diagnostics);
  }
  function selectIdentity(next: ProjectDesignRuntimeVersionSummary | undefined) {
    const key = next ? versionKey(next) : '';
    if (key !== selectedRef.current && next) setRange(`^${next.version}`);
    selectedRef.current = key; setSelected(key);
  }

  async function loadSnapshots(authority: ProjectDesignRuntimeScope, current: () => boolean, choose?: string) {
    const [versions, resolved] = await Promise.allSettled([
      listProjectDesignRuntimeVersions(authority), resolveProjectDesignRuntimeDependency(authority),
    ]);
    if (!current()) return;
    if (resolved.status === 'fulfilled') {
      setDependency(resolved.value);
      const activePackage = resolved.value.resolution.ok ? resolved.value.resolution.versions[0]?.package : undefined;
      if (!constraintsDirty.current && activePackage) setConstraints(activePackage.constraints);
    }
    else { setDependency(null); report(resolved.reason); }
    if (versions.status === 'rejected') { setCatalog([]); setDetail(null); setSnapshotRevision(null); report(versions.reason); return; }
    if (resolved.status === 'rejected') return;
    if (versions.value.revision !== resolved.value.revision) { setDetail(null); setMessage(t('designVersions.staleRead')); return; }
    const revision = resolved.value.revision;
    if (stateRef.current?.revision !== revision) {
      try {
        const fresh = await getProjectDesignRuntime(authority);
        if (!current()) return;
        acceptState(fresh.state);
        if (fresh.state.revision !== revision) { setDetail(null); setMessage(t('designVersions.staleRead')); return; }
      } catch (cause) { if (current()) report(cause); return; }
    }
    if (!current()) return;
    const baseline = stateRef.current?.authoringBase;
    if (baseline && !stateRef.current?.lock.dependencies.length && !constraintsDirty.current) {
      try {
        const result = await getProjectDesignRuntimeVersion(authority, baseline.designSystemId, baseline.version);
        if (!current()) return;
        if (result.revision !== revision) { setDetail(null); setMessage(t('designVersions.staleRead')); return; }
        if (result.version.digest !== baseline.digest || result.version.sourceDigest !== baseline.source.digest) setMessage(t('designVersions.staleRead'));
        else setConstraints(result.version.package.constraints);
      } catch (cause) {
        if (!current()) return;
        // A lost baseline must not hide the catalog needed for explicit recovery.
        report(cause);
      }
    }
    setCatalog(versions.value.versions); setSnapshotRevision(revision);
    const next = versions.value.versions.find((entry) => versionKey(entry) === (choose ?? selectedRef.current)) ?? versions.value.versions[0];
    selectIdentity(next); setDetail(null);
    if (!next) return;
    const result = await getProjectDesignRuntimeVersion(authority, next.id, next.version);
    if (!current()) return;
    if (result.revision !== revision) { setMessage(t('designVersions.staleRead')); return; }
    setDetail(result.version);
  }

  async function perform(operation: (authority: ProjectDesignRuntimeScope, current: () => boolean) => Promise<void>) {
    if (running.current || externalBusy || upgradeBusy) return;
    running.current = true; setBusy(true); busyCallback.current?.(true);
    const token = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    const current = () => mounted.current && generation.current === token;
    const authority = { ...scope, signal: abort.signal };
    setError(''); setMessage(''); setDiagnostics([]);
    try { await operation(authority, current); }
    catch (cause) {
      if (!current()) return;
      report(cause);
      if (cause instanceof ProjectDesignRuntimeError && cause.status === 409) {
        try {
          const fresh = await getProjectDesignRuntime(authority);
          if (current()) { acceptState(fresh.state); setMessage(t('projectStructure.conflict')); }
        } catch (refreshError) { if (current()) report(refreshError); }
        if (current()) {
          try { await loadSnapshots(authority, current); } catch (refreshError) { if (current()) report(refreshError); }
        }
      }
    } finally {
      if (current()) { running.current = false; setBusy(false); busyCallback.current?.(false); }
    }
  }
  useEffect(() => {
    mounted.current = true; running.current = false;
    void perform(loadSnapshots);
    return () => { mounted.current = false; generation.current += 1; controller.current?.abort(); busyCallback.current?.(false); };
    // The keyed wrapper owns all authority changes; form drafts survive ordinary state refreshes.
  }, []);

  function publish() {
    if (disabled || !stateRef.current || integrityFailed) return;
    void perform(async (authority, current) => {
      const currentState = stateRef.current!;
      const result = await publishProjectDesignRuntimeVersion(authority, { expectedRevision: currentState.revision, name, version, sourcePaths,
        ...((!currentState.lock.dependencies.length && !currentState.authoringBase) || constraintsDirty.current ? { constraints } : {}),
      });
      if (!current()) return;
      acceptState(result.state); setMessage(t('designVersions.published'));
      await loadSnapshots(authority, current, versionKey(result.version));
    });
  }
  function activate() {
    if (disabled || !target || !stateRef.current || requiresUpgrade || integrityFailed) return;
    void perform(async (authority, current) => {
      const result = await activateProjectDesignRuntimeDependency(authority, { expectedRevision: stateRef.current!.revision, designSystemId: target.id, version: target.version, range });
      if (!current()) return;
      acceptState(result.state); setMessage(t('designVersions.activated'));
      await loadSnapshots(authority, current);
    });
  }
  function clear() {
    if (disabled || !dependency || (!active && !integrityFailed)) return;
    void perform(async (authority, current) => {
      const result = await clearProjectDesignRuntimeDependency(authority, { expectedRevision: dependency.revision });
      if (!current()) return;
      acceptState(result.state); setMessage(t('designVersions.cleared'));
      await loadSnapshots(authority, current);
    });
  }
  function readPackage(file: File | undefined) {
    if (!file || disabled) return;
    setImported(null);
    void perform(async (_authority, current) => {
      let input: unknown;
      try { input = JSON.parse(await file.text()); }
      catch { if (current()) setError(t('designVersions.invalidPackage')); return; }
      if (!current()) return;
      const parsed = DesignSystemPackageSchema.safeParse(input);
      if (parsed.success) setImported(parsed.data);
      else setError(`${t('designVersions.invalidPackage')} ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' ')}`);
    });
  }
  function exportPackage() {
    if (!detail) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(detail.package, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${detail.package.id}-${detail.package.version}.json`;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); URL.revokeObjectURL(url); }
  }

  return <section className={styles.panel} data-testid="design-system-versions-panel">
    <div className={styles.actions}><Button data-testid="versions-refresh" disabled={locked} onClick={() => void perform(loadSnapshots)}>{t('designRuntime.refresh')}</Button></div>
    {busy ? <p role="status">{t('common.loading')}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {message ? <p className={styles.notice} role="status">{message}</p> : null}
    {snapshotRevision !== null && state && snapshotRevision !== state.revision ? <p className={styles.notice}>{t('designVersions.staleRead')}</p> : null}
    <StructureDiagnostics diagnostics={diagnostics} />
    <section className={styles.card} data-testid="versions-lock">
      <h3>{t('designVersions.lockTitle')}</h3>
      {active ? <><p><strong>{active.designSystemId} · {active.version}</strong> · {state?.dependencies.dependencies[0]?.version}</p>
        <p>{t('designVersions.packageDigest')}: <code>{active.digest}</code></p><p>{t('designVersions.sourceDigest')}: <code>{active.source.digest}</code></p></>
        : !integrityFailed ? <p>{t('designVersions.unlocked')}</p> : null}
      {integrityFailed ? <p className={styles.notice}>{t('designVersions.integrityHint')}</p> : dependency?.resolution.ok && active && dependency.revision === state?.revision ? <p role="status">{t('designVersions.resolved')}</p> : null}
      <StructureDiagnostics diagnostics={dependency?.resolution.diagnostics ?? []} />
      <div className={styles.actions}>
        <Button data-testid="versions-resolve" disabled={locked} onClick={() => void perform(loadSnapshots)}>{t('designVersions.resolve')}</Button>
        <Button data-testid="versions-clear" disabled={disabled || !dependency || (!active && !integrityFailed)} onClick={clear}>{t('designVersions.clear')}</Button>
        {active ? <Button data-testid="versions-review-upgrade" aria-expanded={upgradesOpened} aria-controls={upgradesId} disabled={locked || integrityFailed} onClick={() => setUpgradesOpened((opened) => !opened)}>{t('designUpgrade.title')}</Button> : null}
      </div>
      {active || integrityFailed ? <p className={styles.muted}>{t('designVersions.clearHint')} {t('designValidation.clearHint')}</p> : null}
    </section>
    {upgradesOpened && active ? <div id={upgradesId}><DesignRuntimeUpgrades scope={scope} state={state} catalog={catalog} catalogRevision={snapshotRevision} viewerOnly={viewerOnly} externalBusy={busy || externalBusy || integrityFailed}
      onBusyChange={(next) => { setUpgradeBusy(next); busyCallback.current?.(next); }}
      onState={(next) => { acceptState(next); setMessage(t('designUpgrade.applied')); }} {...(onPreview ? { onPreview } : {})} /></div> : null}
    <div className={styles.columns}>
      <form className={styles.card} onSubmit={(event) => { event.preventDefault(); publish(); }}>
        <h3>{t('designVersions.publishCurrent')}</h3><p className={styles.muted}>{t('designVersions.publishHint')}</p>
        {state?.authoringBase ? <p data-testid="versions-authoring-base" className={styles.notice}>{t('designVersions.authoringBase')}: <code>{state.authoringBase.designSystemId}@{state.authoringBase.version}</code><br />{t('designVersions.authoringHint')}</p> : null}
        <fieldset disabled={disabled || !state?.registry || integrityFailed}>
          <label className={styles.field}>{t('designVersions.name')}<input data-testid="versions-name" value={name} required onChange={(event) => setName(event.target.value)} /></label>
          <label className={styles.field}>{t('designVersions.version')}<input data-testid="versions-version" value={version} required onChange={(event) => setVersion(event.target.value)} /></label>
          <h4>{t('designVersions.sourceFiles')}</h4><p className={styles.muted}>{t('designVersions.sourceUpdateHint')}</p>
          <div className={styles.sources}>{paths.map((path) => <label key={path}><input data-testid={`versions-source-${path}`} type="checkbox" checked={sourcePaths.includes(path)} onChange={(event) => { sourceSelectionDirty.current = true; setSourcePaths((previous) => event.target.checked ? [...previous, path] : previous.filter((entry) => entry !== path)); }} /><code>{path}</code></label>)}</div>
          <details><summary>{t('designVersions.constraints')}</summary><p className={styles.muted}>{t('designVersions.constraintHint')}</p><VersionConstraintFields value={constraints} onChange={(value) => { constraintsDirty.current = true; setConstraints(value); }} /></details>
          <Button type="submit" variant="primary" data-testid="versions-publish" disabled={!sourcePaths.length && !state?.authoringBase && !active}>{t('designVersions.publishCurrent')}</Button>
        </fieldset>
      </form>
      <div className={styles.stack}>
        <section className={styles.card}>
          <h3>{t('designVersions.catalog')}</h3>
          <label className={styles.field}>{t('designVersions.chooseVersion')}<select data-testid="versions-select" disabled={locked || !catalog.length} value={selected} onChange={(event) => {
            const next = catalog.find((entry) => versionKey(entry) === event.target.value); selectIdentity(next); setDetail(null);
            if (next) void perform(async (authority, current) => { const result = await getProjectDesignRuntimeVersion(authority, next.id, next.version); if (current()) {
              if (result.revision !== stateRef.current?.revision) setMessage(t('designVersions.staleRead'));
              else setDetail(result.version);
            } });
          }}><option value="">{t('designVersions.chooseVersion')}</option>{catalog.map((entry) => <option key={versionKey(entry)} value={versionKey(entry)}>{entry.name} · {entry.id}@{entry.version}</option>)}</select></label>
          {target ? <><p>{t('designVersions.packageDigest')}: <code>{target.digest}</code></p><p>{t('designVersions.sourceDigest')}: <code>{target.sourceDigest}</code></p>
            {!active && state?.registry?.id === target.id ? <Button data-testid="versions-restore-authoring-base" disabled={disabled || !detail || snapshotRevision !== state.revision} onClick={() => {
              if (disabled || !target || !stateRef.current) return;
              void perform(async (authority, current) => {
                const result = await restoreProjectDesignRuntimeAuthoringBase(authority, { expectedRevision: stateRef.current!.revision, designSystemId: target.id, version: target.version });
                if (!current()) return;
                acceptState(result.state); await loadSnapshots(authority, current);
              });
            }}>{t('designVersions.restoreAuthoringBase')}</Button> : null}
            <form onSubmit={(event) => { event.preventDefault(); activate(); }}><label className={styles.field}>{t('designVersions.range')}<input data-testid="versions-range" value={range} disabled={disabled || requiresUpgrade || integrityFailed} required onChange={(event) => setRange(event.target.value)} /></label>
              <p className={styles.muted}>{t('designVersions.activateHint')}</p>
              {requiresUpgrade ? <p className={styles.notice}>{t('designVersions.upgradeRequired')}</p> : null}
              <Button type="submit" data-testid="versions-activate" disabled={disabled || !detail || !state || requiresUpgrade || integrityFailed}>{t('designVersions.activate')}</Button>
            </form></> : <p className={styles.muted}>{t('common.none')}</p>}
          {detail ? <DesignSystemVersionDetails value={detail.package} /> : null}
        </section>
        <section className={styles.card}><details><summary>{t('designVersions.advanced')}</summary>
          <p className={styles.muted}>{t('designVersions.importHint')}</p>
          <label className={styles.field}>{t('designVersions.importPackage')}<input data-testid="versions-package-file" type="file" accept=".json,application/json" disabled={disabled || !state || integrityFailed} onChange={(event) => readPackage(event.target.files?.[0])} /></label>
          {imported ? <><p data-testid="versions-import-preview"><strong>{imported.name}</strong> · {imported.id}@{imported.version}</p><DesignSystemVersionDetails value={imported} /></> : null}
          <div className={styles.actions}>
            <Button data-testid="versions-package-import" disabled={disabled || !imported || !state || integrityFailed} onClick={() => {
              if (disabled || !imported || !stateRef.current) return;
              void perform(async (authority, current) => { const result = await importProjectDesignRuntimeVersion(authority, { expectedRevision: stateRef.current!.revision, package: imported }); if (current()) {
                acceptState(result.state); setMessage(t('designVersions.imported')); await loadSnapshots(authority, current, versionKey(result.version));
              } });
            }}>{t('designVersions.importPackage')}</Button>
            <Button data-testid="versions-package-export" disabled={locked || !detail} onClick={exportPackage}>{t('designVersions.exportPackage')}</Button>
          </div>
        </details></section>
      </div>
    </div>
  </section>;
}
