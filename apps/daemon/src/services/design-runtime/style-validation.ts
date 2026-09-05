import postcss from 'postcss';
import type { DesignTokenRegistry, ValidationDiagnostic } from '@open-design/contracts';

export interface StyleFinding { code: ValidationDiagnostic['code']; message: string; sourcePath: string; line: number; column: number }
export interface StyleAnalysis { findings: StyleFinding[]; imports: string[]; complete: boolean; unknownTokens: number; rawColors: number; rawSpacing: number; rawRadius: number }
const colorProperties = /^(?:color|.+-color|fill|stroke)$/;
const spacingProperties = /^(?:scroll-)?(?:margin|padding)(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?$|^(?:gap|row-gap|column-gap|top|right|bottom|left|inset(?:-(?:inline|block)(?:-(?:start|end))?)?)$/;
const radiusProperties = /^border-(?:(?:top|bottom)-(?:left|right)-|(?:start|end)-(?:start|end)-)?radius$/;
const keywords = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'currentcolor', 'transparent', 'none', 'auto']);
const basicColors = new Set(['black', 'silver', 'gray', 'white', 'maroon', 'red', 'purple', 'fuchsia', 'green', 'lime', 'olive', 'yellow', 'navy', 'blue', 'teal', 'aqua', 'orange', 'rebeccapurple']);

/** PostCSS owns declaration boundaries. Unhandled value grammar is evidence of incompleteness. */
export function analyzeDesignStyles(sourceText: string, sourcePath: string, tokens: DesignTokenRegistry, inline = false): StyleAnalysis {
  const result: StyleAnalysis = { findings: [], imports: [], complete: true, unknownTokens: 0, rawColors: 0, rawSpacing: 0, rawRadius: 0 };
  const variables = new Map(tokens.tokens.map((token) => [token.cssVariable, token]));
  const issue = (code: ValidationDiagnostic['code'], message: string, line = 1, column = 1) => result.findings.push({ code, message, sourcePath, line, column });
  try {
    const root = postcss.parse(inline ? `a{${sourceText}}` : sourceText, { from: sourcePath });
    root.walkAtRules((rule) => {
      if (rule.name.toLowerCase() === 'import') {
        const literal = rule.params.match(/^(?:["']([^"']+)["']|url\(\s*["']([^"']+)["']\s*\))$/);
        if (literal) result.imports.push(literal[1] ?? literal[2]!);
        else { result.complete = false; issue('ODDS6002', 'CSS imports require one literal local path without unsupported conditions.', rule.source?.start?.line, rule.source?.start?.column); }
      } else if (!['media', 'supports', 'layer', 'keyframes', 'font-face', 'container'].includes(rule.name.toLowerCase())) {
        result.complete = false; issue('ODDS6002', `CSS @${rule.name} is outside the analyzed grammar.`, rule.source?.start?.line, rule.source?.start?.column);
      }
    });
    root.walkDecls((declaration) => {
      const property = declaration.prop.toLowerCase(); const value = declaration.value.trim();
      const line = declaration.source?.start?.line ?? 1; const column = declaration.source?.start?.column ?? 1;
      if (property.includes('\\') || value.includes('\\')) { result.complete = false; issue('ODDS6002', 'Escaped CSS identifiers or values are outside the certified grammar.', line, column); }
      if (property.startsWith('--')) {
        // Application-defined custom properties cannot impersonate frozen token declarations.
        result.complete = false; issue('ODDS6002', `Application CSS variable definitions require explicit token publication: ${property}.`, line, column);
      }
      const kind = colorProperties.test(property) ? 'color' : spacingProperties.test(property) ? 'spacing' : radiusProperties.test(property) ? 'radius' : undefined;
      const references = [...value.matchAll(/var\(\s*(--[A-Za-z][A-Za-z0-9_-]*)\s*(?=[,)])/g)];
      for (const reference of references) {
        const token = variables.get(reference[1]!);
        if (!token) { result.unknownTokens++; issue('ODDS2001', `CSS variable ${reference[1]} is not declared in the token registry.`, line, column); }
        else if (kind && token.type !== kind) issue('ODDS2005', `Token ${token.id} has type ${token.type}, incompatible with ${property}.`, line, column);
      }
      const withoutVariables = value.replace(/var\(\s*--[A-Za-z][A-Za-z0-9_-]*\s*\)/g, '').trim();
      if (/var\s*\(/i.test(withoutVariables)) {
        result.complete = false; issue('ODDS6002', 'CSS variable fallbacks and computed variable names are not statically certified.', line, column);
      }
      if (['background', 'background-image', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-block', 'border-inline', 'border-block-start', 'border-block-end', 'border-inline-start', 'border-inline-end', 'outline', 'column-rule', 'box-shadow', 'text-shadow', 'border-image', 'all'].includes(property)) {
        // Shorthands may contain protected values even when they cannot be classified fully.
        result.complete = false; issue('ODDS6002', `Expand ${property} to supported explicit declarations before strict validation.`, line, column);
        if (/#(?:[\da-f]{3,8})\b|(?:rgb|hsl|oklch|oklab|lab|lch)\s*\(/i.test(withoutVariables) || withoutVariables.toLowerCase().split(/[^a-z]+/).some((word) => basicColors.has(word))) { result.rawColors++; issue('ODDS2002', `Raw color literal in ${property}.`, line, column); }
      }
      if (!kind || !withoutVariables || keywords.has(withoutVariables.toLowerCase())) return;
      if (kind === 'color') { result.rawColors++; issue('ODDS2002', `Raw color value in ${property}; use a declared token.`, line, column); }
      if (kind === 'spacing') { result.rawSpacing++; issue('ODDS2003', `Raw spacing value in ${property}; use a declared token.`, line, column); }
      if (kind === 'radius') { result.rawRadius++; issue('ODDS2004', `Raw radius value in ${property}; use a declared token.`, line, column); }
    });
  } catch (error) { result.complete = false; issue('ODDS6001', `CSS could not be parsed: ${error instanceof Error ? error.message : String(error)}`); }
  return result;
}
