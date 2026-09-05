import { describe, expect, it } from 'vitest';
import { ComponentDefinitionSchema, DesignReuseMetricSchema, ProjectDesignValidationSettingsSchema, StructuredDesignValidationResultSchema, ValidateStructuredDesignRequestSchema } from '../../src/design-runtime/index.js';

const policy = { unknownComponents: 'error', unknownProps: 'error', invalidVariants: 'error', invalidSlots: 'error', tokens: { undeclared: 'error' }, rawCss: { colors: 'error', spacing: 'error', radius: 'error' }, interactiveHtml: { customControlsWhenBoundComponentExists: 'error' } };
const constraints = { schemaVersion: 1, explore: policy, guided: policy, strict: policy };
const empty = { schemaVersion: 1, id: 'project' };
const request = { schemaVersion: 1, projectId: 'project', projectRevision: 1, settings: { schemaVersion: 1, mode: 'guided', projectConstraints: constraints },
  snapshot: { registry: null, projectComponents: { ...empty, components: [] }, baseCodeIndex: { ...empty, components: [] }, projectCodeIndex: { ...empty, components: [] }, bindings: { ...empty, bindings: [] }, tokens: { ...empty, tokens: [] }, dependencies: { ...empty, dependencies: [] }, lock: { ...empty, dependencies: [] }, versions: [], projectSources: [], targetPackages: [], document: null },
  sources: [{ sourcePath: 'page.html', language: 'html', sourceText: '<main />' }], outputs: [{ sourcePath: 'page.html' }],
};

describe('structural validation contracts', () => {
  it('round trips source-only Guided input without inventing a semantic document', () => {
    expect(ValidateStructuredDesignRequestSchema.parse(request)).toEqual(request);
    expect(ValidateStructuredDesignRequestSchema.safeParse({ ...request, ready: true }).success).toBe(false);
    expect(ValidateStructuredDesignRequestSchema.safeParse({ ...request, sources: [...request.sources, ...request.sources] }).success).toBe(false);
    expect(ValidateStructuredDesignRequestSchema.safeParse({ ...request, outputs: [...request.outputs, ...request.outputs] }).success).toBe(false);
    expect(ValidateStructuredDesignRequestSchema.safeParse({ ...request, projectId: 'different' }).success).toBe(false);
  });

  it('keeps authored control role distinct from a display name and requires supported semantics', () => {
    expect(ComponentDefinitionSchema.parse({ schemaVersion: 1, id: 'action', name: 'Unrelated name', props: {}, controlRole: 'button' }).controlRole).toBe('button');
    expect(ComponentDefinitionSchema.parse({ schemaVersion: 1, id: 'action', name: 'Button', props: {} }).controlRole).toBeUndefined();
    expect(ComponentDefinitionSchema.safeParse({ schemaVersion: 1, id: 'action', name: 'Button', props: {}, controlRole: 'guessed' }).success).toBe(false);
    expect(ProjectDesignValidationSettingsSchema.safeParse({ ...request.settings, mode: 'unknown' }).success).toBe(false);
    expect(ProjectDesignValidationSettingsSchema.safeParse({ ...request.settings, projectConstraints: { ...constraints, strict: { ...policy, unknownProps: 'warning' } } }).success).toBe(false);
  });

  it('does not report empty denominators as perfect reuse or certify incomplete source coverage', () => {
    expect(DesignReuseMetricSchema.parse({ reused: 0, total: 0, rate: null }).rate).toBeNull();
    expect(DesignReuseMetricSchema.safeParse({ reused: 0, total: 0, rate: 1 }).success).toBe(false);
    const ratio = { reused: 0, total: 0, rate: null };
    const result = { schemaVersion: 1, mode: 'guided', policySource: 'project', diagnostics: [], accepted: true, strictReady: false,
      coverage: { semantic: true, source: false, imports: true, styles: true, bindings: true, conformance: true },
      semanticReuse: ratio, metrics: { componentReuse: ratio, bindingReuse: ratio, unknownComponents: 0, unknownTokens: 0, rawColors: 0, rawSpacing: 0, rawRadius: 0, intrinsicControls: 0, duplicateControls: 0, duplicateStructures: 0, unsupported: 1, unresolvedImports: 0 },
    };
    expect(StructuredDesignValidationResultSchema.safeParse(result).success).toBe(true);
    expect(StructuredDesignValidationResultSchema.safeParse({ ...result, strictReady: true }).success).toBe(false);
    expect(StructuredDesignValidationResultSchema.safeParse({ ...result, mode: 'strict' }).success).toBe(false);
  });
});
