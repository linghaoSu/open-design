import type { DesignPatternDefinition, ProjectDesignRuntimeInstantiatePatternRequest, ProjectDesignRuntimeInstantiatePatternResponse, UIIRDocument } from '@open-design/contracts';
import { designRuntimeState } from './design-runtime-fixtures';

export function designPatternFixture() {
  const state = designRuntimeState();
  const digest = `sha256:${'a'.repeat(64)}`;
  const dependency = { designSystemId: 'test', version: '1.0.0', digest, source: { type: 'bundle' as const, digest } };
  state.lock.dependencies = [dependency]; state.dependencies.dependencies = [{ designSystemId: 'test', version: '1.0.0' }];
  state.registry!.components.push({ schemaVersion: 1, id: 'Card', name: 'Card', props: { title: { type: 'string', required: true } }, slots: { body: { accepts: ['text'], required: true, multiple: true } } });
  const document: UIIRDocument = { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, type: 'screen', id: 'applications', name: 'Applications', children: [] }] };
  state.document = document;
  const pattern: DesignPatternDefinition = { schemaVersion: 1, id: 'ResourceList', name: 'Resource list', props: { title: { type: 'string', required: true, default: 'Resources' } },
    template: { schemaVersion: 1, type: 'component', id: 'root', ref: 'ds:test/Card' }, propMappings: [{ prop: 'title', nodeId: 'root', path: ['props', 'title'] }],
    slots: { items: { accepts: ['text'], required: true, multiple: true } }, slotMappings: [{ slot: 'items', nodeId: 'root', targetSlot: 'body' }] };
  const request: ProjectDesignRuntimeInstantiatePatternRequest = { expectedRevision: 1, instanceId: 'list', destinationScreenId: 'applications', props: { title: 'Applications' },
    slots: { items: [{ schemaVersion: 1, type: 'text', id: 'item', text: 'First resource' }] }, document };
  const result: ProjectDesignRuntimeInstantiatePatternResponse = { revision: 1, schemaVersion: 1, dependency, patternId: pattern.id, instanceId: 'list',
    node: { schemaVersion: 1, type: 'component', id: 'p-root', ref: 'ds:test/Card', props: { title: 'Applications' }, slots: { body: [{ schemaVersion: 1, type: 'text', id: 'p-item', text: 'First resource' }] } },
    origins: [{ nodeId: 'p-root', source: { kind: 'pattern', patternId: pattern.id, sourceNodeId: 'root' } }, { nodeId: 'p-item', source: { kind: 'slot', slot: 'items', sourceNodeId: 'item', path: [0] } }], diagnostics: [] };
  return { state, document, dependency, pattern, request, result };
}
