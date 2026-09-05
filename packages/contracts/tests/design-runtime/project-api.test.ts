import { describe, expect, it } from 'vitest';
import {
  ProjectDesignRuntimeBindRequestSchema,
  ProjectDesignRuntimeVersionsResponseSchema, ProjectDesignRuntimeVersionResponseSchema,
  ProjectDesignRuntimeImportVersionRequestSchema, ProjectDesignRuntimePublishVersionResponseSchema,
  ProjectDesignRuntimePublishCurrentRequestSchema, ProjectDesignRuntimeActivateDependencyRequestSchema,
  ProjectDesignRuntimeDependencyResponseSchema,
  ProjectDesignRuntimeSaveDocumentRequestSchema,
  ProjectDesignRuntimeValidateDocumentRequestSchema,
  ProjectDesignRuntimeDocumentResponseSchema,
  ProjectDesignRuntimeReferencesRequestSchema,
  ProjectDesignRuntimeReferencesResponseSchema,
  ProjectDesignRuntimeProjectComponentsResponseSchema,
  ProjectDesignRuntimeDeletionResponseSchema,
  ProjectDesignRuntimeHistoryResponseSchema,
  ProjectDesignRuntimeStageComponentRequestSchema,
  ProjectDesignRuntimeStageComponentResponseSchema,
  ProjectDesignRuntimeChangeResponseSchema,
  ProjectDesignRuntimePublishComponentRequestSchema,
  ProjectDesignRuntimePublishComponentResponseSchema,
  ProjectDesignRuntimeUndoComponentRequestSchema,
  ProjectDesignRuntimeDeleteComponentRequestSchema,
  ProjectDesignRuntimeDetachRequestSchema,
  ProjectDesignRuntimeDetachResponseSchema,
  ProjectDesignRuntimeCodeComponentsResponseSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeComponentsResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema,
  ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeSearchRequestSchema,
  ProjectDesignRuntimeStateSchema,
  ProjectDesignRuntimeValidateRequestSchema,
  ProjectDesignRuntimeValidateResponseSchema,
} from '../../src/api/design-runtime.js';

const selection = { sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'ui/Button' };
const compile = { expectedRevision: 0, designSystemId: 'test', selections: [selection] };
const component = { schemaVersion: 1, id: 'button', name: 'Button', props: {} };
const code = { schemaVersion: 1, id: 'ui/Button', framework: 'react', name: 'Button', exportName: 'Button', sourcePath: 'src/Button.tsx', props: {} };
const binding = { schemaVersion: 1, id: 'binding/button', componentRef: 'ds:test/button', framework: 'react', status: 'bound', verified: true, codeComponentId: 'ui/Button' };
const state = {
  schemaVersion: 1, revision: 1,
  projectComponents: { schemaVersion: 1, id: 'project', components: [] },
  document: null,
  sharedChanges: { schemaVersion: 1, id: 'project', drafts: [], history: [] },
  dependencies: { schemaVersion: 1, id: 'project', dependencies: [] },
  lock: { schemaVersion: 1, id: 'project', dependencies: [] },
  registry: { schemaVersion: 1, id: 'test', components: [component] },
  codeIndex: { schemaVersion: 1, id: 'project', components: [code] },
  bindings: { schemaVersion: 1, id: 'project', bindings: [binding] },
};

const document = { schemaVersion: 1, id: 'design', screens: [] };
const definition = { schemaVersion: 1, id: 'Local', name: 'Local', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, type: 'text', id: 'text', text: 'Local' } };
const draft = { schemaVersion: 1, id: 'create-local', componentRef: 'local:Local', baseDefinition: null, proposedDefinition: definition, source: { type: 'edit' } };
const references = { schemaVersion: 1, target: 'local:Local', directUsages: [], transitiveUsages: [], affectedScreens: [], chains: [], cycles: [], diagnostics: [] };
const resolution = { schemaVersion: 1, document, origins: [], diagnostics: [] };
const impact = { schemaVersion: 1, componentRef: 'local:Local', baseRevision: 0, proposedRevision: 1, usages: references, current: resolution, proposed: resolution, diagnostics: [] };

