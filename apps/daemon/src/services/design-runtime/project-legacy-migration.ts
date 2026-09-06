import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ProjectDesignRuntimeReviewLegacyMigrationRequestSchema, ProjectDesignRuntimeApplyLegacyMigrationRequestSchema,
  LegacyDesignSystemMigrationReviewSchema, ProjectDesignRuntimeStateSchema,
  type ProjectDesignRuntimeReviewLegacyMigrationRequest, type ProjectDesignRuntimeApplyLegacyMigrationRequest,
  type LegacyDesignSystemMigrationPlan, type LegacyDesignSystemMigrationReview,
  type ProjectDesignRuntimeState, type DesignSystemSourceFile, type DesignSystemVersion, type ValidationDiagnostic,
} from '@open-design/contracts';
import { DesignRuntimeRevisionConflictError, type DesignRuntimeStore } from '../../storage/design-runtime-store.js';
import { canonicalDesignSystemJson, createDesignSystemVersion, createProjectDesignSystemLock, digestDesignSystemSource, DesignSystemVersionError } from './design-system-version.js';
import { compileComponentRegistry } from './registry-compiler.js';
import { CompilerError } from './react-compiler.js';
import { resolveProjectDocument } from './project-components.js';
import { migrateLegacyDesignTokens } from './legacy-token-migration.js';

