import { isDeepStrictEqual } from 'node:util';
import {
  ProjectDesignRuntimeValidationSettingsRequestSchema, ProjectDesignRuntimeValidateArtifactsRequestSchema,
  StructuredDesignValidationResultSchema, type ProjectDesignRuntimeValidationSettingsRequest,
  type ProjectDesignRuntimeValidationSettingsResponse, type ProjectDesignRuntimeValidateArtifactsRequest,
  type ProjectDesignRuntimeValidateArtifactsResponse, type ProjectDesignRuntimeState, type HandoffTargetPackage,
  type ValidationDiagnostic, type DesignValidationSource,
} from '@open-design/contracts';
import { DesignRuntimeRevisionConflictError, type DesignRuntimeStore } from '../../storage/design-runtime-store.js';
import { resolveLockedDesignSystemsSync } from './design-system-version.js';
import { validateStructuredDesign } from './design-validation.js';
import { collectProjectValidationFacts } from './project-validation-facts.js';

interface Deps {
  store: DesignRuntimeStore;
  readSource(projectId: string, path: string): Promise<string>;
  observeTargetPackages(projectId: string, names: readonly string[]): Promise<HandoffTargetPackage[]>;
  persist(projectId: string, revision: number, state: ProjectDesignRuntimeState): ProjectDesignRuntimeState;
  reject(message: string, diagnostics?: ValidationDiagnostic[]): never;
}

/** All source, installation and policy facts come from project authority, never an HTTP snapshot. */
export function createProjectValidationService({ store, readSource, observeTargetPackages, persist, reject }: Deps) {
  const atRevision = (projectId: string, expectedRevision: number) => {
    const state = store.read(projectId);
    if (state.revision !== expectedRevision) throw new DesignRuntimeRevisionConflictError(expectedRevision, state.revision);
    return state;
  };
  const resolve = (projectId: string, state: ProjectDesignRuntimeState) => resolveLockedDesignSystemsSync(state.dependencies, state.lock, (entry) => store.readVersion(projectId, entry.designSystemId, entry.version));
  return {
    validationSettings(projectId: string): ProjectDesignRuntimeValidationSettingsResponse {
      const state = store.read(projectId); const resolved = resolve(projectId, state);
      return { revision: state.revision, settings: state.validationSettings, lock: state.lock,
        effectiveConstraints: resolved.ok ? { source: resolved.versions.length ? 'locked' : 'project', constraints: resolved.versions[0]?.package.constraints ?? state.validationSettings.projectConstraints } : null,
        diagnostics: resolved.diagnostics,
      };
    },
    saveValidationSettings(projectId: string, input: ProjectDesignRuntimeValidationSettingsRequest) {
      const { expectedRevision, settings } = ProjectDesignRuntimeValidationSettingsRequestSchema.parse(input);
      const state = atRevision(projectId, expectedRevision); const resolved = resolve(projectId, state);
      if (state.lock.dependencies.length && !isDeepStrictEqual(settings.projectConstraints, state.validationSettings.projectConstraints)) reject('A locked package owns the policy. Clear the dependency before editing project constraints.');
      if (!resolved.ok && settings.mode !== 'explore') reject('The locked package cannot be verified. Explicitly choose Explore to recover before clearing this dependency.', resolved.diagnostics);
      return persist(projectId, expectedRevision, { ...state, validationSettings: settings });
    },
    /** The caller persists this state in the same CAS as dependency removal. */
    prepareDependencyClear(projectId: string, state: ProjectDesignRuntimeState): ProjectDesignRuntimeState {
      const resolved = resolve(projectId, state);
      if (!resolved.ok && state.validationSettings.mode !== 'explore') reject('The locked package cannot be verified. Save Explore mode explicitly before clearing the dependency.', resolved.diagnostics);
      const constraints = resolved.ok ? resolved.versions[0]?.package.constraints : undefined;
      return { ...state, validationSettings: { ...state.validationSettings, ...(constraints ? { projectConstraints: constraints } : {}) },
        dependencies: { ...state.dependencies, dependencies: [] }, lock: { ...state.lock, dependencies: [] } };
    },
    async validateArtifacts(projectId: string, input: ProjectDesignRuntimeValidateArtifactsRequest): Promise<ProjectDesignRuntimeValidateArtifactsResponse> {
      const request = ProjectDesignRuntimeValidateArtifactsRequestSchema.parse(input);
      const state = atRevision(projectId, request.expectedRevision);
      const { request: facts, failures } = await collectProjectValidationFacts({ store, projectId, state, sources: request.sources, outputs: request.outputs,
        readSource: (path) => readSource(projectId, path), observeTargetPackages: (names) => observeTargetPackages(projectId, names) });
      atRevision(projectId, request.expectedRevision);
      const result = validateStructuredDesign(facts);
      if (!failures.length) return { revision: state.revision, result };
      failures.sort((left, right) => left.location!.sourcePath < right.location!.sourcePath ? -1 : 1);
      const diagnostics = [...result.diagnostics, ...failures];
      return { revision: state.revision, result: StructuredDesignValidationResultSchema.parse({ ...result, diagnostics,
        accepted: !diagnostics.some((issue) => issue.severity === 'error'), strictReady: false,
        coverage: { ...result.coverage, source: false, imports: false }, metrics: { ...result.metrics, unresolvedImports: result.metrics.unresolvedImports + failures.length } }) };
    },
  };
}
