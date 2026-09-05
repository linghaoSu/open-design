import { ProjectDesignRuntimeInstantiateMigrationRecipeRequestSchema, type DesignSystemVersion,
  type ProjectDesignRuntimeInstantiateMigrationRecipeRequest, type ProjectDesignRuntimeState } from '@open-design/contracts';
import { DesignSystemVersionError } from './design-system-version.js';
import { instantiateDesignSystemMigrationRecipe } from './migration-recipes.js';

interface Deps {
  read(projectId: string): ProjectDesignRuntimeState;
  readAtRevision(projectId: string, revision: number): ProjectDesignRuntimeState;
  requireVersion(projectId: string, designSystemId: string, version: string): DesignSystemVersion;
}
/** Inject the project's existing exact-version/read authority; recipes never persist a mutation. */
export function createProjectMigrationRecipeService({ read, readAtRevision, requireVersion }: Deps) {
  return {
    migrationRecipes(projectId: string, designSystemId: string, version: string) {
      const state = read(projectId);
      return { revision: state.revision, recipes: requireVersion(projectId, designSystemId, version).package.migrations ?? [] };
    },
    instantiateMigrationRecipe(projectId: string, input: ProjectDesignRuntimeInstantiateMigrationRecipeRequest) {
      const { expectedRevision, designSystemId, version, ...request } = ProjectDesignRuntimeInstantiateMigrationRecipeRequestSchema.parse(input);
      const state = readAtRevision(projectId, expectedRevision);
      const active = state.lock.dependencies[0];
      if (!active) throw new DesignSystemVersionError([{ schemaVersion: 1, code: 'ODDS5002', severity: 'error', message: 'A migration recipe requires an active exact dependency.' }]);
      const from = requireVersion(projectId, active.designSystemId, active.version);
      const to = requireVersion(projectId, designSystemId, version);
      return { revision: state.revision, ...instantiateDesignSystemMigrationRecipe({ projectId, lock: state.lock, bindings: state.bindings }, from, to, request) };
    },
  };
}
