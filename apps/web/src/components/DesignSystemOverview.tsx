import { useEffect, useId, useState } from 'react';
import { Button } from '@open-design/components';
import type { ComponentBinding, DesignSystemVersion, ProjectDesignRuntimeState } from '@open-design/contracts';
import { workspaceAccountScopedCacheKey } from '../collab/workspace-identity';
import { getProjectDesignRuntimeVersion, type ProjectDesignRuntimeScope } from '../providers/design-runtime';
import { useT } from '../i18n';
import { hasStructuredDesignSystem } from './DesignRuntimeLegacyMigration';
import { DesignSystemVersionDetails } from './DesignSystemVersionDetails';
import { Icon } from './Icon';
import styles from './DesignSystemOverview.module.css';

interface Props {
  state: ProjectDesignRuntimeState;
  scope: ProjectDesignRuntimeScope;
  hasLegacyFiles: boolean;
  hasSourceFiles: boolean;
  disabled: boolean;
  viewerOnly: boolean;
  onNavigate(tab: 'code' | 'migration' | 'versions' | 'preview'): void;
  onRepair(componentId: string, binding: ComponentBinding): void;
  onRefresh?(): void;
}
type VersionRead = { identity: string; status: 'loading' } | { identity: string; status: 'error'; stale?: boolean } | { identity: string; status: 'ready'; version: DesignSystemVersion };
type ContentsSection = 'all' | 'tokens' | 'sources';

