import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileSourceComponent } from '../../../src/services/design-runtime/source-compiler.js';
import { compileStorybookMetadata } from '../../../src/services/design-runtime/storybook-compiler.js';
import { CompilerError } from '../../../src/services/design-runtime/react-compiler.js';

const componentSource = readFileSync(new URL('./fixtures/Button.tsx', import.meta.url), 'utf8');
const storySource = readFileSync(new URL('./fixtures/Button.stories.tsx.txt', import.meta.url), 'utf8');
const compiled = compileSourceComponent({ framework: 'react', sourceText: componentSource, sourcePath: 'fixture/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'code/button', designSystemId: 'test' });
const input = { sourceText: storySource, sourcePath: 'fixture/Button.stories.tsx', compiled, selections: [{ id: 'story-primary', exportName: 'Primary' }, { id: 'story-danger', exportName: 'Danger' }] };

describe('Storybook metadata compiler', () => {
  it('imports literal CSF3 presets and provenance without replacing production defaults or bindings', () => {
    const before = JSON.stringify(compiled);
    const result = compileStorybookMetadata(input);
    expect(result.registry.components[0]!.stories).toEqual([
      expect.objectContaining({ id: 'story-danger', exportName: 'Danger', title: 'Fixture/Button', args: { variant: 'danger', disabled: true } }),
      expect.objectContaining({ id: 'story-primary', name: 'Primary example', args: { variant: 'primary', disabled: false },
        argTypes: { variant: expect.objectContaining({ options: ['primary', 'secondary', 'danger'], control: 'select', description: 'Visual variant', source: expect.objectContaining({ kind: 'storybook', exportName: 'default', sourcePath: input.sourcePath }) }) },
        source: expect.objectContaining({ kind: 'storybook', exportName: 'Primary', sourcePath: input.sourcePath, confidence: 1 }) }),
    ]);
    expect(result.registry.components[0]!.props).toEqual(compiled.registry.components[0]!.props);
    expect(result.codeComponent).toEqual(compiled.codeComponent);
    expect(result.binding).toEqual(compiled.binding);
    expect(JSON.stringify(compiled)).toBe(before);
    expect(compileStorybookMetadata({ ...input, selections: input.selections.slice().reverse() })).toEqual(result);
    expect(compileStorybookMetadata({ ...input, compiled: result })).toEqual(result);
  });

  it('keeps explicit story identity stable across export and display renames', () => {
    const result = compileStorybookMetadata({ ...input, sourceText: storySource.replaceAll('Primary', 'Renamed'), selections: [{ id: 'story-primary', exportName: 'Renamed' }] });
    expect(result.registry.components[0]!.stories).toEqual([expect.objectContaining({ id: 'story-primary', name: 'Renamed example', exportName: 'Renamed' })]);
  });

  it('merges inherited arg-type fields and applies explicit story tag removals', () => {
    const sourceText = storySource.replace("name: 'Primary example',", "name: 'Primary example', argTypes: { variant: { description: 'Story description', control: false } }, tags: ['!autodocs', 'example'],");
    const result = compileStorybookMetadata({ ...input, sourceText });
    const story = result.registry.components[0]!.stories!.find((entry) => entry.id === 'story-primary')!;
    expect(story.argTypes.variant).toMatchObject({ options: ['primary', 'secondary', 'danger'], control: false, description: 'Story description', source: { exportName: 'Primary' } });
    expect(story.tags).toEqual(['example']);
  });

  it('never executes imports or top-level source while reading literal evidence', () => {
    expect(() => compileStorybookMetadata({ ...input, sourceText: `throw new Error('Never execute Storybook source');\n${storySource}` })).not.toThrow();
  });

  it.each([
    ['wrong import identity', storySource.replace('Button as ProductionButton', 'Other as ProductionButton')],
    ['wrong source path', storySource.replace("'./Button'", "'./Other'")],
    ['package resolution', storySource.replace("'./Button'", "'@fixture/ui'")],
    ['render function', storySource.replace('title:', 'render: () => null, title:')],
    ['decorators', storySource.replace('title:', 'decorators: [], title:')],
    ['spread args', storySource.replace("variant: 'primary', disabled: false", "...otherArgs, disabled: false")],
    ['invalid enum arg', storySource.replace("variant: 'danger'", "variant: 'filled'")],
    ['overbroad options', storySource.replace("'primary', 'secondary', 'danger'", "'primary', 'filled'")],
    ['computed arg', storySource.replace('disabled: false', 'disabled: getValue()')],
    ['function arg', storySource.replace('disabled: false', 'disabled: () => false')],
    ['runtime mutation', `${storySource}\nPrimary.args = { variant: 'filled' };`],
    ['mutable alias', `${storySource}\nconst alias = meta;`],
    ['namespace mutation', `${storySource}\nnamespace Hidden { meta.args = {}; }`],
    ['enum initializer mutation', `${storySource}\nenum Hidden { Entry = mutate(meta) }`],
  ])('rejects %s rather than publishing partial or permissive examples', (_name, sourceText) => {
    expect(() => compileStorybookMetadata({ ...input, sourceText })).toThrow(CompilerError);
  });
});
