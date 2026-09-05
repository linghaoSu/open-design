import { describe, expect, it, vi } from 'vitest';
import { DesignSystemResolutionResultSchema, DesignSystemVersionCatalogSchema, type DesignSystemPackage, type DesignSystemVersionCatalog } from '@open-design/contracts';
import { packageFixture } from '../../fixtures/design-runtime/design-system-version.js';
import { createDesignSystemVersion, createProjectDesignSystemLock, digestDesignSystemSource, publishDesignSystemVersion, resolveLockedDesignSystems, satisfiesDesignSystemRange, validateDesignSystemPackage, verifyDesignSystemVersion } from '../../../src/services/design-runtime/design-system-version.js';

const catalog = (): DesignSystemVersionCatalog => ({ schemaVersion: 1, id: 'catalog', versions: [] });

describe('immutable design-system versions', () => {
  it('hashes compiler-produced metadata and actual source bytes deterministically without mutating input', () => {
    const pkg = packageFixture(); const before = structuredClone(pkg);
    const version = createDesignSystemVersion(pkg);
    expect(verifyDesignSystemVersion(version)).toEqual([]);
    expect(pkg).toEqual(before);
    expect(createDesignSystemVersion(JSON.parse(JSON.stringify(pkg)))).toEqual(version);
    expect(createDesignSystemVersion({ ...pkg, source: { ...pkg.source, files: [...pkg.source.files].reverse() } })).toEqual(version);
    expect(digestDesignSystemSource({ schemaVersion: 1, files: [{ path: 'x', encoding: 'utf8', content: '\u0000' }] })).toBe(digestDesignSystemSource({ schemaVersion: 1, files: [{ path: 'x', encoding: 'base64', content: 'AA==' }] }));
  });

  it('covers names, tokens, patterns, constraints, binding/code metadata, compatibility, origin and source in the full digest', () => {
    const initial = createDesignSystemVersion(packageFixture());
    const changes: ((pkg: DesignSystemPackage) => void)[] = [
      (pkg) => { pkg.registry.components[0]!.name = 'Action'; },
      (pkg) => { pkg.codeIndex.components[0]!.name = 'Production action'; },
      (pkg) => { pkg.bindings.bindings[0]!.propMappings = [{ designProp: 'label', codeProp: 'label' }]; },
      (pkg) => { pkg.tokens.tokens[0]!.name = 'Brand primary'; },
      (pkg) => { pkg.patterns.patterns[0]!.name = 'Resources'; },
      (pkg) => { pkg.constraints.explore.rawCss.spacing = 'off'; },
      (pkg) => { pkg.codeCompatibility[0]!.version = '^1.1.0'; },
      (pkg) => { pkg.origin = { type: 'git', repository: 'https://example.com/acme.git', commit: 'a'.repeat(40) }; },
      (pkg) => { pkg.source.files.find((file) => file.path === 'DESIGN.md')!.content += 'Updated.\n'; },
    ];
    for (const mutate of changes) { const pkg = packageFixture(); mutate(pkg); expect(createDesignSystemVersion(pkg).digest).not.toBe(initial.digest); }
  });

  it('publishes immutable exact identities and preserves old bytes across serialization and new releases', () => {
    const first = publishDesignSystemVersion(catalog(), packageFixture());
    expect(publishDesignSystemVersion(first, packageFixture())).toEqual(first);
    const second = publishDesignSystemVersion(first, packageFixture('1.1.0'));
    expect(DesignSystemVersionCatalogSchema.parse(JSON.parse(JSON.stringify(second)))).toEqual(second);
    expect(second.versions[0]).toEqual(first.versions[0]);
    const changed = packageFixture(); changed.name = 'Changed';
    expect(() => publishDesignSystemVersion(second, changed)).toThrow('immutable');
    expect(first.versions).toHaveLength(1);
  });

  it('rejects absent source, noncanonical bytes, duplicate/ancestor paths, false export and prop metadata, and mismatched bindings', () => {
    const mutations: ((pkg: DesignSystemPackage) => void)[] = [
      (pkg) => { pkg.source.files = pkg.source.files.filter((file) => file.path !== 'src/Button.tsx'); },
      (pkg) => { pkg.source.files[1]!.content = 'AB=='; },
      (pkg) => { pkg.source.files.push({ ...pkg.source.files[0]!, path: 'SRC/button.tsx' }); },
      (pkg) => { pkg.source.files.push({ path: 'src', encoding: 'utf8', content: '' }); },
      (pkg) => { pkg.source.files[0]!.content = 'export function Different() {}'; },
      (pkg) => { pkg.codeIndex.components[0]!.props.label = { type: 'number', required: false }; },
      (pkg) => { const binding = pkg.bindings.bindings[0]!; if ('codeComponentId' in binding) binding.codeComponentId = 'missing'; },
    ];
    for (const mutate of mutations) { const pkg = packageFixture(); mutate(pkg); expect(() => createDesignSystemVersion(pkg)).toThrow(); }
    expect(() => digestDesignSystemSource({ schemaVersion: 1, files: [{ path: 'x', encoding: 'utf8', content: 'a' }, { path: 'x', encoding: 'utf8', content: 'b' }] })).toThrow();
  });

  it('checks declared provenance fields without interpreting ordinary sourcePath props as files', () => {
    const pkg = packageFixture();
    pkg.registry.components.find((component) => component.id === 'Frame')!.props.sourcePath = { type: 'string', required: false };
    const template = pkg.patterns.patterns[0]!.template;
    if (template.type !== 'component') throw new Error('fixture');
    template.props = { sourcePath: 'route:/docs' };
    expect(validateDesignSystemPackage(pkg)).toEqual([]);
    expect(verifyDesignSystemVersion(createDesignSystemVersion(pkg))).toEqual([]);
    pkg.registry.components.find((component) => component.id === 'Frame')!.props.sourcePath!.source = { kind: 'manual', sourcePath: 'missing/props.json' };
    expect(validateDesignSystemPackage(pkg)).toContainEqual(expect.objectContaining({ code: 'ODDS5005' }));
  });

  it('validates portable pattern slots, requiredness, target identities and whole prop domains', () => {
    const pkg = packageFixture();
    expect(validateDesignSystemPackage(pkg)).toEqual([]);
    pkg.patterns.patterns[0]!.slots.actions!.required = false;
    expect(validateDesignSystemPackage(pkg)).toContainEqual(expect.objectContaining({ code: 'ODDS1004' }));
    const invalid = packageFixture();
    invalid.patterns.patterns[0]!.template = { schemaVersion: 1, type: 'component', id: 'button', ref: 'ds:acme/Button' };
    invalid.patterns.patterns[0]!.props = { variant: { type: 'enum', values: ['primary', 'danger'], required: true } };
    invalid.patterns.patterns[0]!.propMappings = [{ prop: 'variant', nodeId: 'button', path: ['props', 'variant'] }];
    invalid.patterns.patterns[0]!.slots = {}; invalid.patterns.patterns[0]!.slotMappings = [];
    expect(validateDesignSystemPackage(invalid)).toContainEqual(expect.objectContaining({ code: 'ODDS4005' }));
  });
});