/** Exact package metadata supplements the working registry; it never substitutes for it. */
export function DesignSystemOverview({ state, scope, hasLegacyFiles, hasSourceFiles, disabled, viewerOnly, onNavigate, onRepair, onRefresh }: Props) {
  const t = useT();
  const contentsId = useId();
  const hasSystem = hasStructuredDesignSystem(state);
  const locked = state.lock.dependencies.length > 0;
  // The canonical project DTO currently allows one system. Do not turn a future
  // or malformed multi-system snapshot into a misleading first-package total.
  const multiple = state.lock.dependencies.length > 1;
  const pin = multiple ? undefined : state.lock.dependencies[0] ?? state.authoringBase ?? undefined;
  const identity = JSON.stringify([scope.projectId, workspaceAccountScopedCacheKey(scope.workspaceContext), state.revision, state.registry?.id, state.lock.dependencies, state.authoringBase]);
  const [read, setRead] = useState<VersionRead | null>(null);
  const [retry, setRetry] = useState(0);
  const [contents, setContents] = useState<{ identity: string; section: ContentsSection } | null>(null);
  const version = read?.identity === identity && read.status === 'ready' ? read.version : undefined;
  const failed = multiple || !!pin && read?.identity === identity && read.status === 'error';
  const loading = !!pin && !version && !failed;
  const contentsOpen = !!version && contents?.identity === identity;
  const openSection = (section: ContentsSection) => setContents(contentsOpen && contents?.section === section ? null : { identity, section });

  useEffect(() => {
    const abort = new AbortController();
    let current = true;
    if (!pin || multiple) { setRead(null); return () => { current = false; abort.abort(); }; }
    setRead({ identity, status: 'loading' });
    void getProjectDesignRuntimeVersion({ ...scope, signal: abort.signal }, pin.designSystemId, pin.version).then((result) => {
      if (!current) return;
      if (result.revision !== state.revision || result.version.package.id !== state.registry?.id
        || result.version.package.id !== pin.designSystemId || result.version.package.version !== pin.version
        || result.version.digest !== pin.digest || result.version.sourceDigest !== pin.source.digest) {
        setRead({ identity, status: 'error', stale: result.revision !== state.revision }); return;
      }
      setRead({ identity, status: 'ready', version: result.version });
    }).catch(() => { if (current) setRead({ identity, status: 'error' }); });
    return () => { current = false; abort.abort(); };
    // Identity captures project, authority, revision and the exact immutable pin.
    // This read owns its own cancellation; it must not interrupt editor mutations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, retry]);

  const componentRefs = new Map((state.registry?.components ?? []).map((component) => [`ds:${state.registry!.id}/${component.id}`, component.id]));
  const connectionIssues = state.bindings.bindings.filter((binding) => binding.status !== 'bound' && componentRefs.has(binding.componentRef));
  const metadataCount = (count: number | undefined) => count === undefined
    ? pin || multiple ? <span className={styles.pending} aria-label={t(loading ? 'designOverview.loading' : 'designOverview.unavailable')}>—</span>
      : <span className={styles.pending}>{t('designOverview.notPublished')}</span>
    : <strong>{count}</strong>;

  return <div className={styles.overview} data-testid="design-system-overview">
    <div className={styles.heading}>
      <h3>{hasSystem ? version?.package.name ?? state.registry?.id ?? t('designRuntime.title') : t('designWorkspace.startTitle')}</h3>
      <p>{hasSystem ? t(locked ? 'designOverview.lockedHint' : pin ? 'designOverview.editingHint' : 'designOverview.unpublishedHint') : t('designWorkspace.startHint')}</p>
    </div>
    {hasSystem ? <>
      <div className={styles.version} data-testid="design-overview-version-status">
        <span>{locked ? <Icon name="lock" size={15} /> : null}{multiple ? t('designOverview.unavailable') : pin ? t(locked ? 'designOverview.lockedVersion' : 'designOverview.editingVersion', { version: pin.version }) : t('designOverview.unpublished')}</span>
        {version ? <Button variant="ghost" disabled={disabled} aria-expanded={contentsOpen && contents?.section === 'all'} aria-controls={contentsId} onClick={() => openSection('all')}>{t('designOverview.versionContents')}<Icon name="arrow-right" size={14} /></Button> : null}
      </div>
      {loading ? <p className={styles.readStatus} role="status">{t('designOverview.loading')}</p> : null}
      {failed ? <div className={styles.readError} role="alert"><span>{t('designOverview.unavailable')}</span><Button variant="ghost" disabled={disabled} onClick={() => {
        if (read?.identity === identity && read.status === 'error' && read.stale && onRefresh) onRefresh();
        else setRetry((value) => value + 1);
      }}>{t('designRuntime.refresh')}</Button></div> : null}
      <div className={styles.assets}>
        <Button variant="ghost" className={styles.asset} disabled={disabled || !version} aria-expanded={contentsOpen && contents?.section === 'tokens'} aria-controls={contentsId} onClick={() => openSection('tokens')} data-testid="design-overview-tokens">
          <span>{t('designOverview.foundations')}<Icon name="chevron-right" size={14} /></span><div>{metadataCount(version?.package.tokens.tokens.length)}<small>{t('designVersions.tokens')}</small></div>
        </Button>
        <Button variant="ghost" className={styles.asset} disabled={disabled} onClick={() => onNavigate('code')} data-testid="design-overview-components">
          <span>{t('designOverview.codeComponents')}<Icon name="chevron-right" size={14} /></span><div><strong>{state.registry?.components.length ?? 0}</strong></div>
        </Button>
        <Button variant="ghost" className={styles.asset} disabled={disabled} onClick={() => onNavigate('preview')} data-testid="design-overview-pages">
          <span>{t('designOverview.pages')}<Icon name="chevron-right" size={14} /></span><div><strong>{state.document?.screens.length ?? 0}</strong></div>
        </Button>
      </div>
      <Button variant="ghost" className={styles.sources} disabled={disabled || !version} aria-expanded={contentsOpen && contents?.section === 'sources'} aria-controls={contentsId} onClick={() => openSection('sources')} data-testid="design-overview-sources">
        <Icon name="file-code" size={18} /><span>{t('designOverview.sources')}</span>{metadataCount(version?.package.source.files.length)}<Icon name="chevron-right" size={14} />
      </Button>
      <p className={styles.footnote}>{t('designOverview.metadataOnly')}</p>
      <div id={contentsId} hidden={!contentsOpen} data-testid="design-overview-version-contents">
        {version && contentsOpen ? <DesignSystemVersionDetails value={version.package} {...(contents?.section && contents.section !== 'all' ? { section: contents.section } : {})} /> : null}
      </div>
      {connectionIssues.length ? <div className={styles.repair}>
        <Icon name="alert-triangle" size={18} /><div><strong>{t('designWorkspace.repairTitle')}</strong><p>{t('designWorkspace.repairHint', { count: connectionIssues.length })}</p></div>
        <Button disabled={disabled} data-testid="design-runtime-repair-connections" onClick={() => onRepair(componentRefs.get(connectionIssues[0]!.componentRef)!, connectionIssues[0]!)}>{t('designWorkspace.connections')}</Button>
      </div> : null}
      <div className={styles.next}>
        <p>{t(locked ? 'designOverview.lockedNext' : pin ? 'designOverview.editingHint' : 'designOverview.unpublishedHint')}</p>
        <Button variant="primary" disabled={disabled} data-testid="design-overview-next" onClick={() => onNavigate(locked || viewerOnly ? 'versions' : 'code')}>
          {t(locked || viewerOnly ? 'designOverview.manageVersion' : 'designOverview.continueEditing')}<Icon name="arrow-right" size={14} />
        </Button>
      </div>
    </> : <>
      {hasLegacyFiles ? <p className={styles.detected}><Icon name="check" size={16} />{t('designWorkspace.legacyDetected')}</p> : null}
      <div className={styles.choices}>
        <section className={styles.choice}><Icon name="folder-transfer" size={22} /><h4>{t('designWorkspace.migrateTitle')}</h4><p>{t('designWorkspace.migrateHint')}</p>
          <Button data-testid="design-runtime-start-migration" variant={hasLegacyFiles ? 'primary' : 'default'} disabled={disabled} onClick={() => onNavigate('migration')}>{t('designWorkspace.openMigration')}<Icon name="arrow-right" size={14} /></Button>
        </section>
        <section className={styles.choice}><Icon name="blocks" size={22} /><h4>{t('designWorkspace.createTitle')}</h4><p>{t(hasSourceFiles ? 'designWorkspace.createHint' : 'designWorkspace.noSourceFiles')}</p>
          <Button data-testid="design-runtime-start-code" variant={!hasLegacyFiles ? 'primary' : 'default'} disabled={disabled} onClick={() => onNavigate('code')}>{t('designWorkspace.openSources')}<Icon name="arrow-right" size={14} /></Button>
        </section>
      </div>
      <div className={styles.importPackage}><p>{t('designWorkspace.importHint')}</p><Button variant="ghost" disabled={disabled} data-testid="design-runtime-import-version" onClick={() => onNavigate('versions')}><Icon name="import" size={15} />{t('designWorkspace.importVersion')}</Button></div>
    </>}
  </div>;
}
