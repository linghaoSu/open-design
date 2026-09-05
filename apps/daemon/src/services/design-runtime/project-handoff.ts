import { codeImportPackageName } from '@open-design/contracts';
import type {
  HandoffBuildResult, HandoffChangeContext, HandoffTargetPackage,
  ProjectDesignRuntimeCreateHandoffRequest, ProjectDesignRuntimeState,
} from '@open-design/contracts';
import type { DesignRuntimeStore } from '../../storage/design-runtime-store.js';
import { createHandoff, handoffDiagnostic } from './handoff.js';
import { diffDesignSystemVersions } from './design-system-diff.js';
import { effectiveProjectCodeIndex, readProjectCodeEvidence } from './project-code.js';

export interface ProjectHandoffDeps {
  store: Pick<DesignRuntimeStore, 'readVersion'>;
  readSource: (projectId: string, sourcePath: string) => Promise<string>;
  observeTargetPackages: (projectId: string, packageNames: readonly string[]) => Promise<HandoffTargetPackage[]>;
}

/** Public callers select stored history; all authority/evidence inputs are assembled by the daemon. */
export async function buildProjectHandoff(deps: ProjectHandoffDeps, projectId: string, state: ProjectDesignRuntimeState, request: ProjectDesignRuntimeCreateHandoffRequest): Promise<HandoffBuildResult> {
  const fail = (message: string): HandoffBuildResult => ({ schemaVersion: 1, manifest: null, diagnostics: [handoffDiagnostic('ODDS7001', message)] });
  if (!state.document) return fail('Save a semantic document before creating an engineering handoff.');
  const versions = state.lock.dependencies.flatMap((entry) => {
    const version = deps.store.readVersion(projectId, entry.designSystemId, entry.version);
    return version ? [version] : [];
  });
  const changeContext: HandoffChangeContext = {};
  const selection = request.changeContextSelection;
  if (selection?.fromVersion) {
    const from = deps.store.readVersion(projectId, selection.fromVersion.designSystemId, selection.fromVersion.version);
    const to = versions[0];
    if (!from || !to) return fail('Change context requires an available exact previous catalog version and an active locked version.');
    if (from.package.id !== selection.fromVersion.designSystemId || from.package.version !== selection.fromVersion.version) return fail('Stored change context does not match the selected exact catalog identity.');
    const result = diffDesignSystemVersions(from, to);
    if (!result.ok) return { schemaVersion: 1, manifest: null, diagnostics: result.diagnostics };
    changeContext.semanticDiff = result.diff;
  }
  if (selection?.sharedChangeIds) {
    const history = selection.sharedChangeIds.map((id) => state.sharedChanges.history.find((entry) => entry.changeId === id));
    if (history.some((entry) => entry === undefined)) return fail('Selected shared change context must identify immutable published history in this project.');
    changeContext.sharedRevisions = history.filter((entry) => entry !== undefined);
  }
  const packageNames = [...new Set(effectiveProjectCodeIndex(state).components.filter((code) => code.framework === request.framework).flatMap((code) => {
    const root = code.packageName ? codeImportPackageName(code.packageName) : null;
    return root ? [root] : [];
  }))].sort();
  const [projectSources, targetPackages] = await Promise.all([
    readProjectCodeEvidence(state.projectCodeIndex, (sourcePath) => deps.readSource(projectId, sourcePath)),
    deps.observeTargetPackages(projectId, packageNames),
  ]);
  return createHandoff({ id: request.id, projectId, projectRevision: state.revision, framework: request.framework,
    snapshot: { registry: state.registry, projectComponents: state.projectComponents, baseCodeIndex: state.codeIndex,
      projectCodeIndex: state.projectCodeIndex, bindings: state.bindings, document: state.document,
      dependencies: state.dependencies, lock: state.lock, versions, projectSources, targetPackages },
    ...(Object.keys(changeContext).length ? { changeContext } : {}),
  });
}
