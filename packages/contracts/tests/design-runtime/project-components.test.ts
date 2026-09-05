import { describe, expect, it } from 'vitest';
import {
  ComponentDeletionAnalysisSchema,
  ComponentDetachRequestSchema,
  ComponentReferenceOwnerSchema,
  ComponentReferenceScreenOwnerSchema,
  LocalComponentReferenceSchema,
  ProjectComponentDefinitionSchema,
  ProjectComponentDeleteRequestSchema,
  ProjectComponentPropMappingSchema,
  ProjectComponentRegistrySchema,
  ReferenceGraphQueryResultSchema,
  ReferenceGraphQuerySchema,
  ReferenceGraphSchema,
  ReferenceUsageSchema,
  ResolvedInstanceFrameSchema,
  ResolvedNodeOriginSchema,
  ResolvedUIIRResultSchema,
  ValidationDiagnosticSchema,
  type ProjectComponentDefinition,
  type ReferenceGraphQueryResult,
  type ReferenceUsage,
  type ResolvedUIIRResult,
  type ValidationDiagnostic,
} from '../../src/design-runtime/index.js';

const definition: ProjectComponentDefinition = {
  schemaVersion: 1, id: 'ApplicationCard', name: 'Application card', revision: 1,
  props: { title: { type: 'string', required: false, default: 'Untitled' } },
  template: {
    schemaVersion: 1, type: 'component', id: 'card', ref: 'ds:test/Card',
    slots: { content: [
      { schemaVersion: 1, type: 'text', id: 'title', text: '' },
      { schemaVersion: 1, type: 'instance', id: 'button', ref: 'ds:test/Button', overrides: [] },
    ] },
  },
  propMappings: [{ prop: 'title', nodeId: 'title', path: ['text'] }, { prop: 'title', nodeId: 'button', path: ['props', 'label'] }],
};
const registry = { schemaVersion: 1 as const, id: 'project', components: [definition] };
const componentOwner = { kind: 'component' as const, componentRef: 'local:ApplicationCard' };
const screenOwner = { kind: 'screen' as const, documentId: 'product', screenId: 'applications' };
const buttonUsage: ReferenceUsage = { schemaVersion: 1, owner: componentOwner, nodeId: 'button', target: 'ds:test/Button', path: ['template', 'slots', 'content', 1] };
const cardUsage: ReferenceUsage = { schemaVersion: 1, owner: screenOwner, nodeId: 'application-card', target: 'local:ApplicationCard', path: ['screens', 0, 'children', 0] };
const graph = { schemaVersion: 1 as const, id: 'project', edges: [buttonUsage, cardUsage], diagnostics: [] };
const queryResult: ReferenceGraphQueryResult = {
  schemaVersion: 1, target: 'ds:test/Button', directUsages: [buttonUsage],
  transitiveUsages: [componentOwner, screenOwner], affectedScreens: [screenOwner],
  chains: [[buttonUsage, cardUsage]], cycles: [], diagnostics: [],
};
const noUsages: ReferenceGraphQueryResult = {
  schemaVersion: 1, target: 'local:ApplicationCard', directUsages: [], transitiveUsages: [], affectedScreens: [], chains: [], cycles: [], diagnostics: [],
};
const deletion = { schemaVersion: 1, componentRef: 'local:ApplicationCard', canDelete: true, usages: noUsages, diagnostics: [] };
const frame = { instanceId: 'application-card', componentRef: 'local:ApplicationCard', definitionRevision: 1 };
const resolved: ResolvedUIIRResult = {
  schemaVersion: 1,
  document: { schemaVersion: 1, id: 'product', screens: [{ schemaVersion: 1, type: 'screen', id: 'applications', children: [{
    schemaVersion: 1, type: 'component', id: 'resolved-card', ref: 'ds:test/Card',
    slots: { content: [{ schemaVersion: 1, type: 'text', id: 'resolved-title', text: 'Untitled' }] },
  }] }] },
  origins: [
    { nodeId: 'resolved-card', sourceNodeId: 'card', instancePath: [frame] },
    { nodeId: 'resolved-title', sourceNodeId: 'title', instancePath: [frame] },
  ],
  diagnostics: [],
};
const diagnostic: ValidationDiagnostic = { schemaVersion: 1, code: 'ODDS4005', severity: 'error', message: 'Invalid mapping.' };

