import { describe, expect, it } from 'vitest';
import {
  DesignConstraintSetSchema, DesignPatternDefinitionSchema, DesignSystemPackageSchema,
  DesignSystemSemVerSchema, DesignSystemSourceBundleSchema, DesignSystemVersionCatalogSchema,
  DesignSystemVersionRangeSchema, DesignTokenRegistrySchema, ProjectDesignSystemDependenciesSchema,
  ProjectDesignSystemLockSchema,
} from '../../src/design-runtime/index.js';

const policy = { unknownComponents: 'error', unknownProps: 'error', invalidVariants: 'error', invalidSlots: 'error', tokens: { undeclared: 'error' }, rawCss: { colors: 'error', radius: 'error', spacing: 'error' }, interactiveHtml: { customControlsWhenBoundComponentExists: 'error' } };
const pattern = { schemaVersion: 1, id: 'ResourceList', name: 'Resources', props: { title: { type: 'string', required: true } }, template: { schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Frame', slots: { heading: [{ schemaVersion: 1, type: 'text', id: 'title', text: '' }] } }, propMappings: [{ prop: 'title', nodeId: 'title', path: ['text'] }], slots: { body: { accepts: ['text'], required: true, multiple: true } }, slotMappings: [{ slot: 'body', nodeId: 'frame', targetSlot: 'body' }] };
const pkg = {
  schemaVersion: 1, id: 'acme', name: 'Acme', version: '1.0.0',
  registry: { schemaVersion: 1, id: 'acme', components: [] },
  codeIndex: { schemaVersion: 1, id: 'acme', components: [] },
  bindings: { schemaVersion: 1, id: 'acme', bindings: [] },
  tokens: { schemaVersion: 1, id: 'acme', tokens: [{ schemaVersion: 1, id: 'color.primary', name: 'Primary', cssVariable: '--color-primary', type: 'color', value: '#0066ff' }] },
  patterns: { schemaVersion: 1, id: 'acme', patterns: [pattern] },
  constraints: { schemaVersion: 1, explore: policy, guided: policy, strict: policy },
  codeCompatibility: [], source: { schemaVersion: 1, files: [{ path: 'DESIGN.md', encoding: 'utf8', content: 'Rules\n' }] },
};
const digest = `sha256:${'a'.repeat(64)}`;
const version = { schemaVersion: 1, package: pkg, digest, sourceDigest: digest };

describe('immutable design-system package contracts', () => {
  it('round-trips the full content package without runtime/platform dependencies', () => {
    expect(DesignSystemPackageSchema.parse(JSON.parse(JSON.stringify(pkg)))).toEqual(pkg);
    expect(DesignSystemPackageSchema.safeParse({ ...pkg, mutableSourcePath: '/workspace' }).success).toBe(false);
    for (const key of ['registry', 'codeIndex', 'bindings', 'tokens', 'patterns'] as const) expect(DesignSystemPackageSchema.safeParse({ ...pkg, [key]: { ...pkg[key], id: 'other' } }).success).toBe(false);
  });

  it('requires exact SemVer identities and only explicit supported dependency ranges', () => {
    for (const value of ['0.0.0', '1.2.3', '1.2.3-alpha.1+build.01', '9007199254740993.0.0']) expect(DesignSystemSemVerSchema.parse(value)).toBe(value);
    for (const value of ['latest', 'v1.2.3', '^1.2.3', '1.2', '1.02.3', '1.2.3-01']) expect(DesignSystemSemVerSchema.safeParse(value).success).toBe(false);
    for (const value of ['1.2.3', '^1.2.3', '~1.2.3-beta.1']) expect(DesignSystemVersionRangeSchema.parse(value)).toBe(value);
    for (const value of ['latest', '*', '^1', '>=1.0.0', '1.0.0 || 2.0.0']) expect(DesignSystemVersionRangeSchema.safeParse(value).success).toBe(false);
  });

  it('rejects path escapes, case/Unicode aliases, ancestors and malformed byte encodings', () => {
    const file = { path: 'src/Button.tsx', encoding: 'utf8', content: 'source' };
    for (const path of ['../Button.tsx', '/Button.tsx', 'src//Button.tsx', 'src/./Button.tsx', 'src\\Button.tsx']) expect(DesignSystemSourceBundleSchema.safeParse({ schemaVersion: 1, files: [{ ...file, path }] }).success).toBe(false);
    for (const files of [[file, { ...file, path: 'SRC/button.tsx' }], [file, { ...file, path: 'SRC' }], [{ ...file, path: 'é.tsx' }, { ...file, path: 'e\u0301.tsx' }]]) expect(DesignSystemSourceBundleSchema.safeParse({ schemaVersion: 1, files }).success).toBe(false);
    expect(DesignSystemSourceBundleSchema.safeParse({ schemaVersion: 1, files: [{ path: 'binary', encoding: 'base64', content: 'AA=' }] }).success).toBe(false);
  });

  it('rejects mutable lock selectors, duplicate dependencies and duplicate published identities', () => {
    const locked = { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '1.0.0', digest, source: { type: 'bundle', digest } }] };
    expect(ProjectDesignSystemLockSchema.parse(locked)).toEqual(locked);
    expect(ProjectDesignSystemLockSchema.safeParse({ ...locked, dependencies: [{ ...locked.dependencies[0], version: '^1.0.0' }] }).success).toBe(false);
    expect(ProjectDesignSystemLockSchema.safeParse({ ...locked, dependencies: [{ ...locked.dependencies[0], source: { type: 'project', path: 'src' } }] }).success).toBe(false);
    const declared = { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] };
    expect(ProjectDesignSystemDependenciesSchema.safeParse({ ...declared, dependencies: [...declared.dependencies, ...declared.dependencies] }).success).toBe(false);
    expect(DesignSystemVersionCatalogSchema.safeParse({ schemaVersion: 1, id: 'catalog', versions: [version, version] }).success).toBe(false);
  });

  it('keeps token identity separate from labels and rejects duplicate variables or unsupported raw values', () => {
    expect(DesignTokenRegistrySchema.parse(pkg.tokens).tokens[0]!.id).toBe('color.primary');
    expect(DesignTokenRegistrySchema.safeParse({ ...pkg.tokens, tokens: [...pkg.tokens.tokens, { ...pkg.tokens.tokens[0], id: 'other' }] }).success).toBe(false);
    expect(DesignTokenRegistrySchema.safeParse({ ...pkg.tokens, tokens: [{ ...pkg.tokens.tokens[0], value: 'var(--unknown)' }] }).success).toBe(false);
  });

  it('requires concrete DS-only pattern targets and one-to-one configurable slots', () => {
    expect(DesignPatternDefinitionSchema.parse(pattern)).toEqual(pattern);
    expect(DesignPatternDefinitionSchema.safeParse({ ...pattern, template: { schemaVersion: 1, type: 'instance', id: 'local', ref: 'local:Card', overrides: [] } }).success).toBe(false);
    expect(DesignPatternDefinitionSchema.safeParse({ ...pattern, slotMappings: [...pattern.slotMappings, ...pattern.slotMappings] }).success).toBe(false);
    expect(DesignPatternDefinitionSchema.safeParse({ ...pattern, slotMappings: [] }).success).toBe(false);
    expect(DesignConstraintSetSchema.safeParse({ ...pkg.constraints, strict: { ...policy, unknownComponents: 'warning' } }).success).toBe(false);
  });
});
