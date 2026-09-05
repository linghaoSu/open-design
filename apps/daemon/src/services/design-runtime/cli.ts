import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  createApiError,
  createApiErrorResponse,
  ProjectDesignRuntimeBindRequestSchema,
  ProjectDesignRuntimeCodeComponentsResponseSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeComponentsResponseSchema,
  ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeValidateRequestSchema,
  ProjectDesignRuntimeValidateResponseSchema,
  type ProjectDesignRuntimeResponse,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { resolveDaemonUrl } from '../../daemon-url.js';

export const DESIGN_RUNTIME_CLI_USAGE = `Usage:
  od design-runtime get <projectId>
  od design-runtime compile <projectId> --prompt-file <path|->
  od design-runtime components <projectId> [--query <text>]
  od design-runtime code-components <projectId> [--query <text>]
  od design-runtime bind <projectId> --prompt-file <path|->
  od design-runtime unbind <projectId> <bindingId>
  od design-runtime revalidate <projectId> <bindingId>
  od design-runtime resolve <projectId> <bindingId>
  od design-runtime validate <projectId> --prompt-file <path|->

Common options:
  --json                     Emit the daemon JSON response.
  --daemon-url <url>          Override the daemon HTTP base.
  --workspace <id>            Exact Workspace for bound project requests.
  --workspace-member <id>     Exact caller membership for bound projects.
  --expected-revision <n>     Snapshot revision for compile/bind/unbind/revalidate.
  --prompt-file <path|->      Read a JSON request from a local file or stdin.

Compile JSON: {"designSystemId":"acme","selections":[{"sourcePath":"src/Button.tsx","exportName":"Button","componentId":"button","codeComponentId":"acme/Button"}]}
Bind JSON: {"binding":{"schemaVersion":1,"id":"binding:button","componentRef":"ds:acme/button","framework":"react","status":"bound","verified":true,"codeComponentId":"acme/Button"}}
Validate JSON: {"component":"ds:acme/button","props":{"variant":"primary"}}

Compile reads source files inside the project through the daemon. The JSON request
contains project-relative paths, never source text. Mutation requests may include
expectedRevision; when neither the body nor flag supplies it, the CLI reads the
current state once and submits that revision. Conflicts are reported without retry.
Validation errors and unresolved bindings exit 1; malformed arguments exit 2.
`;

interface DesignRuntimeCliDependencies {
  workspaceHeaders: (flags: Record<string, string | boolean | undefined>) => Record<string, string> | null;
}

class CliFailure extends Error {
  constructor(readonly exitCode: number, readonly body: unknown, readonly status?: number) {
    super('Design runtime command failed.');
  }
}

function invalidInput(message: string): never {
  throw new CliFailure(2, createApiErrorResponse(createApiError('BAD_REQUEST', message)));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseInput<T>(schema: { parse: (value: unknown) => T }, value: unknown): T {
  try { return schema.parse(value); } catch (error) {
    return invalidInput(error instanceof Error ? error.message : String(error));
  }
}

async function readRequest(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    if (file === '-') {
      process.stdin.setEncoding('utf8');
      text = '';
      for await (const chunk of process.stdin) text += chunk;
    } else {
      text = await readFile(file, 'utf8');
    }
  } catch (error) {
    return invalidInput(`Cannot read --prompt-file: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const value = asObject(JSON.parse(text));
    if (!value) return invalidInput('--prompt-file must contain a JSON object.');
    return value;
  } catch (error) {
    if (error instanceof CliFailure) throw error;
    return invalidInput(`Invalid JSON in --prompt-file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeFailure(failure: CliFailure, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ ...(failure.status === undefined ? {} : { status: failure.status }), ...asObject(failure.body) })}\n`);
    return;
  }
  const error = asObject(asObject(failure.body)?.error);
  process.stderr.write(`${String(error?.code ?? 'INTERNAL_ERROR')}: ${String(error?.message ?? 'Daemon request failed.')}\n`);
  if (error?.details !== undefined) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
}

function printState({ state }: ProjectDesignRuntimeResponse): void {
  process.stdout.write(`Revision ${state.revision}\nDesign system: ${state.registry?.id ?? '(not compiled)'}\nComponents: ${state.registry?.components.length ?? 0}\nCode components: ${state.codeIndex.components.length}\nBindings: ${state.bindings.bindings.length}\n`);
}

function printDiagnostics(diagnostics: ValidationDiagnostic[]): void {
  if (!diagnostics.length) process.stdout.write('Valid: no diagnostics.\n');
  for (const diagnostic of diagnostics) {
    process.stdout.write(`${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
  }
}

