import type { ProjectDesignRuntimeValidationSettingsResponse, StructuredDesignValidationResult } from '@open-design/contracts';
import { emptyDesignRuntimeState } from './design-runtime-fixtures';

export function validationSettingsFixture(revision = 1): ProjectDesignRuntimeValidationSettingsResponse {
  const state = emptyDesignRuntimeState(revision);
  return { revision, settings: state.validationSettings, lock: state.lock,
    effectiveConstraints: { source: 'project', constraints: state.validationSettings.projectConstraints }, diagnostics: [] };
}
export function artifactValidationFixture(): StructuredDesignValidationResult {
  const empty = { reused: 0, total: 0, rate: null };
  return { schemaVersion: 1, mode: 'explore', policySource: 'project', accepted: true, strictReady: false,
    coverage: { semantic: false, source: true, imports: true, styles: true, bindings: true, conformance: false },
    metrics: { componentReuse: empty, bindingReuse: empty, unknownComponents: 0, unknownTokens: 0, rawColors: 1, rawSpacing: 0, rawRadius: 0, intrinsicControls: 1, duplicateControls: 0, duplicateStructures: 0, unsupported: 0, unresolvedImports: 0 }, semanticReuse: empty,
    diagnostics: [{ schemaVersion: 1, code: 'ODDS2002', severity: 'warning', message: 'Use a declared color token.', location: { sourcePath: 'screen.html', line: 3, column: 4 } }],
  };
}
