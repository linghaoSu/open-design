import { defaultDesignGenerationTargets, defaultProjectDesignValidationSettings, type ProjectDesignPreviewRequest, type ProjectDesignRuntimeState } from '@open-design/contracts';
import { handoffFixture } from './handoff.js';
import type { PrepareDesignPreviewInput } from '../../../src/services/design-runtime/preview-preparation.js';

export function previewFixture(framework: 'react' | 'vue' = 'react'): { input: PrepareDesignPreviewInput; request: ProjectDesignPreviewRequest } {
  const handoff = handoffFixture(framework); const { snapshot } = handoff;
  const state: ProjectDesignRuntimeState = { schemaVersion: 1, revision: handoff.projectRevision,
    registry: snapshot.registry, codeIndex: { ...snapshot.baseCodeIndex, id: handoff.projectId }, projectCodeIndex: snapshot.projectCodeIndex,
    bindings: snapshot.bindings, projectComponents: snapshot.projectComponents, document: snapshot.document,
    sharedChanges: { schemaVersion: 1, id: handoff.projectId, drafts: [], history: [] }, dependencies: snapshot.dependencies, lock: snapshot.lock,
    validationSettings: defaultProjectDesignValidationSettings(), generationTargets: defaultDesignGenerationTargets(),
  };
  return { input: { projectId: handoff.projectId, state, versions: snapshot.versions, projectSources: snapshot.projectSources, targetPackages: snapshot.targetPackages },
    request: { id: 'preview', expectedRevision: state.revision, framework, kind: 'semantic-design', screenIds: ['main'] } };
}
