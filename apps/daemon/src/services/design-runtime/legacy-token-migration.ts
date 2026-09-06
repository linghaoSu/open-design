import postcss, { type Declaration } from 'postcss';
import {
  DesignEntityIdSchema, DesignTokenRegistrySchema, DesignTokenSchema, SourcePathSchema,
  type DesignToken, type DesignTokenRegistry, type LegacyDesignTokenMigrationRecord, type ValidationDiagnostic,
} from '@open-design/contracts';

export interface LegacyDesignTokenMigrationResult {
  registry: DesignTokenRegistry;
  records: LegacyDesignTokenMigrationRecord[];
  diagnostics: ValidationDiagnostic[];
}
type UnresolvedReason = Extract<LegacyDesignTokenMigrationRecord, { status: 'unresolved' }>['reason'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const hex = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const number = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const dimension = new RegExp(`^(${number})(px|rem|em|%)$`, 'i');
const duration = new RegExp(`^(${number})(ms|s)$`, 'i');

/** Known legacy role names select scalar types; ambiguous dimensions remain reference material. */
function tokenType(name: string, value: string): DesignToken['type'] | null {
  if (/^--(?:brand-)?font-weight(?:-|$)/.test(name)) return 'font-weight';
  if (/^--(?:brand-)?font-(?:family(?:-|$)|display$|body$|mono$)/.test(name)) return 'font-family';
  if (/^--(?:brand-)?font-size(?:-|$)|^--text-/.test(name)) return 'font-size';
  if (/^--(?:brand-)?(?:border-)?radius(?:-|$)/.test(name)) return 'radius';
  if (/^--(?:brand-)?(?:space|spacing|size|padding|margin|gap)(?:-|$)|^--(?:section-y|container-gutter)-/.test(name)) return 'spacing';
  if (/^--(?:brand-)?(?:motion(?:-duration)?|duration)(?:-|$)/.test(name) && !name.includes('ease')) return 'duration';
  if (/^--(?:brand-)?color(?:-|$)|^--(?:bg|surface|fg|muted|meta|border|accent|success|warn|danger)(?:-|$)/.test(name) || hex.test(value)) return 'color';
  if (duration.test(value)) return 'duration';
  return null;
}

/** Quoted names remain one entry, including commas. Escapes/functions require a later value grammar. */
function fontFamilies(value: string): string[] | null {
  if (/[\\();{}]/.test(value)) return null;
  const families = postcss.list.comma(value).map((entry) => entry.trim());
  if (!families.length || families.some((entry) => !entry)) return null;
  const parsed: string[] = [];
  for (const entry of families) {
    const quoted = /^(?:"([^"\n]+)"|'([^'\n]+)')$/.exec(entry);
    if (quoted) { parsed.push(quoted[1] ?? quoted[2]!); continue; }
    if (!/^[A-Za-z_-][A-Za-z0-9_-]*(?:\s+[A-Za-z_-][A-Za-z0-9_-]*)*$/.test(entry) || /^(inherit|initial|unset|revert|revert-layer)$/i.test(entry)) return null;
    parsed.push(entry);
  }
  return parsed;
}

function scalarToken(type: DesignToken['type'], value: string): Record<string, unknown> | null {
  if (type === 'color') return hex.test(value) ? { type, value } : null;
  if (type === 'font-family') { const families = fontFamilies(value); return families ? { type, value: families } : null; }
  if (type === 'font-weight') {
    const weight = value === 'normal' ? 400 : value === 'bold' ? 700 : /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isInteger(weight) && weight >= 1 && weight <= 1000 ? { type, value: weight } : null;
  }
  if (type === 'duration') {
    const match = duration.exec(value);
    return match ? { type, value: Number(match[1]), unit: match[2]!.toLowerCase() } : null;
  }
  const match = dimension.exec(value);
  if (value === '0') return { type, value: 0, unit: 'px' };
  return match ? { type, value: Number(match[1]), unit: match[2]!.toLowerCase() } : null;
}

/**
 * Converts explicit top-level :root literals only, without evaluating CSS or reading imports.
 * Dark/conditional declarations stay unresolved alongside the independently proven base value.
 * The caller freezes the unchanged stylesheet; this registry never claims theme equivalence.
 */
