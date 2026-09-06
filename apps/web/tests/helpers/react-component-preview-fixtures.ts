import type { ComponentPreviewResponse } from '@open-design/contracts';

export function componentPreviewFixture(overrides: Partial<ComponentPreviewResponse> = {}): ComponentPreviewResponse {
  const digest = `sha256:${'a'.repeat(64)}`;
  return {
    schemaVersion: 1, projectId: 'proj-1', sourcePath: 'Card.tsx', requestedProps: {}, sourceDigest: digest,
    exports: ['default', 'CompactCard'], selectedExport: 'default',
    controls: [
      { name: 'title', kind: 'string', required: true, provenance: 'typescript', hasDefault: false },
      { name: 'count', kind: 'number', required: false, provenance: 'default', hasDefault: true, defaultValue: 3 },
      { name: 'active', kind: 'boolean', required: true, provenance: 'typescript', hasDefault: false },
      { name: 'variant', kind: 'enum', required: true, provenance: 'typescript', hasDefault: false, options: ['small', 'large'] },
      { name: 'items', kind: 'array', required: true, provenance: 'typescript', hasDefault: false },
      { name: 'onClick', kind: 'function', required: true, provenance: 'typescript', hasDefault: false },
    ],
    mockProps: { title: 'Sample title', active: true, variant: 'small', items: [{ label: 'Sample item' }], onClick: null },
    effectiveProps: { title: 'Sample title', active: true, variant: 'small', items: [{ label: 'Sample item' }], onClick: null },
    callbacks: [{ path: ['onClick'], async: false }],
    bundle: { javascript: 'globalThis.__OD_COMPONENT_PREVIEW_UPDATE_PROPS__ = () => globalThis.__OD_PREVIEW_REPORT__("rendered");globalThis.__OD_PREVIEW_REPORT__("rendered");', css: '', digest },
    evidence: [], runtimePackages: [{ name: 'react', version: '18.3.1', origin: 'tool-runtime' }], diagnostics: [], ...overrides,
  };
}
