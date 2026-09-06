import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ComponentPreviewResponseSchema, type DesignSystemSourceFile } from '@open-design/contracts';
import { createDesignRuntimeStore, migrateDesignRuntimeStore } from '../../src/storage/design-runtime-store.js';
import { createProjectDesignRuntimeService } from '../../src/services/design-runtime/project-service.js';
import { registerDesignRuntimeRoutes } from '../../src/routes/design-runtime.js';
import type { AuthorizeProjectRequest } from '../../src/collab/project-request-authority.js';
import { componentPreviewFiles } from '../fixtures/design-runtime/component-preview.js';

async function fixture(run: (value: {
  authorize: ReturnType<typeof vi.fn<AuthorizeProjectRequest>>; read: ReturnType<typeof vi.fn<(path: string) => Promise<DesignSystemSourceFile>>>; readState: ReturnType<typeof vi.spyOn>;
  request(body: unknown): Promise<{ status: number; json: any }>;
}) => Promise<void>) {
  const db = new Database(':memory:'); db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');"); migrateDesignRuntimeStore(db);
  const store = createDesignRuntimeStore(db); const files = componentPreviewFiles();
  const readState = vi.spyOn(store, 'read'); const read = vi.fn(async (path: string) => { const file = files.get(path); if (!file) throw new Error('Missing'); return structuredClone(file); });
  const service = createProjectDesignRuntimeService({ store, readSource: async () => { throw new Error('Unexpected text-only reader'); }, acquireComponentPreviewAuthority: async () => ({
    readSourceFile: read, assertCurrent: async () => {}, assertCurrentSync: () => {},
  }) });
  const authorize = vi.fn<AuthorizeProjectRequest>(async () => true); const app = express(); app.use(express.json());
  registerDesignRuntimeRoutes(app, { designRuntime: service, authorizeProjectRequest: authorize });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await run({ authorize, read, readState, request: async (body) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/project/design-runtime/component-preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }); return { status: response.status, json: await response.json() };
  } }); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); }
}

describe('read-only component preview HTTP', () => {
  it('uses project read authority twice and requires no registry, lock or state read', () => fixture(async ({ request, authorize, readState }) => {
    const response = await request({ sourcePath: 'Card.tsx' }); expect(response.status).toBe(200);
    const result = ComponentPreviewResponseSchema.parse(response.json); expect(result.bundle).not.toBeNull();
    expect(result.requestedProps).toEqual({}); expect(result.selectedExport).toBe('default');
    expect(authorize.mock.calls.map((call) => call[3])).toEqual([{ mode: 'read' }, { mode: 'read' }]);
    expect(readState).not.toHaveBeenCalled();
  }));

  it('rejects authorization and input source injection/traversal before any source read', () => fixture(async ({ request, authorize, read }) => {
    authorize.mockImplementation(async (_req, res) => { res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Denied' } }); return false; });
    expect((await request({ sourcePath: 'Card.tsx' })).status).toBe(403); expect(read).not.toHaveBeenCalled();
    authorize.mockResolvedValue(true);
    for (const input of [{ sourcePath: '../Card.tsx' }, { sourcePath: 'Card.tsx', sourceText: 'injected' }, { sourcePath: 'Card.tsx', props: [] }, { sourcePath: 'Other.html' }]) expect((await request(input)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  }));

  it('withholds a finished bundle if read permission is revoked during final source verification', () => fixture(async ({ request, authorize, read }) => {
    const original = read.getMockImplementation()!; let calls = 0; let allowed = true;
    authorize.mockImplementation(async (_req, res) => { if (allowed) return true; res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Revoked' } }); return false; });
    read.mockImplementation(async (path) => { const file = await original(path); if (++calls === 8) allowed = false; return file; });
    const response = await request({ sourcePath: 'Card.tsx' }); expect(response.status).toBe(403); expect(response.json).not.toHaveProperty('bundle');
  }));
});
