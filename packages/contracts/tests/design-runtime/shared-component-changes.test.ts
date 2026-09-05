import { describe, expect, it } from 'vitest';
import {
  PublishSharedComponentChangeRequestSchema,
  SharedComponentChangeStateSchema,
  SharedComponentDraftSchema,
  SharedComponentImpactSchema,
  SharedComponentPublishedRevisionSchema,
  SharedComponentPublishResultSchema,
  SharedComponentRegistryChangeResultSchema,
  SharedComponentStageResultSchema,
  StageSharedComponentChangeRequestSchema,
  StageSharedComponentUndoRequestSchema,
  type ProjectComponentDefinition,
  type SharedComponentDraft,
  type SharedComponentImpact,
} from '../../src/design-runtime/index.js';

const definition: ProjectComponentDefinition = { schemaVersion: 1, id: 'Card', name: 'Card', revision: 1, props: {}, propMappings: [], template: { schemaVersion: 1, id: 'label', type: 'text', text: 'Current' } };
const proposed: ProjectComponentDefinition = { ...definition, revision: 2, template: { schemaVersion: 1, id: 'label', type: 'text', text: 'Proposed' } };
const draft: SharedComponentDraft = { schemaVersion: 1, id: 'change-card', componentRef: 'local:Card', baseDefinition: definition, proposedDefinition: proposed, source: { type: 'edit' } };
const history = { schemaVersion: 1 as const, componentRef: 'local:Card', definition, changeId: null };
const changes = { schemaVersion: 1 as const, id: 'project', drafts: [draft], history: [] };
const resolved = { schemaVersion: 1 as const, document: { schemaVersion: 1 as const, id: 'design', screens: [] }, origins: [], diagnostics: [] };
const impact: SharedComponentImpact = {
  schemaVersion: 1, componentRef: 'local:Card', baseRevision: 1, proposedRevision: 2,
  usages: { schemaVersion: 1, target: 'local:Card', directUsages: [], transitiveUsages: [], affectedScreens: [], chains: [], cycles: [], diagnostics: [] },
  current: resolved, proposed: resolved, diagnostics: [],
};
const staged = { schemaVersion: 1, changes, draft, impact };
const published = {
  schemaVersion: 1,
  changes: { ...changes, drafts: [], history: [history, { ...history, definition: proposed, changeId: draft.id }] },
  projectComponents: { schemaVersion: 1, id: 'project', components: [proposed] }, impact,
};
const rewritten = { schemaVersion: 1, changes: published.changes, projectComponents: published.projectComponents, resolved };

