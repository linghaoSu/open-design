import { describe, expect, it } from 'vitest';
import {
  defaultProjectDesignValidationSettings,
  ProjectDesignRuntimeValidationSettingsRequestSchema,
  ProjectDesignRuntimeValidateArtifactsRequestSchema,
} from '../../src/api/design-runtime.js';

describe('public project artifact validation contracts', () => {
  it('accepts file/output selections and refuses injected source bytes or claimed authority', () => {
    const input = { expectedRevision: 4, sources: [{ sourcePath: 'Screen.tsx', language: 'tsx' }], outputs: [{ sourcePath: 'Screen.tsx', exportName: 'Screen', screenId: 'home' }] };
    expect(ProjectDesignRuntimeValidateArtifactsRequestSchema.parse(input)).toEqual(input);
    for (const extra of [{ snapshot: {} }, { mode: 'explore' }, { ready: true }, { targetPackages: [] }]) expect(ProjectDesignRuntimeValidateArtifactsRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(ProjectDesignRuntimeValidateArtifactsRequestSchema.safeParse({ ...input, sources: [{ ...input.sources[0], sourceText: 'claimed bytes' }] }).success).toBe(false);
    expect(ProjectDesignRuntimeValidateArtifactsRequestSchema.safeParse({ ...input, sources: [...input.sources, ...input.sources] }).success).toBe(false);
    expect(ProjectDesignRuntimeValidateArtifactsRequestSchema.safeParse({ ...input, outputs: [{ sourcePath: 'other.tsx' }] }).success).toBe(false);
  });

  it('returns independent Explore defaults and prevents weakening the Strict policy', () => {
    const settings = defaultProjectDesignValidationSettings();
    settings.projectConstraints.explore.rawCss.colors = 'off';
    expect(defaultProjectDesignValidationSettings().projectConstraints.explore.rawCss.colors).toBe('warning');
    expect(ProjectDesignRuntimeValidationSettingsRequestSchema.parse({ expectedRevision: 0, settings }).settings.mode).toBe('explore');
    settings.projectConstraints.strict.rawCss.colors = 'warning';
    expect(ProjectDesignRuntimeValidationSettingsRequestSchema.safeParse({ expectedRevision: 0, settings }).success).toBe(false);
  });
});
