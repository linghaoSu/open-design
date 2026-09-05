import type { DesignConstraintPolicy, DesignSystemPackage } from '@open-design/contracts';
import { compileComponentRegistry } from '../../../src/services/design-runtime/registry-compiler.js';

export function packageFixture(version = '1.0.0'): DesignSystemPackage {
  const sourceText = `export function Button({ variant = 'primary', label = 'Continue' }: { variant?: 'primary' | 'secondary'; label?: string }) { return null; }`;
  const compiled = compileComponentRegistry({ designSystemId: 'acme', selections: [{ sourcePath: 'src/Button.tsx', sourceText, exportName: 'Button', componentId: 'Button', codeComponentId: 'ui/Button', packageName: '@acme/ui' }] });
  const policy = (severity: 'warning' | 'error'): DesignConstraintPolicy => ({ unknownComponents: severity, unknownProps: severity, invalidVariants: severity, invalidSlots: severity, tokens: { undeclared: severity }, rawCss: { colors: severity, radius: severity, spacing: severity }, interactiveHtml: { customControlsWhenBoundComponentExists: severity } });
  return {
    schemaVersion: 1, id: 'acme', name: 'Acme UI', version,
    registry: { ...compiled.registry, components: [...compiled.registry.components, { schemaVersion: 1, id: 'Frame', name: 'Frame', props: {}, slots: { header: { accepts: ['text'], required: true, multiple: false }, body: { accepts: ['ds:acme/Button'], required: true, multiple: true } } }] },
    codeIndex: compiled.codeIndex,
    bindings: { schemaVersion: 1, id: 'acme', bindings: compiled.bindings },
    tokens: { schemaVersion: 1, id: 'acme', tokens: [{ schemaVersion: 1, id: 'color.primary', name: 'Primary', cssVariable: '--color-primary', type: 'color', value: '#0066ff' }, { schemaVersion: 1, id: 'spacing.card', name: 'Card spacing', cssVariable: '--spacing-card', type: 'spacing', value: 16, unit: 'px' }] },
    patterns: { schemaVersion: 1, id: 'acme', patterns: [{ schemaVersion: 1, id: 'ResourceList', name: 'Resource list', props: { title: { type: 'string', required: true, default: 'Resources' } }, template: { schemaVersion: 1, type: 'component', id: 'frame', ref: 'ds:acme/Frame', slots: { header: [{ schemaVersion: 1, type: 'text', id: 'title', text: '' }] } }, propMappings: [{ prop: 'title', nodeId: 'title', path: ['text'] }], slots: { actions: { accepts: ['ds:acme/Button'], required: true, multiple: true } }, slotMappings: [{ slot: 'actions', nodeId: 'frame', targetSlot: 'body' }] }] },
    constraints: { schemaVersion: 1, explore: policy('warning'), guided: policy('error'), strict: policy('error') },
    codeCompatibility: [{ framework: 'react', packageName: '@acme/ui', version: '^1.0.0' }],
    source: { schemaVersion: 1, files: [{ path: 'src/Button.tsx', encoding: 'utf8', content: sourceText }, { path: 'assets/pixel.bin', encoding: 'base64', content: 'AA==' }, { path: 'DESIGN.md', encoding: 'utf8', content: 'Use Acme controls.\n' }] },
  };
}
