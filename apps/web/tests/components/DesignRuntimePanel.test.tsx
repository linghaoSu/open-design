// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDesignRuntimeResponse } from '@open-design/contracts';
import { DesignRuntimePanel } from '../../src/components/DesignRuntimePanel';
import { ReactComponentPreview } from '../../src/components/ReactComponentPreview';
import * as provider from '../../src/providers/design-runtime';
import { designRuntimeState, emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/design-runtime', async () => ({
  ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'),
  getProjectDesignRuntime: vi.fn(), compileProjectDesignRuntime: vi.fn(),
  putProjectDesignRuntimeBinding: vi.fn(), deleteProjectDesignRuntimeBinding: vi.fn(),
  revalidateProjectDesignRuntimeBinding: vi.fn(), resolveProjectDesignRuntimeBinding: vi.fn(),
  validateProjectDesignRuntimeUsage: vi.fn(),
}));
vi.mock('../../src/components/ReactComponentPreview', () => ({ ReactComponentPreview: vi.fn(() => <div data-testid="inline-component-preview" />) }));

const workspaceContext = workspaceContextFixture({ workspaceId: 'workspace-a', workspaceMemberId: 'member-a' });
const panelProps = {
  projectId: 'project-a', workspaceContext,
  files: [{ name: 'src/Button.tsx' }, { name: 'src/Card.tsx' }],
  viewerOnly: false, onClose: vi.fn(),
};

/** Open real disclosures before manipulating their controls. */
function control(id: string): HTMLElement {
  const element = screen.getByTestId(id);
  const parents: HTMLDetailsElement[] = [];
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parents.push(parent as HTMLDetailsElement);
  }
  for (const details of parents.reverse()) {
    if (!details.open) fireEvent.click(details.querySelector('summary')!);
  }
  return element;
}

async function openCode() {
  await waitFor(() => expect((screen.getByTestId('design-runtime-code-tab') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId('design-runtime-code-tab'));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: designRuntimeState() });
  vi.mocked(provider.compileProjectDesignRuntime).mockResolvedValue({ state: designRuntimeState(2) });
  vi.mocked(provider.putProjectDesignRuntimeBinding).mockResolvedValue({ state: designRuntimeState(3) });
  vi.mocked(provider.validateProjectDesignRuntimeUsage).mockResolvedValue({ revision: 1, diagnostics: [] });
});
afterEach(cleanup);

