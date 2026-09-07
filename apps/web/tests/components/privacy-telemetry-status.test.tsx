// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { PrivacySection } from '../../src/components/PrivacySection';
import { PrivacyConsentModal } from '../../src/components/PrivacyConsentModal';
import type { AppConfig } from '../../src/types';

const cfg: AppConfig = {
  mode: 'daemon', apiKey: '', apiProtocol: 'anthropic', baseUrl: '', model: '',
  agentId: 'codex', skillId: null, designSystemId: null,
  privacyDecisionAt: 10, installationId: 'preserved-id', telemetry: { metrics: true, content: true },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function settings() {
  const setCfg = vi.fn();
  const view = render(<I18nProvider initial="en"><PrivacySection cfg={cfg} setCfg={setCfg} /></I18nProvider>);
  return { ...view, setCfg };
}

describe('privacy configuration disclosure', () => {
  it.each([
    [{ metrics: false, content: false }, 'unconfigured'],
    [{ metrics: true, content: false }, 'configured'],
    [{ metrics: false, content: true }, 'configured'],
    [undefined, 'unknown'],
    [null, 'unknown'],
    [{ metrics: false }, 'unknown'],
  ] as const)('distinguishes safe configuration facts %o without changing preferences', async (telemetryConfiguration, state) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: false, key: null, host: null, telemetryConfiguration })));
    vi.stubGlobal('fetch', fetchMock);
    const { setCfg } = settings();
    await waitFor(() => expect(screen.getByTestId('privacy-telemetry-status').getAttribute('data-state')).toBe(state));
    expect(fetchMock).toHaveBeenCalledWith('/api/analytics/config');
    expect(screen.getByRole('button', { name: /Anonymous metrics/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Conversation and tool content/ }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Anonymous ID') as HTMLInputElement).value).toBe('preserved-id');
    expect(setCfg).not.toHaveBeenCalled();
    expect(screen.getByText(/Model requests are still processed by your selected provider/)).toBeTruthy();
  });

  it.each(['http', 'network'])('retains unknown after %s failure', async failure => {
    const fetchMock = failure === 'http'
      ? vi.fn().mockResolvedValue(new Response('{}', { status: 503 }))
      : vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const { setCfg } = settings();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.getByTestId('privacy-telemetry-status').getAttribute('data-state')).toBe('unknown');
    expect(setCfg).not.toHaveBeenCalled();
  });

  it('shares one read and identical disclosure with the existing first-run explanation', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal('fetch', fetchMock);
    const { setCfg } = settings();
    const onShare = vi.fn();
    const onDecline = vi.fn();
    render(<I18nProvider initial="en"><PrivacyConsentModal onShare={onShare} onDecline={onDecline} /></I18nProvider>);
    expect(screen.getAllByTestId('privacy-telemetry-status').every(node => node.getAttribute('data-state') === 'unknown')).toBe(true);
    resolve(new Response(JSON.stringify({ telemetryConfiguration: { metrics: false, content: false } })));
    await waitFor(() => expect(screen.getAllByTestId('privacy-telemetry-status').every(node => node.getAttribute('data-state') === 'unconfigured')).toBe(true));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(setCfg).not.toHaveBeenCalled();
    expect(onShare).not.toHaveBeenCalled();
    expect(onDecline).not.toHaveBeenCalled();
  });
});