describe('exact project lock resolution', () => {
  it('reopens the same frozen source despite newer versions and only calls the exact loader', async () => {
    const first = createDesignSystemVersion(packageFixture());
    const latest = createDesignSystemVersion(packageFixture('1.2.0'));
    const lock = createProjectDesignSystemLock('project', [first]);
    const dependencies = { schemaVersion: 1 as const, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] };
    const loader = vi.fn(async (entry: (typeof lock.dependencies)[number]) => [first, latest].find((version) => version.package.version === entry.version) ?? null);
    const before = await resolveLockedDesignSystems(dependencies, lock, loader);
    const reopened = await resolveLockedDesignSystems(dependencies, JSON.parse(JSON.stringify(lock)), loader);
    expect(DesignSystemResolutionResultSchema.parse(reopened)).toEqual(before);
    expect(reopened).toMatchObject({ ok: true, versions: [{ package: { version: '1.0.0' } }] });
    expect(loader).toHaveBeenCalledWith(lock.dependencies[0]);
  });

  it('fails closed on missing, substituted, tampered or source-mismatched locked versions', async () => {
    const version = createDesignSystemVersion(packageFixture());
    const lock = createProjectDesignSystemLock('project', [version]);
    const dependencies = { schemaVersion: 1 as const, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] };
    const missing = await resolveLockedDesignSystems(dependencies, lock, async () => null);
    expect(missing).toMatchObject({ ok: false, versions: [], diagnostics: [{ code: 'ODDS5003' }] });
    const replaced = await resolveLockedDesignSystems(dependencies, lock, async () => createDesignSystemVersion(packageFixture('1.1.0')));
    expect(replaced).toMatchObject({ ok: false, diagnostics: [{ code: 'ODDS5001' }] });
    const tampered = structuredClone(version); tampered.package.source.files.find((file) => file.path === 'DESIGN.md')!.content += 'tampered';
    expect(await resolveLockedDesignSystems(dependencies, lock, async () => tampered)).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS5005' }), expect.objectContaining({ code: 'ODDS5004' })]) });
    lock.dependencies[0]!.source.digest = `sha256:${'0'.repeat(64)}`;
    expect(await resolveLockedDesignSystems(dependencies, lock, async () => version)).toMatchObject({ ok: false, diagnostics: [{ code: 'ODDS5005' }] });
  });

  it('rejects incomplete/mismatched dependency intent before any source loading', async () => {
    const lock = createProjectDesignSystemLock('project', [createDesignSystemVersion(packageFixture())]);
    const loader = vi.fn();
    for (const dependencies of [
      { schemaVersion: 1 as const, id: 'other', dependencies: [{ designSystemId: 'acme', version: '^1.0.0' }] },
      { schemaVersion: 1 as const, id: 'project', dependencies: [{ designSystemId: 'acme', version: '^2.0.0' }] },
      { schemaVersion: 1 as const, id: 'project', dependencies: [] },
    ]) expect(await resolveLockedDesignSystems(dependencies, lock, loader)).toMatchObject({ ok: false, versions: [] });
    expect(loader).not.toHaveBeenCalled();
  });

  it.each([
    ['1.2.9', '^1.2.3', true], ['2.0.0', '^1.2.3', false], ['1.3.0', '~1.2.3', false],
    ['0.2.9', '^0.2.3', true], ['0.3.0', '^0.2.3', false], ['0.0.4', '^0.0.3', false],
    ['1.2.4-beta.1', '^1.2.3', false], ['1.2.3-beta.3', '^1.2.3-beta.2', true], ['1.2.4-beta.3', '^1.2.3-beta.2', false],
    ['1.2.3+build.2', '1.2.3+build.1', true], ['9007199254740993.0.0', '^9007199254740992.0.0', false],
  ])('checks explicit range intent %s in %s -> %s without numeric rounding', (version, range, accepted) => {
    expect(satisfiesDesignSystemRange(version, range)).toBe(accepted);
  });
});
