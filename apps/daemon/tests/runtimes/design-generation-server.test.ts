import type { Server } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it.each(['invalid-html', 'unrelated-target', 'question-unsupported', 'question-only', 'repair-success', 'repair-transport-failure', 'repair-cancel', 'repair-config-drift'] as const)('checks actual daemon source authority for %s', async (scenario) => {
    root = await mkdtemp(path.join(os.tmpdir(), 'od-design-generation-'));
    const binary = path.join(root, 'claude-fixture');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('claude-code 1.0.0-fixture'); process.exit(0); }
if (process.argv.includes('--help')) { console.log(${JSON.stringify(Object.keys(claudeAgentDef.capabilityFlags).join(' '))}); process.exit(0); }
let input = ''; process.stdin.on('data', async (chunk) => { input += chunk; if (!input.includes('\\n')) return; process.stdin.removeAllListeners('data');
const wrapped = JSON.parse(input.trim()); const prompt = typeof wrapped.message?.content === 'string' ? wrapped.message.content : wrapped.message?.content?.[0]?.text ?? '';
const repair = prompt.includes('open-design.design-repair-turn/v1');
fs.appendFileSync(${JSON.stringify(path.join(root, 'invocations.jsonl'))}, JSON.stringify({ prompt, args:process.argv.slice(2), repair })+'\\n');
${scenario === 'question-only' ? '' : scenario === 'question-unsupported' ? `fs.writeFileSync('Hidden.svelte', '<button style="color:red">Hidden</button>');` : `fs.writeFileSync('index.html', repair && ${JSON.stringify(scenario)} === 'repair-success' ? '<!doctype html><html><body><main>Repaired</main></body></html>' : '<!doctype html><html><body><main style="color:#ff0000">Generated</main></body></html>'); fs.writeFileSync('safe.html', '<main>Harmless unrelated file</main>');`}
if (!repair && ${JSON.stringify(scenario)} === 'repair-config-drift') await fetch(fs.readFileSync(${JSON.stringify(path.join(root, 'daemon-url'))}, 'utf8') + '/api/app-config', {method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agentCliEnv:{claude:{CLAUDE_BIN:${JSON.stringify(binary + '-changed')}}}})});
if (repair && ${JSON.stringify(scenario)} === 'repair-transport-failure') { console.error('HTTP 503 Service Unavailable'); process.exit(1); }
if (repair && ${JSON.stringify(scenario)} === 'repair-cancel') { setInterval(()=>{}, 1000); return; }
console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(scenario.startsWith('question') ? '<question-form>Which option?</question-form>' : 'Created index.html.')}}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:${JSON.stringify(scenario.startsWith('question') ? 'Please choose an option.' : 'Created index.html.')},is_error:false}));
process.exit(0);
});
`, 'utf8'); await chmod(binary, 0o755);
    process.env.OD_DATA_DIR = root; register.clear(); vi.resetModules();
    const { startServer } = await import('../../src/server.js');
    started = await startServer({ port: 0, returnServer: true }) as typeof started;
    await writeFile(path.join(root, 'daemon-url'), started!.url);
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
    let run: any; let source: any; let canceled = false;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      source = (await request('GET', `/api/runs/${created.body.runId}`)).body;
      run = source.designGenerationTask?.activeRunId && source.designGenerationTask.activeRunId !== created.body.runId
        ? (await request('GET', `/api/runs/${source.designGenerationTask.activeRunId}`)).body : source;
      if (scenario === 'repair-cancel' && !canceled && run.designGenerationTask?.attempt === 1 && run.status === 'running' && (await readFile(path.join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n').length === 2) {
        expect((await request('POST', `/api/runs/${created.body.runId}/cancel`)).status).toBe(200); canceled = true;
      }
      if (['succeeded', 'blocked', 'canceled'].includes(run.designGenerationTask?.status)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const invocations = (await readFile(path.join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    if (scenario === 'repair-config-drift') {
      expect(invocations).toHaveLength(1); expect(run.status).toBe('failed');
      expect(run.error).toContain('configuration changed'); expect(run.designGenerationTask.attempt).toBe(1);
      return;
    }
    if (scenario !== 'question-only') {
      expect(invocations).toHaveLength(2);
      const envelope = JSON.parse(invocations[1].prompt);
      expect(envelope).toMatchObject({ schema: 'open-design.design-repair-turn/v1', attempt: 1, sourceRunId: created.body.runId, context: { nativeSessionResume: true } });
      expect(invocations[1].args).toContain('--resume');
      expect(source.designGenerationTask).toMatchObject({ attempt: 1, initialRunId: created.body.runId, activeRunId: run.id });
      expect(source.designGeneration).toMatchObject({ attempt: 0, decision: 'repair_required' });
    }
    if (scenario === 'repair-success') {
      expect(run.status, JSON.stringify({ error: run.error, report: run.designGeneration })).toBe('succeeded'); expect(run.designGenerationTask.status).toBe('succeeded');
      expect(run.designGeneration).toMatchObject({ attempt: 1, decision: 'accepted', validation: { accepted: true } });
      const repairedRunId = run.id;
      await started!.shutdown?.(); started!.server.closeAllConnections();
      await new Promise<void>((resolve) => started!.server.close(() => resolve())); started = undefined;
      register.clear(); vi.resetModules();
      const restarted = await import('../../src/server.js');
      started = await restarted.startServer({ port: 0, returnServer: true }) as typeof started;
      const reopened = (await request('GET', `/api/runs/${created.body.runId}`)).body;
      expect(reopened.designGenerationTask).toMatchObject({ status: 'succeeded', attempt: 1, activeRunId: repairedRunId, nextRunId: repairedRunId });
      expect((await readFile(path.join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    } else if (scenario === 'repair-transport-failure') {
      expect(run.status).toBe('failed'); expect(run.designGenerationTask.status).toBe('blocked');
      expect(run.designGeneration).toMatchObject({ attempt: 1, decision: 'blocked', reasonCodes: ['DESIGN_GENERATION_PROCESS_FAILED'] });
    } else if (scenario === 'repair-cancel') {
      expect(run.status).toBe('canceled'); expect(run.designGenerationTask.status).toBe('canceled');
      expect(run.designGeneration).toMatchObject({ attempt: 1, decision: 'canceled' });
    } else if (scenario === 'question-only') {
      expect(run.status).toBe('succeeded'); expect(run.designGeneration).toMatchObject({ decision: 'not_applicable', validation: null });
    } else {
      expect(run.status).toBe('failed'); expect(run.errorCode).toBe('DESIGN_GENERATION_VALIDATION_FAILED');
      expect(run.designGeneration).toMatchObject({ mode: 'guided', decision: 'blocked', inventory: { changed: expect.arrayContaining([scenario === 'question-unsupported' ? 'Hidden.svelte' : 'index.html']) } });
      if (scenario === 'question-unsupported') expect(run.designGeneration).toMatchObject({ inventory: { complete: false }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS6005' })]) });
      else expect(run.designGeneration.validation).toMatchObject({ accepted: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'ODDS2002' })]) });
    }
  }, 60_000);
});