describe('project design runtime API contracts', () => {
  it.each([
    { name: 'save document', schema: ProjectDesignRuntimeSaveDocumentRequestSchema, value: { expectedRevision: 1, document } },
    { name: 'validate document', schema: ProjectDesignRuntimeValidateDocumentRequestSchema, value: { document } },
    { name: 'resolved document', schema: ProjectDesignRuntimeDocumentResponseSchema, value: { revision: 1, resolution } },
    { name: 'reference query', schema: ProjectDesignRuntimeReferencesRequestSchema, value: { componentRef: 'local:Local' } },
    { name: 'references', schema: ProjectDesignRuntimeReferencesResponseSchema, value: { revision: 1, references } },
    { name: 'local components', schema: ProjectDesignRuntimeProjectComponentsResponseSchema, value: { revision: 1, components: [definition] } },
    { name: 'deletion analysis', schema: ProjectDesignRuntimeDeletionResponseSchema, value: { revision: 1, analysis: { schemaVersion: 1, componentRef: 'local:Local', canDelete: true, usages: references, diagnostics: [] } } },
    { name: 'definition history', schema: ProjectDesignRuntimeHistoryResponseSchema, value: { revision: 1, history: [{ schemaVersion: 1, componentRef: 'local:Local', definition, changeId: 'create-local' }] } },
    { name: 'stage definition', schema: ProjectDesignRuntimeStageComponentRequestSchema, value: { expectedRevision: 1, draftId: draft.id, expectedDefinitionRevision: 0, definition } },
    { name: 'staged definition', schema: ProjectDesignRuntimeStageComponentResponseSchema, value: { state, draft, impact } },
    { name: 'inspect change', schema: ProjectDesignRuntimeChangeResponseSchema, value: { revision: 1, draft, impact } },
    { name: 'publish request', schema: ProjectDesignRuntimePublishComponentRequestSchema, value: { expectedRevision: 1, expectedDefinitionRevision: 0 } },
    { name: 'published change', schema: ProjectDesignRuntimePublishComponentResponseSchema, value: { state, impact } },
    { name: 'undo request', schema: ProjectDesignRuntimeUndoComponentRequestSchema, value: { expectedRevision: 1, draftId: 'undo-local', expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 } },
    { name: 'delete request', schema: ProjectDesignRuntimeDeleteComponentRequestSchema, value: { expectedRevision: 1, action: { type: 'detach' } } },
    { name: 'detach request', schema: ProjectDesignRuntimeDetachRequestSchema, value: { instance: { schemaVersion: 1, type: 'instance', id: 'instance', ref: 'local:Local', overrides: [] }, mode: 'strict' } },
    { name: 'detach response', schema: ProjectDesignRuntimeDetachResponseSchema, value: { revision: 1, node: definition.template, origins: [{ nodeId: 'text', sourceNodeId: 'text', instancePath: [] }], diagnostics: [] } },
    { name: 'state', schema: ProjectDesignRuntimeStateSchema, value: state },
    { name: 'state response', schema: ProjectDesignRuntimeResponseSchema, value: { state } },
    { name: 'compile', schema: ProjectDesignRuntimeCompileRequestSchema, value: compile },
    { name: 'bind', schema: ProjectDesignRuntimeBindRequestSchema, value: { expectedRevision: 1, binding } },
    { name: 'revision mutation', schema: ProjectDesignRuntimeRevisionRequestSchema, value: { expectedRevision: 1 } },
    { name: 'search', schema: ProjectDesignRuntimeSearchRequestSchema, value: { query: 'button' } },
    { name: 'components', schema: ProjectDesignRuntimeComponentsResponseSchema, value: { revision: 1, components: [component] } },
    { name: 'code components', schema: ProjectDesignRuntimeCodeComponentsResponseSchema, value: { revision: 1, components: [code] } },
    { name: 'resolution', schema: ProjectDesignRuntimeResolveResponseSchema, value: { revision: 1, resolution: { ok: true, component, codeComponent: code } } },
    { name: 'failed resolution', schema: ProjectDesignRuntimeResolveResponseSchema, value: { revision: 1, resolution: { ok: false, diagnostics: [] } } },
    { name: 'validate', schema: ProjectDesignRuntimeValidateRequestSchema, value: { component: 'ds:test/button', props: { disabled: false }, nodeId: 'save' } },
    { name: 'diagnostics', schema: ProjectDesignRuntimeValidateResponseSchema, value: { revision: 1, diagnostics: [] } },
  ])('round-trips $name and rejects unknown fields', ({ schema, value }) => {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(schema.safeParse({ ...value, sourceText: 'unrequested source' }).success).toBe(false);
  });

  it('requires a current schema version, consistent project identity and an initialized registry', () => {
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, schemaVersion: 2 }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, bindings: { ...state.bindings, id: 'other' } }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, registry: null }).success).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s', (expectedRevision) => {
    expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, expectedRevision }).success).toBe(false);
  });

  it('rejects caller source text, path escapes and duplicate selections before file reads', () => {
    for (const sourcePath of ['/private/Button.tsx', '../Button.tsx', 'src/../Button.tsx']) {
      expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, selections: [{ ...selection, sourcePath }] }).success).toBe(false);
    }
    expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, selections: [{ ...selection, sourceText: 'code' }] }).success).toBe(false);
    expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, selections: [selection, selection] }).success).toBe(false);
  });

  it('preserves canonical stage and undo revision refinements and project ownership', () => {
    expect(ProjectDesignRuntimeStageComponentRequestSchema.safeParse({ expectedRevision: 1, draftId: draft.id, expectedDefinitionRevision: 1, definition }).success).toBe(false);
    expect(ProjectDesignRuntimeUndoComponentRequestSchema.safeParse({ expectedRevision: 1, draftId: 'undo', expectedDefinitionRevision: 2, restoreDefinitionRevision: 2 }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, projectComponents: { ...state.projectComponents, id: 'other' } }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, sharedChanges: { ...state.sharedChanges, id: 'other' } }).success).toBe(false);
    const { document: _document, ...legacy } = state;
    expect(ProjectDesignRuntimeStateSchema.safeParse(legacy).success).toBe(false);
  });

  it('does not let bind promote an unbound or unverified request implicitly', () => {
    expect(ProjectDesignRuntimeBindRequestSchema.safeParse({ expectedRevision: 1, binding: { ...binding, status: 'candidate', verified: false } }).success).toBe(false);
    expect(ProjectDesignRuntimeBindRequestSchema.safeParse({ expectedRevision: 1, binding: { ...binding, verified: false } }).success).toBe(false);
  });
});


