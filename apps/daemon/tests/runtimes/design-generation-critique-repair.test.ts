import type { Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  errorCode?: string;
  designGeneration?: DesignGenerationReport;
  designGenerationTask?: DesignGenerationTaskProjection;
}

const invalidHtml = '<!doctype html><html><body><main style="color:#ff0000">Invalid publication</main></body></html>';
const correctedHtml = '<!doctype html><html><body><main>Corrected publication</main></body></html>';

function critiqueOutput(html: string) {
  return `<CRITIQUE_RUN version="1" maxRounds="3" threshold="8.0" scale="10">
  <ROUND n="1">
    <PANELIST role="designer"><NOTES>Publication candidate.</NOTES><ARTIFACT mime="text/html"><![CDATA[${html}]]></ARTIFACT></PANELIST>
    <PANELIST role="critic" score="9.0"><DIM name="hierarchy" score="9">Clear.</DIM></PANELIST>
    <PANELIST role="brand" score="9.0"><DIM name="voice" score="9">Consistent.</DIM></PANELIST>
    <PANELIST role="a11y" score="9.0"><DIM name="contrast" score="9">Readable.</DIM></PANELIST>
    <PANELIST role="copy" score="9.0"><DIM name="clarity" score="9">Concise.</DIM></PANELIST>
    <ROUND_END n="1" composite="9.0" must_fix="0" decision="ship"><REASON>Ready.</REASON></ROUND_END>
  </ROUND>
  <SHIP round="1" composite="9.0" status="shipped">
    <ARTIFACT mime="text/html"><![CDATA[${html}]]></ARTIFACT>
    <SUMMARY>Publication complete.</SUMMARY>
  </SHIP>
</CRITIQUE_RUN>
`;
}

