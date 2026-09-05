import type { ComponentInstance, UIIRNode } from '@open-design/contracts';
import type { ProjectComponentContext } from '../../../src/services/design-runtime/reference-graph.js';

export function instance(id: string, ref: string, variant?: string): ComponentInstance {
  return { schemaVersion: 1, type: 'instance', id, ref, overrides: variant === undefined ? [] : [{ schemaVersion: 1, path: ['props', 'variant'], value: variant }] };
}

/** Local Button -> ApplicationCard -> two screens, with one explicit instance override. */
export function projectComponentFixture(): ProjectComponentContext {
  return {
    registry: {
      schemaVersion: 1, id: 'acme', components: [
        { schemaVersion: 1, id: 'Button', name: 'Button', props: {
          variant: { type: 'enum', values: ['primary', 'secondary'], required: true, default: 'primary' },
          label: { type: 'string', required: true, default: 'Apply' },
          disabled: { type: 'boolean', required: true, default: false },
        } },
        { schemaVersion: 1, id: 'Frame', name: 'Frame', props: {}, slots: {
          heading: { accepts: ['text'], required: true, multiple: false },
          body: { accepts: ['ds:acme/Button'], required: true, multiple: false },
        } },
      ],
    },
    projectComponents: {
      schemaVersion: 1, id: 'project', components: [
        { schemaVersion: 1, id: 'Button', name: 'Button', revision: 1,
          props: {
            variant: { type: 'enum', values: ['primary', 'secondary'], required: false, default: 'primary' },
            label: { type: 'string', required: false, default: 'Apply' },
          },
          template: { schemaVersion: 1, type: 'component', id: 'button-root', ref: 'ds:acme/Button' },
          propMappings: [{ prop: 'variant', nodeId: 'button-root', path: ['props', 'variant'] }, { prop: 'label', nodeId: 'button-root', path: ['props', 'label'] }],
        },
        { schemaVersion: 1, id: 'ApplicationCard', name: 'Application card', revision: 1,
          props: {
            variant: { type: 'enum', values: ['primary', 'secondary'], required: false },
            title: { type: 'string', required: true, default: 'Application' },
          },
          template: { schemaVersion: 1, type: 'component', id: 'card-root', ref: 'ds:acme/Frame', slots: {
            heading: [{ schemaVersion: 1, type: 'text', id: 'card-title', text: '' }],
            body: [instance('card-button', 'local:Button')],
          } },
          propMappings: [{ prop: 'variant', nodeId: 'card-button', path: ['props', 'variant'] }, { prop: 'title', nodeId: 'card-title', path: ['text'] }],
        },
      ],
    },
    document: { schemaVersion: 1, id: 'design', screens: [
      { schemaVersion: 1, type: 'screen', id: 'Applications', children: [instance('application', 'local:ApplicationCard')] },
      { schemaVersion: 1, type: 'screen', id: 'Dashboard', children: [instance('dashboard', 'local:ApplicationCard', 'secondary')] },
    ] },
  };
}

export function flattenNodes(nodes: UIIRNode[]): UIIRNode[] {
  return nodes.flatMap((node) => [node, ...(node.type === 'component' ? Object.values(node.slots ?? {}).flatMap(flattenNodes) : [])]);
}