/** HTTP-only client. The dispatcher supplies the CLI's existing explicit workspace policy. */
export async function runDesignRuntimeCli(args: string[], deps: DesignRuntimeCliDependencies): Promise<{ exitCode: number }> {
  let json = args.includes('--json');
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        allowPositionals: true,
        tokens: true,
        options: {
          json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
          'daemon-url': { type: 'string' }, workspace: { type: 'string' }, 'workspace-member': { type: 'string' },
          'prompt-file': { type: 'string' }, 'expected-revision': { type: 'string' }, query: { type: 'string' },
        },
      });
    } catch (error) {
      return invalidInput(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals, tokens } = parsed;
    json = values.json === true;
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.kind !== 'option') continue;
      if (seen.has(token.name)) invalidInput(`Duplicate option --${token.name}.`);
      seen.add(token.name);
    }
    const [command, projectId, bindingId, ...extra] = positionals;
    if (values.help || command === 'help' || command === undefined) {
      process.stdout.write(DESIGN_RUNTIME_CLI_USAGE);
      return { exitCode: command === undefined && !values.help ? 2 : 0 };
    }
    const commands = ['get', 'compile', 'components', 'code-components', 'bind', 'unbind', 'revalidate', 'resolve', 'validate'];
    if (!commands.includes(command)) invalidInput(`Unknown design-runtime command: ${command}.`);
    const needsBindingId = ['unbind', 'revalidate', 'resolve'].includes(command);
    if (!projectId || extra.length || (needsBindingId ? !bindingId : bindingId !== undefined)) {
      invalidInput(`Usage: od design-runtime ${command} <projectId>${needsBindingId ? ' <bindingId>' : ''}.`);
    }
    const mutates = ['compile', 'bind', 'unbind', 'revalidate'].includes(command);
    const needsInput = ['compile', 'bind', 'validate'].includes(command);
    if (needsInput && !values['prompt-file']) invalidInput(`${command} requires --prompt-file <path|->.`);
    if (!needsInput && values['prompt-file'] !== undefined) invalidInput(`--prompt-file is not supported by ${command}.`);
    if (!mutates && values['expected-revision'] !== undefined) invalidInput(`--expected-revision is not supported by ${command}.`);
    if (!['components', 'code-components'].includes(command) && values.query !== undefined) invalidInput(`--query is not supported by ${command}.`);
    const headers = deps.workspaceHeaders(values) ?? {};
    const input = needsInput ? await readRequest(values['prompt-file']!) : {};
    if (values['expected-revision'] !== undefined && !/^\d+$/.test(values['expected-revision'])) {
      invalidInput('--expected-revision must be a nonnegative integer.');
    }
    const flagRevision = values['expected-revision'] === undefined ? undefined
      : parseInput(ProjectDesignRuntimeRevisionRequestSchema, { expectedRevision: Number(values['expected-revision']) }).expectedRevision;
    if (flagRevision !== undefined && input.expectedRevision !== undefined && input.expectedRevision !== flagRevision) {
      invalidInput('--expected-revision conflicts with expectedRevision in the JSON request.');
    }
    let expectedRevision = flagRevision ?? input.expectedRevision;
    // Validate before any HTTP call, even when the revision must be fetched afterward.
    const provisional = { ...input, expectedRevision: expectedRevision === undefined ? 0 : expectedRevision };
    if (command === 'compile') parseInput(ProjectDesignRuntimeCompileRequestSchema, provisional);
    if (command === 'bind') parseInput(ProjectDesignRuntimeBindRequestSchema, provisional);
    if (command === 'validate') parseInput(ProjectDesignRuntimeValidateRequestSchema, input);
    if (mutates) parseInput(ProjectDesignRuntimeRevisionRequestSchema, { expectedRevision: expectedRevision === undefined ? 0 : expectedRevision });

    const base = (await resolveDaemonUrl({ flagUrl: values['daemon-url'] ?? null })).replace(/\/$/, '');
    const prefix = `${base}/api/projects/${encodeURIComponent(projectId!)}/design-runtime`;
    async function request<T>(path: string, schema: { parse: (value: unknown) => T }, method = 'GET', body?: unknown): Promise<T> {
      const response = await fetch(`${prefix}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let data: unknown;
      try { data = await response.json(); } catch {
        throw new CliFailure(1, createApiErrorResponse(createApiError('INTERNAL_ERROR', `Daemon returned HTTP ${response.status} without a JSON response.`)), response.status);
      }
      if (!response.ok) throw new CliFailure(1, data, response.status);
      try { return schema.parse(data); } catch (error) {
        throw new CliFailure(1, createApiErrorResponse(createApiError('INTERNAL_ERROR', `Daemon response did not match the contract: ${error instanceof Error ? error.message : String(error)}`)));
      }
    }
    if (mutates && expectedRevision === undefined) expectedRevision = (await request('', ProjectDesignRuntimeResponseSchema)).state.revision;
    const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
    if (command === 'components' || command === 'code-components') {
      const query = values.query === undefined ? '' : `?${new URLSearchParams({ query: values.query })}`;
      const data = command === 'components'
        ? await request(`/components${query}`, ProjectDesignRuntimeComponentsResponseSchema)
        : await request(`/code-components${query}`, ProjectDesignRuntimeCodeComponentsResponseSchema);
      if (json) output(data);
      else for (const component of data.components) process.stdout.write(`${component.id}\t${component.name}\n`);
      return { exitCode: 0 };
    }
    if (command === 'resolve') {
      const data = await request(`/bindings/${encodeURIComponent(bindingId!)}/resolve`, ProjectDesignRuntimeResolveResponseSchema);
      if (json) output(data);
      else if (data.resolution.ok) process.stdout.write(`${data.resolution.component.id}\t${data.resolution.codeComponent.id}\t${data.resolution.codeComponent.sourcePath}\n`);
      else printDiagnostics(data.resolution.diagnostics);
      return { exitCode: data.resolution.ok ? 0 : 1 };
    }
    if (command === 'validate') {
      const data = await request('/validate', ProjectDesignRuntimeValidateResponseSchema, 'POST', input);
      if (json) output(data); else printDiagnostics(data.diagnostics);
      return { exitCode: data.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0 };
    }
    let data: ProjectDesignRuntimeResponse;
    if (command === 'get') data = await request('', ProjectDesignRuntimeResponseSchema);
    else if (command === 'compile') data = await request('/compile', ProjectDesignRuntimeResponseSchema, 'POST', { ...input, expectedRevision });
    else if (command === 'bind') {
      const body = parseInput(ProjectDesignRuntimeBindRequestSchema, { ...input, expectedRevision });
      data = await request(`/bindings/${encodeURIComponent(body.binding.id)}`, ProjectDesignRuntimeResponseSchema, 'PUT', body);
    } else {
      const path = `/bindings/${encodeURIComponent(bindingId!)}${command === 'revalidate' ? '/revalidate' : ''}`;
      data = await request(path, ProjectDesignRuntimeResponseSchema, command === 'revalidate' ? 'POST' : 'DELETE', { expectedRevision });
    }
    if (json) output(data); else printState(data);
    return { exitCode: 0 };
  } catch (error) {
    const failure = error instanceof CliFailure ? error
      : new CliFailure(1, createApiErrorResponse(createApiError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))));
    writeFailure(failure, json);
    return { exitCode: failure.exitCode };
  }
}
