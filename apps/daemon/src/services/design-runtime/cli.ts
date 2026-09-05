import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  createApiError,
  createApiErrorResponse,
  DesignEntityIdSchema,
  ProjectComponentDeleteRequestSchema,
  ProjectDesignRuntimeBindRequestSchema,
  ProjectDesignRuntimeCodeComponentsResponseSchema,
  ProjectDesignRuntimeCompileRequestSchema,
  ProjectDesignRuntimeComponentsResponseSchema,
  ProjectDesignRuntimeResponseSchema,
  ProjectDesignRuntimeResolveResponseSchema,
  ProjectDesignRuntimeRevisionRequestSchema,
  ProjectDesignRuntimeValidateRequestSchema,
  ProjectDesignRuntimeValidateResponseSchema,
  ProjectDesignRuntimeSaveDocumentRequestSchema,
  ProjectDesignRuntimeValidateDocumentRequestSchema,
  ProjectDesignRuntimeDocumentResponseSchema,
  ProjectDesignRuntimeProjectComponentsResponseSchema,
  ProjectDesignRuntimeReferencesRequestSchema,
  ProjectDesignRuntimeReferencesResponseSchema,
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
  type ComponentReferenceOwner,
  type ReferenceGraphQueryResult,
  type SharedComponentImpact,
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
  od design-runtime save-document <projectId> --prompt-file <path|->
  od design-runtime validate-document <projectId> --prompt-file <path|->
  od design-runtime resolve-document <projectId>
  od design-runtime project-components <projectId> [--query <text>]
  od design-runtime references <projectId> <componentRef>
  od design-runtime deletion <projectId> <componentId>
  od design-runtime history <projectId> <componentId>
  od design-runtime stage <projectId> --prompt-file <path|->
  od design-runtime inspect <projectId> <draftId>
  od design-runtime publish <projectId> <draftId> --prompt-file <path|->
  od design-runtime discard <projectId> <draftId>
  od design-runtime undo <projectId> <componentId> --prompt-file <path|->
  od design-runtime delete <projectId> <componentId> --prompt-file <path|->
  od design-runtime detach <projectId> --prompt-file <path|->

Common options:
  --json                     Emit the daemon JSON response.
  --daemon-url <url>          Override the daemon HTTP base.
  --workspace <id>            Exact Workspace for bound project requests.
  --workspace-member <id>     Exact caller membership for bound projects.
  --expected-revision <n>     Snapshot revision for persisted mutations.
  --prompt-file <path|->      Read a JSON request from a local file or stdin.

Compile JSON: {"designSystemId":"acme","selections":[{"sourcePath":"src/Button.tsx","exportName":"Button","componentId":"button","codeComponentId":"acme/Button"}]}
Bind JSON: {"binding":{"schemaVersion":1,"id":"binding:button","componentRef":"ds:acme/button","framework":"react","status":"bound","verified":true,"codeComponentId":"acme/Button"}}
Validate JSON: {"component":"ds:acme/button","props":{"variant":"primary"}}
Save/validate document JSON: {"document":{"schemaVersion":1,"id":"design","screens":[]}}
Stage JSON: {"draftId":"edit-card","expectedDefinitionRevision":0,"definition":{"schemaVersion":1,"id":"Card","name":"Card","revision":1,"props":{},"propMappings":[],"template":{"schemaVersion":1,"id":"label","type":"text","text":"Card"}}}
Publish JSON: {"expectedDefinitionRevision":0}
Undo JSON: {"draftId":"undo-card","expectedDefinitionRevision":2,"restoreDefinitionRevision":1}
Delete JSON: {"action":{"type":"reject"}} (alternatives: replace with replacementRef, detach, delete-instances)
Detach JSON: {"instance":{"schemaVersion":1,"id":"card-instance","type":"instance","ref":"local:Card","overrides":[]},"mode":"guided"}

