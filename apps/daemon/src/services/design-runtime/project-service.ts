import { isDeepStrictEqual } from 'node:util';
import {
  ProjectDesignRuntimeReviewUpgradeRequestSchema,
  ProjectDesignRuntimeApplyUpgradeRequestSchema,
  type ProjectDesignRuntimeReviewUpgradeRequest,
  type ProjectDesignRuntimeApplyUpgradeRequest,
  type DesignSystemUpgradeContext,
  ProjectDesignRuntimeBindRequestSchema,
  ProjectDesignRuntimeStateSchema,
  ProjectDesignRuntimeRegisterLocalBindingRequestSchema,
  ProjectDesignRuntimeCreateHandoffRequestSchema,
  ProjectDesignRuntimeEmitHandoffRequestSchema,
  type ProjectDesignRuntimeRegisterLocalBindingRequest,
  type ProjectDesignRuntimeCreateHandoffRequest,
  type ProjectDesignRuntimeEmitHandoffRequest,
  type ProjectCodeSourceEvidence,
  type HandoffTargetPackage,
  type HandoffCodeResult,
  ProjectDesignRuntimeImportVersionRequestSchema,
  ProjectDesignRuntimePublishCurrentRequestSchema,
  ProjectDesignRuntimeActivateDependencyRequestSchema,
  type ProjectDesignRuntimeImportVersionRequest,
  type ProjectDesignRuntimePublishCurrentRequest,
  type ProjectDesignRuntimeActivateDependencyRequest,
  type DesignSystemVersion,
  type DesignSystemPackage,
  ProjectDesignRuntimeSaveDocumentRequestSchema,
  ProjectDesignRuntimeValidateDocumentRequestSchema,
  ProjectDesignRuntimeStageComponentRequestSchema,
  ProjectDesignRuntimePublishComponentRequestSchema,
  ProjectDesignRuntimeUndoComponentRequestSchema,
  ProjectDesignRuntimeDeleteComponentRequestSchema,
  ProjectDesignRuntimeDetachRequestSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeValidateRequestSchema,
  type ComponentBinding,
  type ComponentRegistry,
  type ApiErrorCode,
  type ProjectDesignRuntimeBindRequest,
  type ProjectDesignRuntimeSaveDocumentRequest,
  type ProjectDesignRuntimeValidateDocumentRequest,
  type ProjectDesignRuntimeStageComponentRequest,
  type ProjectDesignRuntimePublishComponentRequest,
  type ProjectDesignRuntimeUndoComponentRequest,
  type ProjectDesignRuntimeDeleteComponentRequest,
  type ProjectDesignRuntimeDetachRequest,
  type ProjectDesignRuntimeCompileRequest,
  type ProjectDesignRuntimeRevisionRequest,
  type ProjectDesignRuntimeState,
  type ProjectDesignRuntimeValidateRequest,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import {
  DesignRuntimeRevisionConflictError,
  type DesignRuntimeStore,
} from '../../storage/design-runtime-store.js';
import { createDesignSystemVersion, createProjectDesignSystemLock, resolveLockedDesignSystemsSync, verifyDesignSystemVersion, DesignSystemVersionError } from './design-system-version.js';
import { reviewDesignSystemUpgrade, applyDesignSystemUpgrade } from './design-system-upgrade.js';
import { resolveComponentBinding } from './binding-resolver.js';
import { registerLocalComponentBinding, synchronizeLocalComponentBindings, verifyProjectCodeSources } from './local-component-binding.js';
import { effectiveProjectCodeIndex, readProjectCodeEvidence, refreshProjectCode } from './project-code.js';
import { buildProjectHandoff } from './project-handoff.js';
import { emitHandoffCode } from './handoff-emitter.js';
import { createProjectGenerationTargetsService } from './project-generation-targets.js';
import { createProjectValidationService } from './project-validation.js';
import { createProjectPatternService } from './project-patterns.js';
import { createProjectMigrationRecipeService } from './project-migration-recipes.js';
import {
  reindexComponentBindings,
  revalidateComponentBinding,
  searchCodeComponents,
  unbindComponent,
  upsertComponentBinding,
  type ComponentBindingMutationResult,
} from './code-component-index.js';
import { validateComponentProperties, validateComponentUsage } from './component-validator.js';
import { compileComponentRegistry } from './registry-compiler.js';
import { deleteProjectComponent, detachComponentInstance, resolveProjectDocument } from './project-components.js';
import { analyzeComponentDeletion, compareDesignRuntimeKeys, queryReferenceGraph } from './reference-graph.js';
import {
  discardSharedComponentChange,
  getSharedComponentHistory,
  inspectSharedComponentChange,
  publishSharedComponentChange,
  recordSharedComponentRegistryChange,
  stageSharedComponentChange,
  stageSharedComponentUndo,
} from './shared-component-changes.js';

export class ProjectDesignRuntimeError extends Error {
  constructor(readonly status: number, readonly code: ApiErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ProjectDesignRuntimeError';
  }
}

export interface ProjectDesignRuntimeServiceDeps {
  store: DesignRuntimeStore;
  /** Inject the production project-file reader; routes authorize before any call. */
  readSource: (projectId: string, sourcePath: string) => Promise<string>;
  /** Omission stays explicitly unknown in tests/embedders; production injects the project observer. */
  observeTargetPackages?: (projectId: string, packageNames: readonly string[]) => Promise<HandoffTargetPackage[]>;
}

function requireRegistry(state: ProjectDesignRuntimeState): ComponentRegistry {
  if (!state.registry) throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_NOT_COMPILED', 'Compile project components first.');
  return state.registry;
}

function requireBinding(state: ProjectDesignRuntimeState, id: string): ComponentBinding {
  const binding = state.bindings.bindings.find((entry) => entry.id === id);
  if (!binding) throw new ProjectDesignRuntimeError(404, 'DESIGN_RUNTIME_BINDING_NOT_FOUND', 'Binding not found.');
  return binding;
}

function requireBindingMutation(result: ComponentBindingMutationResult): Extract<ComponentBindingMutationResult, { ok: true }> {
  if (!result.ok) {
    throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_INVALID_BINDING', 'The binding does not match the current component contracts.', { diagnostics: result.diagnostics });
  }
  return result;
}

function componentContext(state: ProjectDesignRuntimeState) {
  return { registry: state.registry, projectComponents: state.projectComponents, document: state.document ?? { schemaVersion: 1 as const, id: state.projectComponents.id, screens: [] } };
}

function upgradeContext(projectId: string, state: ProjectDesignRuntimeState, projectSources: ProjectCodeSourceEvidence[]): DesignSystemUpgradeContext {
  if (state.lock.dependencies.length !== 1) throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_UPGRADE_CONFLICT', 'A reviewed upgrade requires one active design-system dependency.');
  return { projectId, revision: state.revision, dependencies: state.dependencies, lock: state.lock,
    codeIndex: state.codeIndex, projectCodeIndex: state.projectCodeIndex, projectSources, bindings: state.bindings, projectComponents: state.projectComponents,
    document: state.document, sharedChanges: state.sharedChanges };
}

function assertValidProject(state: ProjectDesignRuntimeState): void {
  const result = resolveProjectDocument(componentContext(state));
  if (!result.document) throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_VALIDATION_FAILED', 'The proposed project contains invalid component references or values.', { diagnostics: result.diagnostics });
}

function requireProjectComponent(state: ProjectDesignRuntimeState, componentId: string) {
  const definition = state.projectComponents.components.find((entry) => entry.id === componentId);
  if (!definition) throw new ProjectDesignRuntimeError(404, 'DESIGN_RUNTIME_COMPONENT_NOT_FOUND', 'Project component not found.');
  return definition;
}

export function createProjectDesignRuntimeService({ store, readSource, observeTargetPackages = async (_projectId, names) => [...new Set(names)].sort().map((name) => ({ name, installation: { status: 'unknown' as const } })) }: ProjectDesignRuntimeServiceDeps) {
  function dependencyResolution(projectId: string, state: ProjectDesignRuntimeState) {
    return resolveLockedDesignSystemsSync(state.dependencies, state.lock, (entry) => store.readVersion(projectId, entry.designSystemId, entry.version));
  }
  function activeVersion(projectId: string, state: ProjectDesignRuntimeState): DesignSystemVersion | undefined {
    const result = dependencyResolution(projectId, state);
    if (!result.ok) throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_DEPENDENCY_INVALID', 'The exact design-system dependency cannot be verified.', { diagnostics: result.diagnostics });
    return result.versions[0];
  }
  function read(projectId: string): ProjectDesignRuntimeState {
    const state = store.read(projectId);
    const version = activeVersion(projectId, state);
    const next = version ? { ...state, registry: version.package.registry, codeIndex: { ...version.package.codeIndex, id: projectId } } : state;
    return { ...next, bindings: reindexComponentBindings(state.bindings, effectiveProjectCodeIndex(state), effectiveProjectCodeIndex(next), next.registry, next.projectComponents) };
  }
  function persist(projectId: string, expectedRevision: number, state: ProjectDesignRuntimeState, versions?: readonly DesignSystemVersion[]) {
    const next = { ...state, bindings: synchronizeLocalComponentBindings({ ...state, baseCodeIndex: state.codeIndex }) };
    const checked = ProjectDesignRuntimeStateSchema.safeParse(next);
    if (!checked.success) throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_INVALID_BINDING', 'The proposed project crosses code or binding ownership boundaries.', { issues: checked.error.issues.map(({ path, message }) => ({ path, message })) });
    return store.write(projectId, expectedRevision, checked.data, versions);
  }
  const dsBindings = (state: ProjectDesignRuntimeState) => ({ ...state.bindings, bindings: state.bindings.bindings.filter((binding) => binding.componentRef.startsWith('ds:')) });
  const sourceEvidence = (projectId: string, state: ProjectDesignRuntimeState) => readProjectCodeEvidence(state.projectCodeIndex, (path) => readSource(projectId, path));
  async function bindingSourceDiagnostics(projectId: string, state: ProjectDesignRuntimeState, binding: ComponentBinding) {
    // Local reuse of editable DS code also needs current bytes; frozen DS bytes were verified by read().
    const candidates = binding.componentRef.startsWith('local:') && state.lock.dependencies.length === 0 ? effectiveProjectCodeIndex(state) : state.projectCodeIndex;
    const index = { ...candidates, components: candidates.components.filter((code) => binding.status !== 'unbound' && code.id === binding.codeComponentId) };
    return verifyProjectCodeSources(index, await readProjectCodeEvidence(index, (path) => readSource(projectId, path)));
  }
  async function requireBindingSource(projectId: string, state: ProjectDesignRuntimeState, binding: ComponentBinding) {
    const diagnostics = await bindingSourceDiagnostics(projectId, state, binding);
    if (diagnostics.length) throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_INVALID_BINDING', 'Current project code source requires refresh and explicit verification.', { diagnostics });
  }
  function versionSummary(version: DesignSystemVersion) {
    return { id: version.package.id, name: version.package.name, version: version.package.version, digest: version.digest, sourceDigest: version.sourceDigest };
  }
  function requireVersion(projectId: string, designSystemId: string, version: string): DesignSystemVersion {
    const result = store.readVersion(projectId, designSystemId, version);
    if (!result) throw new ProjectDesignRuntimeError(404, 'DESIGN_RUNTIME_VERSION_NOT_FOUND', 'The exact design-system version is not in this project catalog.');
    const diagnostics = verifyDesignSystemVersion(result);
    if (diagnostics.length) throw new DesignSystemVersionError(diagnostics);
    if (result.package.id !== designSystemId || result.package.version !== version) throw new DesignSystemVersionError([{ schemaVersion: 1, code: 'ODDS5001', severity: 'error', message: 'Stored version does not match its exact catalog identity.' }]);
    return result;
  }
  function publishVersion(projectId: string, expectedRevision: number, state: ProjectDesignRuntimeState, pkg: DesignSystemPackage) {
    const version = createDesignSystemVersion(pkg);
    const previous = store.readVersion(projectId, pkg.id, pkg.version);
    if (previous) {
      const diagnostics = verifyDesignSystemVersion(previous);
      if (diagnostics.length) throw new DesignSystemVersionError(diagnostics);
    }
    return { state: persist(projectId, expectedRevision, state, [version]), version: versionSummary(version) };
  }

  function readAtRevision(projectId: string, expectedRevision: number): ProjectDesignRuntimeState {
    const state = read(projectId);
    if (state.revision !== expectedRevision) throw new DesignRuntimeRevisionConflictError(expectedRevision, state.revision);
    return state;
  }

  const validation = createProjectValidationService({ store, readSource, observeTargetPackages, persist,
    reject: (message, diagnostics) => { throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_VALIDATION_FAILED', message, diagnostics ? { diagnostics } : undefined); },
  });

  return {
    ...createProjectGenerationTargetsService({ store, persist }),
    validationSettings: validation.validationSettings,
    saveValidationSettings: validation.saveValidationSettings,
    validateArtifacts: validation.validateArtifacts,
    ...createProjectMigrationRecipeService({ read, readAtRevision, requireVersion }),
    ...createProjectPatternService({ read, readAtRevision, requireVersion }),
    get: (projectId: string) => read(projectId),

    versions(projectId: string) {
      const state = read(projectId);
      return { revision: state.revision, versions: store.listVersions(projectId) };
    },

    version(projectId: string, designSystemId: string, version: string) {
      const state = read(projectId);
      return { revision: state.revision, version: requireVersion(projectId, designSystemId, version) };
    },

    importVersion(projectId: string, input: ProjectDesignRuntimeImportVersionRequest) {
      const request = ProjectDesignRuntimeImportVersionRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      return publishVersion(projectId, request.expectedRevision, state, request.package);
    },

    async publishCurrent(projectId: string, input: ProjectDesignRuntimePublishCurrentRequest) {
      const request = ProjectDesignRuntimePublishCurrentRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      const registry = requireRegistry(state);
      const active = activeVersion(projectId, state)?.package;
      const constraints = request.constraints ?? active?.constraints;
      if (!constraints) throw new ProjectDesignRuntimeError(400, 'BAD_REQUEST', 'An initial publication requires explicit design constraints.');
      const files = await Promise.all(request.sourcePaths.map(async (path) => {
        try { return { path, encoding: 'utf8' as const, content: await readSource(projectId, path) }; }
        catch { throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_SOURCE_UNAVAILABLE', 'A selected project source could not be read.', { sourcePath: path }); }
      }));
      const origin = request.origin ?? active?.origin;
      const migrations = request.migrations ?? active?.migrations;
      return publishVersion(projectId, request.expectedRevision, state, {
        schemaVersion: 1, id: registry.id, name: request.name, version: request.version,
        registry, codeIndex: { ...state.codeIndex, id: registry.id }, bindings: { ...dsBindings(state), id: registry.id },
        tokens: request.tokens ?? active?.tokens ?? { schemaVersion: 1, id: registry.id, tokens: [] },
        patterns: request.patterns ?? active?.patterns ?? { schemaVersion: 1, id: registry.id, patterns: [] },
        constraints, codeCompatibility: request.codeCompatibility ?? active?.codeCompatibility ?? [],
        source: { schemaVersion: 1, files }, ...(origin === undefined ? {} : { origin }), ...(migrations === undefined ? {} : { migrations }),
      });
    },

    activateDependency(projectId: string, input: ProjectDesignRuntimeActivateDependencyRequest) {
      const request = ProjectDesignRuntimeActivateDependencyRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      const current = state.lock.dependencies[0];
      if (current && (current.designSystemId !== request.designSystemId || current.version !== request.version)) {
        throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_REGISTRY_CHANGE_REQUIRES_UPGRADE', 'Changing a locked version requires a reviewed design-system upgrade.');
      }
      const version = requireVersion(projectId, request.designSystemId, request.version);
      const pkg = version.package;
      if (!current && state.registry && !isDeepStrictEqual(
        { registry: state.registry, codeIndex: { ...state.codeIndex, id: pkg.id }, bindings: { ...dsBindings(state), id: pkg.id } },
        { registry: pkg.registry, codeIndex: pkg.codeIndex, bindings: pkg.bindings },
      )) throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_REGISTRY_CHANGE_REQUIRES_UPGRADE', 'Initial pinning requires the same working component, code, and binding snapshot.');
      const next = { ...state,
        registry: pkg.registry, codeIndex: { ...pkg.codeIndex, id: projectId },
        bindings: current ? state.bindings : { ...pkg.bindings, id: projectId, bindings: [...pkg.bindings.bindings, ...state.bindings.bindings.filter((binding) => binding.componentRef.startsWith('local:'))] },
        dependencies: { schemaVersion: 1 as const, id: projectId, dependencies: [{ designSystemId: pkg.id, version: request.range }] },
        lock: createProjectDesignSystemLock(projectId, [version]),
      };
      activeVersion(projectId, next);
      assertValidProject(next);
      return persist(projectId, request.expectedRevision, next);
    },

    clearDependency(projectId: string, input: ProjectDesignRuntimeRevisionRequest) {
      const { expectedRevision } = ProjectDesignRuntimeRevisionRequestSchema.parse(input);
      // Explicit recovery can unpin an unavailable package without pretending its bytes were verified.
      const state = store.read(projectId);
      if (state.revision !== expectedRevision) throw new DesignRuntimeRevisionConflictError(expectedRevision, state.revision);
      return persist(projectId, expectedRevision, validation.prepareDependencyClear(projectId, state));
    },

    resolveDependency(projectId: string) {
      const state = store.read(projectId);
      return { revision: state.revision, resolution: dependencyResolution(projectId, state) };
    },

    async reviewUpgrade(projectId: string, input: ProjectDesignRuntimeReviewUpgradeRequest) {
      const { expectedRevision, plan } = ProjectDesignRuntimeReviewUpgradeRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      const from = requireVersion(projectId, plan.from.designSystemId, plan.from.version);
      const to = requireVersion(projectId, plan.to.designSystemId, plan.to.version);
      const sources = await sourceEvidence(projectId, state);
      readAtRevision(projectId, expectedRevision);
      return { revision: state.revision, review: reviewDesignSystemUpgrade(upgradeContext(projectId, state, sources), from, to, plan) };
    },

    async applyUpgrade(projectId: string, input: ProjectDesignRuntimeApplyUpgradeRequest) {
      const { expectedRevision, ...request } = ProjectDesignRuntimeApplyUpgradeRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      const from = requireVersion(projectId, request.plan.from.designSystemId, request.plan.from.version);
      const to = requireVersion(projectId, request.plan.to.designSystemId, request.plan.to.version);
      const result = applyDesignSystemUpgrade(upgradeContext(projectId, state, await sourceEvidence(projectId, state)), from, to, request);
      const next = persist(projectId, expectedRevision, { ...state, registry: to.package.registry,
        codeIndex: result.codeIndex, projectCodeIndex: result.projectCodeIndex, bindings: result.bindings, projectComponents: result.projectComponents,
        document: result.document, sharedChanges: result.sharedChanges, dependencies: result.dependencies, lock: result.lock });
      return { state: next, review: result.review };
    },

    async compile(projectId: string, input: ProjectDesignRuntimeCompileRequest): Promise<ProjectDesignRuntimeState> {
      const request = ProjectDesignRuntimeCompileRequestSchema.parse(input);
      const current = readAtRevision(projectId, request.expectedRevision);
      if (current.lock.dependencies.length) throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_REGISTRY_LOCKED', 'Clear the active dependency before compiling editable registry changes.');
      if (current.registry && current.registry.id !== request.designSystemId) {
        throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_REGISTRY_CHANGE_REQUIRES_UPGRADE', 'Changing the active design system requires an explicit upgrade.');
      }
      const sources = new Map<string, Promise<string>>();
      for (const selection of request.selections) {
        for (const { sourcePath } of [selection, ...selection.storySources ?? []]) {
          if (!sources.has(sourcePath)) sources.set(sourcePath, readSource(projectId, sourcePath).catch(() => {
            throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_SOURCE_UNAVAILABLE', 'A selected project source could not be read.', { sourcePath });
          }));
        }
      }
      const sourceTexts = new Map(await Promise.all([...sources].map(async ([path, read]) => [path, await read] as const)));
      const selections = request.selections.map(({ storySources, ...selection }) => ({
        ...selection, sourceText: sourceTexts.get(selection.sourcePath)!,
        ...(storySources ? { storySources: storySources.map((source) => ({ ...source, sourceText: sourceTexts.get(source.sourcePath)! })) } : {}),
      }));
      const compiled = compileComponentRegistry({ designSystemId: request.designSystemId, selections });
      assertValidProject({ ...current, registry: compiled.registry });
      const codeIndex = { ...compiled.codeIndex, id: projectId };
      const previous = reindexComponentBindings(current.bindings, effectiveProjectCodeIndex(current), effectiveProjectCodeIndex({ ...current, codeIndex }), compiled.registry, current.projectComponents);
      const knownTargets = new Set(previous.bindings.map((binding) => `${binding.componentRef}\u0000${binding.framework}`));
      const added = compiled.bindings.filter((binding) => !knownTargets.has(`${binding.componentRef}\u0000${binding.framework}`));
      const bindings = {
        ...previous,
        bindings: [...previous.bindings, ...added].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      };
      return persist(projectId, request.expectedRevision, {
        ...current, registry: compiled.registry, codeIndex, bindings,
      });
    },

    components(projectId: string, query = '') {
      const state = read(projectId);
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const components = (state.registry?.components ?? []).filter((component) => {
        const text = `${component.id}\n${component.name}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return { revision: state.revision, components };
    },

    codeComponents(projectId: string, query = '') {
      const state = read(projectId);
      return { revision: state.revision, components: searchCodeComponents(effectiveProjectCodeIndex(state), query) };
    },

    projectCodeComponents(projectId: string, query = '') {
      const state = read(projectId);
      return { revision: state.revision, components: searchCodeComponents(state.projectCodeIndex, query) };
    },

    async registerLocalBinding(projectId: string, input: ProjectDesignRuntimeRegisterLocalBindingRequest) {
      const request = ProjectDesignRuntimeRegisterLocalBindingRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      let sourceText: string;
      try { sourceText = await readSource(projectId, request.source.sourcePath); }
      catch { throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_SOURCE_UNAVAILABLE', 'The selected project source could not be read.', { sourcePath: request.source.sourcePath }); }
      const result = registerLocalComponentBinding({ ...state, baseCodeIndex: state.codeIndex }, { source: { ...request.source, sourceText }, binding: request.binding });
      if (!result.ok) throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_INVALID_BINDING', 'Local source and binding could not be verified.', { diagnostics: result.diagnostics });
      return { state: persist(projectId, request.expectedRevision, { ...state, projectCodeIndex: result.projectCodeIndex, bindings: result.bindings }), binding: result.binding, diagnostics: result.diagnostics };
    },

    async refreshCodeComponent(projectId: string, codeId: string, input: ProjectDesignRuntimeRevisionRequest) {
      const { expectedRevision } = ProjectDesignRuntimeRevisionRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      const code = state.projectCodeIndex.components.find((entry) => entry.id === codeId);
      if (!code) throw new ProjectDesignRuntimeError(404, 'DESIGN_RUNTIME_COMPONENT_NOT_FOUND', 'Registered project code component not found.');
      const sourceText = await readSource(projectId, code.sourcePath).catch(() => undefined);
      const result = refreshProjectCode(state, codeId, sourceText);
      return { state: persist(projectId, expectedRevision, result.state), diagnostics: result.diagnostics };
    },

    async handoff(projectId: string, input: ProjectDesignRuntimeCreateHandoffRequest) {
      const request = ProjectDesignRuntimeCreateHandoffRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      const result = await buildProjectHandoff({ store, readSource, observeTargetPackages }, projectId, state, request);
      readAtRevision(projectId, request.expectedRevision);
      return { revision: state.revision, result };
    },

    async emitHandoff(projectId: string, input: ProjectDesignRuntimeEmitHandoffRequest) {
      const request = ProjectDesignRuntimeEmitHandoffRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      const handoff = await buildProjectHandoff({ store, readSource, observeTargetPackages }, projectId, state, request);
      const code: HandoffCodeResult = handoff.manifest ? emitHandoffCode({ manifest: handoff.manifest, outputs: request.outputs })
        : { schemaVersion: 1, ok: false, files: [], diagnostics: handoff.diagnostics };
      readAtRevision(projectId, request.expectedRevision);
      return { revision: state.revision, handoff, code };
    },

    async bind(projectId: string, id: string, input: ProjectDesignRuntimeBindRequest): Promise<ProjectDesignRuntimeState> {
      const request = ProjectDesignRuntimeBindRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      if (id !== request.binding.id) throw new ProjectDesignRuntimeError(400, 'BAD_REQUEST', 'Binding ID must match the route.');
      const existing = state.bindings.bindings.find((binding) => binding.id === id);
      if (existing && (existing.componentRef !== request.binding.componentRef || existing.framework !== request.binding.framework)) {
        throw new ProjectDesignRuntimeError(400, 'BAD_REQUEST', 'An existing binding ID must retain its component reference and framework.');
      }
      const targetCode = request.binding.status === 'unbound' ? undefined : request.binding.codeComponentId;
      if (request.binding.componentRef.startsWith('ds:') && state.projectCodeIndex.components.some((code) => code.id === targetCode)) throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_INVALID_BINDING', 'Design-system bindings require design-system-owned code.');
      await requireBindingSource(projectId, state, request.binding);
      const result = requireBindingMutation(upsertComponentBinding(state.bindings, request.binding, state.registry, effectiveProjectCodeIndex(state), state.projectComponents));
      return persist(projectId, request.expectedRevision, { ...state, bindings: result.bindings });
    },

    unbind(projectId: string, id: string, input: ProjectDesignRuntimeRevisionRequest): ProjectDesignRuntimeState {
      const request = ProjectDesignRuntimeRevisionRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      requireBinding(state, id);
      const result = requireBindingMutation(unbindComponent(state.bindings, id));
      return persist(projectId, request.expectedRevision, { ...state, bindings: result.bindings });
    },

    async revalidate(projectId: string, id: string, input: ProjectDesignRuntimeRevisionRequest): Promise<ProjectDesignRuntimeState> {
      const request = ProjectDesignRuntimeRevisionRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      await requireBindingSource(projectId, state, requireBinding(state, id));
      const result = requireBindingMutation(revalidateComponentBinding(state.bindings, id, state.registry, effectiveProjectCodeIndex(state), state.projectComponents));
      return persist(projectId, request.expectedRevision, { ...state, bindings: result.bindings });
    },

    async resolve(projectId: string, id: string) {
      const state = read(projectId);
      const binding = requireBinding(state, id);
      const diagnostics = await bindingSourceDiagnostics(projectId, state, binding);
      readAtRevision(projectId, state.revision);
      return { revision: state.revision, resolution: diagnostics.length ? { ok: false as const, diagnostics } : resolveComponentBinding(binding, state.registry, effectiveProjectCodeIndex(state).components, state.projectComponents) };
    },

    saveDocument(projectId: string, input: ProjectDesignRuntimeSaveDocumentRequest): ProjectDesignRuntimeState {
      const request = ProjectDesignRuntimeSaveDocumentRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      const next = { ...state, document: request.document };
      assertValidProject(next);
      return persist(projectId, request.expectedRevision, next);
    },

    validateDocument(projectId: string, input: ProjectDesignRuntimeValidateDocumentRequest) {
      const request = ProjectDesignRuntimeValidateDocumentRequestSchema.parse(input);
      const state = read(projectId);
      return { revision: state.revision, resolution: resolveProjectDocument({ ...componentContext(state), document: request.document }) };
    },

    resolveDocument(projectId: string) {
      const state = read(projectId);
      return { revision: state.revision, resolution: resolveProjectDocument(componentContext(state)) };
    },

    references(projectId: string, componentRef: string) {
      const state = read(projectId);
      return { revision: state.revision, references: queryReferenceGraph(componentContext(state), componentRef) };
    },

    projectComponents(projectId: string, query = '') {
      const state = read(projectId);
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const components = state.projectComponents.components.filter((component) => terms.every((term) => `${component.id}\n${component.name}`.toLowerCase().includes(term)))
        .sort((a, b) => compareDesignRuntimeKeys(a.id, b.id));
      return { revision: state.revision, components };
    },

    deletion(projectId: string, componentId: string) {
      const state = read(projectId);
      requireProjectComponent(state, componentId);
      const analysis = analyzeComponentDeletion(componentContext(state), `local:${componentId}`);
      // A pending draft is an additional durable dependency, outside the source reference graph.
      if (state.sharedChanges.drafts.some((draft) => draft.componentRef === `local:${componentId}`)) {
        analysis.canDelete = false;
        analysis.diagnostics.push({ schemaVersion: 1, code: 'ODDS4004', severity: 'error', componentRef: `local:${componentId}`, message: 'Discard the pending component draft before deleting its definition.' });
      }
      return { revision: state.revision, analysis };
    },

    history(projectId: string, componentId: string) {
      const state = read(projectId);
      const history = getSharedComponentHistory(state.sharedChanges, `local:${componentId}`);
      if (!history.length) requireProjectComponent(state, componentId);
      return { revision: state.revision, history };
    },

    stageComponent(projectId: string, input: ProjectDesignRuntimeStageComponentRequest) {
      const { expectedRevision, ...request } = ProjectDesignRuntimeStageComponentRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      const result = stageSharedComponentChange(componentContext(state), state.sharedChanges, request);
      return { state: persist(projectId, expectedRevision, { ...state, sharedChanges: result.changes }), draft: result.draft, impact: result.impact };
    },

    inspectComponentChange(projectId: string, draftId: string) {
      const state = read(projectId);
      const impact = inspectSharedComponentChange(componentContext(state), state.sharedChanges, draftId);
      return { revision: state.revision, draft: state.sharedChanges.drafts.find((draft) => draft.id === draftId)!, impact };
    },

    publishComponent(projectId: string, draftId: string, input: ProjectDesignRuntimePublishComponentRequest) {
      const { expectedRevision, expectedDefinitionRevision } = ProjectDesignRuntimePublishComponentRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      const result = publishSharedComponentChange(componentContext(state), state.sharedChanges, { draftId, expectedDefinitionRevision });
      return { state: persist(projectId, expectedRevision, { ...state, projectComponents: result.projectComponents, sharedChanges: result.changes }), impact: result.impact };
    },

    discardComponentChange(projectId: string, draftId: string, input: ProjectDesignRuntimeRevisionRequest) {
      const { expectedRevision } = ProjectDesignRuntimeRevisionRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      return persist(projectId, expectedRevision, { ...state, sharedChanges: discardSharedComponentChange(state.sharedChanges, draftId) });
    },

    undoComponent(projectId: string, componentId: string, input: ProjectDesignRuntimeUndoComponentRequest) {
      const { expectedRevision, ...request } = ProjectDesignRuntimeUndoComponentRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      const result = stageSharedComponentUndo(componentContext(state), state.sharedChanges, { ...request, componentRef: `local:${componentId}` });
      return { state: persist(projectId, expectedRevision, { ...state, sharedChanges: result.changes }), draft: result.draft, impact: result.impact };
    },

    deleteComponent(projectId: string, componentId: string, input: ProjectDesignRuntimeDeleteComponentRequest) {
      const { expectedRevision, action } = ProjectDesignRuntimeDeleteComponentRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      requireProjectComponent(state, componentId);
      const context = componentContext(state);
      const result = deleteProjectComponent(context, { componentRef: `local:${componentId}`, action });
      if (!result.ok) throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_VALIDATION_FAILED', 'Component deletion cannot preserve a valid project.', { diagnostics: result.diagnostics });
      const changeIds: Record<string, string> = {};
      for (const definition of result.projectComponents.components) {
        const previous = state.projectComponents.components.find((entry) => entry.id === definition.id)!;
        if (!isDeepStrictEqual(previous, definition)) {
          const ref = `local:${definition.id}`;
          changeIds[ref] = `delete${Buffer.from(JSON.stringify([expectedRevision + 1, componentId, ref]), 'utf8').toString('hex')}`;
        }
      }
      const recorded = recordSharedComponentRegistryChange(context, { ...context, projectComponents: result.projectComponents, document: result.document }, state.sharedChanges, changeIds);
      return persist(projectId, expectedRevision, { ...state, projectComponents: recorded.projectComponents, sharedChanges: recorded.changes, document: state.document === null ? null : result.document });
    },

    detachInstance(projectId: string, input: ProjectDesignRuntimeDetachRequest) {
      const request = ProjectDesignRuntimeDetachRequestSchema.parse(input);
      const state = read(projectId);
      // The public mode field remains accepted for compatibility; saved project policy owns the operation.
      return { revision: state.revision, ...detachComponentInstance(componentContext(state), { ...request, mode: state.validationSettings.mode }) };
    },

    validate(projectId: string, input: ProjectDesignRuntimeValidateRequest) {
      const request = ProjectDesignRuntimeValidateRequestSchema.parse(input);
      const state = read(projectId);
      const local = state.projectComponents.components.find((definition) => request.component === `local:${definition.id}`);
      const diagnostics: ValidationDiagnostic[] = local ? validateComponentProperties(local, { component: request.component, props: request.props, ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }) }) : state.registry
        ? validateComponentUsage(state.registry, {
          component: request.component, props: request.props,
          ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
        })
        : [{
          schemaVersion: 1, code: 'ODDS1001', severity: 'error',
          message: 'No component registry has been compiled for this project.',
          componentRef: request.component, path: ['component'],
          ...(request.nodeId === undefined ? {} : { nodeId: request.nodeId }),
        }];
      return { revision: state.revision, diagnostics };
    },
  };
}

export type ProjectDesignRuntimeService = ReturnType<typeof createProjectDesignRuntimeService>;
