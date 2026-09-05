import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProjectDesignRuntimeValidationSettings, saveProjectDesignRuntimeValidationSettings, validateProjectDesignRuntimeArtifacts, ProjectDesignRuntimeError } from '../../src/providers/design-runtime';
import { emptyDesignRuntimeState } from '../helpers/design-runtime-fixtures';
import { artifactValidationFixture, validationSettingsFixture } from '../helpers/design-validation-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

afterEach(() => vi.unstubAllGlobals());
describe('design validation provider authority', () => {
  it('uses canonical DTOs, exact workspace headers, no cache and cancellation for settings and evaluation', async () => {
    const scope = { projectId: 'project /#1', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }), signal: new AbortController().signal };
    const settings = validationSettingsFixture(); const response = { revision: 1, result: artifactValidationFixture() };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(settings))).mockResolvedValueOnce(new Response(JSON.stringify({ state: emptyDesignRuntimeState(2) }))).mockResolvedValueOnce(new Response(JSON.stringify(response)));
    vi.stubGlobal('fetch', fetch);
    expect(await getProjectDesignRuntimeValidationSettings(scope)).toEqual(settings);
    await saveProjectDesignRuntimeValidationSettings(scope, { expectedRevision: 1, settings: settings.settings });
    const input = { expectedRevision: 2, sources: [{ sourcePath: 'screen.html', language: 'html' as const }], outputs: [{ sourcePath: 'screen.html' }] };
    expect(await validateProjectDesignRuntimeArtifacts(scope, input)).toEqual(response);
    expect(fetch.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ['/api/projects/project%20%2F%231/design-runtime/validation/settings', 'GET'], ['/api/projects/project%20%2F%231/design-runtime/validation/settings', 'PUT'], ['/api/projects/project%20%2F%231/design-runtime/validation/artifacts', 'POST'],
    ]);
    for (const [, options] of fetch.mock.calls) { expect(options.signal).toBe(scope.signal); expect(options.cache).toBe('no-store'); expect(options.headers.get('x-od-workspace-id')).toBe('team'); expect(options.headers.get('x-od-workspace-member-id')).toBe('member'); }
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual(input);
  });
  it('rejects source injection before fetch and preserves structured conflict details', async () => {
    const scope = { projectId: 'project', workspaceContext: null };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const input = { expectedRevision: 1, sources: [{ sourcePath: 'screen.html', language: 'html' as const, sourceText: 'fake' }], outputs: [{ sourcePath: 'screen.html' }] };
    expect(() => validateProjectDesignRuntimeArtifacts(scope, input)).toThrow(); expect(fetch).not.toHaveBeenCalled();
    fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { code: 'DESIGN_RUNTIME_REVISION_CONFLICT', message: 'Changed', details: { currentRevision: 2, diagnostics: artifactValidationFixture().diagnostics } } }), { status: 409 })));
    await expect(getProjectDesignRuntimeValidationSettings(scope)).rejects.toMatchObject({ currentRevision: 2, diagnostics: artifactValidationFixture().diagnostics });
    await expect(getProjectDesignRuntimeValidationSettings(scope)).rejects.toBeInstanceOf(ProjectDesignRuntimeError);
  });
});