describe('Critique publication through automatic design repair', () => {
  const originalData = process.env.OD_DATA_DIR;
  const originalCritique = process.env.OD_CRITIQUE_ENABLED;
  let directory: string | undefined;
  let started: { url: string; server: Server; shutdown?: () => Promise<void> | void } | undefined;

  afterEach(async () => {
    await started?.shutdown?.();
    started?.server.closeAllConnections();
    if (started) await new Promise<void>((resolve) => started!.server.close(() => resolve()));
    started = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    if (originalData === undefined) delete process.env.OD_DATA_DIR; else process.env.OD_DATA_DIR = originalData;
    if (originalCritique === undefined) delete process.env.OD_CRITIQUE_ENABLED; else process.env.OD_CRITIQUE_ENABLED = originalCritique;
    register.clear();
    vi.resetModules();
  });

  it.each(['corrected', 'exhausted'] as const)('withholds invalid ship bytes and ends the original execution as %s', async (outcome) => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'od-critique-generation-repair-'));
    const binary = path.join(directory, 'qwen-fixture');
    const invocationPath = path.join(directory, 'invocations.jsonl');
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('qwen-code 1.0.0-fixture'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--yolo --model'); process.exit(0); }
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  let repair = false;
  try { repair = JSON.parse(prompt).schema === 'open-design.design-repair-turn/v1'; } catch {}
  fs.appendFileSync(${JSON.stringify(invocationPath)}, JSON.stringify({ prompt, repair }) + '\\n');
  const output = repair && ${JSON.stringify(outcome)} === 'corrected'
    ? ${JSON.stringify(critiqueOutput(correctedHtml))}
    : ${JSON.stringify(critiqueOutput(invalidHtml))};
  process.stdout.write(output, () => process.exit(0));
});
`, { mode: 0o755 });
    process.env.OD_DATA_DIR = directory;
    process.env.OD_CRITIQUE_ENABLED = '1';
    register.clear();
    vi.resetModules();
    const { startServer } = await import('../../src/server.js');
    started = await startServer({ port: 0, returnServer: true }) as typeof started;
    const request = async <T>(method: string, route: string, body?: unknown) => {
      const response = await fetch(`${started!.url}${route}`, {
        method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.headers.get('content-type')).toContain('application/json');
      return { status: response.status, body: await response.json() as T };
    };
    // Real process and SSE boundaries provide completion; no fixed sleeps or status polling.
    const terminalEvents = async (runId: string) => {
      const response = await fetch(`${started!.url}/api/runs/${runId}/events`, { signal: AbortSignal.timeout(20_000) });
      expect(response.status).toBe(200);
      try { return await response.text(); }
      catch (error) {
        const status = (await request<RunView>('GET', `/api/runs/${runId}`)).body;
        throw new Error(`Run ${runId} did not terminate: ${JSON.stringify({
          status: status.status, errorCode: status.errorCode, designGeneration: status.designGeneration,
          designGenerationTask: status.designGenerationTask,
        })}`, { cause: error });
      }
    };
    expect((await request('PUT', '/api/app-config', {
      agentId: 'qwen', agentCliEnv: { qwen: { QWEN_BIN: binary } }, odNextStrategyMode: 'off',
      telemetry: { metrics: false, content: false, artifactManifest: false }, privacyDecisionAt: Date.now(),
    })).status).toBe(200);
    const projectId = 'critique-repair';
    const project = await request<{ conversationId: string }>('POST', '/api/projects', {
      id: projectId, name: 'Critique repair', skillId: 'open-design-landing-deck', designSystemId: 'sleek',
      metadata: { kind: 'prototype', critiqueTheaterEnabled: true }, skipDiscoveryBrief: true,
    });
    expect(project.status).toBe(200);
    const settingsPath = `/api/projects/${projectId}/design-runtime/validation/settings`;
    const settingsResponse = await request<{ revision: number; settings: ReturnType<typeof defaultProjectDesignValidationSettings> }>('GET', settingsPath);
    const settings = settingsResponse.body.settings;
    settings.mode = 'guided';
    settings.projectConstraints.guided.rawCss.colors = 'error';
    expect((await request('PUT', settingsPath, { expectedRevision: settingsResponse.body.revision, settings })).status).toBe(200);

    const created = await request<{ runId: string }>('POST', '/api/runs', {
      projectId, conversationId: project.body.conversationId, assistantMessageId: 'critique-source-message', clientRequestId: 'critique-source-request',
      agentId: 'qwen', skillId: 'open-design-landing-deck', designSystemId: 'sleek', sessionMode: 'design',
      message: 'Create the prototype and publish it through Design Jury.', currentPrompt: 'Create the prototype and publish it through Design Jury.',
    });
    expect(created.status).toBe(202);
    const sourceId = created.body.runId;
    const sourceEvents = await terminalEvents(sourceId);
    const source = (await request<RunView>('GET', `/api/runs/${sourceId}`)).body;
    expect(sourceEvents).toContain('event: critique.run_started');
    expect(sourceEvents).not.toContain('event: critique.ship');
    expect(source.status).toBe('succeeded');
    expect(source.designGeneration).toMatchObject({ attempt: 0, mode: 'guided', decision: 'repair_required' });
    expect(source.designGenerationTask).toMatchObject({ initialRunId: sourceId, attempt: 1, repairLimit: 1 });
    const childId = source.designGenerationTask!.activeRunId;
    expect(childId).not.toBe(sourceId);
    const childEvents = await terminalEvents(childId);
    const child = (await request<RunView>('GET', `/api/runs/${childId}`)).body;
    expect(childEvents).toContain('event: critique.run_started');
    expect(child.designGenerationTask).toMatchObject({
      executionId: source.designGenerationTask!.executionId, initialRunId: sourceId, activeRunId: childId, attempt: 1,
    });

    const invocations = (await readFile(invocationPath, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { prompt: string; repair: boolean });
    expect(invocations.map(({ repair }) => repair)).toEqual([false, true]);
    const envelope = parseDesignRepairTurnV1(invocations[1]!.prompt);
    expect(envelope).toMatchObject({ sourceRunId: sourceId, attempt: 1, strategy: null,
      context: { sourcePrompt: invocations[0]!.prompt, nativeSessionResume: false } });
    const { openDatabase } = await import('../../src/db.js');
    const { getCritiqueRun } = await import('../../src/critique/persistence.js');
    const { createDesignGenerationStore } = await import('../../src/storage/design-generation-store.js');
    const db = openDatabase(process.cwd(), { dataDir: directory });
    const execution = createDesignGenerationStore(db).forRun(childId)!;
    expect(execution).toMatchObject({ id: envelope.executionId, initialRunId: sourceId, latestRunId: childId, attempt: 1,
      repair: { finalText: invocations[1]!.prompt, sourceReport: source.designGeneration } });
    expect(createDesignGenerationStore(db).forRun(sourceId)).toEqual(execution);
    expect(getCritiqueRun(db, sourceId)).toMatchObject({ status: 'failed', artifactPath: null });
    const sourceArtifact = await fetch(`${started!.url}/api/projects/${projectId}/critique/${sourceId}/artifact`);
    expect(sourceArtifact.status).toBe(404);
    await sourceArtifact.arrayBuffer();

    const childArtifact = await fetch(`${started!.url}/api/projects/${projectId}/critique/${childId}/artifact`);
    if (outcome === 'corrected') {
      expect(child.status).toBe('succeeded');
      expect(child.designGenerationTask?.status).toBe('succeeded');
      expect(child.designGeneration).toMatchObject({ attempt: 1, decision: 'accepted', validation: { accepted: true } });
      expect(childEvents.match(/event: critique\.ship\r?\n/g)).toHaveLength(1);
      const row = getCritiqueRun(db, childId)!;
      expect(row.status).toBe('shipped');
      expect(row.artifactPath).not.toBeNull();
      expect(await readFile(row.artifactPath!, 'utf8')).toBe(correctedHtml);
      expect(childArtifact.status).toBe(200);
      expect(await childArtifact.text()).toBe(correctedHtml);
    } else {
      expect(child.status).toBe('failed');
      expect(child.designGenerationTask?.status).toBe('blocked');
      expect(child.designGeneration).toMatchObject({ attempt: 1, decision: 'blocked', validation: { accepted: false } });
      expect(childEvents).not.toContain('event: critique.ship');
      expect(getCritiqueRun(db, childId)).toMatchObject({ status: 'failed', artifactPath: null });
      expect(childArtifact.status).toBe(404);
      await childArtifact.arrayBuffer();
    }
    const artifactFiles = (await readdir(directory, { recursive: true })).filter((name) =>
      [sourceId, childId].includes(path.basename(path.dirname(name))) && path.basename(name).startsWith('artifact.'));
    expect(artifactFiles).toHaveLength(outcome === 'corrected' ? 1 : 0);
    for (const name of artifactFiles) expect(await readFile(path.join(directory, name), 'utf8')).not.toBe(invalidHtml);
  }, 60_000);
});
