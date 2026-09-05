import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CodeComponentDefinitionSchema,
  ComponentBindingSchema,
  ComponentRegistrySchema,
  ValidationDiagnosticSchema,
} from '@open-design/contracts';
import { compileReactComponent } from '../../../src/services/design-runtime/react-compiler.js';
import { resolveComponentBinding } from '../../../src/services/design-runtime/binding-resolver.js';
import { validateComponentUsage } from '../../../src/services/design-runtime/component-validator.js';

describe('structured design runtime first milestone acceptance', () => {
  it('compiles, serializes, resolves, and validates the Button fixture without an LLM', () => {
    const compiled = compileReactComponent({
      sourceText: readFileSync(new URL('./fixtures/Button.tsx', import.meta.url), 'utf8'),
      sourcePath: 'fixture/Button.tsx',
      exportName: 'Button',
      componentId: 'Button',
      codeComponentId: 'fixture/Button',
      designSystemId: 'test',
    });
    // Consume parsed wire artifacts, as a future daemon persistence boundary will.
    const registry = ComponentRegistrySchema.parse(JSON.parse(JSON.stringify(compiled.registry)));
    const codeComponent = CodeComponentDefinitionSchema.parse(JSON.parse(JSON.stringify(compiled.codeComponent)));
    const binding = ComponentBindingSchema.parse(JSON.parse(JSON.stringify(compiled.binding)));
    expect(resolveComponentBinding(binding, registry, [codeComponent])).toEqual({
      ok: true, component: registry.components[0], codeComponent,
    });
    expect(validateComponentUsage(registry, {
      component: 'ds:test/Button', props: { variant: 'primary' },
    })).toEqual([]);
    const diagnostics = validateComponentUsage(registry, {
      component: 'ds:test/Button', props: { variant: 'filled' }, nodeId: 'save-button',
    });
    expect(diagnostics).toEqual([{
      schemaVersion: 1, code: 'ODDS1003', severity: 'error',
      componentRef: 'ds:test/Button', nodeId: 'save-button', path: ['props', 'variant'],
      message: expect.any(String), allowedValues: ['primary', 'secondary', 'danger'],
    }]);
    expect(diagnostics.map((diagnostic) => ValidationDiagnosticSchema.parse(JSON.parse(JSON.stringify(diagnostic)))))
      .toEqual(diagnostics);
  });
});
