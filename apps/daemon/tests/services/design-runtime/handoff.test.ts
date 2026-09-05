import { describe, expect, it } from 'vitest';
import { HandoffManifestSchema, type CreateHandoffRequest } from '@open-design/contracts';
import { handoffFixture } from '../../fixtures/design-runtime/handoff.js';
import { createHandoff } from '../../../src/services/design-runtime/handoff.js';
import { registerLocalComponentBinding } from '../../../src/services/design-runtime/local-component-binding.js';
import { createDesignSystemVersion, createProjectDesignSystemLock } from '../../../src/services/design-runtime/design-system-version.js';

function withLocal(input: CreateHandoffRequest): CreateHandoffRequest {
  input.snapshot.projectComponents.components = [{ schemaVersion: 1, id: 'card', name: 'Existing card', revision: 2,
    props: { label: { type: 'string', required: true, default: 'Shared' } }, template: { schemaVersion: 1, id: 'label', type: 'text', text: '' }, propMappings: [{ prop: 'label', nodeId: 'label', path: ['text'] }],
  }];
  input.snapshot.document.screens[0]!.children = [{ schemaVersion: 1, id: 'card-use', type: 'instance', ref: 'local:card', overrides: [] }];
  return input;
}

describe('portable engineering handoff', () => {
  it.each(['@acme/ui', 'ui'])('observes %s subpath imports through the npm root and intersects exact/root compatibility', (root) => {
    const input = handoffFixture(); const specifier = `${root}/panel`;
    const pkg = structuredClone(input.snapshot.versions[0]!.package);
    pkg.codeIndex.components[0]!.packageName = specifier;
    pkg.codeCompatibility = [{ framework: 'react', packageName: root, version: '^1.0.0' }, { framework: 'react', packageName: specifier, version: '~1.1.0' }];
    const version = createDesignSystemVersion(pkg);
    input.snapshot.baseCodeIndex = pkg.codeIndex; input.snapshot.versions = [version]; input.snapshot.lock = createProjectDesignSystemLock(input.projectId, [version]);
    input.snapshot.targetPackages = [{ name: root, installation: { status: 'observed', version: '1.1.2' } }];
    expect(createHandoff(input).manifest?.ready).toBe(true);
    expect(input.snapshot.versions[0]!.package.codeIndex.components[0]!.packageName).toBe(specifier);
    input.snapshot.targetPackages[0]!.installation = { status: 'observed', version: '1.2.0' };
    expect(createHandoff(input)).toMatchObject({ manifest: { ready: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS7002', message: expect.stringContaining(`${specifier} compatibility ~1.1.0`) })]) });
    pkg.codeCompatibility[1]!.version = '2.0.0'; const changed = createDesignSystemVersion(pkg);
    input.snapshot.versions = [changed]; input.snapshot.lock = createProjectDesignSystemLock(input.projectId, [changed]);
    input.snapshot.targetPackages[0]!.installation = { status: 'observed', version: '2.0.0' };
    expect(createHandoff(input)).toMatchObject({ manifest: { ready: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS7002', message: expect.stringContaining(`${root} compatibility ^1.0.0`) })]) });
    input.snapshot.targetPackages[0]!.name = specifier;
    expect(createHandoff(input).diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS7003' }));
  });
  it.each(['react', 'vue'] as const)('verifies exact %s lock/source, full UI IR and package observations deterministically', (framework) => {
    const input = handoffFixture(framework); const before = structuredClone(input);
    const result = createHandoff(input);
    expect(result).toMatchObject({ manifest: { schemaVersion: 1, ready: true, framework, coverage: [{ componentRef: 'ds:acme/panel', ready: true }] }, diagnostics: [] });
    expect(HandoffManifestSchema.parse(JSON.parse(JSON.stringify(result.manifest)))).toEqual(result.manifest);
    expect(createHandoff(input)).toEqual(result);
    expect(input).toEqual(before);
  });

  it('retains actionable local implementation work, then reuses an explicitly registered local production binding', () => {
    const input = withLocal(handoffFixture());
    expect(createHandoff(input)).toMatchObject({ manifest: { ready: false, coverage: [{ componentRef: 'local:card', binding: null, ready: false }] }, diagnostics: [expect.objectContaining({ code: 'ODDS3004' })] });
    const source = { framework: 'react' as const, sourceText: "export function ExistingCard({label='Code default'}:{label?:string}) {return <article>{label}</article>;}", sourcePath: 'src/components/ExistingCard.tsx', exportName: 'ExistingCard', codeComponentId: 'project/card' };
    const registered = registerLocalComponentBinding(input.snapshot, { source, binding: { schemaVersion: 1, id: 'local/card', componentRef: 'local:card', framework: 'react', codeComponentId: source.codeComponentId, definitionRevision: 2, status: 'bound', verified: true } });
    if (!registered.ok) throw new Error(registered.diagnostics[0]?.message);
    input.snapshot.projectCodeIndex = registered.projectCodeIndex; input.snapshot.bindings = registered.bindings;
    input.snapshot.projectSources = [{ codeComponentId: source.codeComponentId, sourceText: source.sourceText }];
    const result = createHandoff(input);
    expect(result).toMatchObject({ manifest: { ready: true, coverage: [{ componentRef: 'local:card', binding: { definitionRevision: 2 }, ready: true }] } });
    input.snapshot.projectSources = [];
    expect(createHandoff(input)).toMatchObject({ manifest: { ready: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS7004' })]) });
    input.snapshot.projectSources = [{ codeComponentId: source.codeComponentId, sourceText: source.sourceText.replace('label?:string', 'label?:number') }];
    expect(createHandoff(input).manifest?.ready).toBe(false);
  });

  it.each(['missing', 'unknown', 'mismatch'] as const)('diagnoses %s installed package evidence without treating declared ranges as installation', (state) => {
    const input = handoffFixture();
    if (state === 'missing') input.snapshot.targetPackages = [];
    else input.snapshot.targetPackages[0]!.installation = state === 'unknown' ? { status: 'unknown' } : { status: 'observed', version: '2.0.0' };
    const result = createHandoff(input);
    expect(result.manifest?.ready).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: state === 'mismatch' ? 'ODDS7002' : 'ODDS7003', severity: 'error' }));
  });

  it('does not invent compatibility when an exact installed package has no declared compatibility range', () => {
    const input = withLocal(handoffFixture());
    const source = { framework: 'react' as const, sourceText: 'export function Card({label}:{label:string}){return null;}', sourcePath: 'src/Card.tsx', exportName: 'Card', codeComponentId: 'project/card', packageName: '@project/components' };
    const result = registerLocalComponentBinding(input.snapshot, { source, binding: { schemaVersion: 1, id: 'local/card', componentRef: 'local:card', framework: 'react', codeComponentId: source.codeComponentId, definitionRevision: 2, status: 'bound', verified: true } }); if (!result.ok) throw new Error('fixture');
    input.snapshot.projectCodeIndex = result.projectCodeIndex; input.snapshot.bindings = result.bindings; input.snapshot.projectSources = [{ codeComponentId: source.codeComponentId, sourceText: source.sourceText }];
    input.snapshot.targetPackages.push({ name: '@project/components', installation: { status: 'observed', version: '1.0.0' } });
    expect(createHandoff(input)).toMatchObject({ manifest: { ready: true }, diagnostics: [expect.objectContaining({ code: 'ODDS7002', severity: 'warning' })] });
  });

  it.each(['missing-version', 'tampered-source', 'different-registry', 'unlocked', 'extra-version', 'stale-binding'] as const)('blocks %s authority or binding without silently selecting a different version', (change) => {
    const input = handoffFixture();
    if (change === 'missing-version') input.snapshot.versions = [];
    if (change === 'tampered-source') input.snapshot.versions[0]!.package.source.files[0]!.content += 'changed';
    if (change === 'different-registry') input.snapshot.registry!.components[0]!.name = 'Mutated';
    if (change === 'unlocked') { input.snapshot.lock.dependencies = []; input.snapshot.dependencies.dependencies = []; input.snapshot.versions = []; }
    if (change === 'extra-version') input.snapshot.versions.push({ ...input.snapshot.versions[0]!, package: { ...input.snapshot.versions[0]!.package, version: '2.0.0' } });
    if (change === 'stale-binding') input.snapshot.bindings.bindings = input.snapshot.bindings.bindings.map((binding) => binding.status === 'bound' ? { ...binding, status: 'stale', verified: false } : binding);
    expect(createHandoff(input).manifest?.ready).not.toBe(true);
  });

  it('returns no partial manifest for malformed references or crossed project identities', () => {
    const input = handoffFixture(); input.projectId = 'other';
    expect(createHandoff(input).manifest).toBeNull();
    input.projectId = 'project'; input.snapshot.document.screens[0]!.children[0] = { schemaVersion: 1, id: 'bad', type: 'instance', ref: 'local:missing', overrides: [] };
    expect(createHandoff(input).manifest).toBeNull();
  });
});
