import { describe, expect, it } from 'vitest';
import { resolvePackagedWindowTitle } from '../src/window-title.js';
describe('Design Loom window identity', () => {
  it.each([null, '0.1.0', '0.1.0-beta.1'])('does not inherit upstream release branding for %s', (appVersion) => {
    expect(resolvePackagedWindowTitle({ appVersion, namespace: 'design-loom' })).toBe('Design Loom');
  });
});
