// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComponentInstanceSchema, ProjectComponentDefinitionSchema, UIIRScreenSchema, type ComponentRegistry, type ProjectComponentDefinition, type UIIRNode, type UIIRScreen } from '@open-design/contracts';
import { SemanticScreenEditor, SemanticTemplateEditor, SemanticTreeEditor, type SemanticTreeEditorProps } from '../../src/components/SemanticTreeEditor';

const registry: ComponentRegistry = { schemaVersion: 1, id: 'test', components: [{
  schemaVersion: 1, id: 'Container', name: 'Container', props: {},
  slots: { body: { accepts: ['text'], required: false, multiple: true } },
}] };
const localComponents: ProjectComponentDefinition[] = [];
const localCard: ProjectComponentDefinition = ProjectComponentDefinitionSchema.parse({
  schemaVersion: 1, id: 'card', name: 'ApplicationCard', revision: 1,
  props: { title: { type: 'string', required: true, default: 'Inherited title' } },
  template: { schemaVersion: 1, type: 'text', id: 'title-template', text: '' },
  propMappings: [{ prop: 'title', nodeId: 'title-template', path: ['text'] }],
});

function ControlledTree({ initial, emitted, ...props }: Omit<SemanticTreeEditorProps, 'nodes' | 'onChange'> & {
  initial: UIIRNode[];
  emitted: (nodes: UIIRNode[]) => void;
}) {
  const [nodes, setNodes] = useState(initial);
  return <SemanticTreeEditor {...props} nodes={nodes} onChange={(next) => { emitted(next); setNodes(next); }} />;
}

function choose(scope: string, optionName: string) {
  const select = screen.getByTestId(`semantic-add-choice-${scope}`);
  const option = within(select).getByRole('option', { name: optionName }) as HTMLOptionElement;
  fireEvent.change(select, { target: { value: option.value } });
  fireEvent.click(screen.getByTestId(`semantic-add-node-${scope}`));
}

afterEach(cleanup);

