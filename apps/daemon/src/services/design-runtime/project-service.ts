import {
  ProjectDesignRuntimeBindRequestSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeValidateRequestSchema,
  type ComponentBinding,
  type ComponentRegistry,
  type ApiErrorCode,
  type ProjectDesignRuntimeBindRequest,
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
import { resolveComponentBinding } from './binding-resolver.js';
import {
  reindexComponentBindings,
  revalidateComponentBinding,
  searchCodeComponents,
  unbindComponent,
  upsertComponentBinding,
  type ComponentBindingMutationResult,
} from './code-component-index.js';
import { validateComponentUsage } from './component-validator.js';
import { compileComponentRegistry } from './registry-compiler.js';

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

export function createProjectDesignRuntimeService({ store, readSource }: ProjectDesignRuntimeServiceDeps) {
  function readAtRevision(projectId: string, expectedRevision: number): ProjectDesignRuntimeState {
    const state = store.read(projectId);
    if (state.revision !== expectedRevision) throw new DesignRuntimeRevisionConflictError(expectedRevision, state.revision);
    return state;
  }

  return {
    get: (projectId: string) => store.read(projectId),

    async compile(projectId: string, input: ProjectDesignRuntimeCompileRequest): Promise<ProjectDesignRuntimeState> {
      const request = ProjectDesignRuntimeCompileRequestSchema.parse(input);
      const current = readAtRevision(projectId, request.expectedRevision);
      if (current.registry && current.registry.id !== request.designSystemId) {
        throw new ProjectDesignRuntimeError(409, 'DESIGN_RUNTIME_REGISTRY_CHANGE_REQUIRES_UPGRADE', 'Changing the active design system requires an explicit upgrade.');
      }
      const sources = new Map<string, Promise<string>>();
      for (const selection of request.selections) {
        if (!sources.has(selection.sourcePath)) {
          sources.set(selection.sourcePath, readSource(projectId, selection.sourcePath).catch(() => {
            throw new ProjectDesignRuntimeError(400, 'DESIGN_RUNTIME_SOURCE_UNAVAILABLE', 'A selected project source could not be read.', { sourcePath: selection.sourcePath });
          }));
        }
      }
      const selections = await Promise.all(request.selections.map(async (selection) => ({
        ...selection, sourceText: await sources.get(selection.sourcePath)!,
      })));
      const compiled = compileComponentRegistry({ designSystemId: request.designSystemId, selections });
      const codeIndex = { ...compiled.codeIndex, id: projectId };
      const previous = reindexComponentBindings(current.bindings, current.codeIndex, codeIndex, compiled.registry);
      const knownTargets = new Set(previous.bindings.map((binding) => `${binding.componentRef}\u0000${binding.framework}`));
      const added = compiled.bindings.filter((binding) => !knownTargets.has(`${binding.componentRef}\u0000${binding.framework}`));
      const bindings = {
        ...previous,
        bindings: [...previous.bindings, ...added].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      };
      return store.write(projectId, request.expectedRevision, {
        schemaVersion: 1, revision: current.revision, registry: compiled.registry, codeIndex, bindings,
      });
    },

    components(projectId: string, query = '') {
      const state = store.read(projectId);
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const components = (state.registry?.components ?? []).filter((component) => {
        const text = `${component.id}\n${component.name}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return { revision: state.revision, components };
    },

    codeComponents(projectId: string, query = '') {
      const state = store.read(projectId);
      return { revision: state.revision, components: searchCodeComponents(state.codeIndex, query) };
    },

    bind(projectId: string, id: string, input: ProjectDesignRuntimeBindRequest): ProjectDesignRuntimeState {
      const request = ProjectDesignRuntimeBindRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      if (id !== request.binding.id) throw new ProjectDesignRuntimeError(400, 'BAD_REQUEST', 'Binding ID must match the route.');
      const existing = state.bindings.bindings.find((binding) => binding.id === id);
      if (existing && (existing.componentRef !== request.binding.componentRef || existing.framework !== request.binding.framework)) {
        throw new ProjectDesignRuntimeError(400, 'BAD_REQUEST', 'An existing binding ID must retain its component reference and framework.');
      }
      const result = requireBindingMutation(upsertComponentBinding(state.bindings, request.binding, requireRegistry(state), state.codeIndex));
      return store.write(projectId, request.expectedRevision, { ...state, bindings: result.bindings });
    },

    unbind(projectId: string, id: string, input: ProjectDesignRuntimeRevisionRequest): ProjectDesignRuntimeState {
      const request = ProjectDesignRuntimeRevisionRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      requireBinding(state, id);
      const result = requireBindingMutation(unbindComponent(state.bindings, id));
      return store.write(projectId, request.expectedRevision, { ...state, bindings: result.bindings });
    },

    revalidate(projectId: string, id: string, input: ProjectDesignRuntimeRevisionRequest): ProjectDesignRuntimeState {
      const request = ProjectDesignRuntimeRevisionRequestSchema.parse(input);
      const state = readAtRevision(projectId, request.expectedRevision);
      requireBinding(state, id);
      const result = requireBindingMutation(revalidateComponentBinding(state.bindings, id, requireRegistry(state), state.codeIndex));
      return store.write(projectId, request.expectedRevision, { ...state, bindings: result.bindings });
    },

    resolve(projectId: string, id: string) {
      const state = store.read(projectId);
      return { revision: state.revision, resolution: resolveComponentBinding(requireBinding(state, id), requireRegistry(state), state.codeIndex.components) };
    },

    validate(projectId: string, input: ProjectDesignRuntimeValidateRequest) {
      const request = ProjectDesignRuntimeValidateRequestSchema.parse(input);
      const state = store.read(projectId);
      const diagnostics: ValidationDiagnostic[] = state.registry
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
