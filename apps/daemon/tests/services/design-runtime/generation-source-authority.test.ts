import { describe, expect, it } from 'vitest';
import { validateStructuredDesign } from '../../../src/services/design-runtime/design-validation.js';
import { validationFixture } from '../../fixtures/design-runtime/validation-benchmark.js';

describe('generation source inventory is independent of entry selection', () => {
  it.each([
    'export function Hidden(){return <button style={{color:"#123456"}}>Hidden</button>}',
    'const hidden = <button style={{color:"#123456"}}>Hidden</button>;',
    'export function Hidden(){if (window.hidden) return null;return <button style={{color:"#123456"}}>Hidden</button>}',
  ])('audits unselected JSX in an observed changed entry: %s', (extra) => {
    const request = validationFixture(); const entry = request.sources[0]!;
    entry.sourceText += `\n${extra}`;
    const result = validateStructuredDesign(request, { auditPaths: [entry.sourcePath] });
    expect(result).toMatchObject({ strictReady: false, metrics: { rawColors: 1, intrinsicControls: 1 } });
    expect(result.diagnostics.some((issue) => issue.code === 'ODDS2002')).toBe(true);
  });

  it('audits known styles in an imported helper with unsupported flow even when the helper was unchanged', () => {
    const request = validationFixture(); const entry = request.sources[0]!;
    entry.sourceText = 'import {Helper} from "./Helper"; export function Screen(){return <Helper/>;}';
    request.sources.push({ sourcePath: 'pages/Helper.tsx', language: 'tsx', sourceText: 'export function Helper(){if (window.hidden) return null;return <button style={{color:"#123456"}}>Hidden</button>}' });
    const result = validateStructuredDesign(request, { auditPaths: [entry.sourcePath] });
    expect(result).toMatchObject({ strictReady: false, metrics: { rawColors: 1, intrinsicControls: 1 } });
    expect(result.diagnostics.some((issue) => issue.code === 'ODDS2002')).toBe(true);
  });
});
