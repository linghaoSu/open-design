import {
  ComponentPreviewRequestSchema, ComponentPreviewResponseSchema,
  type ComponentPreviewRequest, type JsonValue, type ApiErrorResponse,
} from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { ProjectDesignRuntimeError, type ProjectDesignRuntimeScope } from './design-runtime';

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

export async function createReactComponentPreview(scope: ProjectDesignRuntimeScope, input: ComponentPreviewRequest) {
  const body = ComponentPreviewRequestSchema.parse(input);
  const headers: Record<string, string> = Object.fromEntries(new Headers(scope.workspaceContext ? workspaceProjectHeaders(scope.workspaceContext) : undefined));
  headers['Content-Type'] = 'application/json';
  const response = await fetch(`/api/projects/${encodeURIComponent(scope.projectId)}/design-runtime/component-preview`, {
    method: 'POST', headers, cache: 'no-store', signal: scope.signal, body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = (payload as Partial<ApiErrorResponse> | null)?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') throw new ProjectDesignRuntimeError(response.status, error);
    throw new Error(`Component preview request failed (${response.status}).`);
  }
  const result = ComponentPreviewResponseSchema.parse(payload);
  if (result.projectId !== scope.projectId || result.sourcePath !== body.sourcePath || result.requestedExport !== body.exportName
    || canonical(result.requestedProps) !== canonical(body.props ?? {})) {
    throw new Error('The component preview does not match the requested project, source, export, and props.');
  }
  return result;
}
