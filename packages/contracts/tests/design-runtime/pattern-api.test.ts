import { describe, expect, it } from 'vitest';
import { ProjectDesignRuntimeInstantiatePatternRequestSchema, ProjectDesignRuntimeInstantiatePatternResponseSchema } from '../../src/api/design-runtime.js';
const input = { expectedRevision: 1, instanceId: 'list', destinationScreenId: 'screen', props: {}, slots: {}, document: { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, type: 'screen', id: 'screen', children: [] }] } };
const digest = `sha256:${'a'.repeat(64)}`;
const result = { schemaVersion: 1, revision: 1, patternId: 'ResourceList', instanceId: 'list', dependency: { designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } }, node: { schemaVersion: 1, type: 'text', id: 'title', text: 'Resources' }, origins: [{ nodeId: 'title', source: { kind: 'pattern', patternId: 'ResourceList', sourceNodeId: 'source-title' } }], diagnostics: [] };
describe('public pattern contracts', () => {
  it('accepts only explicit draft authoring input and rejects replacement authority or imprecise revisions', () => {
    expect(ProjectDesignRuntimeInstantiatePatternRequestSchema.parse(input)).toEqual(input);
    for (const extra of [{ expectedRevision: -1 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { lock: {} }, { registry: {} }, { projectComponents: {} }, { package: {} }, { version: 'latest' }, { patternId: 'Other' }]) expect(ProjectDesignRuntimeInstantiatePatternRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    const { document: _document, ...missing } = input; expect(ProjectDesignRuntimeInstantiatePatternRequestSchema.safeParse(missing).success).toBe(false);
  });
  it('preserves canonical origin and diagnostic guarantees through the flat HTTP revision envelope', () => {
    expect(ProjectDesignRuntimeInstantiatePatternResponseSchema.parse(result)).toEqual(result);
    const invalid = { ...result, node: null, origins: [], diagnostics: [{ schemaVersion: 1, severity: 'error', code: 'ODDS1004', message: 'Required slot missing.' }] };
    expect(ProjectDesignRuntimeInstantiatePatternResponseSchema.parse(invalid)).toEqual(invalid);
    for (const changed of [{ ...result, origins: [] }, { ...result, state: {} }, { ...invalid, node: result.node, origins: result.origins }, { ...result, revision: -1 }]) expect(ProjectDesignRuntimeInstantiatePatternResponseSchema.safeParse(changed).success).toBe(false);
  });
});