describe('project exact-version API contracts', () => {
  const policy = { unknownComponents: 'error', unknownProps: 'error', invalidVariants: 'error', invalidSlots: 'error', tokens: { undeclared: 'error' }, rawCss: { colors: 'error', radius: 'error', spacing: 'error' }, interactiveHtml: { customControlsWhenBoundComponentExists: 'error' } };
  const pkg = { schemaVersion: 1, id: 'test', name: 'Test UI', version: '1.0.0', registry: state.registry,
    codeIndex: { ...state.codeIndex, id: 'test' }, bindings: { ...state.bindings, id: 'test' },
    tokens: { schemaVersion: 1, id: 'test', tokens: [] }, patterns: { schemaVersion: 1, id: 'test', patterns: [] },
    constraints: { schemaVersion: 1, explore: policy, guided: policy, strict: policy }, codeCompatibility: [],
    source: { schemaVersion: 1, files: [{ path: 'src/Button.tsx', encoding: 'utf8', content: 'export function Button() {}' }] },
  };
  const digest = `sha256:${'a'.repeat(64)}`;
  const version = { schemaVersion: 1, package: pkg, digest, sourceDigest: digest };
  const summary = { id: 'test', name: 'Test UI', version: '1.0.0', digest, sourceDigest: digest };
  const activate = { expectedRevision: 1, designSystemId: 'test', version: '1.0.0', range: '^1.0.0' };
  const publish = { expectedRevision: 1, name: 'Test UI', version: '1.0.0', sourcePaths: ['src/Button.tsx'], constraints: pkg.constraints };
  it.each([
    [ProjectDesignRuntimeVersionsResponseSchema, { revision: 1, versions: [summary] }],
    [ProjectDesignRuntimeVersionResponseSchema, { revision: 1, version }],
    [ProjectDesignRuntimeImportVersionRequestSchema, { expectedRevision: 1, package: pkg }],
    [ProjectDesignRuntimePublishVersionResponseSchema, { state, version: summary }],
    [ProjectDesignRuntimePublishCurrentRequestSchema, publish],
    [ProjectDesignRuntimeActivateDependencyRequestSchema, activate],
    [ProjectDesignRuntimeDependencyResponseSchema, { revision: 1, resolution: { schemaVersion: 1, ok: true, versions: [version], diagnostics: [] } }],
  ])('round trips one canonical publication/dependency DTO', (schema, input) => {
    expect(schema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    expect(schema.safeParse({ ...input, unknown: true }).success).toBe(false);
  });

  it('rejects implicit versions, unsafe or duplicate selected paths, and source bytes in the summary', () => {
    for (const value of ['latest', '*', '^1.0.0']) expect(ProjectDesignRuntimeActivateDependencyRequestSchema.safeParse({ ...activate, version: value }).success).toBe(false);
    expect(ProjectDesignRuntimeActivateDependencyRequestSchema.safeParse({ ...activate, range: 'latest' }).success).toBe(false);
    for (const sourcePaths of [[], ['../Button.tsx'], ['/Button.tsx'], ['src/Button.tsx', 'SRC/button.tsx'], ['src', 'src/Button.tsx']]) expect(ProjectDesignRuntimePublishCurrentRequestSchema.safeParse({ ...publish, sourcePaths }).success).toBe(false);
    expect(ProjectDesignRuntimeVersionsResponseSchema.safeParse({ revision: 1, versions: [{ ...summary, package: pkg }] }).success).toBe(false);
    expect(ProjectDesignRuntimeImportVersionRequestSchema.safeParse({ expectedRevision: -1, package: pkg }).success).toBe(false);
  });

  it('requires one project-scoped active identity and a paired exact lock', () => {
    const dependencies = { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'test', version: '^1.0.0' }] };
    const lock = { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'test', version: '1.0.0', digest, source: { type: 'bundle', digest } }] };
    expect(ProjectDesignRuntimeStateSchema.parse({ ...state, dependencies, lock }).lock).toEqual(lock);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, dependencies }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, dependencies, lock: { ...lock, id: 'other' } }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, dependencies, lock, registry: { ...state.registry, id: 'other' } }).success).toBe(false);
    const plural = { ...state, dependencies: { ...dependencies, dependencies: [...dependencies.dependencies, { designSystemId: 'second', version: '1.0.0' }] }, lock: { ...lock, dependencies: [...lock.dependencies, { ...lock.dependencies[0], designSystemId: 'second' }] } };
    expect(ProjectDesignRuntimeStateSchema.safeParse(plural).success).toBe(false);
  });
});
