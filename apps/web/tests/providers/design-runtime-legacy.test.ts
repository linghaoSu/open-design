import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDesignRuntimeApplyLegacyMigrationRequest } from '@open-design/contracts';
import { applyProjectDesignRuntimeLegacyMigration, reviewProjectDesignRuntimeLegacyMigration, ProjectDesignRuntimeError } from '../../src/providers/design-runtime';
import { legacyMigrationFixture } from '../helpers/design-runtime-legacy-fixtures';
import { workspaceContextFixture } from '../helpers/workspace-context';

afterEach(() => vi.unstubAllGlobals());
describe('legacy migration provider', () => {
  it('preserves explicit source selections, review proofs, workspace headers and cancellation through review/apply', async () => {
    const fixture = legacyMigrationFixture();
    const scope = { projectId: 'project', workspaceContext: workspaceContextFixture({ workspaceId: 'team', workspaceMemberId: 'member' }), signal: new AbortController().signal };
    const request = { expectedRevision: 1, plan: fixture.plan };
    for (const entry of [
      { call: () => reviewProjectDesignRuntimeLegacyMigration(scope, request), suffix: '/review', body: request, response: { revision: 1, review: fixture.review } },
      { call: () => applyProjectDesignRuntimeLegacyMigration(scope, fixture.proof), suffix: '/apply', body: fixture.proof, response: fixture.applied },
    ]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(entry.response), { status: 200 })); vi.stubGlobal('fetch', fetchMock);
      await expect(entry.call()).resolves.toEqual(entry.response);
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      expect(url).toBe(`/api/projects/project/design-runtime/legacy-migration${entry.suffix}`);
      expect(init.method).toBe('POST'); expect(init.cache).toBe('no-store'); expect(init.signal).toBe(scope.signal);
      expect(JSON.parse(String(init.body))).toEqual(entry.body);
      expect(new Headers(init.headers).get('x-od-workspace-id')).toBe('team');
      expect(new Headers(init.headers).get('x-od-workspace-member-id')).toBe('member');
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    }
  });
  it('rejects incomplete or source-text-injected requests before HTTP', () => {
    const fixture = legacyMigrationFixture(); const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    expect(() => applyProjectDesignRuntimeLegacyMigration({ projectId: 'project', workspaceContext: null }, { expectedRevision: 1, plan: fixture.plan } as ProjectDesignRuntimeApplyLegacyMigrationRequest)).toThrow();
    expect(() => reviewProjectDesignRuntimeLegacyMigration({ projectId: 'project', workspaceContext: null }, { expectedRevision: 1, plan: { ...fixture.plan, sourceText: 'injected' } } as never)).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['project', 'version', 'proof', 'lock'] as const)('rejects a returned foreign %s instead of adopting it', async (mismatch) => {
    const fixture = legacyMigrationFixture(); const scope = { projectId: 'project', workspaceContext: null };
    if (mismatch === 'project') {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: 1, review: { ...fixture.review, projectId: 'other' } }))));
      await expect(reviewProjectDesignRuntimeLegacyMigration(scope, { expectedRevision: 1, plan: fixture.plan })).rejects.toThrow();
    } else {
      const response = structuredClone(fixture.applied);
      if (mismatch === 'version') response.version.version = '9.0.0';
      if (mismatch === 'proof') response.review.id = 'other-proof';
      if (mismatch === 'lock') response.state.lock.dependencies = [];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
      await expect(applyProjectDesignRuntimeLegacyMigration(scope, fixture.proof)).rejects.toThrow();
    }
  });
  it('retains stale-source conflict diagnostics without an automatic retry', async () => {
    const fixture = legacyMigrationFixture();
    const details = { diagnostics: [{ schemaVersion: 1, severity: 'error', code: 'ODDS9002', message: 'Source bytes changed.' }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'DESIGN_RUNTIME_LEGACY_MIGRATION_CONFLICT', message: 'Review again.', details } }), { status: 409 })); vi.stubGlobal('fetch', fetchMock);
    const result = await applyProjectDesignRuntimeLegacyMigration({ projectId: 'project', workspaceContext: null }, fixture.proof).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ProjectDesignRuntimeError); expect(result).toMatchObject({ status: 409, diagnostics: details.diagnostics }); expect(fetchMock).toHaveBeenCalledOnce();
  });
});
