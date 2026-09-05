import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../../src/storage/design-runtime-store.js';
import { projectComponentFixture } from '../../fixtures/design-runtime/project-components.js';
import { createProjectDesignRuntimeService } from '../../../src/services/design-runtime/project-service.js';

const source = `export function Button(props: { variant?: 'primary' | 'secondary' }) { return null; }
export function Card(props: { title: string }) { return null; }`;
const selection = { sourcePath: 'src/ui.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'ui/Button' };
const request = { expectedRevision: 0, designSystemId: 'test', selections: [selection] };
let db: Database.Database;
afterEach(() => db?.close());

function setup(readSource = vi.fn(async () => source)) {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
  migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db);
  const service = createProjectDesignRuntimeService({ store, readSource });
  return { store, service, readSource };
}

describe('project design runtime service', () => {
  it('compiles shared source once, retains deterministic metadata, and never persists source text', async () => {
    const { service, readSource } = setup();
    const state = await service.compile('project', { ...request, selections: [selection, { ...selection, exportName: 'Card', componentId: 'card', codeComponentId: 'ui/Card' }] });
    expect(readSource).toHaveBeenCalledExactlyOnceWith('project', 'src/ui.tsx');
    expect(state.revision).toBe(1);
    expect(state.codeIndex.id).toBe('project');
    expect(state.bindings.id).toBe('project');
    expect(state.registry?.components.map((entry) => entry.id)).toEqual(['button', 'card']);
    const persisted = db.prepare('SELECT state_json FROM project_design_runtime').get() as { state_json: string };
    expect(persisted.state_json).not.toContain('sourceText');
    expect(persisted.state_json).not.toContain('return null');
    expect(service.components('project', 'BUTTON').components.map((entry) => entry.id)).toEqual(['button']);
    expect(service.codeComponents('project', 'src/ui card').components.map((entry) => entry.id)).toEqual(['ui/Card']);
    expect(service.validate('project', { component: 'ds:test/button', props: { variant: 'filled' } }).diagnostics[0]?.code).toBe('ODDS1003');
  });

  it('keeps the entire previous state on failed compilation or a registry identity change', async () => {
    const { service, readSource } = setup();
    const first = await service.compile('project', request);
    readSource.mockResolvedValue('export function Button(props: { nested: object }) {}');
    await expect(service.compile('project', { ...request, expectedRevision: 1 })).rejects.toThrow('Unsupported');
    await expect(service.compile('project', { ...request, expectedRevision: 1, designSystemId: 'other' })).rejects.toMatchObject({ code: 'DESIGN_RUNTIME_REGISTRY_CHANGE_REQUIRES_UPGRADE' });
    expect(service.get('project')).toEqual(first);
  });

  it('preserves explicit unbind and manual mapping while adding only new binding targets', async () => {
    const { service } = setup();
    let state = await service.compile('project', request);
    const original = state.bindings.bindings[0]!;
    state = service.bind('project', original.id, { expectedRevision: 1, binding: { ...original, propMappings: [{ designProp: 'variant', codeProp: 'variant' }] } });
    state = await service.compile('project', { ...request, expectedRevision: state.revision });
    expect(state.bindings.bindings[0]?.propMappings).toEqual([{ designProp: 'variant', codeProp: 'variant' }]);
    state = service.unbind('project', original.id, { expectedRevision: state.revision });
    state = await service.compile('project', { ...request, expectedRevision: state.revision, selections: [selection, { ...selection, exportName: 'Card', componentId: 'card', codeComponentId: 'ui/Card' }] });
    expect(state.bindings.bindings.find((entry) => entry.id === original.id)?.status).toBe('unbound');
    expect(state.bindings.bindings.find((entry) => entry.componentRef === 'ds:test/card')?.status).toBe('bound');
    expect(service.resolve('project', original.id).resolution).toMatchObject({ ok: false, diagnostics: [{ code: 'ODDS3004' }] });
  });

  it('marks changed code stale until explicit revalidation and rejects incompatible manual binding', async () => {
    const { service, readSource } = setup();
    let state = await service.compile('project', request);
    const binding = state.bindings.bindings[0]!;
    if (binding.status !== 'bound') throw new Error('Compiler must establish the fixture binding.');
    readSource.mockResolvedValue("export function Button(props: { variant?: 'primary' | 'secondary' | 'danger' }) {};");
    state = await service.compile('project', { ...request, expectedRevision: 1 });
    expect(state.bindings.bindings[0]?.status).toBe('stale');
    expect(() => service.bind('project', binding.id, { expectedRevision: 2, binding: { ...binding, codeComponentId: 'missing' } })).toThrow('does not match');
    state = service.revalidate('project', binding.id, { expectedRevision: 2 });
    expect(state.bindings.bindings[0]?.status).toBe('bound');
    expect(service.resolve('project', binding.id).resolution.ok).toBe(true);
  });

  it('checks revision both before source reads and again after asynchronous compilation', async () => {
    const { service, readSource } = setup();
    const first = await service.compile('project', request);
    const binding = first.bindings.bindings[0]!;
    readSource.mockClear();
    await expect(service.compile('project', request)).rejects.toMatchObject({ expectedRevision: 0, currentRevision: 1 });
    expect(readSource).not.toHaveBeenCalled();
    let finish!: (value: string) => void;
    readSource.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const compiling = service.compile('project', { ...request, expectedRevision: 1 });
    const unbound = service.unbind('project', binding.id, { expectedRevision: 1 });
    finish(source);
    await expect(compiling).rejects.toMatchObject({ expectedRevision: 1, currentRevision: 2 });
    expect(service.get('project')).toEqual(unbound);
  });
});


