import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DesignSystemPackage } from '@open-design/contracts';
import { compileSourceComponent, extractSourceCodeComponent } from '../../../src/services/design-runtime/source-compiler.js';
import { CompilerError } from '../../../src/services/design-runtime/react-compiler.js';
import { createDesignSystemVersion, verifyDesignSystemVersion } from '../../../src/services/design-runtime/design-system-version.js';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';

const sourceText = readFileSync(new URL('./fixtures/VueCard.vue', import.meta.url), 'utf8');
const input = { framework: 'vue' as const, sourceText, sourcePath: 'src/VueCard.vue', exportName: 'default', codeComponentId: 'ui/card', packageName: '@acme/ui' };
const designInput = { ...input, designSystemId: 'acme', componentId: 'card', metadataExportName: 'CardPolicy' };
const sfc = (script: string, template = '<div />') => `<script setup lang="ts">${script}</script><template>${template}</template>`;

describe('Vue SFC source compiler', () => {
  it('extracts scalar props, exact literal defaults, unscoped slots and explicit semantic policy deterministically', () => {
    const result = compileSourceComponent(designInput);
    expect(result.codeComponent).toMatchObject({ id: 'ui/card', framework: 'vue', name: 'VueCard', exportName: 'default', packageName: '@acme/ui',
      props: {
        title: { type: 'string', required: true }, tone: { type: 'enum', values: ['quiet', 'strong'], default: 'quiet', required: false },
        elevated: { type: 'boolean', default: false }, count: { type: 'number', default: -2 }, empty: { type: 'enum', values: [null], default: null }, busy: { type: 'boolean', default: false },
      }, slots: { default: { kind: 'vue-slot', required: true, multiple: true }, heading: { kind: 'vue-slot', required: false } },
    });
    expect(result.codeComponent.props.title!.source).toEqual({ kind: 'vue', sourcePath: input.sourcePath, exportName: 'default', line: 14, confidence: 1 });
    expect(result.registry.components[0]!.slots).toMatchObject({ body: { accepts: ['text'], required: true }, heading: { multiple: false } });
    expect(result.binding).toMatchObject({ status: 'bound', framework: 'vue', verified: true,
      slotMappings: [{ designSlot: 'body', codeSlot: 'default' }, { designSlot: 'heading', codeSlot: 'heading' }] });
    expect(compileSourceComponent(designInput)).toEqual(result);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const renamed = compileSourceComponent({ ...designInput, sourcePath: 'src/Renamed.vue' });
    expect(renamed.registry.components[0]).toMatchObject({ id: 'card', name: 'Renamed' });
    expect(renamed.codeComponent.id).toBe(result.codeComponent.id);
    expect(renamed.binding.id).toBe(result.binding.id);
  });

  it('accepts reactive destructure defaults, aliases, local types and prototype-named props without execution', () => {
    const script = `import { neverExecute } from './missing-runtime';
      type Choice = true | false | 'auto';
      const { label: text = 'hello', constructor = 3, toString = false, ...rest } = defineProps<{label?:string; constructor?:number; toString?:boolean; mode?:Choice}>();
      neverExecute();`;
    const code = extractSourceCodeComponent({ ...input, sourceText: sfc(script) });
    expect(code.props).toMatchObject({ label: { default: 'hello' }, constructor: { default: 3 }, toString: { default: false }, mode: { values: [true, false, 'auto'] } });
    expect(code.props.mode).toHaveProperty('default', false);
  });

  it('allows a component without props/slots and retains explicitly required prop defaults', () => {
    expect(extractSourceCodeComponent({ ...input, sourceText: sfc('const internal = 1;') })).toMatchObject({ props: {} });
    const code = extractSourceCodeComponent({ ...input, sourceText: sfc("const props = withDefaults(defineProps<{title:string}>(), {title:'Hello'});") });
    expect(code.props.title).toMatchObject({ required: true, default: 'Hello' });
  });

  it('records optional Boolean casting without making required Boolean props omittable', () => {
    const code = extractSourceCodeComponent({ ...input, sourceText: sfc(`
      type Flag = boolean;
      withDefaults(defineProps<{ optional?:Flag; required:boolean; explicit?:boolean; choice?:'auto'|true|false; exact?:true }>(), {explicit:true, exact:true});
    `) });
    expect(code.props).toMatchObject({ optional: { required: false, default: false }, required: { required: true },
      explicit: { default: true }, choice: { default: false }, exact: { default: true } });
    expect(code.props.required).not.toHaveProperty('default');
    expect(() => extractSourceCodeComponent({ ...input, sourceText: sfc('defineProps<{exact?:true}>();') })).toThrow(/implicitly defaults to false outside its enum/);
  });

  it('keeps source slot proof separate from selected semantic acceptance and refuses invented mappings', () => {
    expect(extractSourceCodeComponent(input).slots?.default).toMatchObject({ kind: 'vue-slot', required: true });
    expect(() => compileSourceComponent({ ...designInput, metadataExportName: undefined })).toThrow(/Required code slot/);
    expect(() => compileSourceComponent({ ...designInput, sourceText: sourceText.replace("component: 'default'", 'component: VueCard') })).toThrow();
    expect(() => compileSourceComponent({ ...designInput, sourceText: sourceText.replace("codeSlot: 'default'", "codeSlot: 'missing'") })).toThrow(/Slot mappings/);
    expect(() => compileSourceComponent({ ...designInput, sourceText: sourceText.replace('const props =', 'CardPolicy.slots.body.accepts.push("ds:acme/other");\nconst props =') })).toThrow(/metadata/i);
  });

  it.each([
    ['imported prop type', "import type {Props} from './Props'; defineProps<Props>();"],
    ['object prop', 'defineProps<{value:{x:string}}>();'],
    ['function prop', 'defineProps<{onClick:()=>void}>();'],
    ['generic prop type', 'type Props<T> = {value:T}; defineProps<Props<string>>();'],
    ['scoped slot', 'defineSlots<{default(props:{title:string}):unknown}>();'],
    ['scoped slot even with empty props', 'defineSlots<{default(props:{}):unknown}>();'],
    ['runtime props', "defineProps({title:String});"],
    ['runtime slots', 'defineSlots({default:()=>null});'],
    ['emits', 'defineEmits<{click:[]}>();'],
    ['model', 'defineModel<string>();'],
    ['options', 'defineOptions({props:["hidden"]});'],
    ['macro shadow', 'function defineProps<T>() { return {} as T; } const props = defineProps<{title:string}>();'],
    ['imported macro', "import {defineProps} from 'vue'; defineProps<{title:string}>();"],
    ['aliased macro', 'const api = defineProps; api<{title:string}>();'],
    ['nested macro', 'function setupLater(){return defineProps<{title:string}>();}'],
    ['duplicate macro', 'defineProps<{title:string}>(); defineProps<{hidden:string}>();'],
    ['default outside enum', "withDefaults(defineProps<{tone?:'quiet'|'strong'}>(),{tone:'unknown'});"],
    ['computed default', 'withDefaults(defineProps<{count?:number}>(),{count:Math.random()});'],
    ['factory default', 'withDefaults(defineProps<{count?:number}>(),{count:()=>1});'],
    ['spread default', 'withDefaults(defineProps<{count?:number}>(),{...defaults});'],
    ['unknown default', 'withDefaults(defineProps<{count?:number}>(),{missing:1});'],
    ['overlapping prop and slot', 'defineProps<{default:string}>(); defineSlots<{default():unknown}>();'],
  ])('rejects %s without returning partial metadata', (_name, script) => {
    expect(() => extractSourceCodeComponent({ ...input, sourceText: sfc(script) })).toThrow(CompilerError);
  });

  it.each([
    ['wrong selected export', { exportName: 'VueCard' }],
    ['non-TypeScript script setup', { sourceText: '<script setup>const props = defineProps({title:String})</script>' }],
    ['generic SFC', { sourceText: '<script setup lang="ts" generic="T">defineProps<{value:T}>()</script>' }],
    ['duplicate SFC script block', { sourceText: '<script setup lang="ts">const x=1</script><script setup lang="ts">const y=2</script>' }],
    ['options API competing default', { sourceText: '<script lang="ts">export default {props:["hidden"]}</script>' + sfc('const x=1;') }],
    ['normal-script namespace macro alias', { sourceText: '<script lang="ts">import * as Vue from "vue"; export const hidden = Vue.defineProps({title:String})</script>' + sfc('const x=1;') }],
    ['normal-script type namespace macro spoof', { sourceText: '<script lang="ts">namespace Vue { export function defineProps<T>() { return {} as T; } }</script>' + sfc('const props = Vue.defineProps<{title:string}>();') }],
    ['external script', { sourceText: '<script setup lang="ts" src="./Other.ts"></script><template><div /></template>' }],
    ['scoped template slot', { sourceText: sfc('defineSlots<{default():unknown}>();', '<slot :item="1" />') }],
    ['dynamic template slot', { sourceText: sfc('defineSlots<{default():unknown}>();', '<slot :name="name" />') }],
    ['undeclared template slot', { sourceText: sfc('const x=1;', '<slot name="extra" />') }],
    ['invalid template', { sourceText: sfc('const x=1;', '<div><span></div>') }],
  ])('rejects %s at the SFC boundary', (_name, change) => {
    expect(() => extractSourceCodeComponent({ ...input, ...change })).toThrow(CompilerError);
  });

  it('freezes and re-verifies Vue source, rejecting forged public metadata and changed source contracts', () => {
    const compiled = compileSourceComponent(designInput);
    const base = packageFixture();
    const pkg: DesignSystemPackage = { ...base, registry: compiled.registry,
      codeIndex: { schemaVersion: 1, id: 'acme', components: [compiled.codeComponent] },
      bindings: { schemaVersion: 1, id: 'acme', bindings: [compiled.binding] },
      patterns: { schemaVersion: 1, id: 'acme', patterns: [] },
      codeCompatibility: [{ framework: 'vue', packageName: '@acme/ui', version: '^1.0.0' }],
      source: { schemaVersion: 1, files: [{ path: input.sourcePath, encoding: 'utf8', content: sourceText }] },
    };
    const frozen = createDesignSystemVersion(pkg);
    expect(verifyDesignSystemVersion(JSON.parse(JSON.stringify(frozen)))).toEqual([]);
    const forged = structuredClone(pkg); forged.codeIndex.components[0]!.props.title = { type: 'number', required: true };
    expect(() => createDesignSystemVersion(forged)).toThrow();
    const changed = structuredClone(pkg); changed.source.files[0]!.content = sourceText.replace('title: string', 'title: number');
    expect(() => createDesignSystemVersion(changed)).toThrow();
    const slot = structuredClone(pkg); slot.codeIndex.components[0]!.slots!.default!.required = false;
    expect(() => createDesignSystemVersion(slot)).toThrow();
    const casting = structuredClone(pkg); delete casting.codeIndex.components[0]!.props.busy!.default;
    expect(() => createDesignSystemVersion(casting)).toThrow();
    expect(createDesignSystemVersion(pkg)).toEqual(frozen);
  });
});
