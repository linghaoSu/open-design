import { describe, expect, it } from 'vitest';
import { DESIGN_LOOM_PRODUCT, assertDesignLoomNamespace } from '../src/index.js';

describe('Design Loom distribution identity', () => {
  it('has its own installer, protocol, repository and disabled update policy', () => {
    expect(DESIGN_LOOM_PRODUCT).toMatchObject({ name: 'Design Loom', appId: 'io.github.linghaosu.designloom', protocol: 'designloom', namespace: 'design-loom', updatesEnabled: false, upstreamExperienceSurveyEnabled: false });
    expect(new URL(DESIGN_LOOM_PRODUCT.repositoryUrl).pathname).toBe('/linghaoSu/open-design');
    expect(Object.isFrozen(DESIGN_LOOM_PRODUCT)).toBe(true);
  });
  it.each(['default', 'open-design', 'release-stable', 'release-beta', 'design-loom-/../../open-design', 'design-loom-'])('rejects foreign or unsafe namespace %s', (namespace) => {
    expect(() => assertDesignLoomNamespace(namespace)).toThrow();
  });
  it('accepts the product and explicit isolated validation namespaces', () => {
    expect(() => assertDesignLoomNamespace('design-loom')).not.toThrow();
    expect(() => assertDesignLoomNamespace('design-loom-acceptance')).not.toThrow();
  });
});
