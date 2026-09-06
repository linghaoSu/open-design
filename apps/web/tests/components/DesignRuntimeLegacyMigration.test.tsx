// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignRuntimeLegacyMigration } from '../../src/components/DesignRuntimeLegacyMigration';
import * as provider from '../../src/providers/design-runtime';
import { legacyMigrationFixture } from '../helpers/design-runtime-legacy-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/design-runtime', async () => ({ ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'),
  reviewProjectDesignRuntimeLegacyMigration: vi.fn(), applyProjectDesignRuntimeLegacyMigration: vi.fn(), getProjectDesignRuntime: vi.fn() }));
const scope = { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'team-a', workspaceMemberId: 'member-a' }) };
const files = [{ name: 'DESIGN.md', size: 20, mtime: 1 }, { name: 'tokens.css', size: 20, mtime: 1 }, { name: 'components.html', size: 20, mtime: 1 }, { name: 'src/Button.tsx', size: 20, mtime: 1 }, { name: 'src/Card.vue', size: 20, mtime: 1 }];
const element = (id: string) => screen.getByTestId(id) as HTMLInputElement;
const props = () => ({ scope, state: legacyMigrationFixture().state, files, viewerOnly: false, onState: vi.fn() });
const steps = ['name', 'files', 'review'] as const;
function goToStep(target: typeof steps[number]) {
  const current = steps.findIndex((step) => !screen.getByTestId(`legacy-step-${step}`).hidden);
  const destination = steps.indexOf(target);
  for (let index = current; index !== destination; index += destination > current ? 1 : -1) {
    const direction = destination > current ? 'continue' : 'back';
    expect(element(`legacy-${direction}`)).toBeEnabled();
    fireEvent.click(element(`legacy-${direction}`));
  }
  expect(screen.getByTestId(`legacy-step-${target}`)).toBeVisible();
}
function beginReview() { goToStep('review'); fireEvent.click(element('legacy-review')); }
async function review() { beginReview(); await screen.findByTestId('legacy-review-result'); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(provider.reviewProjectDesignRuntimeLegacyMigration).mockImplementation(async (authority, input) => ({ revision: input.expectedRevision, review: legacyMigrationFixture(input.plan, authority.projectId, input.expectedRevision).review }));
  vi.mocked(provider.applyProjectDesignRuntimeLegacyMigration).mockImplementation(async (authority, input) => legacyMigrationFixture(input.plan, authority.projectId, input.expectedRevision).applied);
});
afterEach(cleanup);