Compile reads source files inside the project through the daemon. The JSON request
contains project-relative paths, never source text. Mutation requests may include
expectedRevision; when neither the body nor flag supplies it, the CLI reads the
current state once and submits that revision. Conflicts are reported without retry.
Definition revisions are explicit in stage/publish/undo JSON and are never inferred.
Component IDs identify local definitions; references use local:Card or ds:acme/button.
Stage and undo save drafts for review; only publish changes live definitions.
Detach returns a materialized node; save-document persists an edited document.
Validation/impact errors, unresolved bindings and blocked deletion checks exit 1;
malformed arguments exit 2. A staged draft is retained even when its impact exits 1.
`;

interface CommandSpec {
  argument?: 'bindingId' | 'componentId' | 'componentRef' | 'draftId';
  mutates?: boolean;
  input?: { parse: (value: unknown) => unknown };
  query?: boolean;
}

const COMMANDS: Record<string, CommandSpec> = {
  get: {},
  compile: { mutates: true, input: ProjectDesignRuntimeCompileRequestSchema },
  components: { query: true },
  'code-components': { query: true },
  bind: { mutates: true, input: ProjectDesignRuntimeBindRequestSchema },
  unbind: { argument: 'bindingId', mutates: true },
  revalidate: { argument: 'bindingId', mutates: true },
  resolve: { argument: 'bindingId' },
  validate: { input: ProjectDesignRuntimeValidateRequestSchema },
  'save-document': { mutates: true, input: ProjectDesignRuntimeSaveDocumentRequestSchema },
  'validate-document': { input: ProjectDesignRuntimeValidateDocumentRequestSchema },
  'resolve-document': {},
  'project-components': { query: true },
  references: { argument: 'componentRef' },
  deletion: { argument: 'componentId' },
  history: { argument: 'componentId' },
  stage: { mutates: true, input: ProjectDesignRuntimeStageComponentRequestSchema },
  inspect: { argument: 'draftId' },
  publish: { argument: 'draftId', mutates: true, input: ProjectDesignRuntimePublishComponentRequestSchema },
  discard: { argument: 'draftId', mutates: true },
  undo: { argument: 'componentId', mutates: true, input: ProjectDesignRuntimeUndoComponentRequestSchema },
  delete: { argument: 'componentId', mutates: true, input: ProjectDesignRuntimeDeleteComponentRequestSchema },
  detach: { input: ProjectDesignRuntimeDetachRequestSchema },
};

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
  process.stdout.write(`Revision ${state.revision}\nDesign system: ${state.registry?.id ?? '(not compiled)'}\nComponents: ${state.registry?.components.length ?? 0}\nCode components: ${state.codeIndex.components.length}\nBindings: ${state.bindings.bindings.length}\nLocal components: ${state.projectComponents.components.length}\nScreens: ${state.document?.screens.length ?? 0}\nPending drafts: ${state.sharedChanges.drafts.length}\n`);
}

function diagnosticsExitCode(diagnostics: ValidationDiagnostic[]): number {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;
}

function ownerLabel(owner: ComponentReferenceOwner): string {
  return owner.kind === 'component' ? owner.componentRef : `${owner.documentId}/${owner.screenId}`;
}

function printReferences(references: ReferenceGraphQueryResult): void {
  process.stdout.write(`${references.target}: ${references.directUsages.length} direct usages, ${references.transitiveUsages.length} dependent owners, ${references.affectedScreens.length} affected screens\n`);
  for (const usage of references.directUsages) process.stdout.write(`Usage: ${ownerLabel(usage.owner)} node ${usage.nodeId}\n`);
  for (const screen of references.affectedScreens) process.stdout.write(`Screen: ${ownerLabel(screen)}\n`);
  for (const chain of references.chains) process.stdout.write(`Chain: ${references.target} <- ${chain.map((usage) => ownerLabel(usage.owner)).join(' <- ')}\n`);
  if (references.diagnostics.length) printDiagnostics(references.diagnostics);
}

function printImpact(impact: SharedComponentImpact): void {
  process.stdout.write(`${impact.componentRef}: definition revision ${impact.baseRevision} -> ${impact.proposedRevision}\n`);
  printReferences(impact.usages);
  printDiagnostics(impact.diagnostics);
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
    const [command, projectId, targetId, ...extra] = positionals;
    if (values.help || command === 'help' || command === undefined) {
      process.stdout.write(DESIGN_RUNTIME_CLI_USAGE);
      return { exitCode: command === undefined && !values.help ? 2 : 0 };
    }
    if (!Object.hasOwn(COMMANDS, command)) invalidInput(`Unknown design-runtime command: ${command}.`);
    const spec = COMMANDS[command]!;
    if (!projectId || extra.length || (spec.argument ? !targetId : targetId !== undefined)) {
      invalidInput(`Usage: od design-runtime ${command} <projectId>${spec.argument ? ` <${spec.argument}>` : ''}.`);
    }
    if (spec.argument === 'componentId' || spec.argument === 'draftId') parseInput(DesignEntityIdSchema, targetId);
    if (spec.argument === 'componentRef') parseInput(ProjectDesignRuntimeReferencesRequestSchema, { componentRef: targetId });
    if (spec.input && !values['prompt-file']) invalidInput(`${command} requires --prompt-file <path|->.`);
    if (!spec.input && values['prompt-file'] !== undefined) invalidInput(`--prompt-file is not supported by ${command}.`);
    if (!spec.mutates && values['expected-revision'] !== undefined) invalidInput(`--expected-revision is not supported by ${command}.`);
    if (!spec.query && values.query !== undefined) invalidInput(`--query is not supported by ${command}.`);
    const headers = deps.workspaceHeaders(values) ?? {};
    let input = spec.input ? await readRequest(values['prompt-file']!) : {};
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
    const provisional = spec.mutates ? { ...input, expectedRevision: expectedRevision === undefined ? 0 : expectedRevision } : input;
    if (spec.input) input = parseInput(spec.input, provisional) as Record<string, unknown>;
    if (spec.mutates) parseInput(ProjectDesignRuntimeRevisionRequestSchema, { expectedRevision: expectedRevision === undefined ? 0 : expectedRevision });
    if (command === 'delete') parseInput(ProjectComponentDeleteRequestSchema, { componentRef: `local:${targetId!}`, action: input.action });

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
    if (spec.mutates && expectedRevision === undefined) expectedRevision = (await request('', ProjectDesignRuntimeResponseSchema)).state.revision;
    const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
    const encodedTarget = encodeURIComponent(targetId ?? '');
    const mutationBody = { ...input, expectedRevision };
    if (command === 'project-components') {
      const query = values.query === undefined ? '' : `?${new URLSearchParams({ query: values.query })}`;
      const data = await request(`/project-components${query}`, ProjectDesignRuntimeProjectComponentsResponseSchema);
      if (json) output(data);
      else for (const component of data.components) process.stdout.write(`${component.id}\t${component.name}\trevision ${component.revision}\n`);
      return { exitCode: 0 };
    }
    if (command === 'references') {
      const data = await request(`/references?${new URLSearchParams({ componentRef: targetId! })}`, ProjectDesignRuntimeReferencesResponseSchema);
      if (json) output(data); else printReferences(data.references);
      return { exitCode: diagnosticsExitCode(data.references.diagnostics) };
    }
    if (command === 'deletion') {
      const data = await request(`/project-components/${encodedTarget}/deletion`, ProjectDesignRuntimeDeletionResponseSchema);
      if (json) output(data);
      else {
        process.stdout.write(`${data.analysis.canDelete ? 'Can delete' : 'Deletion blocked'}: ${data.analysis.componentRef}\n`);
        printReferences(data.analysis.usages);
        if (data.analysis.diagnostics.length) printDiagnostics(data.analysis.diagnostics);
      }
      return { exitCode: data.analysis.canDelete ? 0 : 1 };
    }
    if (command === 'history') {
      const data = await request(`/project-components/${encodedTarget}/history`, ProjectDesignRuntimeHistoryResponseSchema);
      if (json) output(data);
      else if (!data.history.length) process.stdout.write('No published history.\n');
      else for (const entry of data.history) process.stdout.write(`${entry.componentRef}\trevision ${entry.definition.revision}\t${entry.changeId ?? 'imported baseline'}\t${entry.definition.name}\n`);
      return { exitCode: 0 };
    }
    if (command === 'validate-document' || command === 'resolve-document') {
      const data = command === 'validate-document'
        ? await request('/document/validate', ProjectDesignRuntimeDocumentResponseSchema, 'POST', input)
        : await request('/document/resolve', ProjectDesignRuntimeDocumentResponseSchema);
      if (json) output(data);
      else {
        process.stdout.write(`Revision ${data.revision}\nResolved document: ${data.resolution.document?.id ?? '(unavailable)'}\nScreens: ${data.resolution.document?.screens.length ?? 0}\n`);
        printDiagnostics(data.resolution.diagnostics);
      }
      return { exitCode: diagnosticsExitCode(data.resolution.diagnostics) };
    }
    if (command === 'detach') {
      const data = await request('/instances/detach', ProjectDesignRuntimeDetachResponseSchema, 'POST', input);
      if (json) output(data);
      else {
        if (data.node) process.stdout.write(`Detached node (not saved):\n${JSON.stringify(data.node, null, 2)}\n`);
        printDiagnostics(data.diagnostics);
      }
      return { exitCode: diagnosticsExitCode(data.diagnostics) };
    }
    if (command === 'stage' || command === 'undo') {
      const data = await request(command === 'stage' ? '/component-changes' : `/project-components/${encodedTarget}/undo`, ProjectDesignRuntimeStageComponentResponseSchema, 'POST', mutationBody);
      if (json) output(data);
      else {
        process.stdout.write(`Draft saved: ${data.draft.id}\nRevision ${data.state.revision}\n`);
        printImpact(data.impact);
      }
      return { exitCode: diagnosticsExitCode(data.impact.diagnostics) };
    }
    if (command === 'inspect') {
      const data = await request(`/component-changes/${encodedTarget}`, ProjectDesignRuntimeChangeResponseSchema);
      if (json) output(data);
      else { process.stdout.write(`Draft: ${data.draft.id}\nRevision ${data.revision}\n`); printImpact(data.impact); }
      return { exitCode: diagnosticsExitCode(data.impact.diagnostics) };
    }
    if (command === 'publish') {
      const data = await request(`/component-changes/${encodedTarget}/publish`, ProjectDesignRuntimePublishComponentResponseSchema, 'POST', mutationBody);
      if (json) output(data);
      else { process.stdout.write(`Published: ${targetId!}\n`); printState(data); printImpact(data.impact); }
      return { exitCode: diagnosticsExitCode(data.impact.diagnostics) };
    }
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
      const data = await request(`/bindings/${encodedTarget}/resolve`, ProjectDesignRuntimeResolveResponseSchema);
      if (json) output(data);
      else if (data.resolution.ok) process.stdout.write(`${data.resolution.component.id}\t${data.resolution.codeComponent.id}\t${data.resolution.codeComponent.sourcePath}\n`);
      else printDiagnostics(data.resolution.diagnostics);
      return { exitCode: data.resolution.ok ? 0 : 1 };
    }
    if (command === 'validate') {
      const data = await request('/validate', ProjectDesignRuntimeValidateResponseSchema, 'POST', input);
      if (json) output(data); else printDiagnostics(data.diagnostics);
      return { exitCode: diagnosticsExitCode(data.diagnostics) };
    }
    let data: ProjectDesignRuntimeResponse;
    if (command === 'get') data = await request('', ProjectDesignRuntimeResponseSchema);
    else if (command === 'compile') data = await request('/compile', ProjectDesignRuntimeResponseSchema, 'POST', mutationBody);
    else if (command === 'save-document') data = await request('/document', ProjectDesignRuntimeResponseSchema, 'PUT', mutationBody);
    else if (command === 'discard') data = await request(`/component-changes/${encodedTarget}`, ProjectDesignRuntimeResponseSchema, 'DELETE', { expectedRevision });
    else if (command === 'delete') data = await request(`/project-components/${encodedTarget}`, ProjectDesignRuntimeResponseSchema, 'DELETE', mutationBody);
    else if (command === 'bind') {
      const body = parseInput(ProjectDesignRuntimeBindRequestSchema, { ...input, expectedRevision });
      data = await request(`/bindings/${encodeURIComponent(body.binding.id)}`, ProjectDesignRuntimeResponseSchema, 'PUT', body);
    } else {
      const path = `/bindings/${encodedTarget}${command === 'revalidate' ? '/revalidate' : ''}`;
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
