import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ProjectDesignRuntimeCodeComponentsResponseSchema,
  ProjectDesignRuntimeComponentsResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema,
  ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeValidateResponseSchema,
} from '@open-design/contracts';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';

const selection = { sourcePath: 'src/Button.tsx', exportName: 'Button', componentId: 'button', codeComponentId: 'ui/Button' };
const compileRequest = { expectedRevision: 0, designSystemId: 'test', selections: [selection] };

async function withRoute<T>(run: (fixture: {
  request: (method: string, suffix?: string, body?: unknown) => Promise<{ status: number; json: any }>;
  readSource: ReturnType<typeof vi.fn<(projectId: string, sourcePath: string) => Promise<string>>>;
  authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>;
  storeRead: MockInstance<ReturnType<typeof createDesignRuntimeStore>['read']>;
}) => Promise<T>): Promise<T> {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
  migrateDesignRuntimeStore(db);
  const readSource = vi.fn(async (_projectId: string, _sourcePath: string) => "export function Button(props: { variant?: 'primary' | 'secondary' }) {}");
  const store = createDesignRuntimeStore(db);
  const storeRead = vi.spyOn(store, 'read');
  const service = createProjectDesignRuntimeService({ store, readSource });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true);
  const app = express();
  app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const prefix = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/project/design-runtime`;
  try {
    return await run({
      readSource,
      authorize,
      storeRead,
      request: async (method, suffix = '', body) => {
        const response = await fetch(`${prefix}${suffix}`, {
          method,
          ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        });
        return { status: response.status, json: await response.json() };
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  }
}

describe('project design runtime HTTP routes', () => {
  it('dispatches compile, search, binding lifecycle, resolve, and diagnostics through shared DTOs', async () => {
    await withRoute(async ({ request, authorize, readSource }) => {
      const initial = await request('GET');
      expect(ProjectDesignRuntimeResponseSchema.parse(initial.json).state.revision).toBe(0);
      const compiled = await request('POST', '/compile', compileRequest);
      expect(compiled.status).toBe(200);
      let state = ProjectDesignRuntimeResponseSchema.parse(compiled.json).state;
      const binding = state.bindings.bindings[0]!;
      const bindingPath = `/bindings/${encodeURIComponent(binding.id)}`;
      expect(readSource).toHaveBeenCalledExactlyOnceWith('project', 'src/Button.tsx');
      expect(ProjectDesignRuntimeComponentsResponseSchema.parse((await request('GET', '/components?query=button')).json).components).toHaveLength(1);
      expect(ProjectDesignRuntimeCodeComponentsResponseSchema.parse((await request('GET', '/code-components?query=src%2FButton')).json).components).toHaveLength(1);
      expect(ProjectDesignRuntimeResolveResponseSchema.parse((await request('GET', `${bindingPath}/resolve`)).json).resolution.ok).toBe(true);
      const invalid = await request('POST', '/validate', { component: 'ds:test/button', props: { variant: 'filled' } });
      expect(ProjectDesignRuntimeValidateResponseSchema.parse(invalid.json).diagnostics[0]?.code).toBe('ODDS1003');
      expect(authorize.mock.lastCall?.[3]).toEqual({ mode: 'read' });
      state = ProjectDesignRuntimeResponseSchema.parse((await request('DELETE', bindingPath, { expectedRevision: state.revision })).json).state;
      expect(state.bindings.bindings[0]?.status).toBe('unbound');
      expect(authorize.mock.lastCall?.[3]).toEqual({ mode: 'write', capability: 'writeFiles' });
      const missingTarget = await request('POST', `${bindingPath}/revalidate`, { expectedRevision: state.revision });
      expect(missingTarget.status).toBe(400);
      expect(missingTarget.json.error.details.diagnostics[0].code).toBe('ODDS3001');
      state = ProjectDesignRuntimeResponseSchema.parse((await request('PUT', bindingPath, { expectedRevision: state.revision, binding })).json).state;
      state = ProjectDesignRuntimeResponseSchema.parse((await request('POST', `${bindingPath}/revalidate`, { expectedRevision: state.revision })).json).state;
      expect(state.bindings.bindings[0]?.status).toBe('bound');
      const conflict = await request('DELETE', bindingPath, { expectedRevision: 1 });
      expect(conflict.status).toBe(409);
      expect(conflict.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_REVISION_CONFLICT', details: { expectedRevision: 1, currentRevision: state.revision } });
      expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET')).json).state).toEqual(state);
    });
  });

  it('rejects source text, path traversal and duplicate selections before reading project files', async () => {
    await withRoute(async ({ request, readSource }) => {
      for (const selections of [
        [{ ...selection, sourcePath: '../secret.tsx' }],
        [{ ...selection, sourceText: 'export function Button() {}' }],
        [selection, selection],
      ]) {
        const result = await request('POST', '/compile', { ...compileRequest, selections });
        expect(result.status).toBe(400);
        expect(result.json.error.code).toBe('BAD_REQUEST');
      }
      expect(readSource).not.toHaveBeenCalled();
      readSource.mockResolvedValue('export function Button(props: { value: object }) {}');
      const unsupported = await request('POST', '/compile', compileRequest);
      expect(unsupported.status).toBe(400);
      expect(unsupported.json.error).toMatchObject({ code: 'DESIGN_RUNTIME_COMPILATION_FAILED', details: { sourcePath: 'src/Button.tsx', exportName: 'Button' } });
      expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET')).json).state.revision).toBe(0);
    });
  });

  it('authorizes every read and write before source reads or persistence access', async () => {
    await withRoute(async ({ request, authorize, readSource, storeRead }) => {
      authorize.mockImplementation(async (_req, res) => {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Read-only project.' } });
        return false;
      });
      const calls: [string, string, unknown?][] = [
        ['GET', ''], ['GET', '/components'], ['GET', '/code-components'],
        ['POST', '/compile', compileRequest],
        ['PUT', '/bindings/missing', {}], ['DELETE', '/bindings/missing', { expectedRevision: 0 }],
        ['POST', '/bindings/missing/revalidate', { expectedRevision: 0 }],
        ['GET', '/bindings/missing/resolve'],
        ['POST', '/validate', { component: 'ds:test/button', props: {} }],
      ];
      for (const [method, suffix, body] of calls) {
        expect((await request(method, suffix, body)).status).toBe(403);
      }
      expect(readSource).not.toHaveBeenCalled();
      expect(authorize).toHaveBeenCalledTimes(calls.length);
      expect(storeRead).not.toHaveBeenCalled();
      authorize.mockResolvedValue(true);
      expect(ProjectDesignRuntimeResponseSchema.parse((await request('GET')).json).state.revision).toBe(0);
    });
  });
});
