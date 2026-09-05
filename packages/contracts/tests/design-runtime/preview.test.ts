import { describe, expect, it } from 'vitest';
import { ProjectDesignPreviewRequestSchema, ProjectDesignPreviewResultSchema, type ProjectDesignPreviewResult } from '../../src/design-runtime/preview.js';

const digest = `sha256:${'a'.repeat(64)}`;
function result(): ProjectDesignPreviewResult {
  return { schemaVersion: 1, projectId: 'project', revision: 4,
    request: { expectedRevision: 4, id: 'preview', framework: 'react', kind: 'semantic-design', screenIds: ['main'] }, requestDigest: digest,
    impact: { source: 'none', affectedScreens: [], diagnostics: [] }, diagnostics: [], sides: [{ role: 'current', kind: 'semantic-design',
      lock: { schemaVersion: 1, id: 'project', dependencies: [] }, origins: [], sourceEvidence: [], sourceDigest: digest,
      runtimePackages: [{ name: 'react', version: '18.3.1', origin: 'tool-runtime' }], targetPackages: [], diagnostics: [],
      screens: [{ screenId: 'main', sourcePath: 'src/Main.tsx', exportName: 'Main', bundle: { javascript: '', css: '', digest }, diagnostics: [] }],
    }] };
}

describe('verified preview contracts', () => {
  it('round-trips bounded authoring selections while rejecting caller-owned authority or incomplete output identities', () => {
    const input = result(); expect(ProjectDesignPreviewResultSchema.parse(JSON.parse(JSON.stringify(input)))).toEqual(input);
    for (const extra of [{ projectRoot: '/private' }, { sourceText: 'code' }, { snapshot: {} }, { targetPackages: [] }]) expect(ProjectDesignPreviewRequestSchema.safeParse({ ...input.request, ...extra }).success).toBe(false);
    expect(ProjectDesignPreviewRequestSchema.safeParse({ ...input.request, screenIds: ['main', 'main'] }).success).toBe(false);
    expect(ProjectDesignPreviewRequestSchema.safeParse({ ...input.request, outputs: [] }).success).toBe(false);
    expect(ProjectDesignPreviewRequestSchema.safeParse({ ...input.request, outputs: [{ screenId: 'main', sourcePath: '../escape.tsx', exportName: 'Main' }] }).success).toBe(false);
  });
  it('rejects crossed snapshot/kind/screen identity and hidden missing-bundle errors', () => {
    const input = result();
    expect(ProjectDesignPreviewResultSchema.safeParse({ ...input, revision: 5 }).success).toBe(false);
    input.sides[0]!.kind = 'production-handoff'; expect(ProjectDesignPreviewResultSchema.safeParse(input).success).toBe(false); input.sides[0]!.kind = 'semantic-design';
    input.sides[0]!.screens[0]!.bundle = null; expect(ProjectDesignPreviewResultSchema.safeParse(input).success).toBe(false);
    input.sides[0]!.screens[0]!.diagnostics.push({ schemaVersion: 1, code: 'ODDS8002', severity: 'error', message: 'Unsupported source.' });
    expect(ProjectDesignPreviewResultSchema.safeParse(input).success).toBe(true);
    input.sides[0]!.screens[0]!.screenId = 'other'; expect(ProjectDesignPreviewResultSchema.safeParse(input).success).toBe(false);
  });
  it('retains affected-screen graph evidence separately from visual samples and rejects duplicate provenance', () => {
    const input = result(); input.request.comparison = { type: 'shared-draft', draftId: 'draft', expectedDefinitionRevision: 2 };
    input.sides.push({ ...structuredClone(input.sides[0]!), role: 'proposed' });
    input.impact = { source: 'shared-reference-graph', affectedScreens: [{ kind: 'screen', documentId: 'document', screenId: 'main' }, { kind: 'screen', documentId: 'document', screenId: 'unselected' }], diagnostics: [] };
    expect(ProjectDesignPreviewResultSchema.safeParse(input).success).toBe(true);
    input.impact.affectedScreens.push(input.impact.affectedScreens[0]!); expect(ProjectDesignPreviewResultSchema.safeParse(input).success).toBe(false); input.impact.affectedScreens.pop();
    const evidence = { sourcePath: 'src/Button.tsx', digest, byteLength: 20, origin: 'frozen-design-system' as const };
    input.sides[0]!.sourceEvidence = [evidence, evidence]; expect(ProjectDesignPreviewResultSchema.safeParse(input).success).toBe(false);
  });
});