export interface ProjectLegacyMigrationAuthority {
  /** Stable host-derived root, account and workspace identity; never exposed as source paths. */
  identity: string;
  readSourceFile(path: string): Promise<DesignSystemSourceFile>;
  assertCurrent(): Promise<void>;
  /** Final local identity fence after route authorization; no await may follow before publication. */
  assertCurrentSync(): void;
}
interface Deps {
  store: DesignRuntimeStore;
  acquireAuthority(projectId: string): Promise<ProjectLegacyMigrationAuthority>;
}
export class ProjectLegacyMigrationError extends Error {
  constructor(readonly kind: 'conflict' | 'invalid', message: string, readonly diagnostics: ValidationDiagnostic[] = [], readonly review?: LegacyDesignSystemMigrationReview) {
    super(message); this.name = 'ProjectLegacyMigrationError';
  }
}
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalDesignSystemJson(value)).digest('hex')}`;
const bytes = (file: DesignSystemSourceFile) => Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const issue = (code: ValidationDiagnostic['code'], message: string): ValidationDiagnostic => ({ schemaVersion: 1, code, severity: 'error', message });

/** Pure project bootstrap: review never writes; apply publishes package, working snapshot and lock in one CAS. */
export function createProjectLegacyMigrationService({ store, acquireAuthority }: Deps) {
  const atRevision = (projectId: string, revision: number) => {
    const state = store.read(projectId);
    if (state.revision !== revision) throw new DesignRuntimeRevisionConflictError(revision, state.revision);
    return state;
  };
  function proposedState(state: ProjectDesignRuntimeState, version: DesignSystemVersion, plan: LegacyDesignSystemMigrationPlan): ProjectDesignRuntimeState {
    const pkg = version.package;
    return { ...state, registry: pkg.registry, codeIndex: { ...pkg.codeIndex, id: state.codeIndex.id },
      bindings: { ...state.bindings, bindings: [...state.bindings.bindings, ...pkg.bindings.bindings] },
      dependencies: { ...state.dependencies, dependencies: [{ designSystemId: pkg.id, version: pkg.version }] },
      lock: createProjectDesignSystemLock(state.lock.id, [version]),
      validationSettings: { ...state.validationSettings, mode: plan.mode },
    };
  }

  async function prepare(projectId: string, revision: number, plan: LegacyDesignSystemMigrationPlan) {
    const state = atRevision(projectId, revision);
    if (state.registry !== null || state.dependencies.dependencies.length || state.lock.dependencies.length) throw new ProjectLegacyMigrationError('conflict', 'Legacy migration initializes an empty structured registry. Use a reviewed upgrade for an existing design system.', [issue('ODDS9004', 'The project already has a structured registry or design-system dependency.')]);
    const authority = await acquireAuthority(projectId);
    const assertAuthority = async () => {
      try { await authority.assertCurrent(); }
      catch { throw new ProjectLegacyMigrationError('conflict', 'Project root, workspace or account authority changed. Review again.', [issue('ODDS9004', 'Migration project authority changed.')]); }
    };
    const assertFinal = () => {
      try { authority.assertCurrentSync(); }
      catch { throw new ProjectLegacyMigrationError('conflict', 'Project authority changed before migration publication.', [issue('ODDS9004', 'Migration project authority changed.')]); }
      if (!isDeepStrictEqual(atRevision(projectId, revision), state)) throw new ProjectLegacyMigrationError('conflict', 'Project state changed before migration publication.');
    };
    await assertAuthority();
    atRevision(projectId, revision);
    const files: DesignSystemSourceFile[] = [];
    const sourcePaths = [...plan.sourcePaths].sort(compare);
    if (sourcePaths.length > 256) throw new ProjectLegacyMigrationError('invalid', 'Migration exceeds the 256-file source budget.');
    let total = 0;
    for (const path of sourcePaths) {
      let file: DesignSystemSourceFile;
      try { file = await authority.readSourceFile(path); }
      catch { throw new ProjectLegacyMigrationError('invalid', `Selected source ${path} could not be read as a stable project file.`, [issue('ODDS9001', `Selected source ${path} is unavailable.`)]); }
      if (file.path !== path) throw new ProjectLegacyMigrationError('invalid', 'The source reader returned a different project path.');
      const length = bytes(file).length; total += length;
      if (length > 4 * 1024 * 1024 || total > 24 * 1024 * 1024) throw new ProjectLegacyMigrationError('invalid', 'Migration exceeds its 4 MiB per-file or 24 MiB total source budget.');
      files.push(file);
    }
    const sources = new Map(files.map((file) => [file.path, file]));
    const text = (path: string) => {
      const file = sources.get(path);
      if (!file || file.encoding !== 'utf8') throw new ProjectLegacyMigrationError('invalid', `Selected compiler or token source ${path} must be an included UTF-8 file.`);
      return file.content;
    };
    const migrated = plan.tokenStylesheet
      ? migrateLegacyDesignTokens({ designSystemId: plan.designSystemId, sourcePath: plan.tokenStylesheet, sourceText: text(plan.tokenStylesheet) })
      : { registry: { schemaVersion: 1 as const, id: plan.designSystemId, tokens: [] }, records: [], diagnostics: [] };
    const diagnostics: ValidationDiagnostic[] = [...migrated.diagnostics];
    let compiled = { schemaVersion: 1 as const, registry: { schemaVersion: 1 as const, id: plan.designSystemId, components: [] }, codeIndex: { schemaVersion: 1 as const, id: plan.designSystemId, components: [] }, bindings: [] } as ReturnType<typeof compileComponentRegistry>;
    if (plan.selections.length) {
      try {
        compiled = compileComponentRegistry({ designSystemId: plan.designSystemId,
          selections: plan.selections.map(({ storySources, ...selection }) => ({ ...selection, sourceText: text(selection.sourcePath),
            ...(storySources ? { storySources: storySources.map((story) => ({ ...story, sourceText: text(story.sourcePath) })) } : {}) })),
        }, new Map(files.filter((file) => file.encoding === 'utf8').map((file) => [file.path, file.content])));
      } catch (error) {
        if (error instanceof CompilerError) diagnostics.push({ ...issue('ODDS6002', error.message), location: { sourcePath: error.sourcePath, line: error.line ?? 1, column: Math.max(1, error.column ?? 1) } });
        else throw error;
      }
    }
    if (!migrated.registry.tokens.length && !compiled.registry.components.length) diagnostics.push(issue('ODDS9001', 'Migration requires at least one supported token or selected component. Source preservation alone does not create a structured design system.'));
    let candidate: DesignSystemVersion | null = null;
    if (!diagnostics.some((entry) => entry.severity === 'error')) {
      try {
        candidate = createDesignSystemVersion({ schemaVersion: 1, id: plan.designSystemId, name: plan.name, version: plan.version,
          registry: compiled.registry, codeIndex: compiled.codeIndex, bindings: { schemaVersion: 1, id: plan.designSystemId, bindings: compiled.bindings },
          tokens: migrated.registry, patterns: { schemaVersion: 1, id: plan.designSystemId, patterns: [] }, constraints: plan.constraints,
          codeCompatibility: plan.codeCompatibility, source: { schemaVersion: 1, files },
        });
        const previous = store.readVersion(projectId, plan.designSystemId, plan.version);
        if (previous && !isDeepStrictEqual(previous, candidate)) diagnostics.push(issue('ODDS5006', 'This immutable package version already exists with different content. Choose a new version.'));
        const next = ProjectDesignRuntimeStateSchema.safeParse(proposedState(state, candidate, plan));
        if (!next.success) diagnostics.push(...next.error.issues.map((entry) => ({ ...issue('ODDS9001', entry.message), path: entry.path })));
        else {
          const resolved = resolveProjectDocument({ registry: next.data.registry, projectComponents: next.data.projectComponents,
            document: next.data.document ?? { schemaVersion: 1, id: projectId, screens: [] } });
          if (!resolved.document) diagnostics.push(...resolved.diagnostics);
        }
      } catch (error) {
        if (error instanceof DesignSystemVersionError) diagnostics.push(...error.diagnostics);
        else throw error;
      }
    }
    const fileEvidence = files.map((file) => { const content = bytes(file); return { path: file.path, digest: `sha256:${createHash('sha256').update(content).digest('hex')}`, byteLength: content.length }; });
    const content = { schemaVersion: 1 as const, projectId, baseRevision: revision, baseDigest: digest({ state, authority: authority.identity }),
      planDigest: digest(plan), sourceDigest: digestDesignSystemSource({ schemaVersion: 1, files }), files: fileEvidence, candidate,
      tokens: migrated.records, compiledComponentRefs: compiled.registry.components.map((component) => `ds:${plan.designSystemId}/${component.id}`),
      preservedSourcePaths: sourcePaths, diagnostics, canApply: candidate !== null && !diagnostics.some((entry) => entry.severity === 'error'),
    };
    const review = LegacyDesignSystemMigrationReviewSchema.parse({ ...content, id: `migration-${digest(content).slice(7)}` });
    const verify = async () => {
      for (const original of files) {
        let current: DesignSystemSourceFile;
        try { current = await authority.readSourceFile(original.path); }
        catch { throw new ProjectLegacyMigrationError('conflict', 'Selected migration source became unavailable.', [issue('ODDS9004', `Source ${original.path} changed during migration.`)]); }
        if (current.path !== original.path || current.encoding !== original.encoding || current.content !== original.content) throw new ProjectLegacyMigrationError('conflict', 'Selected migration source changed. Review again before applying.', [issue('ODDS9004', `Source ${original.path} changed during migration.`)]);
      }
      await assertAuthority(); atRevision(projectId, revision);
    };
    return { state, review, verify, assertFinal };
  }
  return {
    async reviewLegacyMigration(projectId: string, input: ProjectDesignRuntimeReviewLegacyMigrationRequest, reauthorize: () => Promise<void> = async () => {}) {
      const request = ProjectDesignRuntimeReviewLegacyMigrationRequestSchema.parse(input);
      const prepared = await prepare(projectId, request.expectedRevision, request.plan);
      await prepared.verify(); await reauthorize(); prepared.assertFinal();
      return { revision: request.expectedRevision, review: prepared.review };
    },
    async applyLegacyMigration(projectId: string, input: ProjectDesignRuntimeApplyLegacyMigrationRequest, reauthorize: () => Promise<void> = async () => {}) {
      const request = ProjectDesignRuntimeApplyLegacyMigrationRequestSchema.parse(input);
      const prepared = await prepare(projectId, request.expectedRevision, request.plan);
      const review = prepared.review;
      if (request.reviewId !== review.id || request.baseDigest !== review.baseDigest || request.planDigest !== review.planDigest || request.sourceDigest !== review.sourceDigest) throw new ProjectLegacyMigrationError('conflict', 'The migration review no longer matches this project, plan or selected source. Review again.', [issue('ODDS9004', 'Migration review identity changed.')], review);
      if (!review.canApply || !review.candidate) throw new ProjectLegacyMigrationError('invalid', 'The migration review has unresolved errors.', review.diagnostics, review);
      await prepared.verify(); await reauthorize(); prepared.assertFinal();
      const candidate = review.candidate;
      const state = store.write(projectId, request.expectedRevision, proposedState(prepared.state, candidate, request.plan), [candidate]);
      return { state, review, version: { id: candidate.package.id, name: candidate.package.name, version: candidate.package.version, digest: candidate.digest, sourceDigest: candidate.sourceDigest } };
    },
  };
}