describe('versioned project component and graph contracts', () => {
  it.each([
    [ProjectComponentDefinitionSchema, definition],
    [ProjectComponentRegistrySchema, registry],
    [ReferenceUsageSchema, buttonUsage],
    [ReferenceGraphSchema, graph],
    [ReferenceGraphQueryResultSchema, queryResult],
    [ComponentDeletionAnalysisSchema, deletion],
    [ResolvedUIIRResultSchema, resolved],
  ] as const)('round-trips contract %# and rejects missing/future schema versions', (schema, value) => {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const { schemaVersion: _, ...missingVersion } = value;
    expect(schema.safeParse(missingVersion).success).toBe(false);
    expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...value, rawGeometry: { x: 10 } }).success).toBe(false);
  });

  it('preserves assigned IDs and references when display names and revisions change', () => {
    const changed = ProjectComponentDefinitionSchema.parse({ ...definition, name: 'Resource card', revision: 2 });
    expect(changed.id).toBe(definition.id);
    expect(ReferenceUsageSchema.parse(cardUsage).target).toBe(`local:${changed.id}`);
    expect(ProjectComponentRegistrySchema.safeParse({ ...registry, components: [definition, changed] }).success).toBe(false);
    expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, revision: 0 }).success).toBe(false);
    expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, revision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it('allows structural unresolved local references for deterministic runtime diagnostics', () => {
    const input = { ...definition, props: {}, propMappings: [], template: { schemaVersion: 1, type: 'instance', id: 'nested', ref: 'local:later-defined', overrides: [] } };
    expect(ProjectComponentDefinitionSchema.parse(input)).toEqual(input);
  });
});

describe('explicit public-prop-to-template mappings', () => {
  it('supports one public prop driving multiple targets and keeps defaults out of instances', () => {
    expect(ProjectComponentDefinitionSchema.parse(definition)).toEqual(definition);
    expect(ProjectComponentPropMappingSchema.parse(definition.propMappings[0])).toEqual({ prop: 'title', nodeId: 'title', path: ['text'] });
  });

  it.each([
    [{ prop: 'title', nodeId: 'missing', path: ['text'] }],
    [{ prop: 'missing', nodeId: 'title', path: ['text'] }],
    [{ prop: 'title', nodeId: 'title', path: ['props', 'value'] }],
    [{ prop: 'title', nodeId: 'button', path: ['text'] }],
    [],
    [...definition.propMappings, definition.propMappings[0]],
  ].map((propMappings) => ({ propMappings })))('rejects missing, mistyped, unused or duplicated mapping targets %#', ({ propMappings }) => {
    expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, propMappings }).success).toBe(false);
  });

  it('rejects multiple sources targeting the same template prop', () => {
    expect(ProjectComponentDefinitionSchema.safeParse({
      ...definition, props: { ...definition.props, subtitle: { type: 'string', required: true } },
      propMappings: [...definition.propMappings, { prop: 'subtitle', nodeId: 'button', path: ['props', 'label'] }],
    }).success).toBe(false);
  });

  it.each([
    { type: 'number', required: true },
    { type: 'boolean', required: false, default: false },
    { type: 'enum', required: true, values: ['one', 1] },
    { type: 'enum', required: false, values: [null, 'one'], default: null },
    { type: 'string', required: false },
  ])('rejects text mappings without a guaranteed string value %#', (prop) => {
    expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, props: { title: prop } }).success).toBe(false);
  });

  it('accepts required strings, defaulted string enums, and optional prop mappings without text conversion', () => {
    for (const prop of [{ type: 'string', required: true }, { type: 'enum', required: false, values: ['one', 'two'], default: 'one' }]) {
      expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, props: { title: prop } }).success).toBe(true);
    }
    expect(ProjectComponentDefinitionSchema.safeParse({
      ...definition, props: { title: { type: 'enum', required: false, values: [null, 'one'] } },
      propMappings: [{ prop: 'title', nodeId: 'button', path: ['props', 'label'] }],
    }).success).toBe(true);
  });

  it.each([
    { schemaVersion: 1, type: 'text', id: 'title', text: 'Copied default' },
    { schemaVersion: 1, type: 'component', id: 'button', ref: 'ds:test/Button', props: { label: 'Copied default' } },
    { schemaVersion: 1, type: 'instance', id: 'button', ref: 'local:Button', overrides: [{ schemaVersion: 1, path: ['props', 'label'], value: 'Copied default' }] },
  ])('rejects two competing default sources in a mapped template target %#', (template) => {
    expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, template, propMappings: [template.type === 'text'
      ? { prop: 'title', nodeId: 'title', path: ['text'] }
      : { prop: 'title', nodeId: 'button', path: ['props', 'label'] }] }).success).toBe(false);
  });

  it('rejects copied local components, duplicate template IDs and unsupported mapping paths', () => {
    expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, template: { schemaVersion: 1, type: 'component', id: 'button', ref: 'local:Button' } }).success).toBe(false);
    expect(ProjectComponentDefinitionSchema.safeParse({ ...definition, template: { schemaVersion: 1, type: 'component', id: 'card', ref: 'ds:test/Card', slots: { content: [definition.template, definition.template] } } }).success).toBe(false);
    for (const path of [['props', 'title', 'color'], ['slots', 'content'], ['text', 'value']]) {
      expect(ProjectComponentPropMappingSchema.safeParse({ prop: 'title', nodeId: 'title', path }).success).toBe(false);
    }
  });
});

