import type { Server } from 'node:http';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { register } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeAgentDef } from '../../src/runtimes/defs/claude.js';

/** Real daemon and file writes, following the run-failure telemetry smoke lifecycle. */
describe('design generation completion through the real daemon', () => {
  const originalData = process.env.OD_DATA_DIR;
  let root: string | undefined;
  let started: { url: string; server: Server; shutdown?: () => Promise<void> | void } | undefined;
  afterEach(async () => {
    await started?.shutdown?.(); started?.server.closeAllConnections();
    if (started) await new Promise<void>((resolve) => started!.server.close(() => resolve()));
    started = undefined;
    if (root) await rm(root, { recursive: true, force: true }); root = undefined;
    if (originalData === undefined) delete process.env.OD_DATA_DIR; else process.env.OD_DATA_DIR = originalData;
    register.clear(); vi.resetModules();
  });

  it.each(['invalid-html', 'unrelated-target', 'question-unsupported', 'question-only'] as const)('checks actual daemon source authority for %s', async (scenario) => {
    root = await mkdtemp(path.join(os.tmpdir(), 'od-design-generation-'));
    const binary = path.join(root, 'claude-fixture');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('claude-code 1.0.0-fixture'); process.exit(0); }
if (process.argv.includes('--help')) { console.log(${JSON.stringify(Object.keys(claudeAgentDef.capabilityFlags).join(' '))}); process.exit(0); }
${scenario === 'question-only' ? '' : scenario === 'question-unsupported' ? `fs.writeFileSync('Hidden.svelte', '<button style="color:red">Hidden</button>');` : `fs.writeFileSync('index.html', '<!doctype html><html><body><main style="color:#ff0000">Generated</main></body></html>'); fs.writeFileSync('safe.html', '<main>Harmless unrelated file</main>');`}
console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(scenario.startsWith('question') ? '<question-form>Which option?</question-form>' : 'Created index.html.')}}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:${JSON.stringify(scenario.startsWith('question') ? 'Please choose an option.' : 'Created index.html.')},is_error:false}));
`, 'utf8'); await chmod(binary, 0o755);
    process.env.OD_DATA_DIR = root; register.clear(); vi.resetModules();
    const { startServer } = await import('../../src/server.js');
    started = await startServer({ port: 0, returnServer: true }) as typeof started;
    const request = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`${started!.url}${route}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 150)}`);
      return { status: response.status, body: JSON.parse(text) as any };
    };
    expect((await request('PUT', '/api/app-config', { agentId: 'claude', agentCliEnv: { claude: { CLAUDE_BIN: binary } }, odNextStrategyMode: 'off', telemetry: { metrics: false, content: false, artifactManifest: false }, privacyDecisionAt: Date.now() })).status).toBe(200);
    const projectId = 'generation-guided';
    const project = await request('POST', '/api/projects', { id: projectId, name: 'Generation gate', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true });
    expect(project.status).toBe(200);
    const endpoint = `/api/projects/${projectId}/design-runtime/validation/settings`;
    const initial = (await request('GET', endpoint)).body;
    const settings = structuredClone(initial.settings); settings.mode = 'guided'; settings.projectConstraints.guided.rawCss.colors = 'error';
    expect((await request('PUT', endpoint, { expectedRevision: initial.revision, settings })).status).toBe(200);
    if (scenario === 'unrelated-target') {
      const current = (await request('GET', endpoint)).body;
      expect((await request('PUT', `/api/projects/${projectId}/design-runtime/generation/targets`, { expectedRevision: current.revision, targets: { schemaVersion: 1, outputs: [{ sourcePath: 'safe.html' }] } })).status).toBe(200);
    }
    const created = await request('POST', '/api/runs', { projectId, conversationId: project.body.conversationId,
      assistantMessageId: 'assistant-generation', clientRequestId: 'request-generation', agentId: 'claude', sessionMode: scenario.startsWith('question') ? 'chat' : 'design',
      message: scenario.startsWith('question') ? 'Explain the available options.' : 'Create the prototype in index.html.', currentPrompt: scenario.startsWith('question') ? 'Explain the available options.' : 'Create the prototype in index.html.' });
    expect(created.status).toBe(202);
    let run: any;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      run = (await request('GET', `/api/runs/${created.body.runId}`)).body;
      if (['succeeded', 'failed', 'canceled'].includes(run.status)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (scenario === 'question-only') {
      expect(run.status).toBe('succeeded'); expect(run.designGeneration).toMatchObject({ decision: 'not_applicable', validation: null });
    } else {
      expect(run.status).toBe('failed'); expect(run.errorCode).toBe('DESIGN_GENERATION_VALIDATION_FAILED');
      expect(run.designGeneration).toMatchObject({ mode: 'guided', decision: 'blocked', inventory: { changed: expect.arrayContaining([scenario === 'question-unsupported' ? 'Hidden.svelte' : 'index.html']) } });
      if (scenario === 'question-unsupported') expect(run.designGeneration).toMatchObject({ inventory: { complete: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6005' })]) });
      else expect(run.designGeneration.validation).toMatchObject({ accepted: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS2002' })]) });
    }
  }, 60_000);
});
