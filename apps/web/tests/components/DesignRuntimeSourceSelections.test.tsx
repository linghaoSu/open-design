// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDesignRuntimeCompileRequest } from '@open-design/contracts';
import { DesignRuntimeSourceSelections } from '../../src/components/DesignRuntimeSourceSelections';

type Selection = ProjectDesignRuntimeCompileRequest['selections'][number];
const selected = (): Selection => ({ sourcePath: 'Button.tsx', framework: 'react', exportName: 'NamedButton', componentId: 'button-stable', codeComponentId: 'code/button', packageName: '@test/ui', metadataExportName: 'ButtonPolicy', storySources: [{ sourcePath: 'Button.stories.tsx', selections: [{ id: 'primary-stable', exportName: 'Primary' }] }] });
const files = ['Button.tsx', 'Another.tsx', 'Card.vue', 'Button.stories.tsx', 'index.d.ts'];
function Editor({ change, initial = selected() }: { change(value: Selection[]): void; initial?: Selection }) {
  const [selections, setSelections] = useState([initial]);
  return <DesignRuntimeSourceSelections files={files} selections={selections} onChange={(value) => { change(value); setSelections(value); }} />;
}
const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
afterEach(cleanup);

describe('simplified component source selections', () => {
  it('leads with source and export fields while advanced metadata stays collapsed and intact', () => {
    const change = vi.fn(); render(<Editor change={change} />);
    expect(input('design-runtime-source-path-0').closest('details')).toBeNull();
    expect(input('design-runtime-export-name-0').closest('details')).toBeNull();
    expect(input('design-runtime-export-name-0').placeholder).toBe('Button');
    expect(document.getElementById(input('design-runtime-export-name-0').getAttribute('aria-describedby')!)).toBeTruthy();
    const advanced = screen.getByTestId('design-runtime-source-advanced-0') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced.contains(input('design-runtime-framework-0'))).toBe(true);
    expect(advanced.contains(input('design-runtime-metadata-export-0'))).toBe(true);
    expect(input('design-runtime-component-id-0').value).toBe('button-stable');
    expect(input('design-runtime-story-id-0-0-0').value).toBe('primary-stable');
    expect(change).not.toHaveBeenCalled();
  });

  it('infers framework from the chosen source without reallocating IDs or guessing a React export name', () => {
    const change = vi.fn(); render(<Editor change={change} />);
    const source = screen.getByTestId('design-runtime-source-path-0') as HTMLSelectElement;
    expect([...source.options].map((entry) => entry.value)).toContain('Card.vue');
    fireEvent.change(input('design-runtime-source-path-0'), { target: { value: 'Another.tsx' } });
    expect(change.mock.lastCall![0]).toEqual([{ ...selected(), sourcePath: 'Another.tsx' }]);
    fireEvent.change(input('design-runtime-source-path-0'), { target: { value: 'Card.vue' } });
    expect(change.mock.lastCall![0]).toEqual([{ ...selected(), sourcePath: 'Card.vue', framework: 'vue', exportName: 'default' }]);
    expect(input('design-runtime-export-name-0').readOnly).toBe(true); expect(input('design-runtime-export-name-0').placeholder).toBe('default');
    fireEvent.change(input('design-runtime-source-path-0'), { target: { value: 'Another.tsx' } });
    expect(change.mock.lastCall![0]).toEqual([{ ...selected(), sourcePath: 'Another.tsx', framework: 'react', exportName: '' }]);
    expect(input('design-runtime-export-name-0').readOnly).toBe(false);
    fireEvent.change(input('design-runtime-export-name-0'), { target: { value: 'ConfirmedExport' } });
    expect(change.mock.lastCall![0][0]).toMatchObject({ componentId: 'button-stable', codeComponentId: 'code/button', exportName: 'ConfirmedExport', storySources: selected().storySources });
    fireEvent.click(screen.getByTestId('design-runtime-source-advanced-0').querySelector('summary')!);
    fireEvent.change(input('design-runtime-framework-0'), { target: { value: 'vue' } });
    fireEvent.change(input('design-runtime-framework-0'), { target: { value: 'react' } });
    expect(change.mock.lastCall![0][0]).toMatchObject({ componentId: 'button-stable', codeComponentId: 'code/button', exportName: '', storySources: selected().storySources });
  });

  it('retains a selected unavailable source and its authored export until the user changes it', () => {
    const change = vi.fn(); render(<Editor change={change} initial={{ ...selected(), sourcePath: 'Moved.tsx' }} />);
    expect(input('design-runtime-source-path-0').value).toBe('Moved.tsx');
    expect(input('design-runtime-export-name-0').value).toBe('NamedButton');
    expect(change).not.toHaveBeenCalled();
  });
});
