import type { Express, Request, Response } from 'express';
import {
  JsonValueSchema,
  ProjectDesignRuntimeBindRequestSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeSearchRequestSchema,
  ProjectDesignRuntimeValidateRequestSchema,
} from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import { sendApiError } from '../http/api-errors.js';
import {
  DesignRuntimeProjectNotFoundError,
  DesignRuntimeRevisionConflictError,
} from '../storage/design-runtime-store.js';
import { ProjectDesignRuntimeError } from '../services/design-runtime/project-service.js';
import { CompilerError } from '../services/design-runtime/react-compiler.js';

export interface RegisterDesignRuntimeRoutesDeps extends RouteDeps<'designRuntime' | 'authorizeProjectRequest'> {}

type InputSchema<T> = {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } };
};

function parseInput<T>(schema: InputSchema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ProjectDesignRuntimeError(400, 'BAD_REQUEST', 'Invalid design runtime request.', {
      issues: result.error.issues.map(({ path, message }) => ({ path, message })),
    });
  }
  return result.data;
}

function sendFailure(res: Response, error: unknown): void {
  if (error instanceof DesignRuntimeProjectNotFoundError) {
    sendApiError(res, 404, 'PROJECT_NOT_FOUND', error.message);
  } else if (error instanceof DesignRuntimeRevisionConflictError) {
    sendApiError(res, 409, 'DESIGN_RUNTIME_REVISION_CONFLICT', error.message, {
      details: { expectedRevision: error.expectedRevision, currentRevision: error.currentRevision },
    });
  } else if (error instanceof ProjectDesignRuntimeError) {
    sendApiError(res, error.status, error.code, error.message,
      error.details === undefined ? {} : { details: JsonValueSchema.parse(error.details) });
  } else if (error instanceof CompilerError) {
    sendApiError(res, 400, 'DESIGN_RUNTIME_COMPILATION_FAILED', error.message, {
      details: {
        sourcePath: error.sourcePath, exportName: error.exportName,
        ...(error.line === undefined ? {} : { line: error.line }),
        ...(error.column === undefined ? {} : { column: error.column }),
      },
    });
  } else {
    sendApiError(res, 500, 'INTERNAL_ERROR', 'Design runtime operation failed.');
  }
}

/** All project reads and mutations share the daemon's durable project authority. */
export function registerDesignRuntimeRoutes(app: Express, deps: RegisterDesignRuntimeRoutesDeps): void {
  const prefix = '/api/projects/:id/design-runtime';
  const service = deps.designRuntime;
  const handle = (mode: 'read' | 'write', action: (req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      if (!await deps.authorizeProjectRequest(req, res, String(req.params.id),
        mode === 'read' ? { mode } : { mode, capability: 'writeFiles' })) return;
      res.json(await action(req));
    } catch (error) {
      sendFailure(res, error);
    }
  };

  app.get(prefix, handle('read', (req) => ({ state: service.get(String(req.params.id)) })));
  app.post(`${prefix}/compile`, handle('write', async (req) => ({
    state: await service.compile(String(req.params.id), parseInput(ProjectDesignRuntimeCompileRequestSchema, req.body)),
  })));
  app.get(`${prefix}/components`, handle('read', (req) => {
    const { query } = parseInput(ProjectDesignRuntimeSearchRequestSchema, req.query);
    return service.components(String(req.params.id), query);
  }));
  app.get(`${prefix}/code-components`, handle('read', (req) => {
    const { query } = parseInput(ProjectDesignRuntimeSearchRequestSchema, req.query);
    return service.codeComponents(String(req.params.id), query);
  }));
  app.put(`${prefix}/bindings/:bindingId`, handle('write', (req) => ({
    state: service.bind(String(req.params.id), String(req.params.bindingId), parseInput(ProjectDesignRuntimeBindRequestSchema, req.body)),
  })));
  app.delete(`${prefix}/bindings/:bindingId`, handle('write', (req) => ({
    state: service.unbind(String(req.params.id), String(req.params.bindingId), parseInput(ProjectDesignRuntimeRevisionRequestSchema, req.body)),
  })));
  app.post(`${prefix}/bindings/:bindingId/revalidate`, handle('write', (req) => ({
    state: service.revalidate(String(req.params.id), String(req.params.bindingId), parseInput(ProjectDesignRuntimeRevisionRequestSchema, req.body)),
  })));
  app.get(`${prefix}/bindings/:bindingId/resolve`, handle('read', (req) =>
    service.resolve(String(req.params.id), String(req.params.bindingId))));
  app.post(`${prefix}/validate`, handle('read', (req) =>
    service.validate(String(req.params.id), parseInput(ProjectDesignRuntimeValidateRequestSchema, req.body))));
}
