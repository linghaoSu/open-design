import { describe, expect, it } from 'vitest';
import { prepareDesignPreview } from '../../../src/services/design-runtime/preview-preparation.js';
import { stageSharedComponentChange } from '../../../src/services/design-runtime/shared-component-changes.js';
import { reviewDesignSystemUpgrade } from '../../../src/services/design-runtime/design-system-upgrade.js';
import { previewFixture } from '../../fixtures/design-runtime/preview.js';
import { localHandoffFixture } from '../../fixtures/design-runtime/handoff.js';
import { upgradeFixture } from '../../fixtures/design-runtime/design-system-upgrade.js';

describe('read-only preview preparation', () => {
  it('labels semantic frozen-source rendering separately from unavailable production package proof', () => {
    const { input, request } = previewFixture(); input.targetPackages = [{ name: '@acme/ui', installation: { status: 'unknown' } }];
    const before = structuredClone(input);
    const semantic = prepareDesignPreview(input, request).sides[0]!;
    expect(semantic.files).toHaveLength(1); expect(semantic.handoff).toBeNull();
    expect(semantic.files[0]!.content).toContain('src/components/Panel'); expect(semantic.files[0]!.content).not.toContain('@acme/ui');
    const production = prepareDesignPreview(input, { ...request, kind: 'production-handoff' }).sides[0]!;
    expect(production.files).toEqual([]); expect(production.diagnostics.some((entry) => entry.severity === 'error')).toBe(true);
    expect(input).toEqual(before);
  });

  it('retains complete graph-selected impact when only one affected screen is selected, and stales proposed local production bindings', () => {
    const { input, request } = previewFixture(); const local = localHandoffFixture().snapshot;
    Object.assign(input.state, { projectComponents: local.projectComponents, projectCodeIndex: local.projectCodeIndex, bindings: local.bindings, document: local.document });
    input.projectSources = local.projectSources;
    const children = input.state.document!.screens[0]!.children;
    input.state.document!.screens.push({ schemaVersion: 1, type: 'screen', id: 'other', children: [children.pop()!] });
    const definition = structuredClone(local.projectComponents.components[0]!); definition.revision++; definition.props.tone!.default = 'secondary';
    const staged = stageSharedComponentChange(input.state, input.state.sharedChanges, { draftId: 'change', expectedDefinitionRevision: 2, definition });
    input.state.sharedChanges = staged.changes;
    const selected = { ...request, comparison: { type: 'shared-draft' as const, draftId: 'change', expectedDefinitionRevision: 2 } };
    const before = structuredClone(input); const semantic = prepareDesignPreview(input, selected);
    expect(semantic.impact.affectedScreens.map((entry) => entry.screenId)).toEqual(['main', 'other']);
    expect(semantic.sides.map((side) => side.files.length)).toEqual([1, 1]);
    expect(semantic.sides[0]!.files[0]!.content).toContain('primary'); expect(semantic.sides[1]!.files[0]!.content).toContain('secondary');
    expect(semantic.sides[1]!.origins.some((origin) => origin.instancePath.some((frame) => frame.definitionRevision === 3))).toBe(true);
    const production = prepareDesignPreview(input, { ...selected, kind: 'production-handoff' });
    expect(production.sides[0]!.files).toHaveLength(1); expect(production.sides[1]!.files).toEqual([]);
    expect(production.sides[1]!.diagnostics.some((entry) => entry.severity === 'error')).toBe(true);
    expect(input).toEqual(before);
    expect(() => prepareDesignPreview(input, { ...selected, comparison: { ...selected.comparison, expectedDefinitionRevision: 3 } })).toThrow(/revision changed/);
  });

  it('recomputes exact reviewed upgrade snapshots without applying, and refuses edited proof', () => {
    const { input, request } = previewFixture(); const { context, from, to, plan } = upgradeFixture();
    const { projectId: _projectId, projectSources, ...state } = context;
    input.state = { ...input.state, ...state, registry: from.package.registry }; input.versions = [from]; input.targetVersion = to; input.projectSources = projectSources;
    const review = reviewDesignSystemUpgrade(context, from, to, plan);
    const selection = { ...request, expectedRevision: context.revision, screenIds: ['Applications'], comparison: { type: 'upgrade' as const, proof: { reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, plan } } };
    const before = structuredClone(input); const result = prepareDesignPreview(input, selection);
    expect(result.sides.map((side) => side.files.length)).toEqual([1, 1]);
    expect(result.sides.map((side) => side.snapshot.lock.dependencies[0]!.version)).toEqual(['1.0.0', '2.0.0']);
    expect(result.impact.affectedScreens).toHaveLength(2); expect(input).toEqual(before);
    expect(() => prepareDesignPreview(input, { ...selection, comparison: { ...selection.comparison, proof: { ...selection.comparison.proof, reviewId: 'other' } } })).toThrow(/changed after review/);
    plan.rules = [];
    const invalid = reviewDesignSystemUpgrade(context, from, to, plan); expect(invalid.canApply).toBe(false);
    const rejected = prepareDesignPreview(input, { ...selection, comparison: { type: 'upgrade', proof: { reviewId: invalid.id, baseDigest: invalid.baseDigest, planDigest: invalid.planDigest, plan } } });
    expect(rejected.sides[0]!.files).toHaveLength(1); expect(rejected.sides[1]!.files).toEqual([]);
    expect(rejected.sides[1]!.diagnostics.some((entry) => entry.severity === 'error')).toBe(true);
  });
});
