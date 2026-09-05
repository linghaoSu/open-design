import {
  ProjectDesignRuntimeBindRequestSchema,
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

  constructor(readonly status: number, readonly apiError: ApiErrorResponse['error']) {
    super(apiError.message);
    this.name = 'ProjectDesignRuntimeError';
    const details = apiError.details && typeof apiError.details === 'object' && !Array.isArray(apiError.details)
      ? apiError.details : {};
    const diagnostics = ValidationDiagnosticSchema.array().safeParse(details.diagnostics);
    this.diagnostics = diagnostics.success ? diagnostics.data : [];
    this.currentRevision = typeof details.currentRevision === 'number' ? details.currentRevision : undefined;
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
