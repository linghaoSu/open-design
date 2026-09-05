import { DesignEntityIdSchema, ProjectDesignRuntimeInstantiatePatternRequestSchema,
  type DesignSystemVersion, type ProjectDesignRuntimeInstantiatePatternRequest, type ProjectDesignRuntimeState } from '@open-design/contracts';
import { DesignSystemVersionError } from './design-system-version.js';
import { getDesignPattern, instantiateDesignPattern, searchDesignPatterns } from './pattern-runtime.js';

interface Deps {
  read(projectId: string): ProjectDesignRuntimeState;
  readAtRevision(projectId: string, revision: number): ProjectDesignRuntimeState;
  requireVersion(projectId: string, designSystemId: string, version: string): DesignSystemVersion;
}
/** The draft is authoring input; lock, package and local definitions always come from the daemon. */
export function createProjectPatternService({ read, readAtRevision, requireVersion }: Deps) {
  function version(projectId: string, state: ProjectDesignRuntimeState) {
    const dependency = state.lock.dependencies[0];
    if (!dependency) throw new DesignSystemVersionError([{ schemaVersion: 1, code: 'ODDS5001', severity: 'error', message: 'Lock an exact design-system version before using its patterns.' }]);
    return requireVersion(projectId, dependency.designSystemId, dependency.version);
  }
  return {
    patterns(projectId: string, query = '') {
      const state = read(projectId);
      return { revision: state.revision, ...searchDesignPatterns(state.lock, version(projectId, state), query) };
    },
    pattern(projectId: string, patternId: string) {
      const id = DesignEntityIdSchema.parse(patternId); const state = read(projectId);
      return { revision: state.revision, ...getDesignPattern(state.lock, version(projectId, state), id) };
    },
    instantiatePattern(projectId: string, patternId: string, input: ProjectDesignRuntimeInstantiatePatternRequest) {
      const id = DesignEntityIdSchema.parse(patternId);
      const { expectedRevision, document, ...request } = ProjectDesignRuntimeInstantiatePatternRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      return { revision: state.revision, ...instantiateDesignPattern({ lock: state.lock, projectComponents: state.projectComponents, document }, version(projectId, state), { ...request, patternId: id }) };
    },
  };
}
