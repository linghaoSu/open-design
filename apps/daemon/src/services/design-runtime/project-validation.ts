import { isDeepStrictEqual } from 'node:util';
import {
  codeImportPackageName, ProjectDesignRuntimeValidationSettingsRequestSchema, ProjectDesignRuntimeValidateArtifactsRequestSchema,
  StructuredDesignValidationResultSchema, type ProjectDesignRuntimeValidationSettingsRequest,
  type ProjectDesignRuntimeValidationSettingsResponse, type ProjectDesignRuntimeValidateArtifactsRequest,
  type ProjectDesignRuntimeValidateArtifactsResponse, type ProjectDesignRuntimeState, type HandoffTargetPackage,
  type ValidationDiagnostic, type DesignValidationSource,
} from '@open-design/contracts';
import { DesignRuntimeRevisionConflictError, type DesignRuntimeStore } from '../../storage/design-runtime-store.js';
import { resolveLockedDesignSystemsSync } from './design-system-version.js';
import { validateStructuredDesign } from './design-validation.js';
import { effectiveProjectCodeIndex, readProjectCodeEvidence } from './project-code.js';

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
      const resolved = resolve(projectId, state);
      const versions = state.lock.dependencies.flatMap((entry) => {
        const value = store.readVersion(projectId, entry.designSystemId, entry.version); return value ? [value] : [];
      });
      const frozen = resolved.ok ? resolved.versions[0]?.package : undefined;
      const files = new Map<string, Promise<string>>();
      const cachedRead = (path: string) => {
        let read = files.get(path);
        if (!read) { read = readSource(projectId, path); files.set(path, read); }
        return read;
      };
      const failures: ValidationDiagnostic[] = [];
      const selected = request.sources.map(async (source): Promise<DesignValidationSource[]> => {
        try { return [{ ...source, sourceText: await cachedRead(source.sourcePath) }]; }
        catch { failures.push({ schemaVersion: 1, code: 'ODDS6003', severity: state.validationSettings.mode === 'strict' ? 'error' : 'warning', message: 'A selected project source file could not be read.', location: { sourcePath: source.sourcePath, line: 1, column: 1 } }); return []; }
      });
      const allCodes = effectiveProjectCodeIndex(state);
      // Unlocked compiled code requires current project bytes too; only verified frozen code is exempt.
      const projectCodes = { ...allCodes, components: allCodes.components.filter((code) => !frozen?.codeIndex.components.some((entry) => entry.id === code.id)) };
      const names = [...new Set(allCodes.components.flatMap((code) => { const name = code.packageName ? codeImportPackageName(code.packageName) : null; return name ? [name] : []; }))].sort();
      const [sources, projectSources, targetPackages] = await Promise.all([
        Promise.all(selected).then((values) => values.flat()), readProjectCodeEvidence(projectCodes, cachedRead),
        observeTargetPackages(projectId, names).catch(() => names.map((name) => ({ name, installation: { status: 'unknown' as const } }))),
      ]);
      atRevision(projectId, request.expectedRevision);
      const result = validateStructuredDesign({ schemaVersion: 1, projectId, projectRevision: state.revision, settings: state.validationSettings,
        snapshot: { registry: frozen?.registry ?? state.registry, baseCodeIndex: frozen?.codeIndex ?? state.codeIndex,
          projectCodeIndex: state.projectCodeIndex, bindings: state.bindings, projectComponents: state.projectComponents,
          document: state.document, tokens: frozen?.tokens ?? { schemaVersion: 1, id: state.registry?.id ?? projectId, tokens: [] },
          dependencies: state.dependencies, lock: state.lock, versions, projectSources, targetPackages }, sources, outputs: request.outputs });
      if (!failures.length) return { revision: state.revision, result };
      failures.sort((left, right) => left.location!.sourcePath < right.location!.sourcePath ? -1 : 1);
      const diagnostics = [...result.diagnostics, ...failures];
      return { revision: state.revision, result: StructuredDesignValidationResultSchema.parse({ ...result, diagnostics,
        accepted: !diagnostics.some((issue) => issue.severity === 'error'), strictReady: false,
        coverage: { ...result.coverage, source: false, imports: false }, metrics: { ...result.metrics, unresolvedImports: result.metrics.unresolvedImports + failures.length } }) };
    },
  };
}
