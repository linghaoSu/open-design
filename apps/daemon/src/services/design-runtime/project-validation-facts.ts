import { codeImportPackageName, type ProjectDesignRuntimeState, type HandoffTargetPackage, type ValidationDiagnostic, type DesignValidationSource, type DesignValidationOutput, type ValidateStructuredDesignRequest } from '@open-design/contracts';
import type { DesignRuntimeStore } from '../../storage/design-runtime-store.js';
import { resolveLockedDesignSystemsSync } from './design-system-version.js';
import { effectiveProjectCodeIndex, readProjectCodeEvidence } from './project-code.js';

/** One byte cache spans selected artifacts and registered source proofs. No caller-supplied observations. */
export async function collectProjectValidationFacts({ store, projectId, state, sources: sourcesToRead, outputs, readSource, observeTargetPackages }: {
  store: DesignRuntimeStore; projectId: string; state: ProjectDesignRuntimeState;
  sources: readonly Omit<DesignValidationSource, 'sourceText'>[]; outputs: DesignValidationOutput[];
  readSource(path: string): Promise<string>; observeTargetPackages(names: readonly string[]): Promise<HandoffTargetPackage[]>;
}): Promise<{ request: ValidateStructuredDesignRequest; failures: ValidationDiagnostic[] }> {
  const resolved = resolveLockedDesignSystemsSync(state.dependencies, state.lock, (entry) => store.readVersion(projectId, entry.designSystemId, entry.version));
  const versions = state.lock.dependencies.flatMap((entry) => {
    const value = store.readVersion(projectId, entry.designSystemId, entry.version); return value ? [value] : [];
  });
  const frozen = resolved.ok ? resolved.versions[0]?.package : undefined;
  const files = new Map<string, Promise<string>>();
  const cachedRead = (path: string) => {
    let read = files.get(path);
    if (!read) { read = readSource(path); files.set(path, read); }
    return read;
  };
  const failures: ValidationDiagnostic[] = [];
  const selected = sourcesToRead.map(async (source): Promise<DesignValidationSource[]> => {
    try { return [{ ...source, sourceText: await cachedRead(source.sourcePath) }]; }
    catch { failures.push({ schemaVersion: 1, code: 'ODDS6003', severity: state.validationSettings.mode === 'strict' ? 'error' : 'warning', message: 'A selected project source file could not be read.', location: { sourcePath: source.sourcePath, line: 1, column: 1 } }); return []; }
  });
  const allCodes = effectiveProjectCodeIndex(state);
  // Unlocked compiled code requires current project bytes too; only verified frozen code is exempt.
  const projectCodes = { ...allCodes, components: allCodes.components.filter((code) => !frozen?.codeIndex.components.some((entry) => entry.id === code.id)) };
  const names = [...new Set(allCodes.components.flatMap((code) => { const name = code.packageName ? codeImportPackageName(code.packageName) : null; return name ? [name] : []; }))].sort();
  const [sources, projectSources, targetPackages] = await Promise.all([
    Promise.all(selected).then((values) => values.flat()), readProjectCodeEvidence(projectCodes, cachedRead),
    observeTargetPackages(names).catch(() => names.map((name) => ({ name, installation: { status: 'unknown' as const } }))),
  ]);
  const request: ValidateStructuredDesignRequest = { schemaVersion: 1, projectId, projectRevision: state.revision, settings: state.validationSettings,
    snapshot: { registry: frozen?.registry ?? state.registry, baseCodeIndex: frozen?.codeIndex ?? state.codeIndex,
      projectCodeIndex: state.projectCodeIndex, bindings: state.bindings, projectComponents: state.projectComponents,
      document: state.document, tokens: frozen?.tokens ?? { schemaVersion: 1, id: state.registry?.id ?? projectId, tokens: [] },
      dependencies: state.dependencies, lock: state.lock, versions, projectSources, targetPackages }, sources, outputs };
  return { request, failures };
}
