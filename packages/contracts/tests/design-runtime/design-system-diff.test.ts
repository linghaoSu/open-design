import { describe, expect, it } from 'vitest';
import { DesignSystemDiffResultSchema, DesignSystemDiffValueSchema, DesignSystemSemanticChangeSchema, DesignSystemSemanticDiffSchema } from '../../src/design-runtime/design-system-diff.js';

const endpoint = { designSystemId: 'acme', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, source: { type: 'bundle', digest: `sha256:${'b'.repeat(64)}` } };
const change = { schemaVersion: 1, id: 'rename-button', entity: { kind: 'component', id: 'Button' }, path: ['name'], kind: 'renamed', breaking: false, reason: 'Display name changed.', before: { present: true, value: 'Button' }, after: { present: true, value: 'Action' } };
const diff = { schemaVersion: 1, from: endpoint, to: { ...endpoint, version: '1.0.1', digest: `sha256:${'c'.repeat(64)}` }, changes: [change], recommendedBump: 'patch' };

describe('semantic design-system diff contracts', () => {
  it.each([[DesignSystemSemanticChangeSchema, change], [DesignSystemSemanticDiffSchema, diff], [DesignSystemDiffResultSchema, { schemaVersion: 1, ok: true, diff, diagnostics: [] }]] as const)('round-trips exact snapshots and rejects missing or unsupported versions %#', (schema, value) => {
    expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    const { schemaVersion: _, ...unversioned } = value;
    expect(schema.safeParse(unversioned).success).toBe(false);
    expect(schema.safeParse({ ...value, schemaVersion: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...value, guessRenames: true }).success).toBe(false);
  });
  it('distinguishes missing from null and enforces change-kind presence', () => {
    for (const value of [{ present: false }, { present: true, value: null }]) expect(DesignSystemDiffValueSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(DesignSystemDiffValueSchema.safeParse({ present: true }).success).toBe(false);
    expect(DesignSystemSemanticChangeSchema.safeParse({ ...change, kind: 'added' }).success).toBe(false);
    expect(DesignSystemSemanticChangeSchema.safeParse({ ...change, kind: 'removed', after: { present: false } }).success).toBe(true);
    expect(DesignSystemSemanticChangeSchema.safeParse({ ...change, path: ['props', 'title'], breaking: true }).success).toBe(false);
  });
  it('rejects duplicate locations, mismatched identities, divergent exact versions and contradictory recommendations', () => {
    expect(DesignSystemSemanticDiffSchema.safeParse({ ...diff, changes: [change, { ...change, id: 'other-id' }] }).success).toBe(false);
    expect(DesignSystemSemanticDiffSchema.safeParse({ ...diff, to: { ...diff.to, designSystemId: 'other' } }).success).toBe(false);
    expect(DesignSystemSemanticDiffSchema.safeParse({ ...diff, to: { ...diff.to, version: endpoint.version } }).success).toBe(false);
    for (const recommendedBump of ['none', 'major']) expect(DesignSystemSemanticDiffSchema.safeParse({ ...diff, recommendedBump }).success).toBe(false);
    expect(DesignSystemSemanticDiffSchema.safeParse({ ...diff, changes: [{ ...change, kind: 'changed', breaking: true }] }).success).toBe(false);
  });
  it('never returns a partial diff with failure diagnostics', () => {
    const diagnostic = { schemaVersion: 1, code: 'ODDS5004', severity: 'error', message: 'Invalid digest.' };
    const failure = { schemaVersion: 1, ok: false, diff: null, diagnostics: [diagnostic] };
    expect(DesignSystemDiffResultSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
    expect(DesignSystemDiffResultSchema.safeParse({ ...failure, diff }).success).toBe(false);
    expect(DesignSystemDiffResultSchema.safeParse({ ...failure, diagnostics: [] }).success).toBe(false);
    expect(DesignSystemDiffResultSchema.safeParse({ schemaVersion: 1, ok: true, diff, diagnostics: [diagnostic] }).success).toBe(false);
  });
});