describe('reference graph identities and query facts', () => {
  it('separates screen/document ownership and local component ownership without inferred names', () => {
    expect(ComponentReferenceOwnerSchema.parse(componentOwner)).toEqual(componentOwner);
    expect(ComponentReferenceScreenOwnerSchema.parse(screenOwner)).toEqual(screenOwner);
    expect(ComponentReferenceOwnerSchema.safeParse({ ...componentOwner, componentRef: 'ds:test/Button' }).success).toBe(false);
    expect(ReferenceGraphQuerySchema.parse({ target: 'ds:test/Button' })).toEqual({ target: 'ds:test/Button' });
    expect(ReferenceGraphQuerySchema.safeParse({ target: 'Button' }).success).toBe(false);
  });

  it('rejects duplicate edges by owner and node ID even if target or current location changes', () => {
    expect(ReferenceGraphSchema.safeParse({ ...graph, edges: [buttonUsage, { ...buttonUsage, target: 'ds:test/Other', path: ['template'] }] }).success).toBe(false);
    expect(ReferenceGraphSchema.safeParse({ ...graph, edges: [cardUsage, { ...cardUsage, owner: { ...screenOwner, documentId: 'another-document' } }] }).success).toBe(true);
  });

  it.each([
    { chains: [[]] },
    { chains: [queryResult.chains[0], queryResult.chains[0]] },
    { chains: [[cardUsage, buttonUsage]] },
    { chains: [[buttonUsage, buttonUsage]] },
    { directUsages: [cardUsage] },
    { directUsages: [buttonUsage, buttonUsage] },
    { transitiveUsages: [componentOwner, componentOwner] },
    { affectedScreens: [screenOwner, screenOwner] },
  ])('rejects ambiguous or disconnected query facts %#', (change) => {
    expect(ReferenceGraphQueryResultSchema.safeParse({ ...queryResult, ...change }).success).toBe(false);
  });

  it('represents closed simple local reference cycles and rejects incomplete cycle paths', () => {
    const cycles = [['local:ApplicationCard', 'local:Summary', 'local:ApplicationCard']];
    expect(ReferenceGraphQueryResultSchema.parse({ ...queryResult, cycles }).cycles).toEqual(cycles);
    for (const cycle of [['local:ApplicationCard'], ['local:ApplicationCard', 'local:Summary'], ['local:A', 'local:B', 'local:A', 'local:B', 'local:A']]) {
      expect(ReferenceGraphQueryResultSchema.safeParse({ ...queryResult, cycles: [cycle] }).success).toBe(false);
    }
  });
});

