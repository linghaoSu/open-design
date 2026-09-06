import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultProjectDesignValidationSettings,
  parseDesignRepairTurnV1,
  type DesignGenerationReport,
  type DesignGenerationTaskProjection,
} from '@open-design/contracts';
import { register } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface RunView {
  id: string;
  status: string;
  error?: string;
  errorCode?: string;
  designGeneration?: DesignGenerationReport;
  designGenerationTask?: DesignGenerationTaskProjection;
}

interface ProviderRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

interface Invocation {
  prompt: string;
  args: string[];
  cwd: string;
  provider: {
    npm: string;
    options: { baseURL: string; apiKey: string };
    models: Record<string, { name: string }>;
  };
}

const model = 'local-repair-model';
const fixtureKey = 'local-only-byok-repair-key';
const invalidHtml = '<!doctype html><html><body><main style="color:#ff0000">Initial invalid source</main></body></html>';
const correctedHtml = '<!doctype html><html><body><main>Corrected BYOK source</main></body></html>';

describe('BYOK OpenCode automatic design repair', () => {
  const originalData = process.env.OD_DATA_DIR;
  let directory: string | undefined;
  let providerServer: Server | undefined;
  let started: { url: string; server: Server; shutdown?: () => Promise<void> | void } | undefined;

  afterEach(async () => {
    await started?.shutdown?.();
    started?.server.closeAllConnections();
    if (started) await new Promise<void>((resolve) => started!.server.close(() => resolve()));
    started = undefined;
    providerServer?.closeAllConnections();
    if (providerServer) await new Promise<void>((resolve) => providerServer!.close(() => resolve()));
    providerServer = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    if (originalData === undefined) delete process.env.OD_DATA_DIR; else process.env.OD_DATA_DIR = originalData;
    register.clear();
    vi.resetModules();
  });

  it('repairs actual source with the same provider/model and exact persisted envelope delivered to runtime stdin', async () => {
    const providerCalls: Array<{ url: string | undefined; authorization: string | undefined; body: ProviderRequest }> = [];
    const providerFailures: string[] = [];
    providerServer = createServer(async (req, res) => {
      try {
        let raw = '';
        for await (const chunk of req) raw += String(chunk);
        const body = JSON.parse(raw) as ProviderRequest;
        providerCalls.push({ url: req.url, authorization: req.headers.authorization, body });
        if (req.url !== '/v1/chat/completions' || req.headers.authorization !== `Bearer ${fixtureKey}` || body.model !== model) {
          throw new Error('The runtime changed the configured provider route, credentials, or model.');
        }
        const prompt = body.messages[0]!.content;
        let repair = false;
        try { repair = JSON.parse(prompt).schema === 'open-design.design-repair-turn/v1'; } catch { /* The initial prompt is plain text. */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'local-completion', object: 'chat.completion', model,
          choices: [{ index: 0, message: { role: 'assistant', content: repair ? correctedHtml : invalidHtml }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      } catch (error) {
        providerFailures.push(error instanceof Error ? error.message : String(error));
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Local fixture rejected the provider request.' } }));
      }
    });
    await new Promise<void>((resolve) => providerServer!.listen(0, '127.0.0.1', resolve));
    const address = providerServer.address();
    if (!address || typeof address === 'string') throw new Error('Local provider did not bind a TCP port.');
    const providerUrl = `http://127.0.0.1:${address.port}/v1`;
    directory = await mkdtemp(path.join(os.tmpdir(), 'od-byok-generation-repair-'));
    const binary = path.join(directory, 'opencode-fixture');
    const invocationPath = path.join(directory, 'invocations.jsonl');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('opencode 1.18.18-fixture'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--dangerously-skip-permissions --format --dir -m'); process.exit(0); }
if (process.argv.includes('models')) { console.log(${JSON.stringify(`open-design-byok/${model}`)}); process.exit(0); }
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  try {
    const args = process.argv.slice(2);
    const provider = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider['open-design-byok'];
    fs.appendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ prompt, args, cwd: process.cwd(), provider }) + '\\n');
    const selectedModel = args[args.indexOf('-m') + 1];
    const model = selectedModel.replace(/^open-design-byok\\//, '');
    if (!provider.models[model]) throw new Error('Selected model is absent from provider.models: ' + model);
    const reference = provider.options.apiKey.match(/^\\{env:([^}]+)\\}$/);
    if (!reference) throw new Error('Expected a run-scoped API key environment reference.');
    const response = await fetch(provider.options.baseURL + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env[reference[1]] },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) throw new Error('Local provider request failed: ' + response.status);
    const html = (await response.json()).choices[0].message.content;
    fs.writeFileSync('index.html', html);
    const events = [
      { type: 'step_start' },
      { type: 'tool_use', part: { tool: 'write', callID: 'write-index', state: { status: 'completed', input: { filePath: 'index.html', content: html }, output: 'Saved index.html' } } },
      { type: 'text', part: { text: 'Created index.html.' } },
      { type: 'step_finish', part: { tokens: { input: 1, output: 1 } } },
    ];
    process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n', () => process.exit(0));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
});
`, { mode: 0o755 });
    process.env.OD_DATA_DIR = directory;
    register.clear();
    vi.resetModules();
    const { startServer } = await import('../../src/server.js');
    started = await startServer({ port: 0, returnServer: true }) as typeof started;
    const request = async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(`${started!.url}${route}`, {
        method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.headers.get('content-type')).toContain('application/json');
      return { status: response.status, body: await response.json() as T };
    };
    const terminalEvents = async (runId: string) => {
      const response = await fetch(`${started!.url}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(20_000) });
      expect(response.status).toBe(200);
      await response.text();
      return (await request<RunView>('GET', `/api/runs/${runId}`)).body;
    };
    expect((await request('PUT', '/api/app-config', {
      agentId: 'byok-opencode', agentCliEnv: { opencode: { OPENCODE_BIN: binary } }, odNextStrategyMode: 'off',
      telemetry: { metrics: false, content: false, artifactManifest: false }, privacyDecisionAt: Date.now(),
    })).status).toBe(200);
    const projectId = 'byok-repair';
    const project = await request<{ conversationId: string }>('POST', '/api/projects', {
      id: projectId, name: 'BYOK repair', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true,
    });
    expect(project.status).toBe(200);
    const settingsPath = `/api/projects/${projectId}/design-runtime/validation/settings`;
    const saved = await request<{ revision: number; settings: ReturnType<typeof defaultProjectDesignValidationSettings> }>('GET', settingsPath);
    const settings = saved.body.settings;
    settings.mode = 'guided';
    settings.projectConstraints.guided.rawCss.colors = 'error';
    expect((await request('PUT', settingsPath, { expectedRevision: saved.body.revision, settings })).status).toBe(200);
    const created = await request<{ runId: string }>('POST', '/api/runs', {
      projectId, conversationId: project.body.conversationId, assistantMessageId: 'byok-source-message', clientRequestId: 'byok-source-request',
      agentId: 'byok-opencode', model, sessionMode: 'design', message: 'Create the prototype in index.html.', currentPrompt: 'Create the prototype in index.html.',
      byokProvider: { protocol: 'openai', apiKey: fixtureKey, baseUrl: providerUrl, model, requiresApiKey: true },
    });
    expect(created.status).toBe(202);
    const sourceId = created.body.runId;
    const source = await terminalEvents(sourceId);
    expect(source.designGeneration).toMatchObject({ attempt: 0, mode: 'guided', decision: 'repair_required',
      inventory: { changed: expect.arrayContaining(['index.html']) },
      validation: { accepted: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS2002' })]) } });
    expect(source.designGenerationTask).toMatchObject({ initialRunId: sourceId, attempt: 1, repairLimit: 1 });
    const childId = source.designGenerationTask!.activeRunId;
    expect(childId).not.toBe(sourceId);
    const child = await terminalEvents(childId);
    expect(child.status, JSON.stringify({ error: child.error, report: child.designGeneration })).toBe('succeeded');
    expect(child.designGenerationTask).toMatchObject({ executionId: source.designGenerationTask!.executionId,
      initialRunId: sourceId, activeRunId: childId, attempt: 1, status: 'succeeded' });
    expect(child.designGeneration).toMatchObject({ attempt: 1, decision: 'accepted', validation: { accepted: true } });

    const invocations = (await readFile(invocationPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Invocation);
    expect(invocations).toHaveLength(2);
    expect(providerFailures).toEqual([]);
    expect(providerCalls).toHaveLength(2);
    for (const [index, invocation] of invocations.entries()) {
      expect(invocation.args[invocation.args.indexOf('-m') + 1]).toBe(`open-design-byok/${model}`);
      expect(invocation.args).not.toContain('-s');
      expect(invocation.provider).toEqual(invocations[0]!.provider);
      expect(invocation.provider).toMatchObject({ npm: '@ai-sdk/openai-compatible',
        options: { baseURL: providerUrl, apiKey: '{env:OPEN_DESIGN_BYOK_API_KEY}' }, models: { [model]: { name: model } } });
      expect(Object.keys(invocation.provider.models)).toEqual([model]);
      expect(providerCalls[index]).toMatchObject({ url: '/v1/chat/completions', authorization: `Bearer ${fixtureKey}`,
        body: { model, messages: [{ role: 'user', content: invocation.prompt }] } });
    }
    const envelope = parseDesignRepairTurnV1(invocations[1]!.prompt);
    expect(envelope).toMatchObject({ sourceRunId: sourceId, attempt: 1, strategy: null,
      context: { sourcePrompt: invocations[0]!.prompt, nativeSessionResume: false } });
    const { openDatabase } = await import('../../src/db.js');
    const { createDesignGenerationStore } = await import('../../src/storage/design-generation-store.js');
    const executions = createDesignGenerationStore(openDatabase(process.cwd(), { dataDir: directory }));
    const execution = executions.forRun(childId)!;
    expect(execution).toMatchObject({ id: envelope.executionId, initialRunId: sourceId, latestRunId: childId, attempt: 1,
      repair: { finalText: invocations[1]!.prompt, sourceReport: source.designGeneration }, report: child.designGeneration });
    expect(executions.forRun(sourceId)).toEqual(execution);
    expect(invocations[1]!.cwd).toBe(invocations[0]!.cwd);
    expect(await readFile(path.join(invocations[1]!.cwd, 'index.html'), 'utf8')).toBe(correctedHtml);
  }, 60_000);
});