export function migrateLegacyDesignTokens(input: { designSystemId: string; sourcePath: string; sourceText: string }): LegacyDesignTokenMigrationResult {
  const id = DesignEntityIdSchema.parse(input.designSystemId);
  const sourcePath = SourcePathSchema.parse(input.sourcePath);
  const records: LegacyDesignTokenMigrationRecord[] = [];
  const diagnostics: ValidationDiagnostic[] = [];
  const tokens: DesignToken[] = [];
  const diagnostic = (code: ValidationDiagnostic['code'], severity: ValidationDiagnostic['severity'], message: string, line = 1, column = 1) => diagnostics.push({ schemaVersion: 1, code, severity, message, location: { sourcePath, line, column } });
  const valueOf = (declaration: Declaration) => (declaration.raws.value?.raw ?? declaration.value).trim() + (declaration.important ? ' !important' : '');
  const evidence = (declaration: Declaration) => ({ cssVariable: declaration.prop, sourcePath, line: declaration.source?.start?.line ?? 1, sourceValue: valueOf(declaration) });
  const unresolved = (declaration: Declaration, reason: UnresolvedReason, message: string) => {
    records.push({ ...evidence(declaration), status: 'unresolved', reason });
    diagnostic('ODDS9002', 'warning', message, declaration.source?.start?.line, declaration.source?.start?.column);
  };
  try {
    const root = postcss.parse(input.sourceText, { from: sourcePath });
    root.walkAtRules((rule) => {
      if (rule.name.toLowerCase() === 'import') diagnostic('ODDS9002', 'warning', 'Imported CSS remains reference material; migration reads only the explicitly selected stylesheet.', rule.source?.start?.line, rule.source?.start?.column);
    });
    const base = new Map<string, Declaration[]>();
    root.walkDecls((declaration) => {
      if (!declaration.prop.startsWith('--')) return;
      const parent = declaration.parent;
      if (parent?.type !== 'rule' || parent.selector.trim() !== ':root' || parent.parent?.type !== 'root') {
        unresolved(declaration, 'unsupported-context', `${declaration.prop} is a theme, scoped or conditional declaration; its source is preserved without claiming a structured theme conversion.`);
        return;
      }
      const declarations = base.get(declaration.prop) ?? [];
      declarations.push(declaration); base.set(declaration.prop, declarations);
    });
    for (const [name, declarations] of [...base].sort(([left], [right]) => compare(left, right))) {
      if (new Set(declarations.map(valueOf)).size > 1) {
        for (const declaration of declarations) unresolved(declaration, 'conflicting-declarations', `${name} has conflicting base declarations; choose one explicit value before converting it.`);
        continue;
      }
      // Repeated identical base declarations describe one token; source bytes retain every occurrence.
      const declaration = declarations[0]!;
      if (!/^--[A-Za-z][A-Za-z0-9_-]*$/.test(name)) { unresolved(declaration, 'invalid-name', `${name} is outside the canonical token identity grammar.`); continue; }
      const value = valueOf(declaration);
      const type = tokenType(name, value);
      if (!type) { unresolved(declaration, 'unsupported-token', `${name} has no supported scalar token role; the declaration remains in the frozen stylesheet.`); continue; }
      const scalar = scalarToken(type, value);
      const converted = scalar && DesignTokenSchema.safeParse({ schemaVersion: 1, id: name.slice(2), name: name.slice(2), cssVariable: name, ...scalar,
        source: { kind: 'manual', sourcePath, line: declaration.source?.start?.line ?? 1 },
      });
      if (!converted || !converted.success) { unresolved(declaration, 'unsupported-value', `${name} requires a literal ${type} value supported by the structured token schema; expressions and aliases remain in the source.`); continue; }
      tokens.push(converted.data);
      records.push({ ...evidence(declaration), status: 'converted', token: converted.data });
    }
  } catch (error) {
    if (!(error instanceof postcss.CssSyntaxError)) throw error;
    diagnostic('ODDS9003', 'error', `The selected token stylesheet has invalid CSS: ${error.reason}`, error.line, error.column);
  }
  records.sort((left, right) => left.line - right.line || compare(left.cssVariable, right.cssVariable));
  return { registry: DesignTokenRegistrySchema.parse({ schemaVersion: 1, id, tokens }), records, diagnostics };
}
