import { codeImportPackageName } from '@open-design/contracts';
import type { ComponentFramework, DesignBenchmarkCase, DesignSystemPackage, UIIRNode, ValidateStructuredDesignRequest } from '@open-design/contracts';
import { compileComponentRegistry } from '../../../src/services/design-runtime/registry-compiler.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../../src/services/design-runtime/design-system-version.js';
import { packageFixture } from './design-system-version.js';

const text = (id: string, value: string): UIIRNode => ({ schemaVersion: 1, type: 'text', id, text: value });
const button = (id: string, label: string, variant = 'primary'): UIIRNode => ({ schemaVersion: 1, type: 'component', id, ref: 'ds:acme/button', props: { label, variant } });
const field = (id: string, label: string): UIIRNode => ({ schemaVersion: 1, type: 'component', id, ref: 'ds:acme/field', props: { label } });
const panel = (id: string, title: string, children: UIIRNode[]): UIIRNode => ({ schemaVersion: 1, type: 'component', id, ref: 'ds:acme/panel', props: { title }, slots: { body: children } });

const cases: Array<{ task: DesignBenchmarkCase['task']; framework: ComponentFramework; title: string; body: UIIRNode[]; sourceBody: string }> = [
  { task: 'resource-list', framework: 'react', title: 'Resources', body: [text('rows', 'Alpha, Beta'), button('add', 'Add resource')], sourceBody: '{"Alpha, Beta"}<Button label="Add resource" />' },
  { task: 'resource-detail', framework: 'vue', title: 'Resource detail', body: [text('details', 'Resource Alpha'), button('edit', 'Edit'), button('delete', 'Delete', 'danger')], sourceBody: '{{ "Resource Alpha" }}<Button label="Edit" /><Button label="Delete" variant="danger" />' },
  { task: 'settings', framework: 'react', title: 'Settings', body: [field('timezone', 'Timezone'), button('save', 'Save settings')], sourceBody: '<Field label="Timezone" /><Button label="Save settings" />' },
  { task: 'form', framework: 'vue', title: 'Create resource', body: [field('name', 'Name'), field('description', 'Description'), button('create', 'Create')], sourceBody: '<Field label="Name" /><Field label="Description" /><Button label="Create" />' },
  { task: 'dialog', framework: 'react', title: 'Confirm deletion', body: [text('question', 'Delete resource?'), button('cancel', 'Cancel', 'secondary'), button('confirm', 'Delete', 'danger')], sourceBody: '{"Delete resource?"}<Button label="Cancel" variant="secondary" /><Button label="Delete" variant="danger" />' },
  { task: 'dashboard', framework: 'vue', title: 'Dashboard', body: [text('count', '24 resources'), panel('activity', 'Activity', [text('updated', 'Updated today')])], sourceBody: '{{ "24 resources" }}<Panel title="Activity">{{ "Updated today" }}</Panel>' },
  { task: 'empty-state', framework: 'react', title: 'No resources', body: [text('empty', 'Create your first resource'), button('first', 'Create resource')], sourceBody: '{"Create your first resource"}<Button label="Create resource" />' },
  { task: 'error-state', framework: 'vue', title: 'Something went wrong', body: [text('error', 'Try again'), button('retry', 'Retry')], sourceBody: '{{ "Try again" }}<Button label="Retry" />' },
];

