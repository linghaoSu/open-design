import { describe, expect, it } from 'vitest';
import { LegacyDesignTokenMigrationRecordSchema } from '@open-design/contracts';
import { migrateLegacyDesignTokens } from '../../../src/services/design-runtime/legacy-token-migration.js';
import { deriveTokens } from '../../../src/brands/engine/derive.js';
import { defaultSeed } from '../../../src/brands/engine/seed.js';
import { tokensToCssVars } from '../../../src/brands/engine/export.js';

const migrate = (sourceText: string) => migrateLegacyDesignTokens({ designSystemId: 'legacy', sourcePath: 'tokens.css', sourceText });

describe('legacy CSS token migration', () => {
  it('converts scalar base tokens with exact CSS identities and declaration provenance', () => {
    const input = `:root {
  --accent: #aBcD;
  --spacing-card: 1.5rem;
  --radius-md: 0;
  --text-lg: 18px;
  --font-weight-strong: bold;
  --font-body: "A, B", 'Open Sans', system-ui;
  --motion-fast: .2s;
}`;
    const result = migrate(input);
    expect(result.diagnostics).toEqual([]);
    expect(result.registry.tokens).toHaveLength(7);
    const byName = new Map(result.registry.tokens.map((token) => [token.cssVariable, token]));
    expect(byName.get('--accent')).toMatchObject({ id: 'accent', type: 'color', value: '#aBcD', source: { kind: 'manual', sourcePath: 'tokens.css', line: 2 } });
    expect(byName.get('--spacing-card')).toMatchObject({ type: 'spacing', value: 1.5, unit: 'rem' });
    expect(byName.get('--radius-md')).toMatchObject({ type: 'radius', value: 0, unit: 'px' });
    expect(byName.get('--font-body')).toMatchObject({ type: 'font-family', value: ['A, B', 'Open Sans', 'system-ui'] });
    expect(byName.get('--font-weight-strong')).toMatchObject({ type: 'font-weight', value: 700 });
    expect(byName.get('--motion-fast')).toMatchObject({ type: 'duration', value: 0.2, unit: 's' });
    expect(result.records.every((record) => LegacyDesignTokenMigrationRecordSchema.safeParse(record).success)).toBe(true);
    expect(migrate(input)).toEqual(result);
  });

  it('keeps aliases, expressions and unsupported token roles unresolved without manufacturing values', () => {
    const result = migrate(`:root {
      --accent: var(--other);
      --spacing-large: calc(2 * 8px);
      --radius-md: -4px;
      --font-body: var(--font);
      --tracking-display: -0.02em;
      --focus-ring: 0 0 0 3px #fff;
      --color-mixed: color-mix(in srgb, #fff, #000);
      --font-weight-strong: 1001;
      --container-max: 1120px;
    }`);
    expect(result.registry.tokens).toEqual([]);
    expect(result.records).toHaveLength(9);
    expect(result.records.every((record) => record.status === 'unresolved')).toBe(true);
    expect(result.diagnostics.every((diagnostic) => diagnostic.code === 'ODDS9002' && diagnostic.severity === 'warning')).toBe(true);
    expect(result.records.find((record) => record.cssVariable === '--tracking-display')).toMatchObject({ sourceValue: '-0.02em', reason: 'unsupported-token' });
  });

  it('converts the base value while explicitly preserving dark and conditional overrides', () => {
    const result = migrate(`:root { --bg: #fff; }
.dark { --bg: #000; }
@media (prefers-color-scheme: dark) { :root { --bg: #123; } }
.card { --spacing-card: 4px; }
@import "./other.css";`);
    expect(result.registry.tokens).toMatchObject([{ cssVariable: '--bg', value: '#fff' }]);
    expect(result.records.filter((record) => record.status === 'unresolved')).toMatchObject([
      { cssVariable: '--bg', sourceValue: '#000', reason: 'unsupported-context' },
      { cssVariable: '--bg', sourceValue: '#123', reason: 'unsupported-context' },
      { cssVariable: '--spacing-card', sourceValue: '4px', reason: 'unsupported-context' },
    ]);
    expect(result.diagnostics).toHaveLength(4);
  });

  it('rejects conflicting roots, rejects malformed CSS atomically, and deduplicates identical roots', () => {
    const result = migrate(':root { --accent: #fff; --accent: #000; --bg: #fff; } :root { --bg: #fff; }');
    expect(result.registry.tokens).toMatchObject([{ cssVariable: '--bg', value: '#fff' }]);
    expect(result.records.filter((record) => record.status === 'unresolved')).toHaveLength(2);
    const broken = migrate(':root { --accent: #fff; } :root { --bg: #000;');
    expect(broken.registry.tokens).toEqual([]);
    expect(broken.records).toEqual([]);
    expect(broken.diagnostics).toMatchObject([{ code: 'ODDS9003', severity: 'error', location: { sourcePath: 'tokens.css' } }]);
    expect(migrate('/* --fake: #fff */ .card { color: red; }').registry.tokens).toEqual([]);
  });

  it('preserves complete path/value grammar and prototype-like token identities', () => {
    const result = migrate(':root { --constructor: #fff; --toString: #abc; --brand-font-size: 16px; --bad\\2d name: #123; --spacing-x: 1e999px; }');
    expect(result.registry.tokens.map((token) => token.id)).toEqual(['brand-font-size', 'constructor', 'toString']);
    expect(result.records.filter((record) => record.status === 'unresolved')).toHaveLength(2);
    expect(() => migrateLegacyDesignTokens({ designSystemId: 'legacy', sourcePath: '../tokens.css', sourceText: '' })).toThrow();
  });

  it('migrates actual brand-engine base CSS while retaining its dark theme as unresolved evidence', () => {
    const light = deriveTokens(defaultSeed);
    const dark = deriveTokens(defaultSeed, 'dark');
    const sourceText = tokensToCssVars(light) + tokensToCssVars(dark, '.dark');
    const result = migrateLegacyDesignTokens({ designSystemId: 'brand', sourcePath: 'system/variables.css', sourceText });
    const byName = new Map(result.registry.tokens.map((token) => [token.cssVariable, token]));
    expect(byName.get('--brand-color-primary')).toMatchObject({ type: 'color', value: light.colorPrimary });
    expect(byName.get('--brand-font-size')).toMatchObject({ type: 'font-size', value: light.fontSize, unit: 'px' });
    expect(byName.get('--brand-border-radius')).toMatchObject({ type: 'radius', value: light.borderRadius, unit: 'px' });
    expect(byName.get('--brand-size')).toMatchObject({ type: 'spacing', value: light.size, unit: 'px' });
    expect(result.records.some((record) => record.cssVariable === '--brand-color-primary' && record.status === 'unresolved' && record.reason === 'unsupported-context')).toBe(true);
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
  });
});
