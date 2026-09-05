import { describe, expect, it } from 'vitest';
import {
  ProjectDesignRuntimeRegisterLocalBindingRequestSchema, ProjectDesignRuntimeStateSchema,
  ProjectDesignRuntimeCreateHandoffRequestSchema, ProjectDesignRuntimeEmitHandoffRequestSchema,
  ProjectDesignRuntimeHandoffResponseSchema, ProjectDesignRuntimeEmitHandoffResponseSchema,
  defaultProjectDesignValidationSettings,
} from '../../src/api/design-runtime.js';

const code = { schemaVersion: 1, id: 'project/card', framework: 'react', name: 'Card', sourcePath: 'src/Card.tsx', exportName: 'Card', props: {} };
const binding = { schemaVersion: 1, id: 'local/card', componentRef: 'local:card', framework: 'react', status: 'bound', verified: true, definitionRevision: 2, codeComponentId: code.id };
const source = { framework: code.framework, sourcePath: code.sourcePath, exportName: code.exportName, codeComponentId: code.id };
const state = { schemaVersion: 1, revision: 1, validationSettings: defaultProjectDesignValidationSettings(), registry: null,
  codeIndex: { schemaVersion: 1, id: 'project', components: [] }, projectCodeIndex: { schemaVersion: 1, id: 'project', components: [code] },
  bindings: { schemaVersion: 1, id: 'project', bindings: [binding] },
  projectComponents: { schemaVersion: 1, id: 'project', components: [{ schemaVersion: 1, id: 'card', name: 'Card', revision: 2, props: {}, propMappings: [], template: { schemaVersion: 1, type: 'text', id: 'text', text: 'Card' } }] },
  document: { schemaVersion: 1, id: 'document', screens: [] }, sharedChanges: { schemaVersion: 1, id: 'project', drafts: [], history: [] },
  dependencies: { schemaVersion: 1, id: 'project', dependencies: [] }, lock: { schemaVersion: 1, id: 'project', dependencies: [] },
};

describe('public local code and handoff contracts', () => {
  it('permits local-only state while rejecting code ownership collisions and DS references without a design system', () => {
    expect(ProjectDesignRuntimeStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, projectCodeIndex: undefined }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, codeIndex: { ...state.codeIndex, components: [code] } }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, bindings: { ...state.bindings, bindings: [{ ...binding, componentRef: 'ds:acme/card', definitionRevision: undefined }] } }).success).toBe(false);
  });

  it('requires exact local source selection and revision without accepting caller source bytes', () => {
    const request = { expectedRevision: 1, source, binding };
    expect(ProjectDesignRuntimeRegisterLocalBindingRequestSchema.parse(request)).toEqual(request);
    expect(ProjectDesignRuntimeRegisterLocalBindingRequestSchema.safeParse({ ...request, source: { ...source, sourceText: 'injected' } }).success).toBe(false);
    expect(ProjectDesignRuntimeRegisterLocalBindingRequestSchema.safeParse({ ...request, source: { ...source, sourcePath: '../external' } }).success).toBe(false);
    expect(ProjectDesignRuntimeRegisterLocalBindingRequestSchema.safeParse({ ...request, binding: { ...binding, definitionRevision: undefined } }).success).toBe(false);
    expect(ProjectDesignRuntimeRegisterLocalBindingRequestSchema.safeParse({ ...request, source: { ...source, codeComponentId: 'different' } }).success).toBe(false);
  });

  it('accepts only output/history selections and never caller-owned ready flags or evidence', () => {
    const request = { expectedRevision: 1, id: 'handoff', framework: 'react', changeContextSelection: { fromVersion: { designSystemId: 'acme', version: '1.0.0' }, sharedChangeIds: ['change'] } };
    expect(ProjectDesignRuntimeCreateHandoffRequestSchema.parse(request)).toEqual(request);
    expect(ProjectDesignRuntimeEmitHandoffRequestSchema.parse({ ...request, outputs: [{ screenId: 'main', sourcePath: 'src/Main.tsx', exportName: 'Main' }] }).outputs).toHaveLength(1);
    for (const extra of [{ snapshot: {} }, { targetPackages: [] }, { projectSources: [] }, { ready: true }, { changeContext: { upgradeReview: {} } }]) expect(ProjectDesignRuntimeCreateHandoffRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    expect(ProjectDesignRuntimeCreateHandoffRequestSchema.safeParse({ ...request, changeContextSelection: { sharedChangeIds: ['change', 'change'] } }).success).toBe(false);
    expect(ProjectDesignRuntimeCreateHandoffRequestSchema.safeParse({ ...request, changeContextSelection: { fromVersion: { designSystemId: 'acme', version: 'latest' } } }).success).toBe(false);
  });

  it('keeps successful handoff responses attached to their exact project revision and emission readiness', () => {
    const { validationSettings: _settings, sharedChanges: _changes, revision: _revision, schemaVersion: _schemaVersion, codeIndex, ...snapshot } = state;
    const manifest = { schemaVersion: 1, id: 'handoff', projectId: 'project', projectRevision: 1, framework: 'react',
      snapshot: { ...snapshot, baseCodeIndex: codeIndex, versions: [], projectSources: [{ codeComponentId: code.id, sourceText: '' }], targetPackages: [] }, coverage: [], ready: true, diagnostics: [],
    };
    const result = { schemaVersion: 1, manifest, diagnostics: [] };
    expect(ProjectDesignRuntimeHandoffResponseSchema.safeParse({ revision: 1, result }).success).toBe(true);
    expect(ProjectDesignRuntimeHandoffResponseSchema.safeParse({ revision: 2, result }).success).toBe(false);
    const codeResult = { schemaVersion: 1, ok: true, files: [], diagnostics: [] };
    expect(ProjectDesignRuntimeEmitHandoffResponseSchema.safeParse({ revision: 1, handoff: result, code: codeResult }).success).toBe(true);
    expect(ProjectDesignRuntimeEmitHandoffResponseSchema.safeParse({ revision: 2, handoff: result, code: codeResult }).success).toBe(false);
    const error = { schemaVersion: 1, code: 'ODDS7001', severity: 'error', message: 'Not ready.' };
    const failed = { schemaVersion: 1, manifest: null, diagnostics: [error] };
    expect(ProjectDesignRuntimeEmitHandoffResponseSchema.safeParse({ revision: 1, handoff: failed, code: codeResult }).success).toBe(false);
  });
});
