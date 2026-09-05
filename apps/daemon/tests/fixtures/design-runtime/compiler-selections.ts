import { readFileSync } from 'node:fs';
import type { CompileComponentRegistryRequest, ProjectDesignRuntimeCompileRequest } from '@open-design/contracts';

const fixture = (name: string) => readFileSync(new URL(`../../services/design-runtime/fixtures/${name}`, import.meta.url), 'utf8');
export function mixedCompilerRequest(): CompileComponentRegistryRequest {
  return { designSystemId: 'test', selections: [{
    framework: 'react', sourcePath: 'src/SlotCard.tsx', sourceText: fixture('SlotCard.tsx.txt'), exportName: 'SlotCard', metadataExportName: 'SlotCardPolicy', componentId: 'card', codeComponentId: 'ui/Card',
    storySources: [{ sourcePath: 'src/SlotCard.stories.ts', sourceText: fixture('SlotCard.stories.ts.txt'), selections: [{ id: 'card-plain', exportName: 'Plain' }, { id: 'card-raised', exportName: 'Raised' }] }],
  }, {
    framework: 'vue', sourcePath: 'src/VueButton.vue', sourceText: fixture('VueButton.vue'), exportName: 'default', componentId: 'vue-button', codeComponentId: 'ui/VueButton',
    storySources: [{ sourcePath: 'src/VueButton.stories.ts', sourceText: fixture('VueButton.stories.ts.txt'), selections: [{ id: 'vue-primary', exportName: 'Primary' }] }],
  }] };
}
export function mixedProjectCompilerRequest(expectedRevision = 0) {
  const input = mixedCompilerRequest();
  const sources = new Map(input.selections.flatMap((selection) => [selection, ...selection.storySources ?? []].map((source) => [source.sourcePath, source.sourceText] as const)));
  const request: ProjectDesignRuntimeCompileRequest = { designSystemId: input.designSystemId, expectedRevision, selections: input.selections.map(({ sourceText: _, storySources, ...selection }) => ({
    ...selection, ...(storySources ? { storySources: storySources.map(({ sourceText: _, ...source }) => source) } : {}),
  })) };
  return { request, sources };
}
