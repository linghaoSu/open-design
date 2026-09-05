import type { DesignSystemMigrationPlan, DesignSystemUpgradeContext, DesignSystemVersion } from '@open-design/contracts';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../../src/services/design-runtime/design-system-version.js';
import { compileComponentRegistry } from '../../../src/services/design-runtime/registry-compiler.js';
import { packageFixture } from './design-system-version.js';

export function upgradeVersion(version = '1.0.0', variant = 'primary', extra = ''): DesignSystemVersion {
  const pkg = packageFixture(version);
  const file = pkg.source.files.find((entry) => entry.path === 'src/Button.tsx')!;
  file.content = `export function Button({ variant = '${variant}', label = 'Continue' }: { variant?: '${variant}' | 'secondary'; label?: string${extra} }) { return null; }`;
  const compiled = compileComponentRegistry({ designSystemId: pkg.id, selections: [{ sourcePath: file.path, sourceText: file.content, exportName: 'Button', componentId: 'Button', codeComponentId: 'ui/Button', packageName: '@acme/ui' }] });
  pkg.registry.components[0] = compiled.registry.components[0]!;
  pkg.codeIndex = compiled.codeIndex; pkg.bindings.bindings = compiled.bindings;
  return createDesignSystemVersion(pkg);
}
export function upgradeFixture() {
  const from = upgradeVersion(); const to = upgradeVersion('2.0.0', 'ghost');
  const props = () => ({ tone: { type: 'enum' as const, required: false, values: ['primary', 'secondary'], default: 'primary' } });
  const context: DesignSystemUpgradeContext = {
    projectId: 'project', revision: 8,
    dependencies: { schemaVersion: 1, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] },
    lock: createProjectDesignSystemLock('project', [from]),
    codeIndex: { ...structuredClone(from.package.codeIndex), id: 'project' }, bindings: { ...structuredClone(from.package.bindings), id: 'project' },
    sharedChanges: { schemaVersion: 1, id: 'project', drafts: [], history: [] },
    projectComponents: { schemaVersion: 1, id: 'project', components: [
      { schemaVersion: 1, id: 'LocalButton', name: 'Local Button', revision: 1, props: props(), template: { schemaVersion: 1, type: 'component', id: 'button-template', ref: 'ds:acme/Button' }, propMappings: [{ prop: 'tone', nodeId: 'button-template', path: ['props', 'variant'] }] },
      { schemaVersion: 1, id: 'Card', name: 'Card', revision: 3, props: props(), template: { schemaVersion: 1, type: 'instance', id: 'local-template', ref: 'local:LocalButton', overrides: [] }, propMappings: [{ prop: 'tone', nodeId: 'local-template', path: ['props', 'tone'] }] },
    ] },
    document: { schemaVersion: 1, id: 'design', screens: [
      { schemaVersion: 1, type: 'screen', id: 'Applications', children: [
        { schemaVersion: 1, type: 'instance', id: 'default-card', ref: 'local:Card', overrides: [] },
        { schemaVersion: 1, type: 'instance', id: 'custom-card', ref: 'local:Card', overrides: [{ schemaVersion: 1, path: ['props', 'tone'], value: 'primary' }] },
      ] },
      { schemaVersion: 1, type: 'screen', id: 'Dashboard', children: [{ schemaVersion: 1, type: 'instance', id: 'secondary-card', ref: 'local:Card', overrides: [{ schemaVersion: 1, path: ['props', 'tone'], value: 'secondary' }] }] },
    ] },
  };
  const plan: DesignSystemMigrationPlan = {
    schemaVersion: 1, id: 'to-v2', from: context.lock.dependencies[0]!, to: createProjectDesignSystemLock('project', [to]).dependencies[0]!, targetRange: '^2.0.0',
    rules: [{ id: 'variant-to-ghost', type: 'transform-prop', componentRef: 'ds:acme/Button', fromProp: 'variant', toProp: 'variant', valueMap: [{ from: 'primary', to: 'ghost' }] }],
    bindingDecisions: [{ type: 'use-target-package', bindingId: context.bindings.bindings[0]!.id, targetBindingId: to.package.bindings.bindings[0]!.id }],
  };
  return { context, from, to, plan };
}