describe('project component aggregate integration', () => {
  it('keeps invalid staged changes reviewable, blocks publish/save/compile failures atomically, and retains source instances', async () => {
    const { service, readSource } = setup();
    let state = await service.compile('project', request);
    const definition = {
      schemaVersion: 1 as const, id: 'Local', name: 'Local', revision: 1,
      props: { variant: { type: 'enum' as const, values: ['primary', 'secondary'], required: false, default: 'primary' } },
      template: { schemaVersion: 1 as const, type: 'component' as const, id: 'root', ref: 'ds:test/button' },
      propMappings: [{ prop: 'variant', nodeId: 'root', path: ['props', 'variant'] as ['props', string] }],
    };
    state = service.stageComponent('project', { expectedRevision: state.revision, draftId: 'initial', expectedDefinitionRevision: 0, definition }).state;
    expect(state.document).toBeNull();
    expect(state.projectComponents.components).toEqual([]);
    state = service.publishComponent('project', 'initial', { expectedRevision: state.revision, expectedDefinitionRevision: 0 }).state;
    const document = { schemaVersion: 1 as const, id: 'design', screens: [{ schemaVersion: 1 as const, type: 'screen' as const, id: 'screen', children: [{ schemaVersion: 1 as const, type: 'instance' as const, id: 'instance', ref: 'local:Local', overrides: [] }] }] };
    state = service.saveDocument('project', { expectedRevision: state.revision, document });
    readSource.mockResolvedValue("export function Button(props: { variant?: 'primary' }) {}");
    await expect(service.compile('project', { ...request, expectedRevision: state.revision })).rejects.toMatchObject({ code: 'DESIGN_RUNTIME_VALIDATION_FAILED', details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS4005' })]) } });
    expect(service.get('project')).toEqual(state);
    const badDocument = { ...document, screens: [{ ...document.screens[0]!, children: [{ ...document.screens[0]!.children[0]!, ref: 'local:Missing' }] }] };
    expect(() => service.saveDocument('project', { expectedRevision: state.revision, document: badDocument })).toThrow('invalid component references');
    expect(service.get('project')).toEqual(state);
    const bad = { ...definition, revision: 2, template: { ...definition.template, ref: 'ds:test/Missing' } };
    const staged = service.stageComponent('project', { expectedRevision: state.revision, draftId: 'edit', expectedDefinitionRevision: 1, definition: bad });
    state = staged.state;
    expect(staged.impact.proposed.document).toBeNull();
    expect(state.projectComponents.components[0]).toEqual(definition);
    expect(() => service.publishComponent('project', 'edit', { expectedRevision: state.revision, expectedDefinitionRevision: 1 })).toThrow('blocked');
    expect(service.get('project')).toEqual(state);
    const edited = { ...definition, revision: 2, props: { variant: { ...definition.props.variant, default: 'secondary' } } };
    state = service.stageComponent('project', { expectedRevision: state.revision, draftId: 'edit', expectedDefinitionRevision: 1, definition: edited }).state;
    state = service.publishComponent('project', 'edit', { expectedRevision: state.revision, expectedDefinitionRevision: 1 }).state;
    expect(state.document).toEqual(document);
    expect(state.sharedChanges.history.map((entry) => entry.definition.revision)).toEqual([1, 2]);
    expect(service.resolveDocument('project').resolution.document!.screens[0]!.children[0]).toMatchObject({ type: 'component', props: { variant: 'secondary' } });
    expect(() => service.saveDocument('project', { expectedRevision: state.revision - 1, document })).toThrow('changed; refresh');
  });

  it('records deletion rewrites as new immutable surviving revisions and refuses pending affected drafts', () => {
    const { service, store } = setup();
    const fixture = projectComponentFixture();
    fixture.projectComponents.components.push({ ...structuredClone(fixture.projectComponents.components[0]!), id: 'Button2', name: 'Button2' });
    let state = store.write('project', 0, { ...store.read('project'), registry: fixture.registry, projectComponents: fixture.projectComponents, document: fixture.document });
    const pending = { ...fixture.projectComponents.components[1]!, revision: 2 };
    state = service.stageComponent('project', { expectedRevision: state.revision, draftId: 'pending-card', expectedDefinitionRevision: 1, definition: pending }).state;
    const deletion = { action: { type: 'replace' as const, replacementRef: 'local:Button2' } };
    expect(() => service.deleteComponent('project', 'Button', { expectedRevision: state.revision, ...deletion })).toThrow('pending drafts');
    expect(service.get('project')).toEqual(state);
    state = service.discardComponentChange('project', 'pending-card', { expectedRevision: state.revision });
    const previousDocument = structuredClone(state.document);
    state = service.deleteComponent('project', 'Button', { expectedRevision: state.revision, ...deletion });
    expect(state.projectComponents.components.find((entry) => entry.id === 'ApplicationCard')!.revision).toBe(2);
    expect(state.projectComponents.components.find((entry) => entry.id === 'Button2')!.revision).toBe(1);
    expect(service.history('project', 'ApplicationCard').history.map((entry) => entry.definition.revision)).toEqual([1, 2]);
    expect(service.history('project', 'Button').history.map((entry) => entry.definition.revision)).toEqual([1]);
    expect(state.document).toEqual(previousDocument);
    expect(state.sharedChanges.history.find((entry) => entry.componentRef === 'local:ApplicationCard' && entry.definition.revision === 2)!.changeId).toMatch(/^delete[0-9a-f]+$/);
    const button2 = state.projectComponents.components.find((entry) => entry.id === 'Button2')!;
    state = service.stageComponent('project', { expectedRevision: state.revision, draftId: 'pending-button', expectedDefinitionRevision: 1, definition: { ...button2, revision: 2 } }).state;
    expect(service.deletion('project', 'Button2').analysis.diagnostics).toContainEqual(expect.objectContaining({ code: 'ODDS4004' }));
    expect(() => service.deleteComponent('project', 'Button2', { expectedRevision: state.revision, action: { type: 'replace', replacementRef: 'ds:acme/Button' } })).toThrow('pending drafts');
    expect(service.get('project')).toEqual(state);
  });
});
