import { describe, expect, it } from 'vitest';
import {
  ProjectDesignRuntimeBindRequestSchema,
  ProjectDesignRuntimeCodeComponentsResponseSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeComponentsResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema,
  ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeSearchRequestSchema,
  ProjectDesignRuntimeStateSchema,
  ProjectDesignRuntimeValidateRequestSchema,
  ProjectDesignRuntimeValidateResponseSchema,
} from '../../src/api/design-runtime.js';

const selection = { sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'ui/Button' };
const compile = { expectedRevision: 0, designSystemId: 'test', selections: [selection] };
const component = { schemaVersion: 1, id: 'button', name: 'Button', props: {} };
const code = { schemaVersion: 1, id: 'ui/Button', framework: 'react', name: 'Button', exportName: 'Button', sourcePath: 'src/Button.tsx', props: {} };
const binding = { schemaVersion: 1, id: 'binding/button', componentRef: 'ds:test/button', framework: 'react', status: 'bound', verified: true, codeComponentId: 'ui/Button' };
const state = {
  schemaVersion: 1, revision: 1,
  registry: { schemaVersion: 1, id: 'test', components: [component] },
  codeIndex: { schemaVersion: 1, id: 'project', components: [code] },
  bindings: { schemaVersion: 1, id: 'project', bindings: [binding] },
};

describe('project design runtime API contracts', () => {
  it.each([
    { name: 'state', schema: ProjectDesignRuntimeStateSchema, value: state },
    { name: 'state response', schema: ProjectDesignRuntimeResponseSchema, value: { state } },
    { name: 'compile', schema: ProjectDesignRuntimeCompileRequestSchema, value: compile },
    { name: 'bind', schema: ProjectDesignRuntimeBindRequestSchema, value: { expectedRevision: 1, binding } },
    { name: 'revision mutation', schema: ProjectDesignRuntimeRevisionRequestSchema, value: { expectedRevision: 1 } },
    { name: 'search', schema: ProjectDesignRuntimeSearchRequestSchema, value: { query: 'button' } },
    { name: 'components', schema: ProjectDesignRuntimeComponentsResponseSchema, value: { revision: 1, components: [component] } },
    { name: 'code components', schema: ProjectDesignRuntimeCodeComponentsResponseSchema, value: { revision: 1, components: [code] } },
    { name: 'resolution', schema: ProjectDesignRuntimeResolveResponseSchema, value: { revision: 1, resolution: { ok: true, component, codeComponent: code } } },
    { name: 'failed resolution', schema: ProjectDesignRuntimeResolveResponseSchema, value: { revision: 1, resolution: { ok: false, diagnostics: [] } } },
    { name: 'validate', schema: ProjectDesignRuntimeValidateRequestSchema, value: { component: 'ds:test/button', props: { disabled: false }, nodeId: 'save' } },
    { name: 'diagnostics', schema: ProjectDesignRuntimeValidateResponseSchema, value: { revision: 1, diagnostics: [] } },
  ])('round-trips $name and rejects unknown fields', ({ schema, value }) => {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(schema.safeParse({ ...value, sourceText: 'unrequested source' }).success).toBe(false);
  });

  it('requires a current schema version, consistent project identity and an initialized registry', () => {
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, schemaVersion: 2 }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, bindings: { ...state.bindings, id: 'other' } }).success).toBe(false);
    expect(ProjectDesignRuntimeStateSchema.safeParse({ ...state, registry: null }).success).toBe(false);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s', (expectedRevision) => {
    expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, expectedRevision }).success).toBe(false);
  });

  it('rejects caller source text, path escapes and duplicate selections before file reads', () => {
    for (const sourcePath of ['/private/Button.tsx', '../Button.tsx', 'src/../Button.tsx']) {
      expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, selections: [{ ...selection, sourcePath }] }).success).toBe(false);
    }
    expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, selections: [{ ...selection, sourceText: 'code' }] }).success).toBe(false);
    expect(ProjectDesignRuntimeCompileRequestSchema.safeParse({ ...compile, selections: [selection, selection] }).success).toBe(false);
  });

  it('does not let bind promote an unbound or unverified request implicitly', () => {
    expect(ProjectDesignRuntimeBindRequestSchema.safeParse({ expectedRevision: 1, binding: { ...binding, status: 'candidate', verified: false } }).success).toBe(false);
    expect(ProjectDesignRuntimeBindRequestSchema.safeParse({ expectedRevision: 1, binding: { ...binding, verified: false } }).success).toBe(false);
  });
});
