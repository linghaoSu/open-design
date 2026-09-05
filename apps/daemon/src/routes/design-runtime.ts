import type { Express, Request, Response } from 'express';
import {
  JsonValueSchema,
  DesignSystemSemVerSchema,
  ProjectDesignRuntimeImportVersionRequestSchema,
  ProjectDesignRuntimePublishCurrentRequestSchema,
  ProjectDesignRuntimeActivateDependencyRequestSchema,
  DesignEntityIdSchema,
  ProjectComponentDeleteRequestSchema,
  ProjectDesignRuntimeSaveDocumentRequestSchema,
  ProjectDesignRuntimeValidateDocumentRequestSchema,
  ProjectDesignRuntimeReferencesRequestSchema,
  ProjectDesignRuntimeStageComponentRequestSchema,
  ProjectDesignRuntimePublishComponentRequestSchema,
  ProjectDesignRuntimeUndoComponentRequestSchema,
  ProjectDesignRuntimeDeleteComponentRequestSchema,
  ProjectDesignRuntimeDetachRequestSchema,
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
  DesignRuntimeImmutableVersionError,
  DesignRuntimeRevisionConflictError,
} from '../storage/design-runtime-store.js';
import { ProjectDesignRuntimeError } from '../services/design-runtime/project-service.js';
import { CompilerError } from '../services/design-runtime/react-compiler.js';
import { DesignSystemVersionError } from '../services/design-runtime/design-system-version.js';
import { SharedComponentChangeError } from '../services/design-runtime/shared-component-changes.js';

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
  } else if (error instanceof DesignRuntimeImmutableVersionError) {
    sendApiError(res, 409, 'DESIGN_RUNTIME_VERSION_IMMUTABLE', error.message, { details: { designSystemId: error.designSystemId, version: error.version, diagnostics: [{ schemaVersion: 1, code: 'ODDS5006', severity: 'error', message: error.message }] } });
  } else if (error instanceof DesignSystemVersionError) {
    sendApiError(res, 400, 'DESIGN_RUNTIME_VERSION_INVALID', error.message, { details: JsonValueSchema.parse({ diagnostics: error.diagnostics }) });
  } else if (error instanceof ProjectDesignRuntimeError) {
    sendApiError(res, error.status, error.code, error.message,
      error.details === undefined ? {} : { details: JsonValueSchema.parse(error.details) });
  } else if (error instanceof SharedComponentChangeError) {
    const status = error.code === 'CONFLICT' ? 409 : error.code === 'NOT_FOUND' ? 404 : 400;
    const code = error.code === 'CONFLICT' ? 'DESIGN_RUNTIME_COMPONENT_CHANGE_CONFLICT' : error.code === 'NOT_FOUND' ? 'DESIGN_RUNTIME_COMPONENT_CHANGE_NOT_FOUND' : 'DESIGN_RUNTIME_VALIDATION_FAILED';
    sendApiError(res, status, code, error.message, { details: JsonValueSchema.parse({
      diagnostics: error.diagnostics,
      ...(error.impact === undefined ? {} : { impact: error.impact }),
      ...(error.expectedDefinitionRevision === undefined ? {} : { expectedDefinitionRevision: error.expectedDefinitionRevision }),
      ...(error.currentDefinitionRevision === undefined ? {} : { currentDefinitionRevision: error.currentDefinitionRevision }),
    }) });
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
  const componentId = (req: Request) => parseInput(DesignEntityIdSchema, req.params.componentId);
  const draftId = (req: Request) => parseInput(DesignEntityIdSchema, req.params.draftId);
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
  app.get(`${prefix}/versions`, handle('read', (req) => service.versions(String(req.params.id))));
  app.get(`${prefix}/versions/:designSystemId/:version`, handle('read', (req) => service.version(String(req.params.id), parseInput(DesignEntityIdSchema, req.params.designSystemId), parseInput(DesignSystemSemVerSchema, req.params.version))));
  app.post(`${prefix}/versions`, handle('write', (req) => service.importVersion(String(req.params.id), parseInput(ProjectDesignRuntimeImportVersionRequestSchema, req.body))));
  app.post(`${prefix}/versions/publish-current`, handle('write', (req) => service.publishCurrent(String(req.params.id), parseInput(ProjectDesignRuntimePublishCurrentRequestSchema, req.body))));
  app.post(`${prefix}/dependency`, handle('write', (req) => ({ state: service.activateDependency(String(req.params.id), parseInput(ProjectDesignRuntimeActivateDependencyRequestSchema, req.body)) })));
  app.delete(`${prefix}/dependency`, handle('write', (req) => ({ state: service.clearDependency(String(req.params.id), parseInput(ProjectDesignRuntimeRevisionRequestSchema, req.body)) })));
  app.get(`${prefix}/dependency/resolve`, handle('read', (req) => service.resolveDependency(String(req.params.id))));
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
  app.put(`${prefix}/document`, handle('write', (req) => ({ state: service.saveDocument(String(req.params.id), parseInput(ProjectDesignRuntimeSaveDocumentRequestSchema, req.body)) })));
  app.post(`${prefix}/document/validate`, handle('read', (req) => service.validateDocument(String(req.params.id), parseInput(ProjectDesignRuntimeValidateDocumentRequestSchema, req.body))));
  app.get(`${prefix}/document/resolve`, handle('read', (req) => service.resolveDocument(String(req.params.id))));
  app.get(`${prefix}/references`, handle('read', (req) => service.references(String(req.params.id), parseInput(ProjectDesignRuntimeReferencesRequestSchema, req.query).componentRef)));
  app.get(`${prefix}/project-components`, handle('read', (req) => service.projectComponents(String(req.params.id), parseInput(ProjectDesignRuntimeSearchRequestSchema, req.query).query)));
  app.get(`${prefix}/project-components/:componentId/deletion`, handle('read', (req) => service.deletion(String(req.params.id), componentId(req))));
  app.get(`${prefix}/project-components/:componentId/history`, handle('read', (req) => service.history(String(req.params.id), componentId(req))));
  app.post(`${prefix}/component-changes`, handle('write', (req) => service.stageComponent(String(req.params.id), parseInput(ProjectDesignRuntimeStageComponentRequestSchema, req.body))));
  app.get(`${prefix}/component-changes/:draftId`, handle('read', (req) => service.inspectComponentChange(String(req.params.id), draftId(req))));
  app.post(`${prefix}/component-changes/:draftId/publish`, handle('write', (req) => service.publishComponent(String(req.params.id), draftId(req), parseInput(ProjectDesignRuntimePublishComponentRequestSchema, req.body))));
  app.delete(`${prefix}/component-changes/:draftId`, handle('write', (req) => ({ state: service.discardComponentChange(String(req.params.id), draftId(req), parseInput(ProjectDesignRuntimeRevisionRequestSchema, req.body)) })));
  app.post(`${prefix}/project-components/:componentId/undo`, handle('write', (req) => service.undoComponent(String(req.params.id), componentId(req), parseInput(ProjectDesignRuntimeUndoComponentRequestSchema, req.body))));
  app.delete(`${prefix}/project-components/:componentId`, handle('write', (req) => {
    const id = componentId(req);
    const request = parseInput(ProjectDesignRuntimeDeleteComponentRequestSchema, req.body);
    parseInput(ProjectComponentDeleteRequestSchema, { componentRef: `local:${id}`, action: request.action });
    return { state: service.deleteComponent(String(req.params.id), id, request) };
  }));
  app.post(`${prefix}/instances/detach`, handle('read', (req) => service.detachInstance(String(req.params.id), parseInput(ProjectDesignRuntimeDetachRequestSchema, req.body))));
  app.post(`${prefix}/validate`, handle('read', (req) =>
    service.validate(String(req.params.id), parseInput(ProjectDesignRuntimeValidateRequestSchema, req.body))));
}
