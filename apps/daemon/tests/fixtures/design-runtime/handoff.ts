import type { ComponentFramework, CreateHandoffRequest, DesignSystemPackage } from '@open-design/contracts';
import { packageFixture } from './design-system-version.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../../src/services/design-runtime/design-system-version.js';
import { compileSourceComponent } from '../../../src/services/design-runtime/source-compiler.js';
import { registerLocalComponentBinding } from '../../../src/services/design-runtime/local-component-binding.js';

export function handoffFixture(framework: ComponentFramework = 'react'): CreateHandoffRequest {
  const base = packageFixture();
  const sourceText = framework === 'react' ? `import type { ReactNode } from 'react';
export function Panel(props:{label?:string; children:ReactNode; 'side-panel'?:ReactNode; constructor?:ReactNode; toString?:ReactNode}) { return <section>{props.children}</section>; }
export const PanelPolicy = {component:Panel,slots:{body:{codeSlot:'children',accepts:['text'],required:true,multiple:true}, side:{codeSlot:'side-panel',accepts:['text'],required:false,multiple:true}, constructor:{codeSlot:'constructor',accepts:['text'],required:false,multiple:false}, toString:{codeSlot:'toString',accepts:['text'],required:false,multiple:false}}} as const;`
    : `<script lang="ts">export const PanelPolicy = {component:'default',slots:{body:{codeSlot:'default',accepts:['text'],required:true,multiple:true}, side:{codeSlot:'side-panel',accepts:['text'],required:false,multiple:true}, constructor:{codeSlot:'constructor',accepts:['text'],required:false,multiple:false}, toString:{codeSlot:'toString',accepts:['text'],required:false,multiple:false}}} as const;</script>
<script setup lang="ts">defineProps<{label?:string}>(); defineSlots<{default():unknown; 'side-panel'?():unknown; constructor?():unknown; toString?():unknown}>();</script><template><section><slot /></section></template>`;
  const sourcePath = `src/components/Panel.${framework === 'react' ? 'tsx' : 'vue'}`;
  const compiled = compileSourceComponent({ framework, sourceText, sourcePath, exportName: framework === 'react' ? 'Panel' : 'default', codeComponentId: 'ui/panel', packageName: '@acme/ui', componentId: 'panel', designSystemId: 'acme', metadataExportName: 'PanelPolicy' });
  const pkg: DesignSystemPackage = { ...base, registry: compiled.registry, codeIndex: { schemaVersion: 1, id: 'acme', components: [compiled.codeComponent] },
    bindings: { schemaVersion: 1, id: 'acme', bindings: [compiled.binding] }, patterns: { schemaVersion: 1, id: 'acme', patterns: [] },
    source: { schemaVersion: 1, files: [{ path: sourcePath, encoding: 'utf8', content: sourceText }] },
    codeCompatibility: [{ framework, packageName: '@acme/ui', version: '^1.0.0' }],
  };
  const version = createDesignSystemVersion(pkg);
  return { id: 'handoff', projectId: 'project', projectRevision: 4, framework, snapshot: {
    registry: pkg.registry, baseCodeIndex: pkg.codeIndex, projectCodeIndex: { schemaVersion: 1, id: 'project', components: [] },
    bindings: { ...pkg.bindings, id: 'project' }, projectComponents: { schemaVersion: 1, id: 'project', components: [] },
    dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] },
    lock: createProjectDesignSystemLock('project', [version]), versions: [version], projectSources: [],
    targetPackages: [{ name: '@acme/ui', declaredRange: '^1.0.0', installation: { status: 'observed', version: '1.2.0' } }],
    document: { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, id: 'main', type: 'screen', children: [{ schemaVersion: 1, id: 'panel', type: 'component', ref: 'ds:acme/panel', props: { label: 'Welcome' }, slots: {
      body: [{ schemaVersion: 1, id: 'body', type: 'text', text: 'Body' }], side: [{ schemaVersion: 1, id: 'side', type: 'text', text: 'Side' }],
      constructor: [{ schemaVersion: 1 as const, id: 'constructor', type: 'text' as const, text: 'Own constructor' }], toString: [{ schemaVersion: 1 as const, id: 'toString', type: 'text' as const, text: 'Own toString' }],
    } }] }] },
  } };
}

export function localHandoffFixture(framework: ComponentFramework = 'react', codeProp: 'appearance' | 'constructor' | 'toString' = 'appearance'): CreateHandoffRequest {
  const input = handoffFixture(framework);
  input.snapshot.projectComponents.components = [{ schemaVersion: 1, id: 'card', name: 'Shared card', revision: 2,
    props: { tone: { type: 'enum', values: ['primary', 'secondary'], required: false, default: 'primary' } },
    template: { schemaVersion: 1, id: 'label', type: 'text', text: '' }, propMappings: [{ prop: 'tone', nodeId: 'label', path: ['text'] }],
  }];
  input.snapshot.document.screens[0]!.children = [
    { schemaVersion: 1, id: 'default-card', type: 'instance', ref: 'local:card', overrides: [] },
    { schemaVersion: 1, id: 'override-card', type: 'instance', ref: 'local:card', overrides: [{ schemaVersion: 1, path: ['props', 'tone'], value: 'secondary' }] },
  ];
  const source = { framework, sourcePath: `src/components/Card 'quoted' \`file\`.${framework === 'react' ? 'tsx' : 'vue'}`, exportName: framework === 'react' ? 'ExistingCard' : 'default', codeComponentId: 'project/card',
    sourceText: (framework === 'react' ? "export function ExistingCard({appearance='outline'}:{appearance?:'filled'|'outline'}) { return <article>{appearance}</article>; }"
      : `<script setup lang="ts">withDefaults(defineProps<{appearance?:'filled'|'outline'}>(),{appearance:'outline'});</script><template><article /></template>`).replaceAll('appearance', codeProp),
  };
  const registered = registerLocalComponentBinding(input.snapshot, { source, binding: {
    schemaVersion: 1, id: 'local/card', componentRef: 'local:card', framework, codeComponentId: source.codeComponentId,
    definitionRevision: 2, status: 'bound', verified: true,
    propMappings: [{ designProp: 'tone', codeProp, valueTransform: { type: 'map', entries: [{ from: 'primary', to: 'filled' }, { from: 'secondary', to: 'outline' }] } }],
  } });
  if (!registered.ok) throw new Error(registered.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
  input.snapshot.projectCodeIndex = registered.projectCodeIndex; input.snapshot.bindings = registered.bindings;
  input.snapshot.projectSources = [{ codeComponentId: source.codeComponentId, sourceText: source.sourceText }];
  return input;
}
