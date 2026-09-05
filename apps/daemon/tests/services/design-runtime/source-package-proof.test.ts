import { describe, expect, it } from 'vitest';
import type { DesignSystemPackage, SourceProvenance } from '@open-design/contracts';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';
import { compileSourceComponent } from '../../../src/services/design-runtime/source-compiler.js';
import { compileStorybookMetadata } from '../../../src/services/design-runtime/storybook-compiler.js';
import { createDesignSystemVersion, validateDesignSystemPackage, verifyDesignSystemVersion } from '../../../src/services/design-runtime/design-system-version.js';

function slotPackage(): DesignSystemPackage {
  const pkg = packageFixture();
  const sourceText = `import type { ReactNode } from 'react';
export function Card({ children }: { children: ReactNode }) { return <section>{children}</section>; }
export const CardPolicy = { component: Card, slots: { body: { codeSlot: 'children', accepts: ['text'], required: true, multiple: true } } } as const;`;
  const compiled = compileSourceComponent({ framework: 'react', sourceText, sourcePath: 'src/Card.tsx', exportName: 'Card', metadataExportName: 'CardPolicy', designSystemId: pkg.id, componentId: 'Card', codeComponentId: 'ui/Card', packageName: '@acme/ui' });
  const storyText = `import { Card } from './Card';
export default { component: Card, argTypes: { children: { control: 'text' } } };
export const Example = { args: { children: 'Welcome' } };`;
  const withStory = compileStorybookMetadata({ sourceText: storyText, sourcePath: 'src/Card.stories.tsx', compiled, selections: [{ id: 'card-example', exportName: 'Example' }] });
  pkg.registry.components.push(...withStory.registry.components);
  pkg.codeIndex.components.push(compiled.codeComponent);
  pkg.bindings.bindings.push(compiled.binding);
  pkg.source.files.push({ path: 'src/Card.tsx', encoding: 'utf8', content: sourceText }, { path: 'src/Card.stories.tsx', encoding: 'utf8', content: storyText });
  return pkg;
}

describe('frozen component source proof', () => {
  it('verifies code slot capability independently of manual semantic metadata and includes stories in the immutable digest', () => {
    const pkg = slotPackage();
    const before = structuredClone(pkg);
    expect(validateDesignSystemPackage(pkg)).toEqual([]);
    const version = createDesignSystemVersion(pkg);
    expect(verifyDesignSystemVersion(version)).toEqual([]);
    expect(pkg).toEqual(before);
    pkg.registry.components.find((component) => component.id === 'Card')!.stories![0]!.name = 'Welcome example';
    expect(createDesignSystemVersion(pkg).digest).not.toBe(version.digest);
  });

  it('rejects invented optional code slots even when the bound design uses no slots', () => {
    const pkg = packageFixture();
    pkg.codeIndex.components[0]!.slots = { footer: { kind: 'react-node', required: false, multiple: true } };
    expect(validateDesignSystemPackage(pkg)).toContainEqual(expect.objectContaining({ code: 'ODDS5007', path: ['codeIndex', 'ui/Button', 'slots'] }));
  });

  it('rejects false slot requiredness and validates frozen explicit slot mappings separately', () => {
    const pkg = slotPackage();
    pkg.codeIndex.components.find((component) => component.id === 'ui/Card')!.slots!.children!.required = false;
    expect(validateDesignSystemPackage(pkg)).toContainEqual(expect.objectContaining({ code: 'ODDS5007', path: ['codeIndex', 'ui/Card', 'slots'] }));
    const unmapped = slotPackage();
    delete unmapped.bindings.bindings.find((binding) => binding.componentRef === 'ds:acme/Card')!.slotMappings;
    expect(validateDesignSystemPackage(unmapped)).toContainEqual(expect.objectContaining({ code: 'ODDS3001' }));
  });

  it.each(['design slot', 'code slot', 'slot mapping', 'story', 'arg type', 'pattern slot'] as const)('requires bundled bytes for typed %s provenance', (field) => {
    const pkg = slotPackage();
    const card = pkg.registry.components.find((component) => component.id === 'Card')!;
    const source: SourceProvenance = { kind: 'manual', sourcePath: 'missing/metadata.ts' };
    if (field === 'design slot') card.slots!.body!.source = source;
    if (field === 'code slot') pkg.codeIndex.components.find((component) => component.id === 'ui/Card')!.slots!.children!.source = source;
    if (field === 'slot mapping') pkg.bindings.bindings.find((binding) => binding.componentRef === 'ds:acme/Card')!.slotMappings![0]!.source = source;
    if (field === 'story') card.stories![0]!.source = source;
    if (field === 'arg type') card.stories![0]!.argTypes.children!.source = source;
    if (field === 'pattern slot') pkg.patterns.patterns[0]!.slots.actions!.source = source;
    expect(validateDesignSystemPackage(pkg)).toContainEqual(expect.objectContaining({ code: 'ODDS5005', path: ['source', source.sourcePath] }));
  });
});
