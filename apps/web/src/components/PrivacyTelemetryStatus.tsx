import { useEffect, useState } from 'react';
import { telemetryConfigurationState, type TelemetryConfigurationState } from '@open-design/contracts/analytics';
import { fetchAnalyticsConfigShared } from '../analytics/config';
import { useT } from '../i18n';

const STATUS_KEYS = {
  configured: 'settings.privacyConfigured',
  unconfigured: 'settings.privacyUnconfigured',
  unknown: 'settings.privacyConfigurationUnknown',
} as const;

/** Configuration is a daemon fact, not a saved preference or an upload receipt. */
export function PrivacyTelemetryStatus() {
  const t = useT();
  const [state, setState] = useState<TelemetryConfigurationState>('unknown');
  useEffect(() => {
    let active = true;
    void fetchAnalyticsConfigShared().then(response => {
      if (active) setState(telemetryConfigurationState(response?.telemetryConfiguration));
    }).catch(() => {
      if (active) setState('unknown');
    });
    return () => { active = false; };
  }, []);
  return (
    <div className="hint" data-testid="privacy-telemetry-status" data-state={state}>
      <p>{t(STATUS_KEYS[state])}</p>
      <p>{t('settings.privacyProviderHint')}</p>
    </div>
  );
}
