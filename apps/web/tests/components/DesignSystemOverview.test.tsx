// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemVersionSchema, type ProjectDesignRuntimeVersionResponse } from '@open-design/contracts';
import { DesignSystemOverview } from '../../src/components/DesignSystemOverview';
import { initialVersionConstraints } from '../../src/components/DesignSystemVersionDetails';
import * as provider from '../../src/providers/design-runtime';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';
import { emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

vi.mock('../../src/providers/design-runtime', async () => ({
  ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'),
  getProjectDesignRuntimeVersion: vi.fn(),
}));
const scope = { projectId: 'project-a', workspaceContext: workspaceContextFixture({ workspaceId: 'workspace-a', workspaceMemberId: 'member-a' }) };
const props = { scope, hasLegacyFiles: true, hasSourceFiles: true, disabled: false, viewerOnly: false, onNavigate: vi.fn(), onRepair: vi.fn() };
function fixture() {
  const state = { ...emptyDesignRuntimeState(4), registry: { schemaVersion: 1 as const, id: 'test', components: [] } };
  const version = DesignSystemVersionSchema.parse({ schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}`, package: {
    schemaVersion: 1, id: 'test', name: 'Preserved system', version: '1.0.2', registry: state.registry,
    codeIndex: { ...state.codeIndex, id: 'test' }, bindings: { ...state.bindings, id: 'test' },
    constraints: initialVersionConstraints(),
    tokens: { schemaVersion: 1, id: 'test', tokens: Array.from({ length: 45 }, (_, index) => ({ schemaVersion: 1, id: `color-${index}`, name: `Color ${index}`, cssVariable: `--color-${index}`, type: 'color', value: '#112233' })) },
    patterns: { schemaVersion: 1, id: 'test', patterns: [] }, codeCompatibility: [],
    source: { schemaVersion: 1, files: ['DESIGN.md', 'tokens.css', 'components.html', 'usage.md', 'assets/icon.svg', 'assets/logo.png'].map((path) => ({ path, encoding: 'utf8', content: 'PRIVATE_SOURCE_BYTES' })) },
  } });
  const pin = { designSystemId: 'test', version: '1.0.2', digest: version.digest, source: { type: 'bundle' as const, digest: version.sourceDigest } };
  state.lock.dependencies = [pin]; state.dependencies.dependencies = [{ designSystemId: 'test', version: '^1.0.0' }];
  return { state, version, pin };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(provider.getProjectDesignRuntimeVersion).mockReset(); });
afterEach(() => { cleanup(); resetWorkspaceAccountGeneration(); });

describe('DesignSystemOverview', () => {
  it('shows the exact token-only package separately from working components and pages, with real read-only version contents', async () => {
    const { state, version } = fixture();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockResolvedValue({ revision: state.revision, version });
    render(<DesignSystemOverview {...props} state={state} viewerOnly />);
    expect(await screen.findByRole('heading', { name: 'Preserved system' })).toBeVisible();
    expect(screen.getByTestId('design-overview-version-status')).toHaveTextContent('Locked · 1.0.2');
    expect(screen.getByTestId('design-overview-tokens')).toHaveTextContent('45');
    expect(screen.getByTestId('design-overview-sources')).toHaveTextContent('6');
    expect(screen.getByTestId('design-overview-components')).toHaveTextContent('0');
    expect(screen.getByTestId('design-overview-pages')).toHaveTextContent('0');
    expect(screen.queryByTestId('design-runtime-start-code')).toBeNull();
    expect(screen.queryByTestId('design-runtime-start-migration')).toBeNull();
    expect(screen.getByTestId('design-overview-next')).toHaveTextContent('Manage version');
    fireEvent.click(screen.getByTestId('design-overview-next'));
    expect(props.onNavigate).toHaveBeenCalledWith('versions');
    fireEvent.click(screen.getByTestId('design-overview-tokens'));
    expect(screen.getByText('Color 0')).toBeVisible();
    expect(screen.queryByText('components.html')).toBeNull();
    fireEvent.click(screen.getByTestId('design-overview-sources'));
    expect(screen.getByText('components.html')).toBeVisible();
    expect(screen.queryByText('Color 0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View version contents' }));
    const details = screen.getByTestId('design-overview-version-contents');
    expect(details).toBeVisible();
    fireEvent.click(within(details).getByText('Tokens (45)', { selector: 'summary' }));
    expect(within(details).getByText('Color 0')).toBeVisible();
    fireEvent.click(within(details).getByText('Frozen source files (6)', { selector: 'summary' }));
    expect(within(details).getByText('components.html')).toBeVisible();
    expect(screen.queryByText('PRIVATE_SOURCE_BYTES')).toBeNull();
    expect(provider.getProjectDesignRuntimeVersion).toHaveBeenCalledWith(expect.objectContaining({ ...scope, signal: expect.any(AbortSignal) }), 'test', '1.0.2');
  });

  it('retains foundations after clearing a lock and labels the exact editing baseline honestly', async () => {
    const { state, version, pin } = fixture();
    state.lock.dependencies = []; state.dependencies.dependencies = []; state.authoringBase = pin;
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockResolvedValue({ revision: state.revision, version });
    render(<DesignSystemOverview {...props} state={state} />);
    await screen.findByRole('heading', { name: 'Preserved system' });
    expect(screen.getByTestId('design-overview-version-status')).toHaveTextContent('Editing from 1.0.2');
    expect(screen.getByTestId('design-overview-version-status')).not.toHaveTextContent('Locked');
    expect(screen.getByTestId('design-overview-tokens')).toHaveTextContent('45');
    expect(screen.getByTestId('design-overview-next')).toHaveTextContent('Continue editing');
    fireEvent.click(screen.getByTestId('design-overview-next'));
    expect(props.onNavigate).toHaveBeenCalledWith('code');
  });

  it('keeps new projects simple and does not guess unpublished metadata for an editable registry', () => {
    const view = render(<DesignSystemOverview {...props} state={emptyDesignRuntimeState()} />);
    expect(screen.getByTestId('design-runtime-start-code')).toBeVisible();
    expect(screen.queryByTestId('design-overview-tokens')).toBeNull();
    const state = { ...emptyDesignRuntimeState(), registry: { schemaVersion: 1 as const, id: 'working', components: [] } };
    view.rerender(<DesignSystemOverview {...props} state={state} />);
    expect(screen.getByTestId('design-overview-version-status')).toHaveTextContent('Unpublished collection');
    expect(screen.getByTestId('design-overview-tokens')).toHaveTextContent('Not published');
    expect(screen.getByTestId('design-overview-sources')).toHaveTextContent('Not published');
    expect(provider.getProjectDesignRuntimeVersion).not.toHaveBeenCalled();
  });

  it.each(['revision', 'digest', 'source digest', 'package identity', 'missing'] as const)('does not turn %s failure or loading into a zero count, and allows explicit retry', async (failure) => {
    const { state, version } = fixture();
    const pending = deferred<ProjectDesignRuntimeVersionResponse>();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockReturnValueOnce(pending.promise).mockResolvedValue({ revision: state.revision, version });
    render(<DesignSystemOverview {...props} state={state} />);
    const tokens = screen.getByTestId('design-overview-tokens');
    expect(tokens).toBeDisabled(); expect(tokens).not.toHaveTextContent('45');
    expect(within(tokens).getByLabelText('Loading version contents…')).toHaveTextContent('—');
    const invalid = structuredClone({ revision: state.revision, version });
    if (failure === 'revision') invalid.revision += 1;
    if (failure === 'digest') invalid.version.digest = `sha256:${'c'.repeat(64)}`;
    if (failure === 'source digest') invalid.version.sourceDigest = `sha256:${'c'.repeat(64)}`;
    if (failure === 'package identity') invalid.version.package.id = 'different';
    await act(async () => { if (failure === 'missing') pending.reject(new Error('The exact design-system version is not in this project catalog.')); else pending.resolve(invalid); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Version contents could not be verified');
    expect(screen.queryByRole('heading', { name: 'Preserved system' })).toBeNull();
    expect(tokens).not.toHaveTextContent('45');
    expect(within(tokens).getByLabelText('Version contents could not be verified. Refresh to try again.')).toHaveTextContent('—');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('heading', { name: 'Preserved system' });
    expect(tokens).toHaveTextContent('45');
  });

  it.each(['project', 'workspace', 'permission', 'account'] as const)('cancels an old %s read and never renders its delayed package in the new authority', async (boundary) => {
    const { state, version } = fixture();
    const pending = deferred<ProjectDesignRuntimeVersionResponse>();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockReturnValueOnce(pending.promise).mockResolvedValue({ revision: state.revision, version: { ...version, package: { ...version.package, name: 'New authority package' } } });
    const view = render(<DesignSystemOverview {...props} state={state} />);
    const signal = vi.mocked(provider.getProjectDesignRuntimeVersion).mock.calls[0]![0].signal!;
    const next = { ...scope };
    if (boundary === 'project') next.projectId = 'project-b';
    if (boundary === 'workspace') next.workspaceContext = workspaceContextFixture({ workspaceId: 'workspace-b', workspaceMemberId: 'member-b' });
    if (boundary === 'permission') next.workspaceContext = { ...scope.workspaceContext, permissions: { ...scope.workspaceContext.permissions, canWriteSyncedFiles: false } };
    if (boundary === 'account') advanceWorkspaceAccountGeneration('signed-in-again');
    view.rerender(<DesignSystemOverview {...props} scope={next} state={state} />);
    expect(signal.aborted).toBe(true);
    await screen.findByRole('heading', { name: 'New authority package' });
    await act(async () => pending.resolve({ revision: state.revision, version }));
    expect(screen.queryByRole('heading', { name: 'Preserved system' })).toBeNull();
  });

  it('clears prior contents immediately when revision changes without reusing stale metadata', async () => {
    const { state, version } = fixture();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockResolvedValueOnce({ revision: state.revision, version });
    const view = render(<DesignSystemOverview {...props} state={state} />);
    await screen.findByRole('heading', { name: 'Preserved system' });
    fireEvent.click(screen.getByRole('button', { name: 'View version contents' }));
    expect(screen.getByTestId('design-overview-version-contents')).toBeVisible();
    const pending = deferred<ProjectDesignRuntimeVersionResponse>();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockReturnValueOnce(pending.promise);
    view.rerender(<DesignSystemOverview {...props} state={{ ...state, revision: state.revision + 1 }} />);
    expect(screen.getByTestId('design-overview-version-contents')).not.toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Preserved system' })).toBeNull();
    await act(async () => pending.resolve({ revision: state.revision, version }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('design-overview-tokens')).not.toHaveTextContent('45');
  });

  it('refreshes the owning project snapshot to recover from a version response at a newer revision', async () => {
    const { state, version } = fixture();
    const onRefresh = vi.fn();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockResolvedValue({ revision: state.revision + 1, version });
    const view = render(<DesignSystemOverview {...props} state={state} onRefresh={onRefresh} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(provider.getProjectDesignRuntimeVersion).toHaveBeenCalledOnce();
    view.rerender(<DesignSystemOverview {...props} state={{ ...state, revision: state.revision + 1 }} onRefresh={onRefresh} />);
    expect(await screen.findByRole('heading', { name: 'Preserved system' })).toBeVisible();
    expect(screen.getByTestId('design-overview-tokens')).toHaveTextContent('45');
  });

  it('hides an opened token section across a workspace boundary until the user selects the new verified contents', async () => {
    const { state, version } = fixture();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockResolvedValueOnce({ revision: state.revision, version });
    const view = render(<DesignSystemOverview {...props} state={state} />);
    await screen.findByRole('heading', { name: 'Preserved system' });
    fireEvent.click(screen.getByTestId('design-overview-tokens'));
    expect(screen.getByText('Color 0')).toBeVisible();
    const nextVersion = structuredClone(version); nextVersion.package.tokens.tokens[0]!.name = 'New workspace color';
    const pending = deferred<ProjectDesignRuntimeVersionResponse>();
    vi.mocked(provider.getProjectDesignRuntimeVersion).mockReturnValueOnce(pending.promise);
    view.rerender(<DesignSystemOverview {...props} state={state} scope={{ projectId: 'project-b', workspaceContext: null }} />);
    expect(screen.queryByText('Color 0')).toBeNull();
    await act(async () => pending.resolve({ revision: state.revision, version: nextVersion }));
    expect(screen.getByTestId('design-overview-version-contents')).not.toBeVisible();
    fireEvent.click(screen.getByTestId('design-overview-tokens'));
    expect(screen.getByText('New workspace color')).toBeVisible();
    expect(screen.queryByText('Color 0')).toBeNull();
  });

  it('does not summarize the first package as the total for an unsupported multiple-lock snapshot', async () => {
    const { state, pin } = fixture();
    state.lock.dependencies.push({ ...pin, designSystemId: 'other' });
    render(<DesignSystemOverview {...props} state={state} />);
    await screen.findByRole('alert');
    expect(provider.getProjectDesignRuntimeVersion).not.toHaveBeenCalled();
    expect(screen.getByTestId('design-overview-tokens')).not.toHaveTextContent('45');
    expect(screen.getByTestId('design-overview-version-status')).not.toHaveTextContent('1.0.2');
  });
});