function library(framework: ComponentFramework): DesignSystemPackage {
  const base = packageFixture();
  const accepts = "['text','ds:acme/button','ds:acme/field','ds:acme/panel']";
  const files = framework === 'react' ? [
    { id: 'button', exportName: 'Button', sourceText: `export function Button({label,variant='primary'}:{label:string;variant?:'primary'|'secondary'|'danger'}) { return <button style={{color:'#f00'}}>{label}</button>; }` },
    { id: 'field', exportName: 'Field', sourceText: `export function Field({label}:{label:string}) { return <input aria-label={label} style={{padding:'12px'}}/>; }` },
    { id: 'panel', exportName: 'Panel', sourceText: `import type {ReactNode} from 'react'; export function Panel(props:{title:string;children?:ReactNode}) { return <section>{props.children}</section>; } export const PanelPolicy={component:Panel,slots:{body:{codeSlot:'children',accepts:${accepts},required:false,multiple:true}}} as const;`, metadataExportName: 'PanelPolicy' },
  ] : [
    { id: 'button', exportName: 'default', sourceText: `<script setup lang="ts">withDefaults(defineProps<{label:string;variant?:'primary'|'secondary'|'danger'}>(),{variant:'primary'});</script><template><button style="color:#f00">{{label}}</button></template>` },
    { id: 'field', exportName: 'default', sourceText: `<script setup lang="ts">defineProps<{label:string}>();</script><template><input :aria-label="label" style="padding:12px"/></template>` },
    { id: 'panel', exportName: 'default', sourceText: `<script lang="ts">export const PanelPolicy={component:'default',slots:{body:{codeSlot:'default',accepts:${accepts},required:false,multiple:true}}} as const;</script><script setup lang="ts">defineProps<{title:string}>();defineSlots<{default?():unknown}>();</script><template><section><slot/></section></template>`, metadataExportName: 'PanelPolicy' },
  ];
  const selections = files.map((file) => ({ ...file, framework, sourcePath: `library/${file.id}.${framework === 'react' ? 'tsx' : 'vue'}`, componentId: file.id, codeComponentId: `ui/${file.id}`, packageName: framework === 'react' ? '@fixture/ui' : `@fixture/ui/${file.id}` }));
  const compiled = compileComponentRegistry({ designSystemId: 'acme', selections: selections.map(({ id: _id, ...selection }) => selection) });
  compiled.registry.components.find((component) => component.id === 'button')!.controlRole = 'button';
  compiled.registry.components.find((component) => component.id === 'field')!.controlRole = 'text-input';
  return { ...base, registry: compiled.registry, codeIndex: compiled.codeIndex, bindings: { schemaVersion: 1, id: 'acme', bindings: compiled.bindings }, patterns: { schemaVersion: 1, id: 'acme', patterns: [] },
    tokens: { ...base.tokens, tokens: [...base.tokens.tokens, { schemaVersion: 1, id: 'radius.card', name: 'Card radius', type: 'radius', cssVariable: '--radius-card', value: 8, unit: 'px' }] },
    source: { schemaVersion: 1, files: selections.map((source) => ({ path: source.sourcePath, encoding: 'utf8', content: source.sourceText })) },
    codeCompatibility: [...new Set(selections.map((source) => source.packageName))].map((packageName) => ({ framework, packageName, version: '^1.0.0' })),
  };
}

/** Eight authored page fixtures exercise the production validator, independently of code emission. */
export function validationBenchmarkFixtures(): DesignBenchmarkCase[] {
  return cases.map((entry) => {
    const pkg = library(entry.framework); const version = createDesignSystemVersion(pkg);
    const imports = entry.framework === 'react' ? `import {Button,Field,Panel} from '@fixture/ui';` : `import Button from '@fixture/ui/button';import Field from '@fixture/ui/field';import Panel from '@fixture/ui/panel';`;
    const sourceText = entry.framework === 'react' ? `${imports}\nimport './page.css';\nexport function Screen(){return <Panel title=${JSON.stringify(entry.title)}>${entry.sourceBody}</Panel>;}`
      : `<script setup lang="ts">${imports}\nimport './page.css';</script><template><Panel title=${JSON.stringify(entry.title)}>${entry.sourceBody}</Panel></template>`;
    const sourcePath = `pages/${entry.task}.${entry.framework === 'react' ? 'tsx' : 'vue'}`;
    const request: ValidateStructuredDesignRequest = { schemaVersion: 1, projectId: 'project', projectRevision: 1,
      settings: { schemaVersion: 1, mode: 'strict', projectConstraints: pkg.constraints },
      snapshot: { registry: pkg.registry, projectComponents: { schemaVersion: 1, id: 'project', components: [] }, baseCodeIndex: pkg.codeIndex, projectCodeIndex: { schemaVersion: 1, id: 'project', components: [] },
        bindings: { ...pkg.bindings, id: 'project' }, tokens: pkg.tokens, dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] }, lock: createProjectDesignSystemLock('project', [version]), versions: [version], projectSources: [],
        targetPackages: [...new Set(pkg.codeCompatibility.map((target) => codeImportPackageName(target.packageName)!))].map((name) => ({ name, installation: { status: 'observed', version: '1.0.0' } })),
        document: { schemaVersion: 1, id: 'document', screens: [{ schemaVersion: 1, type: 'screen', id: entry.task, children: [panel('root', entry.title, structuredClone(entry.body))] }] },
      },
      sources: [{ sourcePath, language: entry.framework === 'react' ? 'tsx' : 'vue', sourceText }, { sourcePath: 'pages/page.css', language: 'css', sourceText: 'main { color: var(--color-primary); padding: var(--spacing-card); border-radius: var(--radius-card); }' }],
      outputs: [{ sourcePath, exportName: entry.framework === 'react' ? 'Screen' : 'default', screenId: entry.task }],
    };
    const initial = structuredClone(request);
    initial.sources[1]!.sourceText = initial.sources[1]!.sourceText.replace('var(--color-primary)', '#ff0000');
    return { id: entry.task, task: entry.task, request: initial, repairSteps: [{ reason: 'Replace the raw application color with the declared color token.', request }] };
  });
}

export function validationFixture(framework: ComponentFramework = 'react'): ValidateStructuredDesignRequest {
  return validationBenchmarkFixtures()[framework === 'react' ? 0 : 1]!.repairSteps[0]!.request;
}