describe('DesignRuntimePanel', () => {
  it('starts on the overview with setup choices and keeps advanced tools out of the initial view', async () => {
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: emptyDesignRuntimeState() });
    render(<DesignRuntimePanel {...panelProps} />);
    await waitFor(() => expect((screen.getByTestId('design-runtime-code-tab') as HTMLButtonElement).disabled).toBe(false));

    expect(screen.getByRole('heading', { name: 'Design system', level: 2 })).toBeVisible();
    expect(screen.getByTestId('design-runtime-overview-tab').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('design-runtime-start-code')).toBeVisible();
    expect(screen.getByTestId('design-runtime-import-version')).toBeVisible();
    expect(screen.getByTestId('design-runtime-compile')).not.toBeVisible();
    for (const tab of ['migration', 'structure', 'versions', 'validation', 'handoff']) {
      expect(screen.getByTestId(`design-runtime-${tab}-tab`)).not.toBeVisible();
    }
    expect(provider.compileProjectDesignRuntime).not.toHaveBeenCalled();
    expect(provider.putProjectDesignRuntimeBinding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('design-runtime-start-code'));
    expect(screen.getByTestId('design-runtime-code-tab').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('design-runtime-compile')).toBeVisible();
    expect(screen.getByTestId('design-runtime-system-id')).not.toBeVisible();
    expect(control('design-runtime-system-id')).toBeVisible();
  });

  it('shows registered components while leaving registration, binding and usage forms collapsed', async () => {
    render(<DesignRuntimePanel {...panelProps} />);
    await waitFor(() => expect(screen.getByTestId('design-runtime-code-tab')).toHaveAttribute('aria-selected', 'true'));

    expect(screen.getByTestId('design-runtime-component-select-button')).toBeVisible();
    for (const id of ['design-runtime-compile', 'design-runtime-bind', 'design-runtime-validate']) {
      expect(screen.getByTestId(id)).not.toBeVisible();
      expect(screen.getByTestId(id).closest('details')?.open).toBe(false);
      expect(control(id)).toBeVisible();
    }
    expect(provider.compileProjectDesignRuntime).not.toHaveBeenCalled();
    expect(provider.putProjectDesignRuntimeBinding).not.toHaveBeenCalled();
    expect(provider.validateProjectDesignRuntimeUsage).not.toHaveBeenCalled();
  });

  it('keeps the selected component and its draft through search and list/detail navigation', async () => {
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    const row = screen.getByTestId('design-runtime-component-select-button');
    fireEvent.click(row);
    expect(screen.getByTestId('design-runtime-catalog')).toHaveAttribute('data-view', 'detail');
    expect(screen.getByRole('heading', { name: 'Button', level: 3 })).toHaveFocus();
    const draft = control('design-runtime-value-transform-variant') as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: '{ "valueTransform":' } });
    fireEvent.click(screen.getByTestId('design-runtime-back-to-components'));
    expect(row).toHaveFocus();
    fireEvent.change(screen.getByTestId('design-runtime-component-search'), { target: { value: 'no match' } });
    expect(screen.getByText('No components match your search.')).toBeVisible();
    expect(screen.getByTestId('design-runtime-component-count')).toHaveTextContent('0 / 1');
    expect(screen.queryByTestId('design-runtime-component-select-button')).toBeNull();
    fireEvent.click(screen.getByTestId('design-runtime-overview-tab'));
    fireEvent.click(screen.getByTestId('design-runtime-code-tab'));
    expect(screen.getByTestId('design-runtime-component-count')).toHaveTextContent('0 / 1');
    fireEvent.change(screen.getByTestId('design-runtime-component-search'), { target: { value: '  Button  ' } });
    fireEvent.click(screen.getByTestId('design-runtime-component-select-button'));
    expect(screen.getByTestId('design-runtime-component-count')).toHaveTextContent('1 / 1');
    fireEvent.click(screen.getByTestId('design-runtime-back-to-components'));
    fireEvent.change(screen.getByTestId('design-runtime-component-search'), { target: { value: '   ' } });
    expect(screen.getByTestId('design-runtime-component-count')).toHaveTextContent(/^1$/);
    fireEvent.click(screen.getByTestId('design-runtime-component-select-button'));
    expect(control('design-runtime-value-transform-variant')).toBe(draft);
    expect(draft.value).toBe('{ "valueTransform":');
    expect(provider.putProjectDesignRuntimeBinding).not.toHaveBeenCalled();
  });

  it('opens the selected local JSX/TSX export for real preview without using an alternate binding target', async () => {
    const onOpenSource = vi.fn();
    render(<DesignRuntimePanel {...panelProps} onOpenSource={onOpenSource} />);
    await openCode();
    fireEvent.click(screen.getByTestId('design-runtime-preview-source'));
    expect(onOpenSource).toHaveBeenCalledWith('src/Button.tsx', 'Button');
  });

  it('renders the actual source preview inline with current scope and keeps it mounted across navigation', async () => {
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    const preview = screen.getByTestId('inline-component-preview');
    expect(vi.mocked(ReactComponentPreview).mock.calls.at(-1)?.[0]).toMatchObject({ layout: 'component', projectId: panelProps.projectId, workspaceContext, sourcePath: 'src/Button.tsx', componentPreviewRequest: { exportName: 'Button', nonce: 0 } });
    fireEvent.click(screen.getByTestId('design-runtime-overview-tab'));
    expect(preview).not.toBeVisible();
    fireEvent.click(screen.getByTestId('design-runtime-code-tab'));
    expect(screen.getByTestId('inline-component-preview')).toBe(preview);
    expect(preview).toBeVisible();
  });

  it.each(['package/Button.tsx', 'src/Button.ts'])('does not offer an unavailable source preview for %s', async (sourcePath) => {
    const state = designRuntimeState();
    state.registry!.components[0]!.source = { kind: 'typescript', sourcePath, exportName: 'Button' };
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} onOpenSource={vi.fn()} />);
    await openCode();
    expect(screen.queryByTestId('design-runtime-preview-source')).toBeNull();
    expect(screen.queryByTestId('inline-component-preview')).toBeNull();
  });

  it('does not silently preview another export when the component source has no export identity', async () => {
    const state = designRuntimeState();
    delete state.registry!.components[0]!.source!.exportName;
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} onOpenSource={vi.fn()} />);
    await openCode();
    expect(screen.queryByTestId('design-runtime-preview-source')).toBeNull();
    expect(screen.queryByTestId('inline-component-preview')).toBeNull();
  });

  it('opens an existing token-only system on the component empty state', async () => {
    const state = designRuntimeState();
    state.registry!.components = [];
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} />);
    await waitFor(() => expect(screen.getByTestId('design-runtime-code-tab')).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText('No components yet. Choose component files above to add your first.')).toBeVisible();
    expect(screen.getByTestId('design-runtime-start-migration')).not.toBeVisible();
  });

  it('explains an active token-only version and disables registration until its dependency is managed', async () => {
    const state = designRuntimeState();
    state.registry!.components = [];
    state.lock.dependencies = [{ designSystemId: 'test', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, source: { type: 'bundle', digest: `sha256:${'b'.repeat(64)}` } }];
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    expect(screen.getByText('This version contains design foundations, with no code components.')).toBeVisible();
    expect(screen.getByTestId('design-runtime-manage-version')).toBeVisible();
    expect(control('design-runtime-compile')).toBeDisabled();
    fireEvent.submit(screen.getByTestId('design-runtime-compile').closest('form')!);
    expect(provider.compileProjectDesignRuntime).not.toHaveBeenCalled();
  });

  it('chooses the first view after a failed initial read is explicitly retried, without resetting later navigation', async () => {
    vi.mocked(provider.getProjectDesignRuntime).mockRejectedValueOnce(new Error('Offline'));
    render(<DesignRuntimePanel {...panelProps} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByTestId('design-runtime-code-tab')).toHaveAttribute('aria-selected', 'true'));
    fireEvent.click(screen.getByTestId('design-runtime-overview-tab'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(screen.getByTestId('design-runtime-overview-tab')).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the first registry connection problem on its exact framework target without changing bindings', async () => {
    const state = designRuntimeState();
    const button = state.registry!.components[0]!;
    state.registry!.components.push({
      ...button, id: 'card', name: 'Card',
      source: { kind: 'typescript', sourcePath: 'src/Card.tsx', exportName: 'Card' },
    });
    state.codeIndex.components.push(
      { ...state.codeIndex.components[0]!, id: 'code/Card', name: 'React Card', sourcePath: 'src/Card.tsx', exportName: 'Card', source: { kind: 'typescript', sourcePath: 'src/Card.tsx', exportName: 'Card' } },
      { schemaVersion: 1, id: 'code/VueCard', name: 'Vue Card', framework: 'vue', sourcePath: 'src/Card.vue', exportName: 'default', props: { appearance: button.props.variant!, disabled: button.props.disabled! } },
    );
    state.bindings.bindings.unshift({ schemaVersion: 1, id: 'local-unbound', componentRef: 'local:banner', framework: 'react', status: 'unbound', verified: false });
    state.bindings.bindings.push(
      { schemaVersion: 1, id: 'card-react-binding', componentRef: 'ds:test/card', framework: 'react', status: 'bound', verified: true, codeComponentId: 'code/Card' },
      { schemaVersion: 1, id: 'card-vue-binding', componentRef: 'ds:test/card', framework: 'vue', status: 'broken', verified: false, codeComponentId: 'code/VueCard', propMappings: [{ designProp: 'variant', codeProp: 'appearance' }] },
    );
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} files={[...panelProps.files, { name: 'src/Card.vue' }]} />);
    await waitFor(() => expect((screen.getByTestId('design-runtime-repair-connections') as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByTestId('design-runtime-overview-tab'));
    expect(screen.getByText('1 connections need to be checked before use.')).toBeVisible();
    expect(screen.getByTestId('design-runtime-component-select-button')).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByTestId('design-runtime-connections') as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByTestId('design-runtime-overview-tab'));
    fireEvent.click(screen.getByTestId('design-runtime-repair-connections'));

    expect(screen.getByTestId('design-runtime-code-tab').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('design-runtime-component-select-card')).toHaveAttribute('aria-pressed', 'true');
    expect((screen.getByTestId('design-runtime-connections') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByTestId('design-runtime-code-select')).toBeVisible();
    expect((screen.getByTestId('design-runtime-code-select') as HTMLSelectElement).value).toBe('code/VueCard');
    expect(screen.getByTestId('design-runtime-binding-status')).toHaveTextContent('Broken');
    expect((screen.getByRole('combobox', { name: 'Property mappings: variant' }) as HTMLSelectElement).value).toBe('appearance');
    expect(provider.getProjectDesignRuntime).toHaveBeenCalledOnce();
    for (const request of [provider.compileProjectDesignRuntime, provider.putProjectDesignRuntimeBinding, provider.deleteProjectDesignRuntimeBinding, provider.revalidateProjectDesignRuntimeBinding, provider.resolveProjectDesignRuntimeBinding, provider.validateProjectDesignRuntimeUsage]) {
      expect(request).not.toHaveBeenCalled();
    }
  });

  it.each([
    { status: 'broken', label: 'Broken', codeId: 'code/MissingVueButton', option: 'code/MissingVueButton' },
    { status: 'unbound', label: 'Unbound', codeId: '', option: 'None' },
  ] as const)('keeps the Vue $status connection selected when only React code is available', async ({ status, label, codeId, option }) => {
    const state = designRuntimeState();
    const vueBinding = { schemaVersion: 1 as const, id: 'button-vue-binding', componentRef: 'ds:test/button', framework: 'vue' as const, verified: false as const };
    state.bindings.bindings.push(status === 'broken'
      ? { ...vueBinding, status, codeComponentId: codeId }
      : { ...vueBinding, status });
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} />);
    await waitFor(() => expect((screen.getByTestId('design-runtime-repair-connections') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('design-runtime-binding-status')).toHaveTextContent('Bound');

    fireEvent.click(screen.getByTestId('design-runtime-overview-tab'));
    fireEvent.click(screen.getByTestId('design-runtime-repair-connections'));

    expect(screen.getByTestId('design-runtime-code-tab').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('design-runtime-connections') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByTestId('design-runtime-binding-status')).toHaveTextContent(label);
    const target = screen.getByTestId('design-runtime-code-select') as HTMLSelectElement;
    expect(target).toBeVisible();
    expect(target.value).toBe(codeId);
    expect(target.selectedOptions[0]?.textContent).toBe(option);
    expect(screen.getByTestId('design-runtime-bind')).toBeDisabled();
    expect(provider.getProjectDesignRuntime).toHaveBeenCalledOnce();
    for (const request of [provider.compileProjectDesignRuntime, provider.putProjectDesignRuntimeBinding, provider.deleteProjectDesignRuntimeBinding, provider.revalidateProjectDesignRuntimeBinding, provider.resolveProjectDesignRuntimeBinding, provider.validateProjectDesignRuntimeUsage]) {
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('keeps an edited registration draft mounted across overview and advanced navigation', async () => {
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    const draft = control('design-runtime-export-name-0') as HTMLInputElement;
    fireEvent.change(draft, { target: { value: 'UnsubmittedButton' } });
    fireEvent.click(screen.getByTestId('design-runtime-overview-tab'));
    expect(draft).not.toBeVisible();
    for (const tab of ['migration', 'structure', 'versions', 'validation', 'handoff']) {
      expect(control(`design-runtime-${tab}-tab`)).toBeVisible();
    }
    fireEvent.click(screen.getByTestId('design-runtime-structure-tab'));
    expect(screen.getByTestId('design-runtime-structure-tab').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('project-structure-panel')).toBeVisible();
    fireEvent.click(screen.getByTestId('design-runtime-code-tab'));
    expect(screen.getByTestId('design-runtime-export-name-0')).toBe(draft);
    expect(draft.value).toBe('UnsubmittedButton');
    expect(draft).toBeVisible();
    expect(provider.compileProjectDesignRuntime).not.toHaveBeenCalled();
  });

  it('recommends migration on the overview without starting a review or opening setup automatically', async () => {
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: emptyDesignRuntimeState() });
    render(<DesignRuntimePanel {...panelProps} files={[{ name: 'DESIGN.md' }, { name: 'system/variables.css' }, { name: 'components.html' }]} />);
    await waitFor(() => expect((screen.getByTestId('design-runtime-start-migration') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('design-runtime-overview-tab').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('design-runtime-legacy-migration')).toBeNull();
    expect(provider.compileProjectDesignRuntime).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('design-runtime-start-migration'));
    await screen.findByTestId('design-runtime-legacy-migration');
    expect(screen.getByTestId('design-runtime-migration-tab').getAttribute('aria-selected')).toBe('true');
    expect((screen.getByTestId('legacy-token-stylesheet') as HTMLSelectElement).value).toBe('system/variables.css');
    expect(screen.queryByTestId('legacy-review-result')).toBeNull();
    expect(provider.compileProjectDesignRuntime).not.toHaveBeenCalled();
  });

  it('preserves and exposes typed and legacy value conversions when editing another code mapping', async () => {
    const state = designRuntimeState();
    state.bindings.bindings[0]!.propMappings = [
      { designProp: 'variant', codeProp: 'variant', valueTransform: { type: 'map', entries: [{ from: 'primary', to: 'primary' }, { from: 'secondary', to: 'secondary' }] } },
      { designProp: 'disabled', codeProp: 'disabled', values: { false: false, true: true } },
    ];
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-component-select-button');
    expect((control('design-runtime-value-transform-variant') as HTMLTextAreaElement).value).toContain('valueTransform');
    expect((control('design-runtime-value-transform-disabled') as HTMLTextAreaElement).value).toContain('values');
    fireEvent.click(control('design-runtime-bind'));
    await waitFor(() => expect(provider.putProjectDesignRuntimeBinding).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.putProjectDesignRuntimeBinding).mock.calls[0]![2].binding.propMappings).toEqual(state.bindings.bindings[0]!.propMappings);
  });
  it.each(['constructor', 'toString'])('validates a required %s prop without reading Object.prototype', async (name) => {
    const state = designRuntimeState();
    state.registry!.components[0]!.props = { [name]: { type: 'boolean', required: true } };
    state.codeIndex.components[0]!.props = state.registry!.components[0]!.props;
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-component-select-button');
    fireEvent.click(control('design-runtime-validate'));
    await waitFor(() => expect(provider.validateProjectDesignRuntimeUsage).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.validateProjectDesignRuntimeUsage).mock.calls[0]![1].props).toEqual({ [name]: false });
  });
  it('compiles multiple selected project exports with identities retained across export edits', async () => {
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: emptyDesignRuntimeState() });
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await waitFor(() => expect(control('design-runtime-compile').closest('fieldset')?.disabled).toBe(false));
    const componentId = (control('design-runtime-component-id-0') as HTMLInputElement).value;
    const codeId = (control('design-runtime-code-id-0') as HTMLInputElement).value;
    fireEvent.change(control('design-runtime-export-name-0'), { target: { value: 'Button' } });
    fireEvent.change(control('design-runtime-export-name-0'), { target: { value: 'RenamedButton' } });
    fireEvent.click(control('design-runtime-add-source'));
    fireEvent.change(control('design-runtime-source-path-1'), { target: { value: 'src/Card.tsx' } });
    fireEvent.change(control('design-runtime-export-name-1'), { target: { value: 'Card' } });
    fireEvent.click(control('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce());
    const [authority, request] = vi.mocked(provider.compileProjectDesignRuntime).mock.calls[0]!;
    expect(authority).toMatchObject({ projectId: 'project-a', workspaceContext });
    expect(request).toMatchObject({ expectedRevision: 0, designSystemId: 'project', selections: [
      { sourcePath: 'src/Button.tsx', exportName: 'RenamedButton', componentId, codeComponentId: codeId },
      { sourcePath: 'src/Card.tsx', exportName: 'Card' },
    ] });
    expect(request.selections[1]!.componentId).not.toBe(componentId);
    expect(request.selections.every((selection) => !Object.hasOwn(selection, 'sourceText'))).toBe(true);
  });

  it('compiles explicit frameworks, metadata and grouped story selections without reallocating identities', async () => {
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: emptyDesignRuntimeState() });
    render(<DesignRuntimePanel {...panelProps} files={[...panelProps.files, { name: 'src/Button.stories.ts' }, { name: 'src/Card.vue' }, { name: 'src/Card.stories.ts' }]} />);
    await openCode();
    await waitFor(() => expect(control('design-runtime-compile').closest('fieldset')?.disabled).toBe(false));
    fireEvent.change(control('design-runtime-source-path-0'), { target: { value: 'src/Button.tsx' } });
    fireEvent.change(control('design-runtime-export-name-0'), { target: { value: 'Button' } });
    fireEvent.change(control('design-runtime-metadata-export-0'), { target: { value: 'ButtonPolicy' } });
    fireEvent.click(control('design-runtime-add-story-source-0'));
    fireEvent.change(control('design-runtime-story-source-0-0'), { target: { value: 'src/Button.stories.ts' } });
    fireEvent.change(control('design-runtime-story-export-0-0-0'), { target: { value: 'Primary' } });
    const storyId = (control('design-runtime-story-id-0-0-0') as HTMLInputElement).value;
    fireEvent.change(control('design-runtime-story-export-0-0-0'), { target: { value: 'RenamedPrimary' } });
    fireEvent.click(control('design-runtime-add-story-0-0'));
    fireEvent.change(control('design-runtime-story-export-0-0-1'), { target: { value: 'Secondary' } });
    fireEvent.click(control('design-runtime-add-source'));
    const componentId = (control('design-runtime-component-id-1') as HTMLInputElement).value;
    const codeId = (control('design-runtime-code-id-1') as HTMLInputElement).value;
    fireEvent.change(control('design-runtime-framework-1'), { target: { value: 'vue' } });
    fireEvent.change(control('design-runtime-source-path-1'), { target: { value: 'src/Card.vue' } });
    expect((control('design-runtime-export-name-1') as HTMLInputElement).readOnly).toBe(true);
    fireEvent.click(control('design-runtime-add-story-source-1'));
    fireEvent.change(control('design-runtime-story-source-1-0'), { target: { value: 'src/Card.stories.ts' } });
    fireEvent.change(control('design-runtime-story-export-1-0-0'), { target: { value: 'Plain' } });
    fireEvent.click(control('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce());
    const request = vi.mocked(provider.compileProjectDesignRuntime).mock.calls[0]![1];
    expect(request.selections).toMatchObject([
      { framework: 'react', sourcePath: 'src/Button.tsx', exportName: 'Button', metadataExportName: 'ButtonPolicy', storySources: [{ sourcePath: 'src/Button.stories.ts', selections: [{ id: storyId, exportName: 'RenamedPrimary' }, { exportName: 'Secondary' }] }] },
      { framework: 'vue', sourcePath: 'src/Card.vue', exportName: 'default', componentId, codeComponentId: codeId, storySources: [{ sourcePath: 'src/Card.stories.ts', selections: [{ exportName: 'Plain' }] }] },
    ]);
    expect(new Set(request.selections.flatMap((selection) => selection.storySources?.flatMap((source) => source.selections.map((story) => story.id)) ?? [])).size).toBe(3);
    expect(JSON.stringify(request)).not.toContain('sourceText');
  });

  it.each(['body', 'constructor'])('restores selected metadata and story identities, and explicitly rebinds the %s slot', async (slotName) => {
    const state = designRuntimeState();
    state.registry!.components[0]!.slots = { [slotName]: { accepts: ['text'], required: false, multiple: true, source: { kind: 'manual', sourcePath: 'src/Button.tsx', exportName: 'ButtonPolicy' } } };
    state.registry!.components[0]!.stories = [{ id: 'primary-stable', name: 'Primary example', exportName: 'Primary', args: { variant: 'secondary' }, argTypes: {}, source: { kind: 'storybook', sourcePath: 'src/Button.stories.ts', exportName: 'Primary' } }];
    state.codeIndex.components[0]!.slots = { children: { kind: 'react-node', required: false, multiple: true } };
    state.bindings.bindings[0]!.slotMappings = [{ designSlot: slotName, codeSlot: 'children' }];
    const unbound = structuredClone(state);
    unbound.revision = 2;
    unbound.bindings.bindings = [{ schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button', status: 'unbound', verified: false }];
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state });
    vi.mocked(provider.deleteProjectDesignRuntimeBinding).mockResolvedValue({ state: unbound });
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByText('Primary example');
    expect((control('design-runtime-metadata-export-0') as HTMLInputElement).value).toBe('ButtonPolicy');
    expect((control('design-runtime-story-source-0-0') as HTMLSelectElement).value).toBe('src/Button.stories.ts');
    expect((control('design-runtime-story-id-0-0-0') as HTMLInputElement).value).toBe('primary-stable');
    expect((control(`design-runtime-slot-mapping-${slotName}`) as HTMLSelectElement).value).toBe('children');
    fireEvent.click(control('design-runtime-unbind'));
    await waitFor(() => expect(control('design-runtime-binding-status').textContent).toBe('Unbound'));
    fireEvent.change(control(`design-runtime-slot-mapping-${slotName}`), { target: { value: '' } });
    fireEvent.change(control(`design-runtime-slot-mapping-${slotName}`), { target: { value: 'children' } });
    fireEvent.click(control('design-runtime-bind'));
    await waitFor(() => expect(provider.putProjectDesignRuntimeBinding).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.putProjectDesignRuntimeBinding).mock.calls[0]![2]).toMatchObject({ expectedRevision: 2, binding: { slotMappings: [{ designSlot: slotName, codeSlot: 'children' }] } });
  });

  it('keeps original compilation sources, identities and metadata after retargeting a binding and reopening', async () => {
    const initial = designRuntimeState();
    const button = initial.registry!.components[0]!;
    button.slots = { body: { accepts: ['text'], required: false, multiple: true, source: { kind: 'manual', sourcePath: 'src/Button.tsx', exportName: 'ButtonPolicy' } } };
    initial.codeIndex.components[0]!.slots = { children: { kind: 'react-node', required: false, multiple: true } };
    initial.bindings.bindings[0]!.slotMappings = [{ designSlot: 'body', codeSlot: 'children' }];
    const cardSource = { kind: 'typescript' as const, sourcePath: 'src/Card.tsx', exportName: 'Card' };
    initial.registry!.components.push({ ...structuredClone(button), id: 'card', name: 'Card', source: cardSource,
      slots: { body: { accepts: ['text'], required: false, multiple: true, source: { kind: 'manual', sourcePath: 'src/Card.tsx', exportName: 'CardPolicy' } } },
    });
    initial.codeIndex.components.push({ ...structuredClone(initial.codeIndex.components[0]!), id: 'code/Card', name: 'Card', source: cardSource, sourcePath: cardSource.sourcePath, exportName: 'Card' });
    initial.bindings.bindings.push({ schemaVersion: 1, id: 'card-binding', componentRef: 'ds:test/card', framework: 'react', status: 'bound', verified: true, codeComponentId: 'code/Card', slotMappings: [{ designSlot: 'body', codeSlot: 'children' }] });
    const retargeted = structuredClone(initial);
    retargeted.revision = 2;
    retargeted.bindings.bindings[0] = { schemaVersion: 1, id: 'button-binding', componentRef: 'ds:test/button', framework: 'react', status: 'bound', verified: true, codeComponentId: 'code/Card', slotMappings: [{ designSlot: 'body', codeSlot: 'children' }] };
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: initial });
    vi.mocked(provider.putProjectDesignRuntimeBinding).mockResolvedValue({ state: retargeted });
    const first = render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-code-select');
    fireEvent.change(control('design-runtime-code-select'), { target: { value: 'code/Card' } });
    fireEvent.change(control('design-runtime-slot-mapping-body'), { target: { value: 'children' } });
    fireEvent.click(control('design-runtime-bind'));
    await screen.findByText('Changes saved.');
    expect(vi.mocked(provider.putProjectDesignRuntimeBinding).mock.calls[0]![2].binding).toMatchObject({ componentRef: 'ds:test/button', codeComponentId: 'code/Card' });
    first.unmount();
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: retargeted });
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-code-select');
    expect((control('design-runtime-code-select') as HTMLSelectElement).value).toBe('code/Card');
    expect((control('design-runtime-source-path-0') as HTMLSelectElement).value).toBe('src/Button.tsx');
    expect((control('design-runtime-code-id-0') as HTMLInputElement).value).toBe('code/Button');
    fireEvent.click(control('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce());
    expect(vi.mocked(provider.compileProjectDesignRuntime).mock.calls[0]![1]).toMatchObject({ expectedRevision: 2, selections: [
      { sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'code/Button', metadataExportName: 'ButtonPolicy' },
      { sourcePath: 'src/Card.tsx', exportName: 'Card', componentId: 'card', codeComponentId: 'code/Card', metadataExportName: 'CardPolicy' },
    ] });
  });

  it('allows viewers to browse and validate while disabling every mutation', async () => {
    vi.mocked(provider.validateProjectDesignRuntimeUsage).mockResolvedValue({ revision: 1, diagnostics: [{
      schemaVersion: 1, code: 'ODDS1003', severity: 'error', message: 'Variant is not allowed.', path: ['props', 'variant'], allowedValues: ['primary', 'secondary'],
    }] });
    render(<DesignRuntimePanel {...panelProps} viewerOnly />);
    await openCode();
    await screen.findByTestId('design-runtime-component-select-button');
    expect(screen.getByText(/Read-only access/)).toBeTruthy();
    expect(control('design-runtime-compile').closest('fieldset')?.disabled).toBe(true);
    for (const action of ['bind', 'unbind', 'revalidate']) expect((control(`design-runtime-${action}`) as HTMLButtonElement).disabled).toBe(true);
    expect((control('design-runtime-component-select-button') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(control('design-runtime-prop-include-variant'));
    fireEvent.change(control('design-runtime-prop-variant'), { target: { value: 'filled' } });
    fireEvent.click(control('design-runtime-validate'));
    await screen.findByText('ODDS1003');
    expect(provider.validateProjectDesignRuntimeUsage).toHaveBeenCalledWith(expect.objectContaining({ workspaceContext }), { component: 'ds:test/button', props: { variant: 'filled' } });
    expect(screen.getByText('Allowed values: "primary", "secondary"')).toBeTruthy();
    expect(screen.getByText('props → variant')).toBeTruthy();
    expect(provider.putProjectDesignRuntimeBinding).not.toHaveBeenCalled();
  });

  it('uses the current revision for explicit unbind and bind operations', async () => {
    const unbound = designRuntimeState(2);
    unbound.bindings.bindings = [{ schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button', status: 'unbound', verified: false }];
    vi.mocked(provider.deleteProjectDesignRuntimeBinding).mockResolvedValue({ state: unbound });
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-unbind');
    fireEvent.click(control('design-runtime-unbind'));
    await waitFor(() => expect(control('design-runtime-binding-status').textContent).toBe('Unbound'));
    fireEvent.click(control('design-runtime-bind'));
    await waitFor(() => expect(control('design-runtime-binding-status').textContent).toBe('Bound'));
    expect(provider.putProjectDesignRuntimeBinding).toHaveBeenCalledWith(expect.any(Object), 'button-binding', {
      expectedRevision: 2,
      binding: { schemaVersion: 1, id: 'button-binding', framework: 'react', componentRef: 'ds:test/button', status: 'bound', verified: true, codeComponentId: 'code/Button', propMappings: [], slotMappings: [] },
    });
  });

  it.each(['project', 'workspace'] as const)('discards late reads and drafts when the %s identity changes', async (boundary) => {
    const old = deferred<ProjectDesignRuntimeResponse>();
    vi.mocked(provider.getProjectDesignRuntime).mockReturnValueOnce(old.promise);
    const { rerender } = render(<DesignRuntimePanel {...panelProps} />);
    const nextState = designRuntimeState(7);
    nextState.registry!.components[0]!.name = 'Current component';
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: nextState });
    const nextProps = boundary === 'project' ? { ...panelProps, projectId: 'project-b' }
      : { ...panelProps, workspaceContext: workspaceContextFixture({ workspaceId: 'workspace-b', workspaceMemberId: 'member-b' }) };
    rerender(<DesignRuntimePanel {...nextProps} />);
    await openCode();
    await waitFor(() => expect(control('design-runtime-component-select-button')).toHaveTextContent('Current componentButton'));
    const oldState = designRuntimeState(99);
    oldState.registry!.components[0]!.name = 'Old component';
    await act(async () => old.resolve({ state: oldState }));
    expect(control('design-runtime-component-select-button')).toHaveTextContent('Current componentButton');
    expect(screen.queryByText('Old component')).toBeNull();
    expect(vi.mocked(provider.getProjectDesignRuntime).mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(vi.mocked(provider.getProjectDesignRuntime).mock.calls[1]![0]).toMatchObject({ projectId: nextProps.projectId, workspaceContext: nextProps.workspaceContext });
  });

  it('discards a late mutation response after switching projects', async () => {
    const old = deferred<ProjectDesignRuntimeResponse>();
    vi.mocked(provider.deleteProjectDesignRuntimeBinding).mockReturnValueOnce(old.promise);
    const { rerender } = render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-unbind');
    fireEvent.click(control('design-runtime-unbind'));
    const current = designRuntimeState(7);
    current.registry!.components[0]!.name = 'Current component';
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: current });
    rerender(<DesignRuntimePanel {...panelProps} projectId="project-b" />);
    await openCode();
    await waitFor(() => expect(control('design-runtime-component-select-button')).toHaveTextContent('Current componentButton'));
    await act(async () => old.resolve({ state: designRuntimeState(99) }));
    expect(control('design-runtime-component-select-button')).toHaveTextContent('Current componentButton');
    expect(screen.queryByText('Changes saved.')).toBeNull();
  });

  it('keeps a conflicting compile draft, refreshes state, and requires an explicit retry with the new revision', async () => {
    vi.mocked(provider.compileProjectDesignRuntime).mockRejectedValueOnce(new provider.ProjectDesignRuntimeError(409, {
      code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Revision changed.', details: { currentRevision: 7 },
    }));
    const { unmount } = render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-component-select-button');
    fireEvent.change(control('design-runtime-export-name-0'), { target: { value: 'DraftButton' } });
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: designRuntimeState(7) });
    fireEvent.click(control('design-runtime-compile'));
    await screen.findByText(/The registry changed/);
    expect(provider.getProjectDesignRuntime).toHaveBeenCalledTimes(2);
    expect((control('design-runtime-export-name-0') as HTMLInputElement).value).toBe('DraftButton');
    expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce();
    fireEvent.click(control('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provider.compileProjectDesignRuntime).mock.calls[1]![1].expectedRevision).toBe(7);
    unmount();
  });

  it('reports a failed conflict refresh without claiming that the latest revision loaded', async () => {
    vi.mocked(provider.compileProjectDesignRuntime).mockRejectedValueOnce(new provider.ProjectDesignRuntimeError(409, {
      code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Revision changed.', details: { currentRevision: 7 },
    }));
    render(<DesignRuntimePanel {...panelProps} />);
    await openCode();
    await screen.findByTestId('design-runtime-component-select-button');
    vi.mocked(provider.getProjectDesignRuntime).mockRejectedValueOnce(new Error('Refresh unavailable.'));
    fireEvent.click(control('design-runtime-compile'));
    await screen.findByText('Revision changed. Refresh unavailable.');
    expect(screen.queryByText(/latest revision is loaded/)).toBeNull();
    expect(provider.compileProjectDesignRuntime).toHaveBeenCalledOnce();
    fireEvent.click(control('design-runtime-compile'));
    await waitFor(() => expect(provider.compileProjectDesignRuntime).toHaveBeenCalledTimes(2));
    expect(vi.mocked(provider.compileProjectDesignRuntime).mock.calls[1]![1].expectedRevision).toBe(1);
  });
});
