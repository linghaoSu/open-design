import {
  codeImportPackageName, ProjectDesignPreviewRequestSchema, ProjectDesignPreviewResultSchema,
  type DesignPreviewSide, type DesignPreviewSourceEvidence, type DesignSystemVersion, type HandoffTargetPackage,
  type ProjectDesignPreviewRequest, type ProjectDesignPreviewResult, type ProjectDesignRuntimeState,
} from '@open-design/contracts';
import type { DesignRuntimeStore } from '../../storage/design-runtime-store.js';
import { effectiveProjectCodeIndex, readProjectCodeEvidence } from './project-code.js';
import { DesignPreviewError, prepareDesignPreview, previewDiagnostic, previewDigest } from './preview-preparation.js';
import { bundleDesignPreview, previewRuntimePackages } from './preview-bundler.js';

export interface ProjectPreviewDeps {
  store: Pick<DesignRuntimeStore, 'readVersion'>;
  readAtRevision(projectId: string, revision: number): ProjectDesignRuntimeState;
  acquireAuthority(projectId: string): Promise<ProjectPreviewAuthority>;
}
export interface ProjectPreviewAuthority {
  /** A bounded reader pinned to the authorized workspace and project root. */
  readSource(path: string): Promise<string>;
  observeTargetPackages(names: readonly string[]): Promise<HandoffTargetPackage[]>;
  /** The server derives this physical path from managed/imported project metadata. */
  projectRoot?: string | undefined;
  /** Check captured root, account and workspace authority at entry and before returning. */
  assertCurrent(): Promise<void>;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const evidenceKey = (entry: DesignPreviewSourceEvidence) => JSON.stringify([entry.origin, entry.packageName, entry.version, entry.sourcePath]);

/** Read-only orchestration. Source proofs and bundle imports share one byte snapshot. */
export function createProjectPreviewService(deps: ProjectPreviewDeps) {
  return { async preview(projectId: string, raw: ProjectDesignPreviewRequest): Promise<ProjectDesignPreviewResult> {
    const request = ProjectDesignPreviewRequestSchema.parse(raw);
    const authority = await deps.acquireAuthority(projectId); await authority.assertCurrent();
    const state = deps.readAtRevision(projectId, request.expectedRevision);
    const sources = new Map<string, Promise<string>>(); let bytes = 0;
    const readSource = (path: string): Promise<string> => {
      let pending = sources.get(path);
      if (!pending) {
        if (sources.size >= 256) return Promise.reject(new DesignPreviewError('INVALID_REQUEST', 'Preview source traversal exceeded its file budget.'));
        pending = authority.readSource(path).then((source) => {
          const length = Buffer.byteLength(source); bytes += length;
          if (length > 4 * 1024 * 1024 || bytes > 24 * 1024 * 1024) throw new DesignPreviewError('INVALID_REQUEST', 'Preview source traversal exceeded its byte budget.');
          return source;
        });
        sources.set(path, pending);
      }
      return pending;
    };
    const versions = state.lock.dependencies.flatMap((entry) => {
      const value = deps.store.readVersion(projectId, entry.designSystemId, entry.version); return value ? [value] : [];
    });
    let targetVersion: DesignSystemVersion | undefined;
    if (request.comparison?.type === 'upgrade') {
      const target = request.comparison.proof.plan.to;
      targetVersion = deps.store.readVersion(projectId, target.designSystemId, target.version) ?? undefined;
    }
    const names = [...new Set([...effectiveProjectCodeIndex(state).components, ...targetVersion?.package.codeIndex.components ?? []].filter((code) => code.framework === request.framework).flatMap((code) => {
      const name = code.packageName ? codeImportPackageName(code.packageName) : null; return name ? [name] : [];
    }))].sort();
    const [projectSources, targetPackages] = await Promise.all([
      readProjectCodeEvidence(state.projectCodeIndex, readSource), authority.observeTargetPackages(names),
    ]);
    const prepared = prepareDesignPreview({ projectId, state, versions, projectSources, targetPackages, targetVersion }, request);
    const projectRoot = authority.projectRoot;
    const verifiers: (() => Promise<boolean>)[] = [];
    const sides: DesignPreviewSide[] = [];
    for (const side of prepared.sides) {
      const evidence = new Map<string, DesignPreviewSourceEvidence>();
      const packages = new Map(side.snapshot.targetPackages.map((entry) => [entry.name, entry]));
      const diagnostics = [...side.diagnostics];
      const screens: DesignPreviewSide['screens'] = [];
      for (const screenId of request.screenIds) {
        const file = side.files.find((entry) => entry.screenId === screenId);
        const authored = request.outputs?.find((entry) => entry.screenId === screenId) ?? { screenId, sourcePath: `.od-preview/${request.id}/${screenId}.${request.framework === 'react' ? 'tsx' : 'vue'}`, exportName: request.framework === 'react' ? 'PreviewScreen' : 'default' };
        if (!file) {
          const failures = diagnostics.filter((entry) => entry.severity === 'error');
          screens.push({ ...authored, bundle: null, diagnostics: failures.length ? failures : [previewDiagnostic('ODDS8001', 'This screen could not be materialized for the selected preview kind.')] });
          continue;
        }
        const built = await bundleDesignPreview(file, side.snapshot, request.kind, { readProjectSource: readSource, projectRoot });
        verifiers.push(built.verifyInstalledSources);
        for (const source of built.sourceEvidence) {
          const key = evidenceKey(source); const previous = evidence.get(key);
          if (previous && previous.digest !== source.digest) throw new DesignPreviewError('CONFLICT', 'Preview source changed between selected screens.');
          evidence.set(key, source);
        }
        for (const installed of built.targetPackages) {
          const previous = packages.get(installed.name);
          if (previous?.installation.status === 'observed' && installed.installation.status === 'observed' && previous.installation.version !== installed.installation.version) throw new DesignPreviewError('CONFLICT', 'Installed package changed between selected screens.');
          packages.set(installed.name, installed);
        }
        screens.push({ screenId, sourcePath: file.sourcePath, exportName: file.exportName, bundle: built.bundle, diagnostics: built.diagnostics });
      }
      let sourceEvidence = [...evidence.values()].sort((a, b) => compare(evidenceKey(a), evidenceKey(b)));
      if (sourceEvidence.length > 256 || sourceEvidence.reduce((total, entry) => total + entry.byteLength, 0) > 24 * 1024 * 1024) {
        const failure = previewDiagnostic('ODDS8002', 'Selected screens exceed the aggregate preview source budget.'); diagnostics.push(failure);
        sourceEvidence = []; screens.forEach((screen) => { screen.bundle = null; screen.diagnostics.push(failure); });
      }
      sides.push({ role: side.role, kind: request.kind, lock: side.snapshot.lock, origins: side.origins,
        sourceEvidence, sourceDigest: previewDigest(sourceEvidence), runtimePackages: previewRuntimePackages(request.framework),
        targetPackages: [...packages.values()].sort((a, b) => compare(a.name, b.name)), screens, diagnostics });
    }
    // Re-read every current file, including negative lookups that could change import resolution.
    for (const [path, source] of sources) {
      const before = await source.then((text) => ({ text }), () => null);
      const after = await authority.readSource(path).then((text) => ({ text }), () => null);
      if (before?.text !== after?.text || Boolean(before) !== Boolean(after)) throw new DesignPreviewError('CONFLICT', 'Project source changed while the preview was being built.');
    }
    for (const verify of verifiers) if (!await verify()) throw new DesignPreviewError('CONFLICT', 'Installed source changed while the preview was being built.');
    await authority.assertCurrent();
    deps.readAtRevision(projectId, request.expectedRevision);
    return ProjectDesignPreviewResultSchema.parse({ schemaVersion: 1, projectId, revision: state.revision,
      request, requestDigest: previewDigest(request), impact: prepared.impact, sides, diagnostics: [] });
  } };
}
