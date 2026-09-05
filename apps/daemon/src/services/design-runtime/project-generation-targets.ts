import {
  ProjectDesignRuntimeGenerationTargetsRequestSchema,
  type ProjectDesignRuntimeGenerationTargetsRequest,
  type ProjectDesignRuntimeGenerationTargetsResponse,
  type ProjectDesignRuntimeState,
} from '@open-design/contracts';
import { DesignRuntimeRevisionConflictError, type DesignRuntimeStore } from '../../storage/design-runtime-store.js';

/** Authoring targets remain accessible when a package or source needs repair. */
export function createProjectGenerationTargetsService({ store, persist }: {
  store: DesignRuntimeStore;
  persist(projectId: string, expectedRevision: number, state: ProjectDesignRuntimeState): ProjectDesignRuntimeState;
}) {
  return {
    generationTargets(projectId: string): ProjectDesignRuntimeGenerationTargetsResponse {
      const state = store.read(projectId);
      return { revision: state.revision, targets: state.generationTargets };
    },
    saveGenerationTargets(projectId: string, input: ProjectDesignRuntimeGenerationTargetsRequest): ProjectDesignRuntimeState {
      const request = ProjectDesignRuntimeGenerationTargetsRequestSchema.parse(input);
      const state = store.read(projectId);
      if (state.revision !== request.expectedRevision) throw new DesignRuntimeRevisionConflictError(request.expectedRevision, state.revision);
      return persist(projectId, request.expectedRevision, { ...state, generationTargets: request.targets });
    },
  };
}
