// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_LOOM_PRODUCT } from '@open-design/contracts';
import { ExperienceSurvey } from '../src/components/ExperienceSurvey';
import { notifyArtifactDelivered, onArtifactDelivered, SURVEY_DELAY_MS } from '../src/components/experience-survey-trigger';
import { trackExperienceSurveyDismissed, trackExperienceSurveySent, trackExperienceSurveyShown } from '../src/analytics/events';

vi.mock('../src/i18n', () => ({ useT: () => (key: string) => key }));

// This suite deliberately consumes the real authored fork policy, with no
// product mock, environment feature flag, or dependence on missing API keys.
const globals = window as typeof window & { __odExperienceSurvey?: { open: () => void } };
const retiredKey = 'open-design:experience-survey:v1:retired';
const countKey = 'open-design:experience-survey:v1:deliveries';

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

function deliverAndWait() {
  act(() => {
    notifyArtifactDelivered();
    vi.advanceTimersByTime(SURVEY_DELAY_MS + 100);
  });
}

describe('Design Loom upstream survey isolation', () => {
  it('declares the disabled survey as an immutable product capability', () => {
    expect(DESIGN_LOOM_PRODUCT).toMatchObject({ id: 'design-loom', upstreamExperienceSurveyEnabled: false });
    expect(Object.isFrozen(DESIGN_LOOM_PRODUCT)).toBe(true);
  });

  it.each([true, false, undefined])('never mounts a survey across remounts with metrics consent %s', (metricsConsent) => {
    const onExposure = vi.fn();
    const onSubmit = vi.fn();
    const onDismiss = vi.fn();
    const consent = metricsConsent === undefined ? {} : { metricsConsent };
    const props = { ...consent, onExposure, onSubmit, onDismiss };
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const first = render(<ExperienceSurvey {...props} />);
    deliverAndWait();
    expect(screen.queryByText('experienceSurvey.recommendation')).toBeNull();
    first.unmount();
    render(<ExperienceSurvey {...props} />);
    deliverAndWait();

    expect(screen.queryByText('experienceSurvey.recommendation')).toBeNull();
    expect(globals.__odExperienceSurvey).toBeUndefined();
    expect(onExposure).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('does not arm delivery listeners or alter existing survey storage', () => {
    window.localStorage.setItem(countKey, '4');
    window.localStorage.setItem(retiredKey, '0');
    const listener = vi.fn();
    const unsubscribe = onArtifactDelivered(listener);
    try {
      deliverAndWait();
      expect(listener).not.toHaveBeenCalled();
      expect(window.localStorage.getItem(countKey)).toBe('4');
      expect(window.localStorage.getItem(retiredKey)).toBe('0');
    } finally {
      unsubscribe();
    }
  });

  it('cannot bypass the product policy through either development preview hook', () => {
    vi.stubEnv('NODE_ENV', 'development');
    window.history.replaceState({}, '', '/?survey=preview');
    const onExposure = vi.fn();
    render(<ExperienceSurvey metricsConsent onExposure={onExposure} />);
    act(() => globals.__odExperienceSurvey?.open());
    deliverAndWait();

    expect(globals.__odExperienceSurvey).toBeUndefined();
    expect(screen.queryByText('experienceSurvey.recommendation')).toBeNull();
    expect(onExposure).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(retiredKey)).toBeNull();
  });

  it('does not send shown, dismissed or answered survey events even to an available tracker', () => {
    const track = vi.fn();
    trackExperienceSurveyShown(track);
    trackExperienceSurveyDismissed(track);
    trackExperienceSurveySent(track, { recommendation: 8, improvement: 1 });
    trackExperienceSurveySent(track, { recommendation: 5, improvementOther: 'private feedback' });
    expect(track).not.toHaveBeenCalled();
  });
});