describe('safe deletion and detachment contracts', () => {
  it('cannot certify deletion with references, cycles, errors, or a mismatched query target', () => {
    const changes = [
      { usages: { ...noUsages, directUsages: [cardUsage] } },
      { usages: { ...noUsages, transitiveUsages: [screenOwner] } },
      { usages: { ...noUsages, affectedScreens: [screenOwner] } },
      { usages: { ...noUsages, chains: [[cardUsage]] } },
      { usages: { ...noUsages, cycles: [['local:ApplicationCard', 'local:ApplicationCard']] } },
      { usages: { ...noUsages, diagnostics: [diagnostic] } },
      { diagnostics: [diagnostic] },
      { usages: { ...noUsages, target: 'local:Another' } },
    ];
    for (const change of changes) expect(ComponentDeletionAnalysisSchema.safeParse({ ...deletion, ...change }).success).toBe(false);
    expect(ComponentDeletionAnalysisSchema.safeParse({ ...deletion, canDelete: false, diagnostics: [diagnostic] }).success).toBe(true);
    expect(ComponentDeletionAnalysisSchema.safeParse({ ...deletion, diagnostics: [{ ...diagnostic, severity: 'warning' }] }).success).toBe(true);
  });

  it.each([{ type: 'reject' }, { type: 'replace', replacementRef: 'local:Replacement' }, { type: 'detach' }, { type: 'delete-instances' }])('round-trips explicit local deletion action $type', (action) => {
    const request = { componentRef: 'local:ApplicationCard', action };
    expect(ProjectComponentDeleteRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(ProjectComponentDeleteRequestSchema.safeParse({ ...request, componentRef: 'ds:test/Button' }).success).toBe(false);
  });

  it('rejects same-component replacements and leaves Strict DS detach enforcement to the runtime', () => {
    expect(LocalComponentReferenceSchema.safeParse('ds:test/Button').success).toBe(false);
    expect(ProjectComponentDeleteRequestSchema.safeParse({ componentRef: 'local:Card', action: { type: 'replace', replacementRef: 'local:Card' } }).success).toBe(false);
    const request = { instance: { schemaVersion: 1, type: 'instance', id: 'button', ref: 'ds:test/Button', overrides: [] }, mode: 'strict' };
    expect(ComponentDetachRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
    expect(ComponentDetachRequestSchema.safeParse({ ...request, allowDsDetach: true }).success).toBe(false);
  });
});

describe('resolved output and provenance', () => {
  it('records local definition revisions, allowing DS frames without a revision', () => {
    expect(ResolvedInstanceFrameSchema.parse(frame)).toEqual(frame);
    const { definitionRevision: _, ...withoutRevision } = frame;
    expect(ResolvedInstanceFrameSchema.safeParse(withoutRevision).success).toBe(false);
    expect(ResolvedInstanceFrameSchema.parse({ ...withoutRevision, componentRef: 'ds:test/Button' })).toEqual({ ...withoutRevision, componentRef: 'ds:test/Button' });
    expect(ResolvedNodeOriginSchema.parse(resolved.origins[0])).toEqual(resolved.origins[0]);
  });

  it('requires exactly one origin per resolved node, including nested text', () => {
    for (const origins of [resolved.origins.slice(0, 1), [...resolved.origins, resolved.origins[0]], [{ ...resolved.origins[0], nodeId: 'missing' }, resolved.origins[1]]]) {
      expect(ResolvedUIIRResultSchema.safeParse({ ...resolved, origins }).success).toBe(false);
    }
  });

  it('rejects unresolved local and instance nodes in claimed resolved output', () => {
    for (const node of [
      { schemaVersion: 1, type: 'instance', id: 'resolved-card', ref: 'local:ApplicationCard', overrides: [] },
      { schemaVersion: 1, type: 'component', id: 'resolved-card', ref: 'local:ApplicationCard' },
    ]) {
      const document = { ...resolved.document!, screens: [{ schemaVersion: 1, type: 'screen', id: 'applications', children: [node] }] };
      expect(ResolvedUIIRResultSchema.safeParse({ ...resolved, document, origins: resolved.origins.slice(0, 1) }).success).toBe(false);
    }
  });

  it('returns only diagnostics when resolution cannot complete', () => {
    const failure = { schemaVersion: 1, document: null, origins: [], diagnostics: [diagnostic] };
    expect(ResolvedUIIRResultSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
    expect(ResolvedUIIRResultSchema.safeParse({ ...resolved, diagnostics: [diagnostic] }).success).toBe(false);
    expect(ResolvedUIIRResultSchema.safeParse({ ...failure, origins: resolved.origins }).success).toBe(false);
    expect(ResolvedUIIRResultSchema.safeParse({ ...failure, diagnostics: [] }).success).toBe(false);
  });

  it.each(['ODDS4003', 'ODDS4004', 'ODDS4005', 'ODDS4006', 'ODDS4007'])('round-trips stable structural diagnostic %s', (code) => {
    expect(ValidationDiagnosticSchema.parse({ ...diagnostic, code }).code).toBe(code);
  });
});
