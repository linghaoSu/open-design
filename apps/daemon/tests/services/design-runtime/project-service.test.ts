import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../../src/storage/design-runtime-store.js';
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
