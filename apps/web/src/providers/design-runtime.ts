import {
  ProjectDesignRuntimeBindRequestSchema,
  DesignEntityIdSchema, DesignSystemSemVerSchema,
  ProjectDesignRuntimeVersionsResponseSchema, ProjectDesignRuntimeVersionResponseSchema,
  ProjectDesignRuntimeImportVersionRequestSchema, ProjectDesignRuntimePublishVersionResponseSchema,
  ProjectDesignRuntimePublishCurrentRequestSchema, ProjectDesignRuntimeActivateDependencyRequestSchema,
  ProjectDesignRuntimeDependencyResponseSchema,
  type ProjectDesignRuntimeImportVersionRequest, type ProjectDesignRuntimePublishCurrentRequest,
  type ProjectDesignRuntimeActivateDependencyRequest,
  ProjectDesignRuntimeSaveDocumentRequestSchema,
  ProjectDesignRuntimeValidateDocumentRequestSchema,
  ProjectDesignRuntimeDocumentResponseSchema,
  ProjectDesignRuntimeReferencesRequestSchema,
  ProjectDesignRuntimeReferencesResponseSchema,
  ProjectDesignRuntimeProjectComponentsResponseSchema,
  ProjectDesignRuntimeDeletionResponseSchema,
  ProjectDesignRuntimeHistoryResponseSchema,
  ProjectDesignRuntimeStageComponentRequestSchema,
  ProjectDesignRuntimeStageComponentResponseSchema,
  ProjectDesignRuntimeChangeResponseSchema,
  ProjectDesignRuntimePublishComponentRequestSchema,
  ProjectDesignRuntimePublishComponentResponseSchema,
  ProjectDesignRuntimeUndoComponentRequestSchema,
  ProjectDesignRuntimeDeleteComponentRequestSchema,
  ProjectDesignRuntimeDetachRequestSchema,
  ProjectDesignRuntimeDetachResponseSchema,
  ProjectDesignRuntimeCodeComponentsResponseSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeComponentsResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema,
  ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeValidateRequestSchema,
  ProjectDesignRuntimeValidateResponseSchema,
  ValidationDiagnosticSchema,
  type ApiErrorResponse,
  type ProjectDesignRuntimeBindRequest,
  type ProjectDesignRuntimeSaveDocumentRequest,
  type ProjectDesignRuntimeValidateDocumentRequest,
  type ProjectDesignRuntimeStageComponentRequest,
  type ProjectDesignRuntimePublishComponentRequest,
  type ProjectDesignRuntimeUndoComponentRequest,
  type ProjectDesignRuntimeDeleteComponentRequest,
  type ProjectDesignRuntimeDetachRequest,
  type ProjectDesignRuntimeCompileRequest,
  type ProjectDesignRuntimeRevisionRequest,
  type ProjectDesignRuntimeValidateRequest,
  type ValidationDiagnostic,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';

/** Project authority is explicit on every request; no ambient workspace fallback. */
export interface ProjectDesignRuntimeScope {
  projectId: string;
  workspaceContext: WorkspaceCollabContext | null;
  signal?: AbortSignal;
}

export class ProjectDesignRuntimeError extends Error {
  readonly diagnostics: ValidationDiagnostic[];
  readonly currentRevision: number | undefined;
  readonly currentDefinitionRevision: number | undefined;

  constructor(readonly status: number, readonly apiError: ApiErrorResponse['error']) {
    super(apiError.message);
    this.name = 'ProjectDesignRuntimeError';
    const details = apiError.details && typeof apiError.details === 'object' && !Array.isArray(apiError.details)
      ? apiError.details : {};
    const diagnostics = ValidationDiagnosticSchema.array().safeParse(details.diagnostics);
    this.diagnostics = diagnostics.success ? diagnostics.data : [];
    this.currentRevision = typeof details.currentRevision === 'number' ? details.currentRevision : undefined;
    this.currentDefinitionRevision = typeof details.currentDefinitionRevision === 'number' ? details.currentDefinitionRevision : undefined;
  }
}

async function request<T>(
  scope: ProjectDesignRuntimeScope,
  path: string,
  schema: { parse(input: unknown): T },
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const headers = new Headers(scope.workspaceContext ? workspaceProjectHeaders(scope.workspaceContext) : undefined);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/projects/${encodeURIComponent(scope.projectId)}/design-runtime${path}`, {
    method,
    headers,
    cache: 'no-store',
    signal: scope.signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = (payload as Partial<ApiErrorResponse> | null)?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      throw new ProjectDesignRuntimeError(response.status, error);
    }
    throw new Error(`Design runtime request failed (${response.status}).`);
  }
  return schema.parse(payload);
}

export const getProjectDesignRuntime = (scope: ProjectDesignRuntimeScope) =>
  request(scope, '', ProjectDesignRuntimeResponseSchema);

export const compileProjectDesignRuntime = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeCompileRequest) =>
  request(scope, '/compile', ProjectDesignRuntimeResponseSchema, 'POST', ProjectDesignRuntimeCompileRequestSchema.parse(input));

export const putProjectDesignRuntimeBinding = (scope: ProjectDesignRuntimeScope, id: string, input: ProjectDesignRuntimeBindRequest) =>
  request(scope, `/bindings/${encodeURIComponent(id)}`, ProjectDesignRuntimeResponseSchema, 'PUT', ProjectDesignRuntimeBindRequestSchema.parse(input));

export const deleteProjectDesignRuntimeBinding = (scope: ProjectDesignRuntimeScope, id: string, input: ProjectDesignRuntimeRevisionRequest) =>
  request(scope, `/bindings/${encodeURIComponent(id)}`, ProjectDesignRuntimeResponseSchema, 'DELETE', ProjectDesignRuntimeRevisionRequestSchema.parse(input));

export const revalidateProjectDesignRuntimeBinding = (scope: ProjectDesignRuntimeScope, id: string, input: ProjectDesignRuntimeRevisionRequest) =>
  request(scope, `/bindings/${encodeURIComponent(id)}/revalidate`, ProjectDesignRuntimeResponseSchema, 'POST', ProjectDesignRuntimeRevisionRequestSchema.parse(input));

export const resolveProjectDesignRuntimeBinding = (scope: ProjectDesignRuntimeScope, id: string) =>
  request(scope, `/bindings/${encodeURIComponent(id)}/resolve`, ProjectDesignRuntimeResolveResponseSchema);

export const validateProjectDesignRuntimeUsage = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeValidateRequest) =>
  request(scope, '/validate', ProjectDesignRuntimeValidateResponseSchema, 'POST', ProjectDesignRuntimeValidateRequestSchema.parse(input));

export const searchProjectDesignRuntimeComponents = (scope: ProjectDesignRuntimeScope, query = '') =>
  request(scope, `/components?query=${encodeURIComponent(query)}`, ProjectDesignRuntimeComponentsResponseSchema);

export const searchProjectDesignRuntimeCodeComponents = (scope: ProjectDesignRuntimeScope, query = '') =>
  request(scope, `/code-components?query=${encodeURIComponent(query)}`, ProjectDesignRuntimeCodeComponentsResponseSchema);


export const saveProjectDesignRuntimeDocument = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeSaveDocumentRequest) =>
  request(scope, '/document', ProjectDesignRuntimeResponseSchema, 'PUT', ProjectDesignRuntimeSaveDocumentRequestSchema.parse(input));

export const validateProjectDesignRuntimeDocument = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeValidateDocumentRequest) =>
  request(scope, '/document/validate', ProjectDesignRuntimeDocumentResponseSchema, 'POST', ProjectDesignRuntimeValidateDocumentRequestSchema.parse(input));

export const resolveProjectDesignRuntimeDocument = (scope: ProjectDesignRuntimeScope) =>
  request(scope, '/document/resolve', ProjectDesignRuntimeDocumentResponseSchema);

export const getProjectDesignRuntimeReferences = (scope: ProjectDesignRuntimeScope, componentRef: string) =>
  request(scope, `/references?componentRef=${encodeURIComponent(ProjectDesignRuntimeReferencesRequestSchema.parse({ componentRef }).componentRef)}`, ProjectDesignRuntimeReferencesResponseSchema);

export const searchProjectDesignRuntimeProjectComponents = (scope: ProjectDesignRuntimeScope, query = '') =>
  request(scope, `/project-components?query=${encodeURIComponent(query)}`, ProjectDesignRuntimeProjectComponentsResponseSchema);

export const getProjectDesignRuntimeDeletion = (scope: ProjectDesignRuntimeScope, componentId: string) =>
  request(scope, `/project-components/${encodeURIComponent(componentId)}/deletion`, ProjectDesignRuntimeDeletionResponseSchema);

export const getProjectDesignRuntimeHistory = (scope: ProjectDesignRuntimeScope, componentId: string) =>
  request(scope, `/project-components/${encodeURIComponent(componentId)}/history`, ProjectDesignRuntimeHistoryResponseSchema);

export const stageProjectDesignRuntimeComponent = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeStageComponentRequest) =>
  request(scope, '/component-changes', ProjectDesignRuntimeStageComponentResponseSchema, 'POST', ProjectDesignRuntimeStageComponentRequestSchema.parse(input));

export const getProjectDesignRuntimeChange = (scope: ProjectDesignRuntimeScope, draftId: string) =>
  request(scope, `/component-changes/${encodeURIComponent(draftId)}`, ProjectDesignRuntimeChangeResponseSchema);

export const publishProjectDesignRuntimeComponent = (scope: ProjectDesignRuntimeScope, draftId: string, input: ProjectDesignRuntimePublishComponentRequest) =>
  request(scope, `/component-changes/${encodeURIComponent(draftId)}/publish`, ProjectDesignRuntimePublishComponentResponseSchema, 'POST', ProjectDesignRuntimePublishComponentRequestSchema.parse(input));

export const discardProjectDesignRuntimeComponent = (scope: ProjectDesignRuntimeScope, draftId: string, input: ProjectDesignRuntimeRevisionRequest) =>
  request(scope, `/component-changes/${encodeURIComponent(draftId)}`, ProjectDesignRuntimeResponseSchema, 'DELETE', ProjectDesignRuntimeRevisionRequestSchema.parse(input));

export const undoProjectDesignRuntimeComponent = (scope: ProjectDesignRuntimeScope, componentId: string, input: ProjectDesignRuntimeUndoComponentRequest) =>
  request(scope, `/project-components/${encodeURIComponent(componentId)}/undo`, ProjectDesignRuntimeStageComponentResponseSchema, 'POST', ProjectDesignRuntimeUndoComponentRequestSchema.parse(input));

export const deleteProjectDesignRuntimeComponent = (scope: ProjectDesignRuntimeScope, componentId: string, input: ProjectDesignRuntimeDeleteComponentRequest) =>
  request(scope, `/project-components/${encodeURIComponent(componentId)}`, ProjectDesignRuntimeResponseSchema, 'DELETE', ProjectDesignRuntimeDeleteComponentRequestSchema.parse(input));

export const detachProjectDesignRuntimeInstance = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeDetachRequest) =>
  request(scope, '/instances/detach', ProjectDesignRuntimeDetachResponseSchema, 'POST', ProjectDesignRuntimeDetachRequestSchema.parse(input));


export const listProjectDesignRuntimeVersions = (scope: ProjectDesignRuntimeScope) =>
  request(scope, '/versions', ProjectDesignRuntimeVersionsResponseSchema);

export const getProjectDesignRuntimeVersion = (scope: ProjectDesignRuntimeScope, designSystemId: string, version: string) => {
  const id = DesignEntityIdSchema.parse(designSystemId);
  const exactVersion = DesignSystemSemVerSchema.parse(version);
  return request(scope, `/versions/${encodeURIComponent(id)}/${encodeURIComponent(exactVersion)}`, ProjectDesignRuntimeVersionResponseSchema).then((result) => {
    if (result.version.package.id !== id || result.version.package.version !== exactVersion) throw new Error('The server returned a different design-system version.');
    return result;
  });
};

export const importProjectDesignRuntimeVersion = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeImportVersionRequest) =>
  request(scope, '/versions', ProjectDesignRuntimePublishVersionResponseSchema, 'POST', ProjectDesignRuntimeImportVersionRequestSchema.parse(input));

export const publishProjectDesignRuntimeVersion = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimePublishCurrentRequest) =>
  request(scope, '/versions/publish-current', ProjectDesignRuntimePublishVersionResponseSchema, 'POST', ProjectDesignRuntimePublishCurrentRequestSchema.parse(input));

export const activateProjectDesignRuntimeDependency = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeActivateDependencyRequest) =>
  request(scope, '/dependency', ProjectDesignRuntimeResponseSchema, 'POST', ProjectDesignRuntimeActivateDependencyRequestSchema.parse(input));

export const clearProjectDesignRuntimeDependency = (scope: ProjectDesignRuntimeScope, input: ProjectDesignRuntimeRevisionRequest) =>
  request(scope, '/dependency', ProjectDesignRuntimeResponseSchema, 'DELETE', ProjectDesignRuntimeRevisionRequestSchema.parse(input));

export const resolveProjectDesignRuntimeDependency = (scope: ProjectDesignRuntimeScope) =>
  request(scope, '/dependency/resolve', ProjectDesignRuntimeDependencyResponseSchema);
