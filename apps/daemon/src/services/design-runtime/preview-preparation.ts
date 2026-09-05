import { createHash } from 'node:crypto';
import {
  ProjectDesignPreviewRequestSchema, type ProjectDesignPreviewRequest, type ProjectDesignRuntimeState,
  type HandoffBuildResult, type HandoffSnapshot, type DesignSystemVersion, type ProjectCodeSourceEvidence,
  type HandoffTargetPackage, type ResolvedNodeOrigin, type ValidationDiagnostic, type HandoffCodeFile,
  type DesignPreviewImpact,
} from '@open-design/contracts';
import { canonicalDesignSystemJson, resolveLockedDesignSystemsSync } from './design-system-version.js';
import { prepareReviewedDesignSystemUpgrade } from './design-system-upgrade.js';
import { inspectSharedComponentChange } from './shared-component-changes.js';
import { synchronizeLocalComponentBindings } from './local-component-binding.js';
import { resolveProjectDocument } from './project-components.js';
import { createHandoff } from './handoff.js';
import { emitHandoffCode, emitMaterializedCode, materializeDocumentCodeCalls, type HandoffCodeNode } from './handoff-emitter.js';

export function previewDigest(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalDesignSystemJson(value)).digest('hex')}`; }
export function previewDiagnostic(code: 'ODDS8001' | 'ODDS8002' | 'ODDS8003' | 'ODDS8004', message: string): ValidationDiagnostic { return { schemaVersion: 1, severity: 'error', code, message }; }
export class DesignPreviewError extends Error {
  constructor(readonly code: 'CONFLICT' | 'INVALID_REQUEST', message: string, readonly diagnostics: ValidationDiagnostic[] = [previewDiagnostic('ODDS8001', message)]) { super(message); this.name = 'DesignPreviewError'; }
}
export interface PreparedPreviewSide {
  role: 'current' | 'proposed'; snapshot: HandoffSnapshot; origins: ResolvedNodeOrigin[];
  handoff: HandoffBuildResult | null; files: HandoffCodeFile[]; diagnostics: ValidationDiagnostic[];
}
export interface PrepareDesignPreviewInput {
  projectId: string; state: ProjectDesignRuntimeState; versions: DesignSystemVersion[];
  projectSources: ProjectCodeSourceEvidence[]; targetPackages: HandoffTargetPackage[];
  targetVersion?: DesignSystemVersion | undefined;
}

/** Pure snapshot preparation reuses inheritance, shared impact, reviewed migration and production-call materialization. */
export function prepareDesignPreview(input: PrepareDesignPreviewInput, raw: ProjectDesignPreviewRequest): { sides: PreparedPreviewSide[]; impact: DesignPreviewImpact } {
  const request = ProjectDesignPreviewRequestSchema.parse(raw); const { projectId, state } = input;
  let impactEvidence: DesignPreviewImpact = { source: 'none', affectedScreens: [], diagnostics: [] };
  if (state.revision !== request.expectedRevision || state.projectComponents.id !== projectId) throw new DesignPreviewError('CONFLICT', 'Preview requires the exact selected project snapshot.');
  const states: { role: 'current' | 'proposed'; state: ProjectDesignRuntimeState; versions: DesignSystemVersion[]; diagnostics: ValidationDiagnostic[] }[] = [{ role: 'current', state, versions: input.versions, diagnostics: [] }];
  if (request.comparison?.type === 'shared-draft') {
    const selection = request.comparison; const draft = state.sharedChanges.drafts.find((entry) => entry.id === selection.draftId);
    if (!draft || (draft.baseDefinition?.revision ?? 0) !== selection.expectedDefinitionRevision) throw new DesignPreviewError('CONFLICT', 'The selected shared draft or definition revision changed.');
    const impact = inspectSharedComponentChange({ registry: state.registry, projectComponents: state.projectComponents, document: state.document }, state.sharedChanges, draft.id);
    impactEvidence = { source: 'shared-reference-graph', affectedScreens: impact.usages.affectedScreens, diagnostics: impact.usages.diagnostics };
    const projectComponents = { ...state.projectComponents, components: [...state.projectComponents.components.filter((entry) => entry.id !== draft.proposedDefinition.id), draft.proposedDefinition] };
    const next = { ...state, projectComponents };
    states.push({ role: 'proposed', state: { ...next, bindings: synchronizeLocalComponentBindings({ ...next, baseCodeIndex: next.codeIndex }) }, versions: input.versions, diagnostics: impact.diagnostics });
  } else if (request.comparison?.type === 'upgrade') {
    const from = input.versions[0]; const to = input.targetVersion;
    if (!from || !to) throw new DesignPreviewError('INVALID_REQUEST', 'Upgrade preview requires both exact catalog versions.');
    const { revision, dependencies, lock, codeIndex, projectCodeIndex, bindings, projectComponents, document, sharedChanges } = state;
    const prepared = prepareReviewedDesignSystemUpgrade({ projectId, revision, dependencies, lock, codeIndex, projectCodeIndex, bindings, projectComponents, document, sharedChanges, projectSources: input.projectSources }, from, to, request.comparison.proof);
    impactEvidence = { source: 'reviewed-upgrade', affectedScreens: prepared.review.affectedScreens, diagnostics: prepared.review.diagnostics };
    states.push({ role: 'proposed', state: { ...state, ...prepared, registry: to.package.registry }, versions: [to], diagnostics: prepared.review.diagnostics });
  }
  const sides = states.map((side): PreparedPreviewSide => {
    const context = { registry: side.state.registry, projectComponents: side.state.projectComponents, document: side.state.document ?? { schemaVersion: 1 as const, id: projectId, screens: [] } };
    const resolved = resolveProjectDocument(context);
    const diagnostics = [...side.diagnostics, ...resolved.diagnostics];
    if (!side.state.document) diagnostics.push(previewDiagnostic('ODDS8001', 'Save a semantic document before previewing.'));
    const document = request.kind === 'semantic-design' ? resolved.document : side.state.document;
    const screens = request.screenIds.flatMap((id) => {
      const screen = document?.screens.find((entry) => entry.id === id);
      if (!screen) diagnostics.push(previewDiagnostic('ODDS8001', `Selected screen ${id} is unavailable on the ${side.role} side.`));
      return screen ? [screen] : [];
    });
    // Expanded local templates render through DS bindings. They cannot borrow stale local implementation proof.
    const semantic = request.kind === 'semantic-design';
    const snapshot: HandoffSnapshot = { registry: side.state.registry,
      projectComponents: semantic ? { ...side.state.projectComponents, components: [] } : side.state.projectComponents,
      baseCodeIndex: side.state.codeIndex, projectCodeIndex: semantic ? { ...side.state.projectCodeIndex, components: [] } : side.state.projectCodeIndex,
      bindings: semantic ? { ...side.state.bindings, bindings: side.state.bindings.bindings.filter((binding) => binding.componentRef.startsWith('ds:')) } : side.state.bindings,
      document: { ...context.document, screens }, dependencies: side.state.dependencies, lock: side.state.lock,
      versions: side.versions, projectSources: semantic ? [] : input.projectSources, targetPackages: input.targetPackages,
    };
    if (diagnostics.some((entry) => entry.severity === 'error')) return { role: side.role, snapshot, origins: resolved.origins, handoff: null, files: [], diagnostics };
    const outputs = request.outputs ?? request.screenIds.map((screenId) => ({ screenId, sourcePath: `.od-preview/${request.id}/${screenId}.${request.framework === 'react' ? 'tsx' : 'vue'}`, exportName: request.framework === 'react' ? 'PreviewScreen' : 'default' }));
    if (semantic) {
      const locked = resolveLockedDesignSystemsSync(snapshot.dependencies, snapshot.lock, (entry) => snapshot.versions.find((version) => version.package.id === entry.designSystemId && version.package.version === entry.version) ?? null);
      diagnostics.push(...locked.diagnostics);
      const version = locked.ok ? locked.versions[0] : undefined;
      if (version ? canonicalDesignSystemJson(snapshot.registry) !== canonicalDesignSystemJson(version.package.registry) || canonicalDesignSystemJson(snapshot.baseCodeIndex.components) !== canonicalDesignSystemJson(version.package.codeIndex.components)
        : snapshot.registry?.components.length || snapshot.baseCodeIndex.components.length) diagnostics.push(previewDiagnostic('ODDS8001', 'Semantic preview requires the exact frozen DS registry and code source.'));
      if (diagnostics.some((entry) => entry.severity === 'error')) return { role: side.role, snapshot, origins: resolved.origins, handoff: null, files: [], diagnostics };
      const calls = materializeDocumentCodeCalls(snapshot, request.framework, diagnostics);
      if (!calls.ok) return { role: side.role, snapshot, origins: resolved.origins, handoff: null, files: [], diagnostics: calls.diagnostics };
      const frozenImports = (node: HandoffCodeNode): HandoffCodeNode => {
        if (node.type === 'text') return node;
        const { packageName: _packageName, ...codeComponent } = node.codeComponent;
        return { ...node, codeComponent, slots: Object.fromEntries(Object.entries(node.slots).map(([name, children]) => [name, children.map(frozenImports)])) };
      };
      const code = emitMaterializedCode(request.framework, calls.screens.map((screen) => ({ ...screen, nodes: screen.nodes.map(frozenImports) })), snapshot.baseCodeIndex.components, outputs, diagnostics);
      return { role: side.role, snapshot, origins: resolved.origins, handoff: null, files: code.files, diagnostics: code.diagnostics };
    }
    const handoff = createHandoff({ id: request.id, projectId, projectRevision: state.revision, framework: request.framework, snapshot });
    diagnostics.push(...handoff.diagnostics);
    if (!handoff.manifest?.ready) return { role: side.role, snapshot, origins: resolved.origins, handoff, files: [], diagnostics };
    const code = emitHandoffCode({ manifest: handoff.manifest, outputs });
    diagnostics.push(...code.diagnostics);
    return { role: side.role, snapshot, origins: resolved.origins, handoff, files: code.files, diagnostics };
  });
  return { sides, impact: impactEvidence };
}