describe('shared component change contracts', () => {
  it.each([
    [SharedComponentDraftSchema, draft],
    [SharedComponentPublishedRevisionSchema, history],
    [SharedComponentChangeStateSchema, changes],
    [SharedComponentImpactSchema, impact],
    [SharedComponentStageResultSchema, staged],
    [SharedComponentPublishResultSchema, published],
    [SharedComponentRegistryChangeResultSchema, rewritten],
  ] as const)('round-trips versioned change contract %# and rejects unsupported fields/versions', (schema, value) => {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const { schemaVersion: _, ...unversioned } = value;
    expect(schema.safeParse(unversioned).success).toBe(false);
    expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...value, automaticPublish: true }).success).toBe(false);
  });

  it('allows initial revision 1 and requires existing drafts to advance exactly one revision', () => {
    expect(SharedComponentDraftSchema.safeParse({ ...draft, baseDefinition: null, proposedDefinition: definition }).success).toBe(true);
    for (const revision of [1, 3]) expect(SharedComponentDraftSchema.safeParse({ ...draft, proposedDefinition: { ...proposed, revision } }).success).toBe(false);
    expect(SharedComponentDraftSchema.safeParse({ ...draft, componentRef: 'local:Other' }).success).toBe(false);
    expect(SharedComponentPublishedRevisionSchema.safeParse({ ...history, componentRef: 'local:Other' }).success).toBe(false);
  });

  it('rejects duplicate drafts, per-component drafts, history revisions and reused published IDs', () => {
    const anotherDraft = { ...draft, id: 'another-change' };
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, drafts: [draft, draft] }).success).toBe(false);
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, drafts: [draft, anotherDraft] }).success).toBe(false);
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, history: [history, history] }).success).toBe(false);
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, history: [history, { ...history, definition: proposed }] }).success).toBe(false);
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, history: [{ ...history, changeId: draft.id }] }).success).toBe(false);
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, drafts: [], history: [{ ...history, changeId: 'reused' }, { ...history, definition: proposed, changeId: 'reused' }] }).success).toBe(false);
  });

  it('requires undo provenance to identify an earlier immutable snapshot in this history', () => {
    const undo = { ...draft, baseDefinition: proposed, proposedDefinition: { ...definition, revision: 3 }, source: { type: 'undo', definitionRevision: 1 } };
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, drafts: [undo], history: [history] }).success).toBe(true);
    expect(SharedComponentChangeStateSchema.safeParse({ ...changes, drafts: [undo] }).success).toBe(false);
    expect(SharedComponentDraftSchema.safeParse({ ...undo, source: { type: 'undo', definitionRevision: 2 } }).success).toBe(false);
  });

  it('cannot hide proposed errors or certify a contradictory published snapshot', () => {
    const diagnostic = { schemaVersion: 1, code: 'ODDS4001', severity: 'error', message: 'Invalid override.' };
    const failed = { ...resolved, document: null, diagnostics: [diagnostic] };
    expect(SharedComponentImpactSchema.safeParse({ ...impact, proposed: failed }).success).toBe(false);
    expect(SharedComponentImpactSchema.safeParse({ ...impact, proposed: failed, diagnostics: [diagnostic] }).success).toBe(true);
    expect(SharedComponentImpactSchema.safeParse({ ...impact, current: failed }).success).toBe(true);
    expect(SharedComponentPublishResultSchema.safeParse({ ...published, impact: { ...impact, diagnostics: [diagnostic] } }).success).toBe(false);
    expect(SharedComponentPublishResultSchema.safeParse({ ...published, changes }).success).toBe(false);
    expect(SharedComponentPublishResultSchema.safeParse({ ...published, projectComponents: { ...published.projectComponents, components: [definition] } }).success).toBe(false);
    expect(SharedComponentStageResultSchema.safeParse({ ...staged, changes: { ...changes, drafts: [] } }).success).toBe(false);
    expect(SharedComponentRegistryChangeResultSchema.safeParse({ ...rewritten, resolved: failed }).success).toBe(false);
    expect(SharedComponentRegistryChangeResultSchema.safeParse({ ...rewritten, changes: { ...rewritten.changes, id: 'different-project' } }).success).toBe(false);
  });

  it('requires explicit stage/publish/undo revision intent with canonical request shapes', () => {
    const stage = { draftId: draft.id, expectedDefinitionRevision: 1, definition: proposed };
    expect(StageSharedComponentChangeRequestSchema.parse(JSON.parse(JSON.stringify(stage)))).toEqual(stage);
    expect(StageSharedComponentChangeRequestSchema.safeParse({ ...stage, expectedDefinitionRevision: 0 }).success).toBe(false);
    const publish = { draftId: draft.id, expectedDefinitionRevision: 1 };
    expect(PublishSharedComponentChangeRequestSchema.parse(publish)).toEqual(publish);
    expect(PublishSharedComponentChangeRequestSchema.safeParse({ draftId: draft.id }).success).toBe(false);
    const undo = { draftId: 'undo-card', componentRef: 'local:Card', expectedDefinitionRevision: 2, restoreDefinitionRevision: 1 };
    expect(StageSharedComponentUndoRequestSchema.parse(JSON.parse(JSON.stringify(undo)))).toEqual(undo);
    expect(StageSharedComponentUndoRequestSchema.safeParse({ ...undo, restoreDefinitionRevision: 2 }).success).toBe(false);
  });
});