describe('legacy migration panel', () => {
  it('shows one step at a time and keeps the same name and file drafts mounted across navigation', () => {
    render(<DesignRuntimeLegacyMigration {...props()} />);
    const name = element('legacy-name');
    const source = element('legacy-source-src/Button.tsx');
    expect(screen.getByTestId('legacy-step-name')).toBeVisible();
    expect(screen.getByTestId('legacy-step-files')).not.toBeVisible();
    expect(screen.getByTestId('legacy-step-review')).not.toBeVisible();
    expect(screen.getByTestId('legacy-step-indicator-name')).toHaveAttribute('aria-current', 'step');
    expect(element('legacy-back')).toBeDisabled();
    fireEvent.change(name, { target: { value: '' } });
    expect(element('legacy-continue')).toBeDisabled();
    fireEvent.change(name, { target: { value: 'Preserved system name' } });

    goToStep('files');
    fireEvent.click(source);
    expect(source.checked).toBe(true);
    expect(name).not.toBeVisible();
    goToStep('name');
    expect(element('legacy-name')).toBe(name);
    expect(name.value).toBe('Preserved system name');
    goToStep('review');
    expect(element('legacy-source-src/Button.tsx')).toBe(source);
    expect(source.checked).toBe(true);
    expect(source).not.toBeVisible();
    expect(screen.getByTestId('legacy-step-indicator-review')).toHaveAttribute('aria-current', 'step');
    expect(element('legacy-review')).toBeVisible();
    expect(screen.queryByTestId('legacy-apply')).toBeNull();
    expect(provider.reviewProjectDesignRuntimeLegacyMigration).not.toHaveBeenCalled();
    expect(provider.applyProjectDesignRuntimeLegacyMigration).not.toHaveBeenCalled();
  });
  it('requires a fresh explicit review after a file change on an earlier step', async () => {
    const input = props(); render(<DesignRuntimeLegacyMigration {...input} />);
    await review();
    const proof = screen.getByTestId('legacy-review-result');
    goToStep('files');
    expect(proof).not.toBeVisible();
    goToStep('review');
    expect(screen.getByTestId('legacy-review-result')).toBe(proof);
    expect(provider.reviewProjectDesignRuntimeLegacyMigration).toHaveBeenCalledOnce();

    goToStep('files');
    fireEvent.click(element('legacy-source-components.html'));
    goToStep('review');
    expect(screen.queryByTestId('legacy-review-result')).toBeNull();
    expect(screen.queryByTestId('legacy-apply')).toBeNull();
    expect(provider.reviewProjectDesignRuntimeLegacyMigration).toHaveBeenCalledOnce();
    expect(provider.applyProjectDesignRuntimeLegacyMigration).not.toHaveBeenCalled();
    await review();
    const request = vi.mocked(provider.reviewProjectDesignRuntimeLegacyMigration).mock.calls[1]![1];
    expect(request.plan.sourcePaths).toEqual(['DESIGN.md', 'tokens.css']);
    fireEvent.click(element('legacy-apply'));
    await waitFor(() => expect(input.onState).toHaveBeenCalledOnce());
    expect(provider.applyProjectDesignRuntimeLegacyMigration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(scope), legacyMigrationFixture(request.plan).proof);
  });
  it('reviews canonical legacy files without JSON authoring, shows incomplete facts and applies the exact proof once', async () => {
    const input = props(); render(<DesignRuntimeLegacyMigration {...input} />);
    expect(element('legacy-token-stylesheet').value).toBe('tokens.css'); expect(screen.queryByTestId('legacy-apply')).toBeNull();
    expect((screen.getByTestId('legacy-advanced') as HTMLDetailsElement).open).toBe(false);
    expect(element('legacy-name').closest('details')).toBeNull();
    await review();
    const request = vi.mocked(provider.reviewProjectDesignRuntimeLegacyMigration).mock.calls[0]![1];
    expect(request.plan.sourcePaths).toEqual(['DESIGN.md', 'components.html', 'tokens.css']); expect(request.plan.selections).toEqual([]);
    expect(screen.getByTestId('legacy-converted-count').textContent).toBe('1'); expect(screen.getByTestId('legacy-unresolved-count').textContent).toBe('1');
    expect(screen.getByTestId('legacy-token-foundation').textContent).toContain('not Strict ready'); expect(screen.getByText('--shadow')).toBeTruthy();
    expect(screen.getByTestId('legacy-packaged-sources').textContent).toContain('components.html'); expect(provider.applyProjectDesignRuntimeLegacyMigration).not.toHaveBeenCalled();
    expect((screen.getByTestId('legacy-package-details') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('legacy-review-result').compareDocumentPosition(element('legacy-apply')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(element('legacy-apply')); fireEvent.click(element('legacy-apply'));
    await waitFor(() => expect(input.onState).toHaveBeenCalledOnce());
    expect(provider.applyProjectDesignRuntimeLegacyMigration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(scope), legacyMigrationFixture(request.plan).proof);
    expect(screen.queryByTestId('legacy-apply')).toBeNull();
  });
  it('offers system/variables.css and optional editable React/Vue selections including removal of the last component', async () => {
    render(<DesignRuntimeLegacyMigration {...props()} files={files.map((file) => file.name === 'tokens.css' ? { ...file, name: 'system/variables.css' } : file)} />);
    goToStep('files');
    expect(element('legacy-token-stylesheet').value).toBe('system/variables.css');
    fireEvent.click(element('legacy-add-component').closest('details')!.querySelector('summary')!);
    fireEvent.click(element('legacy-add-component'));
    fireEvent.change(element('design-runtime-source-path-0'), { target: { value: 'src/Card.vue' } });
    expect(element('design-runtime-export-name-0').value).toBe('default');
    await review(); expect(vi.mocked(provider.reviewProjectDesignRuntimeLegacyMigration).mock.calls[0]![1].plan.sourcePaths).toContain('src/Card.vue');
    goToStep('files');
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1' })); expect(screen.queryByTestId('design-runtime-export-name-0')).toBeNull(); expect(screen.queryByTestId('legacy-apply')).toBeNull();
    expect(screen.queryByTestId('legacy-review-result')).toBeNull();
  });
  it.each(['version', 'name', 'mode', 'files', 'revision'] as const)('invalidates an existing review when %s changes', async (change) => {
    const input = props(); const mounted = render(<DesignRuntimeLegacyMigration {...input} />); await review();
    if (change === 'files') mounted.rerender(<DesignRuntimeLegacyMigration {...input} files={files.map((file) => ({ ...file, mtime: 2 }))} />);
    else if (change === 'revision') mounted.rerender(<DesignRuntimeLegacyMigration {...input} state={{ ...input.state, revision: 2 }} />);
    else {
      goToStep('name');
      if (change !== 'name') fireEvent.click(screen.getByTestId('legacy-advanced').querySelector('summary')!);
      fireEvent.change(element(`legacy-${change}`), { target: { value: change === 'mode' ? 'guided' : change === 'version' ? '2.0.0' : 'Edited' } });
    }
    expect(screen.queryByTestId('legacy-apply')).toBeNull(); expect(screen.queryByTestId('legacy-review-result')).toBeNull();
  });
  it.each(['workspace', 'source'] as const)('aborts pending review on %s changes and ignores its late response', async (change) => {
    let complete!: (value: Awaited<ReturnType<typeof provider.reviewProjectDesignRuntimeLegacyMigration>>) => void;
    vi.mocked(provider.reviewProjectDesignRuntimeLegacyMigration).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const input = props(); const mounted = render(<DesignRuntimeLegacyMigration {...input} />); beginReview();
    expect(element('legacy-back')).toBeDisabled();
    const [authority, request] = vi.mocked(provider.reviewProjectDesignRuntimeLegacyMigration).mock.calls[0]!;
    if (change === 'workspace') mounted.rerender(<DesignRuntimeLegacyMigration {...input} scope={{ ...scope, workspaceContext: workspaceContextFixture({ workspaceId: 'team-b', workspaceMemberId: 'member-b' }) }} />);
    else mounted.rerender(<DesignRuntimeLegacyMigration {...input} files={files.map((file) => ({ ...file, mtime: 2 }))} />);
    expect(authority.signal?.aborted).toBe(true);
    await act(async () => complete({ revision: 1, review: legacyMigrationFixture(request.plan).review }));
    expect(screen.queryByTestId('legacy-review-result')).toBeNull(); expect(screen.queryByTestId('legacy-apply')).toBeNull();
  });
  it('allows a readonly review while preventing application and reports a blocked document-only candidate', async () => {
    const input = props(); const mounted = render(<DesignRuntimeLegacyMigration {...input} viewerOnly />); await review(); expect(element('legacy-apply').disabled).toBe(true);
    vi.mocked(provider.reviewProjectDesignRuntimeLegacyMigration).mockImplementation(async (authority, request) => ({ revision: 1, review: legacyMigrationFixture(request.plan, authority.projectId, 1, false).review }));
    mounted.rerender(<DesignRuntimeLegacyMigration {...input} files={[files[0]!]} />); await review();
    expect(screen.queryByTestId('legacy-apply')).toBeNull(); expect(screen.getByText('No convertible facts.')).toBeTruthy(); expect(provider.applyProjectDesignRuntimeLegacyMigration).not.toHaveBeenCalled();
  });
  it('does not adopt a late application after the Workspace identity changes', async () => {
    const input = props(); const mounted = render(<DesignRuntimeLegacyMigration {...input} />); await review();
    let complete!: (value: Awaited<ReturnType<typeof provider.applyProjectDesignRuntimeLegacyMigration>>) => void;
    vi.mocked(provider.applyProjectDesignRuntimeLegacyMigration).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    fireEvent.click(element('legacy-apply'));
    const [authority, request] = vi.mocked(provider.applyProjectDesignRuntimeLegacyMigration).mock.calls[0]!;
    mounted.rerender(<DesignRuntimeLegacyMigration {...input} scope={{ ...scope, workspaceContext: workspaceContextFixture({ workspaceId: 'team-b', workspaceMemberId: 'member-b' }) }} />);
    expect(authority.signal?.aborted).toBe(true);
    await act(async () => complete(legacyMigrationFixture(request.plan).applied));
    expect(input.onState).not.toHaveBeenCalled(); expect(screen.queryByTestId('legacy-review-result')).toBeNull(); expect(screen.queryByTestId('legacy-apply')).toBeNull();
  });
  it('invalidates a stale source proof, refreshes the project, and never retries apply', async () => {
    const input = props(); render(<DesignRuntimeLegacyMigration {...input} />); await review();
    vi.mocked(provider.applyProjectDesignRuntimeLegacyMigration).mockRejectedValue(new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_LEGACY_MIGRATION_CONFLICT', message: 'Source bytes changed.' }));
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: { ...input.state, revision: 2 } });
    fireEvent.click(element('legacy-apply')); await screen.findByText('Source bytes changed.');
    await waitFor(() => expect(input.onState).toHaveBeenCalledOnce()); expect(screen.queryByTestId('legacy-apply')).toBeNull(); expect(provider.applyProjectDesignRuntimeLegacyMigration).toHaveBeenCalledOnce();
  });
});
