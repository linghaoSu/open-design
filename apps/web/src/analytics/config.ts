import type { AnalyticsConfigResponse } from '@open-design/contracts/analytics';
import { coalescedGet } from '../lib/coalesced-get';

/** Share only concurrent reads; later reads must observe current host facts. */
export function fetchAnalyticsConfigShared(): Promise<AnalyticsConfigResponse | null> {
  return coalescedGet('analytics-config', async () => {
    const response = await fetch('/api/analytics/config');
    if (!response.ok) return null;
    return await response.json() as AnalyticsConfigResponse;
  }, 0);
}
