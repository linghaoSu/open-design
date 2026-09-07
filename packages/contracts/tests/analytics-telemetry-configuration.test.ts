import { describe, expect, it } from 'vitest';
import { telemetryConfigurationState } from '../src/analytics/public-params.js';

describe('telemetry configuration facts', () => {
  it.each([
    [{ metrics: false, content: false }, 'unconfigured'],
    [{ metrics: true, content: false }, 'configured'],
    [{ metrics: false, content: true }, 'configured'],
    [{ metrics: true, content: true }, 'configured'],
  ] as const)('reports only explicit complete configuration %o', (configuration, state) => {
    expect(telemetryConfigurationState(configuration)).toBe(state);
  });

  it.each([undefined, null, {}, { metrics: false }, { content: true },
    { metrics: 'false', content: false }, { metrics: false, content: 0 },
    { enabled: false, key: null, host: null }, Object.create({ metrics: false, content: false }),
  ])('keeps legacy, missing and invalid configuration unknown: %o', (value) => {
    expect(telemetryConfigurationState(value)).toBe('unknown');
  });
});
