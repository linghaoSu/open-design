import type { ProjectDesignPreviewResult } from '@open-design/contracts';
import { emptyDesignRuntimeState } from './design-runtime-fixtures';

export function previewUiFixture() {
  const state = emptyDesignRuntimeState(2);
  state.document = { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, id: 'home', type: 'screen', children: [{ schemaVersion: 1, id: 'label', type: 'text', text: 'Actual component' }] }] };
  const digest = `sha256:${'a'.repeat(64)}`;
  const result: ProjectDesignPreviewResult = { schemaVersion: 1, projectId: 'project', revision: 2,
    request: { id: 'preview', expectedRevision: 2, framework: 'react', kind: 'semantic-design', screenIds: ['home'] }, requestDigest: digest,
    impact: { source: 'none', affectedScreens: [], diagnostics: [] }, diagnostics: [], sides: [{ role: 'current', kind: 'semantic-design', lock: state.lock,
      origins: [], sourceEvidence: [], sourceDigest: digest, runtimePackages: [{ name: 'react', version: '18.3.1', origin: 'tool-runtime' }], targetPackages: [], diagnostics: [],
      screens: [{ screenId: 'home', sourcePath: 'src/Home.tsx', exportName: 'Home', bundle: { javascript: 'globalThis.__OD_PREVIEW_REPORT__("rendered");', css: '', digest }, diagnostics: [] }],
    }] };
  return { state, result };
}