describe('SemanticTreeEditor', () => {
  it('treats a declared constructor slot as empty when the node has no own slot value', () => {
    const input = structuredClone(registry);
    input.components[0]!.slots = { constructor: { accepts: ['text'], required: false, multiple: false } };
    render(<SemanticTreeEditor registry={input} localComponents={localComponents} nodes={[
      { schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Container', slots: {} },
    ]} onChange={vi.fn()} />);
    expect(screen.getByTestId('semantic-add-node-container-constructor')).toBeTruthy();
  });

  it('shows an undeclared toString slot and retains its children for explicit removal', () => {
    const child: UIIRNode = { schemaVersion: 1, type: 'text', id: 'retained-child', text: 'Keep me' };
    render(<SemanticTreeEditor registry={registry} localComponents={localComponents} nodes={[
      { schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Container', slots: {
        toString: [child],
      } },
    ]} onChange={vi.fn()} />);
    expect(screen.getByText('Unknown slot: toString')).toBeTruthy();
    expect(screen.getByDisplayValue('Keep me')).toBeTruthy();
  });

  it('emits invalid numeric input as a draft value instead of retaining an invisible old number', () => {
    const input = structuredClone(registry);
    input.components[0]!.props = { count: { type: 'number', required: false } };
    const emitted = vi.fn();
    function Harness() {
      const [nodes, setNodes] = useState<UIIRNode[]>([{ schemaVersion: 1, type: 'component', id: 'counter', ref: 'ds:test/Container', props: { count: 3 } }]);
      return <SemanticTreeEditor registry={input} localComponents={localComponents} nodes={nodes} onChange={(next) => { emitted(next); setNodes(next); }} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByTestId('semantic-prop-counter-count'), { target: { value: '-' } });
    expect(emitted).toHaveBeenLastCalledWith([{ schemaVersion: 1, type: 'component', id: 'counter', ref: 'ds:test/Container', props: { count: '-' } }]);
    expect(within(screen.getByTestId('semantic-node-counter')).getByRole('alert')).toBeTruthy();
  });

  it('creates an override-only local instance and preserves inheritance through edits and reset', () => {
    const emitted = vi.fn();
    const { rerender } = render(<ControlledTree registry={registry} localComponents={[localCard]} initial={[]} emitted={emitted} />);
    choose('root', 'Instance: ApplicationCard');
    const created = emitted.mock.calls.at(-1)![0][0] as UIIRNode;
    expect(created).toEqual({ schemaVersion: 1, id: expect.stringMatching(/^node-/), type: 'instance', ref: 'local:card', overrides: [] });
    const title = screen.getByTestId(`semantic-prop-${created.id}-title`) as HTMLInputElement;
    expect(title.value).toBe('Inherited title');
    expect(title.disabled).toBe(true);
    fireEvent.click(screen.getByTestId(`semantic-explicit-${created.id}-title`));
    fireEvent.change(title, { target: { value: 'Production' } });
    expect(emitted.mock.calls.at(-1)![0][0]).toEqual({ ...created, overrides: [{ schemaVersion: 1, path: ['props', 'title'], value: 'Production' }] });
    const changedDefinition: ProjectComponentDefinition = { ...localCard, revision: 2, props: { title: { type: 'string', required: true, default: 'Updated shared title' } } };
    rerender(<ControlledTree registry={registry} localComponents={[changedDefinition]} initial={[]} emitted={emitted} />);
    expect(title.value).toBe('Production');
    fireEvent.click(screen.getByTestId(`semantic-reset-${created.id}-title`));
    expect(title.value).toBe('Updated shared title');
    expect(emitted.mock.calls.at(-1)![0][0]).toEqual(created);
    for (const [nodes] of emitted.mock.calls) expect(ComponentInstanceSchema.parse(nodes[0])).toEqual(nodes[0]);
    expect(localCard.props.title!.default).toBe('Inherited title');
  });

  it('offers local instances by resolved template root, including nested local roots with cycle protection', () => {
    const input = structuredClone(registry);
    input.components[0]!.slots = { body: { accepts: ['ds:test/Button'], required: false, multiple: true } };
    input.components.push({ schemaVersion: 1, id: 'Button', name: 'Button', props: {} });
    const makeLocal = (id: string, target: string): ProjectComponentDefinition => ({
      schemaVersion: 1, id, name: id, revision: 1, props: {}, propMappings: [],
      template: { schemaVersion: 1, type: 'instance', id: `${id}-root`, ref: target, overrides: [] },
    });
    const components = [makeLocal('Base', 'ds:test/Button'), makeLocal('Nested', 'local:Base'), makeLocal('CycleA', 'local:CycleB'), makeLocal('CycleB', 'local:CycleA'), localCard];
    const emitted = vi.fn();
    render(<ControlledTree registry={input} localComponents={components} initial={[
      { schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Container' },
    ]} emitted={emitted} />);
    const options = within(screen.getByTestId('semantic-add-choice-container-body')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Component: Button', 'Instance: Button', 'Instance: Base', 'Instance: Nested']);
    choose('container-body', 'Instance: Nested');
    expect(emitted.mock.calls.at(-1)![0][0].slots.body[0]).toEqual({ schemaVersion: 1, id: expect.any(String), type: 'instance', ref: 'local:Nested', overrides: [] });
  });

  it('limits new children by declared slot cardinality and retains existing invalid children for removal', () => {
    const input = structuredClone(registry);
    input.components[0]!.slots = { footer: { accepts: ['text'], required: true, multiple: false } };
    const emitted = vi.fn();
    const initial: UIIRNode[] = [{ schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Container', slots: { footer: [
      { schemaVersion: 1, type: 'instance', id: 'invalid', ref: 'ds:test/Container', overrides: [] },
    ] } }];
    render(<ControlledTree registry={input} localComponents={[]} initial={initial} emitted={emitted} />);
    expect(screen.getByText('This node is not allowed in this slot.')).toBeTruthy();
    expect((screen.getByTestId('semantic-add-node-container-footer') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete invalid' }));
    expect((screen.getByTestId('semantic-add-node-container-footer') as HTMLButtonElement).disabled).toBe(false);
    choose('container-footer', 'Text');
    expect((screen.getByTestId('semantic-add-node-container-footer') as HTMLButtonElement).disabled).toBe(true);
    expect(emitted.mock.calls.at(-1)![0][0].slots.footer[0]).toMatchObject({ schemaVersion: 1, type: 'text', text: '' });
  });

  it('preserves explicit props and children after a reference change and removes unknown data only on request', () => {
    const input = structuredClone(registry);
    input.components[0]!.props = { heading: { type: 'string', required: false } };
    input.components.push({ schemaVersion: 1, id: 'Button', name: 'Button', props: {} });
    const child: UIIRNode = { schemaVersion: 1, type: 'text', id: 'body-copy', text: 'Body copy' };
    const original: UIIRNode[] = [{ schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Container', props: { heading: 'Keep heading' }, slots: { body: [child] } }];
    const before = JSON.stringify(original);
    const emitted = vi.fn();
    render(<ControlledTree registry={input} localComponents={[]} initial={original} emitted={emitted} />);
    fireEvent.change(screen.getByTestId('semantic-reference-container'), { target: { value: 'ds:test/Button' } });
    expect(emitted.mock.calls.at(-1)![0]).toEqual([{ ...original[0], ref: 'ds:test/Button' }]);
    expect(screen.getByText(/Unknown property: heading/)).toBeTruthy();
    expect(screen.getByText('Unknown slot: body')).toBeTruthy();
    expect(screen.getByDisplayValue('Body copy')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete heading' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete body-copy' }));
    expect(emitted.mock.calls.at(-1)![0]).toEqual([{ schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Button' }]);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('reorders and edits screen nodes without changing screen or node identities', () => {
    const emitted = vi.fn();
    const initial: UIIRScreen = { schemaVersion: 1, type: 'screen', id: 'screen-one', name: 'Original screen', children: [
      { schemaVersion: 1, type: 'text', id: 'first', text: 'First' },
      { schemaVersion: 1, type: 'text', id: 'second', text: 'Second' },
    ] };
    function Harness() {
      const [value, setValue] = useState(initial);
      return <SemanticScreenEditor registry={registry} localComponents={[]} screen={value} onChange={(next) => { emitted(next); setValue(next); }} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Screen name'), { target: { value: 'Renamed screen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move down first' }));
    fireEvent.change(screen.getByTestId('semantic-text-first'), { target: { value: 'Edited first' } });
    const result = emitted.mock.calls.at(-1)![0];
    expect(result).toEqual({ ...initial, name: 'Renamed screen', children: [initial.children[1], { ...initial.children[0], text: 'Edited first' }] });
    expect(UIIRScreenSchema.parse(result)).toEqual(result);
  });

  it('keeps template roots nonempty and exposes creation and extraction as callbacks', () => {
    const template: UIIRNode = { schemaVersion: 1, type: 'text', id: 'root', text: 'Reusable' };
    const change = vi.fn();
    const create = vi.fn();
    const extract = vi.fn();
    render(<SemanticTemplateEditor registry={registry} localComponents={[]} template={template} onChange={change} onCreateLocalComponent={create} onExtractComponent={extract} />);
    expect((screen.getByRole('button', { name: 'Delete root' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('semantic-add-node-root') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'New shared component' }));
    fireEvent.click(screen.getByRole('button', { name: 'Extract shared component' }));
    expect(create).toHaveBeenCalledOnce();
    expect(extract).toHaveBeenCalledWith(template);
    expect(change).not.toHaveBeenCalled();
  });

  it('keeps mapped prop and text targets read-only and exposes removal of invalid duplicate values', () => {
    const input = structuredClone(registry);
    input.components[0]!.props = { title: { type: 'string', required: false } };
    const emitted = vi.fn();
    const nodes: UIIRNode[] = [{ schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Container', props: { title: 'Duplicate prop' }, slots: { body: [
      { schemaVersion: 1, type: 'text', id: 'mapped-text', text: 'Duplicate text' },
    ] } }];
    render(<ControlledTree registry={input} localComponents={[]} initial={nodes} emitted={emitted} mappedTargets={[
      { prop: 'heading', nodeId: 'container', path: ['props', 'title'] },
      { prop: 'description', nodeId: 'mapped-text', path: ['text'] },
    ]} />);
    expect((screen.getByTestId('semantic-prop-container-title') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('semantic-reset-container-title') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('semantic-text-mapped-text') as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getAllByText(/duplicate explicit value/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete title' }));
    const mappedText = screen.getByTestId('semantic-node-mapped-text');
    fireEvent.click(within(mappedText).getByRole('button', { name: 'Delete' }));
    expect(emitted.mock.calls.at(-1)![0]).toEqual([{ schemaVersion: 1, type: 'component', id: 'container', ref: 'ds:test/Container', slots: { body: [{ schemaVersion: 1, type: 'text', id: 'mapped-text', text: '' }] } }]);
    expect(screen.getByText('Controlled by public property: heading')).toBeTruthy();
    expect(screen.queryByTestId('semantic-prop-container-title')).toBeNull();
  });

  it('renders metadata for missing references and disables all editing for read-only consumers', () => {
    const emitted = vi.fn();
    render(<SemanticTreeEditor registry={registry} localComponents={[]} disabled nodes={[
      { schemaVersion: 1, type: 'component', id: 'missing', ref: 'ds:test/Missing', props: { count: 1 } },
    ]} onChange={emitted} onExtractComponent={vi.fn()} onCreateLocalComponent={vi.fn()} />);
    expect(screen.getByText('Unavailable component reference: ds:test/Missing')).toBeTruthy();
    expect(screen.getByText(/Unknown property: count/)).toBeTruthy();
    for (const control of screen.getAllByRole('button')) expect((control as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('semantic-reference-missing') as HTMLSelectElement).disabled).toBe(true);
    expect(emitted).not.toHaveBeenCalled();
  });

  it('creates text and local instances before a design system has been compiled', () => {
    const emitted = vi.fn();
    render(<ControlledTree registry={null} localComponents={[localCard]} initial={[]} emitted={emitted} />);
    const options = within(screen.getByTestId('semantic-add-choice-root')).getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual(['Text', 'Instance: ApplicationCard']);
    choose('root', 'Text');
    choose('root', 'Instance: ApplicationCard');
    expect(emitted.mock.calls.at(-1)![0]).toEqual([
      { schemaVersion: 1, type: 'text', id: expect.any(String), text: '' },
      { schemaVersion: 1, type: 'instance', id: expect.any(String), ref: 'local:card', overrides: [] },
    ]);
  });
});
