// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemVersionSchema, type DesignSystemVersion, type ProjectDesignRuntimeState, type ProjectDesignRuntimePublishVersionResponse } from '@open-design/contracts';
import { DesignSystemVersionsPanel } from '../../src/components/DesignSystemVersionsPanel';
import { initialVersionConstraints } from '../../src/components/DesignSystemVersionDetails';
import { DesignRuntimePanel } from '../../src/components/DesignRuntimePanel';
import * as provider from '../../src/providers/design-runtime';
import { designRuntimeState } from '../helpers/design-runtime-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';

vi.mock('../../src/providers/design-runtime', async () => ({
  ...await vi.importActual<typeof import('../../src/providers/design-runtime')>('../../src/providers/design-runtime'),
  getProjectDesignRuntime: vi.fn(), listProjectDesignRuntimeVersions: vi.fn(), getProjectDesignRuntimeVersion: vi.fn(),
  resolveProjectDesignRuntimeDependency: vi.fn(), publishProjectDesignRuntimeVersion: vi.fn(),
  activateProjectDesignRuntimeDependency: vi.fn(), clearProjectDesignRuntimeDependency: vi.fn(), importProjectDesignRuntimeVersion: vi.fn(),
}));
const scope = { projectId: 'project-a', workspaceContext: workspaceContextFixture({ workspaceId: 'workspace-a', workspaceMemberId: 'member-a' }) };
const files = [{ name: 'src/Button.tsx' }, { name: 'DESIGN.md' }];
const key = (version: string) => JSON.stringify(['test', version]);
function versionFixture(version = '1.0.0'): DesignSystemVersion {
  const state = designRuntimeState();
  return DesignSystemVersionSchema.parse({ schemaVersion: 1, digest: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}`, package: {
    schemaVersion: 1, id: 'test', name: 'Acme UI', version, registry: state.registry,
    codeIndex: { ...state.codeIndex, id: 'test' }, bindings: { ...state.bindings, id: 'test' },
    constraints: initialVersionConstraints(), tokens: { schemaVersion: 1, id: 'test', tokens: [] }, patterns: { schemaVersion: 1, id: 'test', patterns: [] }, codeCompatibility: [],
    source: { schemaVersion: 1, files: [{ path: 'src/Button.tsx', encoding: 'utf8', content: 'SECRET_SOURCE_BYTES_SHOULD_NOT_APPEAR_IN_LIST' }] },
  } });
}
const summary = (entry: DesignSystemVersion) => ({ id: entry.package.id, name: entry.package.name, version: entry.package.version, digest: entry.digest, sourceDigest: entry.sourceDigest });
function lockedState(version = versionFixture()): ProjectDesignRuntimeState {
  return { ...designRuntimeState(2), dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'test', version: '^1.0.0' }] },
    lock: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'test', version: version.package.version, digest: version.digest, source: { type: 'bundle', digest: version.sourceDigest } }] } };
}
function server(initial = designRuntimeState(), existing: DesignSystemVersion[] = []) {
  let state = structuredClone(initial);
  const versions = structuredClone(existing);
  vi.mocked(provider.getProjectDesignRuntime).mockImplementation(async () => ({ state: structuredClone(state) }));
  vi.mocked(provider.listProjectDesignRuntimeVersions).mockImplementation(async () => ({ revision: state.revision, versions: versions.map(summary) }));
  vi.mocked(provider.getProjectDesignRuntimeVersion).mockImplementation(async (_scope, id, version) => ({ revision: state.revision, version: structuredClone(versions.find((entry) => entry.package.id === id && entry.package.version === version)!) }));
  vi.mocked(provider.resolveProjectDesignRuntimeDependency).mockImplementation(async () => ({ revision: state.revision, resolution: { schemaVersion: 1, ok: true, diagnostics: [], versions: versions.filter((entry) => state.lock.dependencies.some((lock) => lock.version === entry.package.version)) } }));
  vi.mocked(provider.publishProjectDesignRuntimeVersion).mockImplementation(async (_scope, input) => {
    const value = versionFixture(input.version); value.package.name = input.name;
    const constraints = input.constraints ?? versions.find((entry) => state.lock.dependencies.some((lock) => lock.version === entry.package.version))?.package.constraints;
    if (!constraints) throw new Error('Initial publication requires constraints');
    value.package.constraints = constraints;
    versions.push(value); state = { ...state, revision: state.revision + 1 };
    return { state: structuredClone(state), version: summary(value) };
  });
  vi.mocked(provider.activateProjectDesignRuntimeDependency).mockImplementation(async (_scope, input) => {
    const selected = versions.find((entry) => entry.package.version === input.version)!;
    state = { ...state, revision: state.revision + 1, dependencies: { ...state.dependencies, dependencies: [{ designSystemId: input.designSystemId, version: input.range }] },
      lock: { ...state.lock, dependencies: [{ designSystemId: input.designSystemId, version: input.version, digest: selected.digest, source: { type: 'bundle', digest: selected.sourceDigest } }] } };
    return { state: structuredClone(state) };
  });
  vi.mocked(provider.clearProjectDesignRuntimeDependency).mockImplementation(async () => {
    state = { ...state, revision: state.revision + 1, dependencies: { ...state.dependencies, dependencies: [] }, lock: { ...state.lock, dependencies: [] } };
    return { state: structuredClone(state) };
  });
  return { get state() { return state; }, versions, replace(value: ProjectDesignRuntimeState) { state = value; } };
}
function Harness({ initial = designRuntimeState(), viewerOnly = false, accepted = vi.fn() }: { initial?: ProjectDesignRuntimeState | null; viewerOnly?: boolean; accepted?: (state: ProjectDesignRuntimeState) => void }) {
  const [state, setState] = useState(initial);
  return <DesignSystemVersionsPanel scope={scope} state={state} files={files} viewerOnly={viewerOnly} onState={(next) => { accepted(next); setState(next); }} />;
}
const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;
async function ready() { await waitFor(() => expect(input('versions-refresh').disabled).toBe(false)); }
function fillPublish(version = '1.0.0') {
  fireEvent.change(input('versions-name'), { target: { value: 'Acme UI' } });
  fireEvent.change(input('versions-version'), { target: { value: version } });
  if (!input('versions-source-src/Button.tsx').checked) fireEvent.click(input('versions-source-src/Button.tsx'));
}
beforeEach(() => vi.resetAllMocks());
afterEach(() => { cleanup(); resetWorkspaceAccountGeneration(); });

describe('DesignSystemVersionsPanel', () => {
  it('publishes selected source and policies, activates explicitly, and leaves the exact lock unchanged on another publication', async () => {
    const stored = server(); const accepted = vi.fn();
    render(<StrictMode><Harness accepted={accepted} /></StrictMode>); await ready();
    expect(input('versions-publish').disabled).toBe(true);
    fillPublish(); fireEvent.change(input('versions-policy-explore-rawColors'), { target: { value: 'off' } });
    fireEvent.click(input('versions-publish')); await ready();
    expect(provider.publishProjectDesignRuntimeVersion).toHaveBeenCalledOnce();
    expect(vi.mocked(provider.publishProjectDesignRuntimeVersion).mock.calls[0]).toEqual([expect.objectContaining(scope), expect.objectContaining({ expectedRevision: 1, name: 'Acme UI', version: '1.0.0', sourcePaths: ['src/Button.tsx'], constraints: expect.objectContaining({ explore: expect.objectContaining({ rawCss: expect.objectContaining({ colors: 'off' }) }) }) })]);
    expect(stored.state.lock.dependencies).toEqual([]); expect(provider.activateProjectDesignRuntimeDependency).not.toHaveBeenCalled();
    expect(screen.queryByText('SECRET_SOURCE_BYTES_SHOULD_NOT_APPEAR_IN_LIST')).toBeNull();
    fireEvent.click(input('versions-activate')); await ready();
    expect(vi.mocked(provider.activateProjectDesignRuntimeDependency).mock.calls[0]![1]).toEqual({ expectedRevision: 2, designSystemId: 'test', version: '1.0.0', range: '^1.0.0' });
    expect(within(screen.getByTestId('versions-lock')).getByText('test · 1.0.0')).toBeTruthy();
    fillPublish('1.1.0'); fireEvent.click(input('versions-publish')); await ready();
    expect(stored.state.lock.dependencies[0]!.version).toBe('1.0.0');
    expect((input('versions-select') as unknown as HTMLSelectElement).value).toBe(key('1.1.0'));
    expect(input('versions-activate').disabled).toBe(true); expect(provider.activateProjectDesignRuntimeDependency).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledTimes(3);
  });

  it('reopens the exact lock and uses its policies as the next publication baseline', async () => {
    const version = versionFixture(); version.package.constraints.guided.rawCss.colors = 'warning';
    const state = lockedState(version); const stored = server(state, [version, versionFixture('1.1.0')]);
    render(<Harness initial={state} />); await ready();
    expect(input('versions-policy-guided-rawColors').value).toBe('warning');
    fillPublish('1.2.0'); fireEvent.click(input('versions-publish')); await ready();
    expect(vi.mocked(provider.publishProjectDesignRuntimeVersion).mock.calls[0]![1].constraints).toBeUndefined();
    expect(stored.versions.find((entry) => entry.package.version === '1.2.0')!.package.constraints.guided.rawCss.colors).toBe('warning');
    fireEvent.change(input('versions-select'), { target: { value: key('1.1.0') } }); await ready();
    expect(input('versions-activate').disabled).toBe(true);
    expect(within(screen.getByTestId('versions-lock')).getByText('test · 1.0.0')).toBeTruthy();
    expect(provider.activateProjectDesignRuntimeDependency).not.toHaveBeenCalled();
  });

  it('inherits imported policy after activating from an initially unlocked panel', async () => {
    const version = versionFixture(); version.package.constraints.explore.rawCss.radius = 'error';
    const stored = server(designRuntimeState(), [version]); render(<Harness />); await ready();
    fireEvent.click(input('versions-activate')); await ready();
    expect(input('versions-policy-explore-rawRadius').value).toBe('error');
    fillPublish('1.1.0'); fireEvent.click(input('versions-publish')); await ready();
    expect(vi.mocked(provider.publishProjectDesignRuntimeVersion).mock.calls[0]![1].constraints).toBeUndefined();
    expect(stored.versions[1]!.package.constraints.explore.rawCss.radius).toBe('error');
  });

  it('preserves draft inputs through a CAS conflict and stages no retry without an explicit click', async () => {
    const stored = server(); render(<Harness />); await ready(); fillPublish('2.0.0');
    vi.mocked(provider.publishProjectDesignRuntimeVersion).mockRejectedValueOnce(new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Revision changed', details: { currentRevision: 7 } }));
    stored.replace(designRuntimeState(7)); fireEvent.click(input('versions-publish')); await ready();
    expect(screen.getByRole('alert').textContent).toContain('Revision changed');
    expect(input('versions-name').value).toBe('Acme UI'); expect(input('versions-version').value).toBe('2.0.0'); expect(input('versions-source-src/Button.tsx').checked).toBe(true);
    expect(provider.publishProjectDesignRuntimeVersion).toHaveBeenCalledOnce();
    fireEvent.click(input('versions-publish')); await ready();
    expect(vi.mocked(provider.publishProjectDesignRuntimeVersion).mock.calls[1]![1].expectedRevision).toBe(7);
  });

  it('keeps the Versions entry reachable after root state fails and explicitly clears using the diagnostic revision', async () => {
    const stored = server(lockedState(), [versionFixture()]);
    const fault = new provider.ProjectDesignRuntimeError(409, { code: 'DESIGN_RUNTIME_VERSION_INVALID', message: 'Locked bytes are missing' });
    vi.mocked(provider.getProjectDesignRuntime).mockRejectedValue(fault);
    vi.mocked(provider.listProjectDesignRuntimeVersions).mockRejectedValue(fault);
    vi.mocked(provider.resolveProjectDesignRuntimeDependency).mockResolvedValue({ revision: 9, resolution: { schemaVersion: 1, ok: false, versions: [], diagnostics: [{ schemaVersion: 1, code: 'ODDS5003', severity: 'error', message: 'Package unavailable' }] } });
    render(<DesignRuntimePanel projectId={scope.projectId} workspaceContext={scope.workspaceContext} files={files} viewerOnly={false} onClose={vi.fn()} />);
    await waitFor(() => expect(input('design-runtime-versions-tab').disabled).toBe(false));
    fireEvent.click(input('design-runtime-versions-tab')); await ready();
    expect(screen.getByText('ODDS5003')).toBeTruthy(); expect(input('versions-clear').disabled).toBe(false);
    expect(provider.clearProjectDesignRuntimeDependency).not.toHaveBeenCalled();
    const recovered = { ...stored.state, revision: 10, lock: { ...stored.state.lock, dependencies: [] }, dependencies: { ...stored.state.dependencies, dependencies: [] } };
    vi.mocked(provider.clearProjectDesignRuntimeDependency).mockResolvedValue({ state: recovered });
    vi.mocked(provider.getProjectDesignRuntime).mockResolvedValue({ state: recovered });
    vi.mocked(provider.listProjectDesignRuntimeVersions).mockResolvedValue({ revision: 10, versions: [] });
    vi.mocked(provider.resolveProjectDesignRuntimeDependency).mockResolvedValue({ revision: 10, resolution: { schemaVersion: 1, ok: true, versions: [], diagnostics: [] } });
    fireEvent.click(input('versions-clear')); await ready();
    expect(vi.mocked(provider.clearProjectDesignRuntimeDependency).mock.calls[0]![1]).toEqual({ expectedRevision: 9 });
    expect(screen.queryByText('ODDS5003')).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
  });

  it('allows read-only browsing and export while disabling every version mutation', async () => {
    const state = lockedState(); server(state, [versionFixture()]);
    render(<Harness initial={state} viewerOnly />); await ready();
    expect(input('versions-name').closest('fieldset')!.disabled).toBe(true);
    expect(input('versions-activate').disabled).toBe(true); expect(input('versions-clear').disabled).toBe(true); expect(input('versions-package-file').disabled).toBe(true);
    expect(input('versions-package-export').disabled).toBe(false);
    fireEvent.click(input('versions-clear')); fireEvent.click(input('versions-activate'));
    expect(provider.clearProjectDesignRuntimeDependency).not.toHaveBeenCalled(); expect(provider.activateProjectDesignRuntimeDependency).not.toHaveBeenCalled();
  });

  it('validates and previews imported packages before an explicit scoped import', async () => {
    const stored = server(); render(<Harness />); await ready();
    const upload = (value: unknown) => { const file = new File([''], 'package.json', { type: 'application/json' }); Object.defineProperty(file, 'text', { value: async () => JSON.stringify(value) }); fireEvent.change(input('versions-package-file'), { target: { files: [file] } }); };
    upload({ schemaVersion: 900 }); await ready();
    expect(screen.getByRole('alert').textContent).toContain('not a valid design system package'); expect(provider.importProjectDesignRuntimeVersion).not.toHaveBeenCalled();
    const imported = versionFixture('3.0.0'); imported.package.source.files.push({ path: 'assets/icon.bin', encoding: 'base64', content: 'AA==' });
    upload(imported.package); await ready();
    expect(screen.getByTestId('versions-import-preview').textContent).toContain('test@3.0.0'); expect(provider.importProjectDesignRuntimeVersion).not.toHaveBeenCalled();
    vi.mocked(provider.importProjectDesignRuntimeVersion).mockImplementation(async (_scope, request) => {
      stored.versions.push({ ...imported, package: request.package }); stored.replace({ ...stored.state, revision: stored.state.revision + 1 });
      return { state: structuredClone(stored.state), version: summary(imported) };
    });
    fireEvent.click(input('versions-package-import')); await ready();
    expect(vi.mocked(provider.importProjectDesignRuntimeVersion).mock.calls[0]).toEqual([expect.objectContaining(scope), { expectedRevision: 1, package: imported.package }]);
    expect(stored.state.lock.dependencies).toEqual([]); expect(provider.activateProjectDesignRuntimeDependency).not.toHaveBeenCalled();
  });

  it('exports the selected complete package, including frozen source, without displaying source contents', async () => {
    const version = versionFixture(); server(designRuntimeState(), [version]);
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const create = vi.fn((_blob: Blob) => 'blob:export-package'); const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      render(<Harness viewerOnly />); await ready(); fireEvent.click(input('versions-package-export'));
      expect(click).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:export-package');
      const blob = create.mock.calls[0]![0];
      const exported = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
      expect(JSON.parse(exported)).toEqual(version.package);
      expect(screen.queryByText('SECRET_SOURCE_BYTES_SHOULD_NOT_APPEAR_IN_LIST')).toBeNull();
    } finally {
      click.mockRestore();
      if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor); else Reflect.deleteProperty(URL, 'createObjectURL');
      if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor); else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('shows published states, provenance, code package identity, and explicit property mappings', async () => {
    const version = versionFixture();
    version.package.registry.components[0]!.states = ['hover', 'pressed'];
    version.package.registry.components[0]!.source = { kind: 'manual', sourcePath: 'metadata/Button.ts', exportName: 'ButtonPolicy', line: 42 };
    version.package.codeIndex.components[0]!.packageName = '@acme/production-ui';
    version.package.bindings.bindings[0]!.propMappings = [{ designProp: 'variant', codeProp: 'intent' }];
    server(designRuntimeState(), [version]); render(<Harness />); await ready();
    const contents = screen.getByTestId('versions-contents');
    expect(contents.textContent).toContain('hover, pressed'); expect(contents.textContent).toContain('metadata/Button.ts:42');
    expect(contents.textContent).toContain('ButtonPolicy'); expect(contents.textContent).toContain('@acme/production-ui'); expect(contents.textContent).toContain('variant → intent');
  });

  it.each(['project', 'workspace', 'account'] as const)('fences a late publication after a %s authority change', async (change) => {
    server(); const accepted = vi.fn(); let complete!: (value: ProjectDesignRuntimePublishVersionResponse) => void;
    vi.mocked(provider.publishProjectDesignRuntimeVersion).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const props = { scope, state: designRuntimeState(), files, viewerOnly: false, onState: accepted };
    const view = render(<DesignSystemVersionsPanel {...props} />); await ready(); fillPublish(); fireEvent.click(input('versions-publish'));
    const authority = vi.mocked(provider.publishProjectDesignRuntimeVersion).mock.calls[0]![0];
    let nextScope = scope;
    if (change === 'project') nextScope = { ...scope, projectId: 'project-b' };
    if (change === 'workspace') nextScope = { ...scope, workspaceContext: workspaceContextFixture({ workspaceId: 'workspace-b', workspaceMemberId: 'member-b' }) };
    if (change === 'account') advanceWorkspaceAccountGeneration('workspace-a');
    view.rerender(<DesignSystemVersionsPanel {...props} scope={nextScope} />); await ready();
    expect(authority.signal?.aborted).toBe(true);
    await act(async () => complete({ state: designRuntimeState(90), version: summary(versionFixture()) }));
    expect(accepted).not.toHaveBeenCalled(); expect(input('versions-name').value).toBe('test');
  });
});
