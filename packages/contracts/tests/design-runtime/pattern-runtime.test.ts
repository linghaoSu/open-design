import { describe, expect, it } from 'vitest';
import { DesignPatternInstantiationResultSchema, InstantiateDesignPatternRequestSchema } from '../../src/design-runtime/pattern-runtime.js';

const request = { patternId: 'ResourceList', instanceId: 'list', destinationScreenId: 'screen', props: {}, slots: {} };
const digest = `sha256:${'a'.repeat(64)}`;
const dependency = { designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } };
const node = { schemaVersion: 1, type: 'component', id: 'root', ref: 'ds:acme/Frame', slots: { content: [{ schemaVersion: 1, type: 'instance', id: 'child', ref: 'local:Button', overrides: [] }] } };
const origins = [{ nodeId: 'root', source: { kind: 'pattern', patternId: 'ResourceList', sourceNodeId: 'frame' } }, { nodeId: 'child', source: { kind: 'slot', slot: 'content', sourceNodeId: 'old-child', path: [0] } }];
const result = { schemaVersion: 1, patternId: 'ResourceList', instanceId: 'list', dependency, node, origins, diagnostics: [] };
describe('pattern runtime contracts', () => {
  it('requires explicit configuration and destination identity without accepting package or inherited state', () => {
    expect(InstantiateDesignPatternRequestSchema.parse(request)).toEqual(request);
    for (const input of [{ ...request, instanceId: '' }, { ...request, package: {} }, { ...request, inheritedProps: {} }, { ...request, destinationScreenId: '' }, { ...request, props: { bad: undefined } }]) expect(InstantiateDesignPatternRequestSchema.safeParse(input).success).toBe(false);
    const { slots: _slots, ...missing } = request; expect(InstantiateDesignPatternRequestSchema.safeParse(missing).success).toBe(false);
  });
  it('requires exact dependency proof and unique complete origins for every emitted semantic node', () => {
    expect(DesignPatternInstantiationResultSchema.parse(result)).toEqual(result);
    for (const changed of [{ ...result, dependency: { ...dependency, version: 'latest' } }, { ...result, origins: origins.slice(0, 1) }, { ...result, origins: [...origins, origins[0]] }, { ...result, origins: [{ ...origins[0], source: { ...origins[0]!.source, patternId: 'Other' } }, origins[1]] }]) expect(DesignPatternInstantiationResultSchema.safeParse(changed).success).toBe(false);
  });
  it('never returns an adoptable partial subtree with errors or origins without an output node', () => {
    const diagnostic = { schemaVersion: 1, severity: 'error', code: 'ODDS1004', message: 'Required slot is empty.' };
    expect(DesignPatternInstantiationResultSchema.parse({ ...result, node: null, origins: [], diagnostics: [diagnostic] })).toMatchObject({ node: null });
    for (const changed of [{ ...result, diagnostics: [diagnostic] }, { ...result, node: null }, { ...result, node: null, origins: [] }]) expect(DesignPatternInstantiationResultSchema.safeParse(changed).success).toBe(false);
  });
});
