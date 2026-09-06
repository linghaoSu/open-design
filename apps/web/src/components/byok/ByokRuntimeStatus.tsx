import type { AgentInfo } from '../../types';
import { useT } from '../../i18n';
import styles from './ByokRuntimeStatus.module.css';

interface Props {
  runtime: AgentInfo | undefined;
  loading: boolean;
  daemonLive: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
  onInstall?: (() => void) | undefined;
  onOpenDocs?: (() => void) | undefined;
}

/** Displays the same daemon-owned runtime fact used when starting API runs. */
export function ByokRuntimeStatus({ runtime, loading, daemonLive, refreshFailed, onRefresh, onInstall, onOpenDocs }: Props) {
  const t = useT();
  const status = !daemonLive ? 'offline' : loading ? 'loading' : refreshFailed ? 'error'
    : !runtime ? 'unknown' : runtime.available ? 'available' : 'missing';
  return <div className={styles.root} data-testid="settings-byok-runtime" data-status={status}>
    <p>{t('settings.byokNoFileToolsNotice')}</p>
    <div className={styles.statusRow}>
      <strong role={status === 'error' ? 'alert' : 'status'} aria-live="polite">
        {status === 'offline' ? t('settings.modeDaemonOffline')
          : status === 'loading' ? t('settings.rescanRunning')
            : status === 'error' ? t('settings.rescanFailed')
              : status === 'unknown' ? t('settings.byokRuntimeUnknown')
            : status === 'available' ? t('settings.byokRuntimeReady') : t('settings.byokRuntimeMissing')}
      </strong>
      <div className={styles.actions}>
        {status === 'missing' && onOpenDocs ? <button type="button" className="ghost icon-btn" onClick={onOpenDocs}>
          {t('settings.agentInstall.docs')}
        </button> : null}
        {status === 'missing' && onInstall ? <button type="button" className="ghost icon-btn" onClick={onInstall}>
          {t('settings.agentInstall.install')}
        </button> : null}
        <button type="button" className="ghost icon-btn" onClick={onRefresh} disabled={loading || !daemonLive}>
          {t('settings.rescan')}
        </button>
      </div>
    </div>
    {status === 'missing' ? <p>{t('settings.byokRuntimeMissingHint')}</p> : null}
    <p className={styles.hint}>{t('settings.byokRuntimeConnectionHint')}</p>
  </div>;
}
