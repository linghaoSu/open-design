import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectDesignPreviewResultSchema } from '@open-design/contracts';
import { createProjectPreviewService, type ProjectPreviewAuthority, type ProjectPreviewDeps } from '../../../src/services/design-runtime/project-preview.js';
import { previewFixture } from '../../fixtures/design-runtime/preview.js';
import { localHandoffFixture } from '../../fixtures/design-runtime/handoff.js';
import { upgradeFixture } from '../../fixtures/design-runtime/design-system-upgrade.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../../src/services/design-runtime/design-system-version.js';
import { reviewDesignSystemUpgrade } from '../../../src/services/design-runtime/design-system-upgrade.js';

function serviceFixture() {
  const fixture = previewFixture(); const { input } = fixture;
  const authority: ProjectPreviewAuthority = { readSource: async () => { throw new Error('Source is unavailable'); }, observeTargetPackages: async () => input.targetPackages, assertCurrent: async () => {} };
  const deps: ProjectPreviewDeps = {
    store: { readVersion: (_project, id, version) => input.versions.find((entry) => entry.package.id === id && entry.package.version === version) ?? null },
    readAtRevision: (_project, revision) => { if (revision !== input.state.revision) throw new Error('CAS conflict'); return structuredClone(input.state); },
    acquireAuthority: async () => authority,
  };
  return { ...fixture, deps, authority };
}

describe('daemon-owned read-only preview service', () => {
  it('returns canonical exact-revision evidence, deterministic bundles and no state mutations', async () => {
    const { input, request, deps } = serviceFixture(); const before = structuredClone(input);
    const service = createProjectPreviewService(deps); const result = await service.preview('project', request);
    expect(result.sides[0]!.screens[0]!.bundle).not.toBeNull();
    expect(ProjectDesignPreviewResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(await service.preview('project', request)).toEqual(result); expect(input).toEqual(before);
    expect(result.sides[0]!.sourceEvidence.every((entry) => entry.byteLength > 0)).toBe(true);
    await expect(service.preview('project', { ...request, expectedRevision: 0 })).rejects.toThrow('CAS conflict');
  });
  it('detects project edits during asynchronous work and refuses a stale response', async () => {
    const { input, request, deps, authority } = serviceFixture();
    authority.observeTargetPackages = async () => { input.state.revision++; return input.targetPackages; };
    await expect(createProjectPreviewService(deps).preview('project', request)).rejects.toThrow('CAS conflict');
  });
  it('uses one project byte cache for proof and imports, then detects source-only edits without a state revision', async () => {
    const { input, request, deps, authority } = serviceFixture(); const local = localHandoffFixture().snapshot;
    Object.assign(input.state, { projectComponents: local.projectComponents, projectCodeIndex: local.projectCodeIndex, bindings: local.bindings, document: local.document });
    const path = local.projectCodeIndex.components[0]!.sourcePath; const source = local.projectSources[0]!.sourceText; let reads = 0;
    authority.readSource = async (requested) => { if (requested !== path) throw new Error('missing'); reads++; return reads === 1 ? source : source.replace('article', 'aside'); };
    await expect(createProjectPreviewService(deps).preview('project', { ...request, kind: 'production-handoff' })).rejects.toThrow(/source changed/);
    expect(reads).toBe(2);
  });
  it('refuses a response when root/account/workspace authority changes without a design revision', async () => {
    const { request, deps, authority } = serviceFixture(); let changed = false;
    authority.assertCurrent = async () => { if (changed) throw new Error('Project authority conflict'); };
    authority.observeTargetPackages = async () => { changed = true; return []; };
    await expect(createProjectPreviewService(deps).preview('project', request)).rejects.toThrow('Project authority conflict');
  });
  it('observes both current and exact proposed production packages before proving an upgrade preview', async () => {
    const { input, request, deps, authority } = serviceFixture(); const { context, from, to, plan } = upgradeFixture();
    context.projectComponents.components = [];
    context.document!.screens = [{ schemaVersion: 1, type: 'screen', id: 'main', children: [{ schemaVersion: 1, type: 'component', id: 'button', ref: 'ds:acme/Button', props: { variant: 'primary' } }] }];
    const pkg = structuredClone(to.package); pkg.codeIndex.components[0]!.packageName = '@next/ui'; pkg.codeCompatibility = [{ framework: 'react', packageName: '@next/ui', version: '^1.0.0' }];
    const target = createDesignSystemVersion(pkg); plan.to = createProjectDesignSystemLock('project', [target]).dependencies[0]!;
    const review = reviewDesignSystemUpgrade(context, from, target, plan); expect(review.canApply).toBe(true);
    const { projectId: _projectId, projectSources: _projectSources, ...state } = context;
    input.state = { ...input.state, ...state, registry: from.package.registry }; input.versions = [from, target];
    const root = await mkdtemp(join(tmpdir(), 'od-preview-upgrade-'));
    try {
      for (const name of ['@acme/ui', '@next/ui']) {
        const directory = join(root, 'node_modules', name); await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.2.0', main: 'index.js' }));
        await writeFile(join(directory, 'index.js'), `export function Button(){return ${JSON.stringify(name)}}`);
      }
      authority.projectRoot = root;
      authority.observeTargetPackages = async (names) => { expect(names).toEqual(['@acme/ui', '@next/ui']); return names.map((name) => ({ name, installation: { status: 'observed', version: '1.2.0' } })); };
      const result = await createProjectPreviewService(deps).preview('project', { ...request, expectedRevision: context.revision, kind: 'production-handoff', comparison: { type: 'upgrade', proof: { reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, plan } } });
      expect(result.sides.map((side) => side.screens[0]!.bundle !== null)).toEqual([true, true]);
      expect(result.sides[1]!.screens[0]!.bundle!.javascript).toContain('@next/ui');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
