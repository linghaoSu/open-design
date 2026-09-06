import { describe, expect, it } from 'vitest';
import { ComponentPreviewRequestSchema, ComponentPreviewResponseSchema, type ComponentPreviewResponse } from '../../src/design-runtime/component-preview.js';

const digest = `sha256:${'1'.repeat(64)}`;
const fixture = (): ComponentPreviewResponse => ({
  schemaVersion: 1, projectId: 'project', sourcePath: 'Card.tsx', requestedProps: {}, sourceDigest: digest,
  exports: ['default'], selectedExport: 'default', controls: [{ name: 'onClick', kind: 'function', required: true, provenance: 'usage', hasDefault: false }],
  mockProps: { onClick: null }, effectiveProps: { onClick: null }, callbacks: [{ path: ['onClick'], async: false }],
  bundle: { javascript: 'void 0;', css: '', digest }, evidence: [], runtimePackages: [], diagnostics: [],
});

describe('component playground contracts', () => {
  it('roundtrips preview-only JSON values and declarative callbacks without registry identities', () => {
    expect(ComponentPreviewResponseSchema.parse(JSON.parse(JSON.stringify(fixture())))).toEqual(fixture());
    expect(ComponentPreviewRequestSchema.parse({ sourcePath: 'src/Card.jsx', props: { object: { nested: [1, true, null] }, codeLookingString: 'alert(1)' } })).toMatchObject({ props: { codeLookingString: 'alert(1)' } });
    expect(ComponentPreviewRequestSchema.safeParse({ sourcePath: '../Card.jsx' }).success).toBe(false);
    expect(ComponentPreviewRequestSchema.safeParse({ sourcePath: 'Card.jsx', registry: {} }).success).toBe(false);
    expect(ComponentPreviewRequestSchema.safeParse({ sourcePath: 'Card.jsx', props: JSON.parse('{"__proto__":{}}') }).success).toBe(false);
  });

  it('rejects contradictory export, bundle, callback and default evidence', () => {
    const response = fixture();
    expect(ComponentPreviewResponseSchema.safeParse({ ...response, selectedExport: 'missing' }).success).toBe(false);
    expect(ComponentPreviewResponseSchema.safeParse({ ...response, requestedExport: 'Named' }).success).toBe(false);
    expect(ComponentPreviewResponseSchema.safeParse({ ...response, bundle: null }).success).toBe(false);
    expect(ComponentPreviewResponseSchema.safeParse({ ...response, callbacks: [{ path: ['missing'], async: false }] }).success).toBe(false);
    expect(ComponentPreviewResponseSchema.safeParse({ ...response, callbacks: [...response.callbacks, ...response.callbacks] }).success).toBe(false);
    expect(ComponentPreviewResponseSchema.safeParse({ ...response, controls: [{ ...response.controls[0], defaultValue: 'x' }] }).success).toBe(false);
    expect(ComponentPreviewResponseSchema.safeParse({ ...response, callbacks: [{ path: ['onClick'], async: false, source: '()=>alert(1)' }] }).success).toBe(false);
  });

  it('allows a diagnosed unavailable export and preserves own prototype-like JSON keys', () => {
    const response = fixture(); response.exports = []; response.selectedExport = null; response.bundle = null;
    response.diagnostics = [{ schemaVersion: 1, code: 'ODDS8002', severity: 'error', message: 'No renderable local export.' }];
    expect(ComponentPreviewResponseSchema.parse(response)).toEqual(response);
    expect(ComponentPreviewRequestSchema.parse({ sourcePath: 'Card.tsx', props: { ['constructor']: 'Own value', ['toString']: null } }).props).toEqual({ ['constructor']: 'Own value', ['toString']: null });
  });
});
