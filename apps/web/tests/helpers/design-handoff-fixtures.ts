import { HandoffManifestSchema, type ProjectDesignRuntimeRegisterLocalBindingRequest } from '@open-design/contracts';
import { emptyDesignRuntimeState } from './design-runtime-fixtures';

export function handoffUiFixture(revision = 2) {
  const state = emptyDesignRuntimeState(revision);
  state.projectComponents.components = [{ schemaVersion: 1, id: 'Card', name: 'Card', revision: 3,
    props: { tone: { type: 'enum', required: false, values: ['primary', 'secondary'], default: 'primary' } },
    template: { schemaVersion: 1, id: 'text', type: 'text', text: '' }, propMappings: [{ prop: 'tone', nodeId: 'text', path: ['text'] }],
  }];
  state.document = { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, id: 'home', type: 'screen', children: [{ schemaVersion: 1, type: 'instance', id: 'card', ref: 'local:Card', overrides: [] }] }] };
  const source = { codeComponentId: 'project/Card', framework: 'react' as const, sourcePath: 'src/Card.tsx', exportName: 'Card' };
  const binding: ProjectDesignRuntimeRegisterLocalBindingRequest['binding'] = { schemaVersion: 1, id: 'local/Card', componentRef: 'local:Card', framework: 'react', status: 'bound', verified: true, definitionRevision: 3, codeComponentId: source.codeComponentId,
    propMappings: [{ designProp: 'tone', codeProp: 'appearance', valueTransform: { type: 'map', entries: [{ from: 'primary', to: 'filled' }, { from: 'secondary', to: 'outline' }] } }],
  };
  state.projectCodeIndex.components = [{ schemaVersion: 1, id: source.codeComponentId, name: 'Card', framework: 'react', sourcePath: source.sourcePath, exportName: source.exportName, props: { appearance: { type: 'enum', required: false, values: ['filled', 'outline'], default: 'filled' } } }];
  state.bindings.bindings = [binding];
  const { codeIndex, sharedChanges: _changes, revision: _revision, schemaVersion: _version, ...snapshot } = state;
  const manifest = HandoffManifestSchema.parse({ schemaVersion: 1, id: 'handoff', projectId: 'project', projectRevision: revision, framework: 'react',
    snapshot: { ...snapshot, baseCodeIndex: codeIndex, versions: [], projectSources: [{ codeComponentId: source.codeComponentId, sourceText: 'export function Card(){ return null; }' }], targetPackages: [] },
    coverage: [{ componentRef: binding.componentRef, binding, ready: true, diagnostics: [] }], ready: true, diagnostics: [],
  });
  return { state, source, binding, result: { schemaVersion: 1 as const, manifest, diagnostics: [] } };
}
