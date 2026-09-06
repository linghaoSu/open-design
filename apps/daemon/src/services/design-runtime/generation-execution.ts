import { randomUUID } from 'node:crypto';
import {
  DesignGenerationExecutionSchema, DesignGenerationReportSchema, defaultDesignGenerationTargets,
  serializeDesignRepairTurnV1, type DesignRepairTurnV1, DesignGenerationTaskProjectionSchema, type DesignGenerationTaskProjection,
  type DesignGenerationExecution, type DesignGenerationPolicy, type DesignGenerationReport,
  type ProjectDesignRuntimeState, type HandoffTargetPackage, type DesignGenerationTargets, type DesignValidationSource, type ValidationDiagnostic,
} from '@open-design/contracts';
import type { DesignRuntimeStore } from '../../storage/design-runtime-store.js';
import type { DesignGenerationStore } from '../../storage/design-generation-store.js';
import { canonicalDesignSystemJson, resolveLockedDesignSystemsSync } from './design-system-version.js';
import { captureGenerationInventory, generationDigest, generationInventoryChanges, generationInventoryDiagnostic, type CapturedGenerationInventory } from './generation-inventory.js';
import { collectProjectValidationFacts } from './project-validation-facts.js';
import { validateStructuredDesign } from './design-validation.js';

export interface DesignGenerationAuthority { projectId: string; conversationId: string | null; scope: unknown }
type Authority = DesignGenerationAuthority;
interface Deps {
  state: DesignRuntimeStore; executions: DesignGenerationStore;
  root(projectId: string): string;
  currentScope(projectId: string): unknown;
  observeTargetPackages(projectId: string, names: readonly string[]): Promise<HandoffTargetPackage[]>;
  capture?: typeof captureGenerationInventory;
}
export type PreparedDesignGeneration = Omit<DesignGenerationExecution, 'initialRunId' | 'latestRunId'>;
export interface DesignGenerationCompletionOptions {
  production: boolean; retainActive?: boolean; externalSources?: DesignValidationSource[]; externalDiagnostics?: ValidationDiagnostic[];
  /** Host dispatch capability only; absence retains the standalone no-repair gate. */
  allowRepair?: boolean;
  canonicalEntry?: string | null; canceled(): boolean;
}
const digest = (value: unknown) => generationDigest(canonicalDesignSystemJson(value));
const semantic = (state: ProjectDesignRuntimeState) => digest([state.document, state.projectComponents]);
const targets = (state: ProjectDesignRuntimeState): DesignGenerationTargets => state.generationTargets ?? defaultDesignGenerationTargets();

/** Daemon authority. A physical process exit is only a candidate until these current-byte facts are checked. */
export function createDesignGenerationService(deps: Deps) {
  const captureOnce = deps.capture ?? captureGenerationInventory;
  const capture = async (root: string) => {
    const first = await captureOnce(root);
    // A host artifact sidecar can land after an entry listing. Recollect all bytes once;
    // never certify the incomplete snapshot or retry away a persistent read/coverage error.
    return !first.inventory.complete && first.inventory.diagnostics.length > 0
      && first.inventory.diagnostics.every((issue) => issue.message.startsWith('A project directory changed during source inventory'))
      ? captureOnce(root) : first;
  };
  const policy = (projectId: string, state: ProjectDesignRuntimeState): DesignGenerationPolicy => {
    const resolved = resolveLockedDesignSystemsSync(state.dependencies, state.lock, (entry) => deps.state.readVersion(projectId, entry.designSystemId, entry.version));
    if (!resolved.ok) throw new Error('The active design policy cannot be verified. Explicitly recover its saved settings and dependency before generating.');
    const facts = { schemaVersion: 1 as const, mode: state.validationSettings.mode, constraints: resolved.versions[0]?.package.constraints ?? state.validationSettings.projectConstraints,
      source: resolved.versions.length ? 'locked' as const : 'project' as const, dependencies: state.dependencies, lock: state.lock };
    return { ...facts, digest: digest(facts) };
  };
  const authorityKey = ({ projectId, conversationId, scope }: Authority) => digest({ projectId, conversationId, scope });
  const assertCurrent = (execution: DesignGenerationExecution, authority: Authority) => {
    if (execution.policy.mode !== 'explore' && !deps.executions.isCurrent(execution.id)) throw new Error('A newer or concurrent logical Run invalidated this source authority.');
    if (execution.authorityKey !== authorityKey(authority) || digest(authority.scope) !== digest(deps.currentScope(authority.projectId))) throw new Error('Project workspace/account authority changed during generation.');
    if (policy(execution.projectId, deps.state.read(execution.projectId)).digest !== execution.policy.digest) throw new Error('Saved design mode, effective policy or exact dependency changed during generation. Start a new task to use the new policy.');
  };
  async function prepare(authority: Authority): Promise<PreparedDesignGeneration> {
    const state = deps.state.read(authority.projectId); const frozen = policy(authority.projectId, state);
    const baseline = { schemaVersion: 1 as const, digest: digest([]), complete: false, files: [], diagnostics: [generationInventoryDiagnostic('The pre-agent source baseline is pending.')] };
    if (policy(authority.projectId, deps.state.read(authority.projectId)).digest !== frozen.digest) throw new Error('Design policy changed while the generation baseline was collected.');
    return { schemaVersion: 1, id: `generation_${randomUUID().replaceAll('-', '')}`, projectId: authority.projectId, conversationId: authority.conversationId,
      authorityKey: authorityKey(authority), policy: frozen, targets: targets(state), baselineStatus: 'pending', baseline, semanticDigest: semantic(state),
      attempt: 0, revision: 0, status: 'active', report: null };
  }
  function claim(runId: string, prepared: PreparedDesignGeneration): DesignGenerationExecution {
    return deps.executions.create(DesignGenerationExecutionSchema.parse({ ...prepared, initialRunId: runId, latestRunId: runId }));
  }
  function bindContinuation(sourceRunId: string, runId: string, authority: Authority): DesignGenerationExecution {
    const execution = deps.executions.forRun(sourceRunId);
    if (!execution || execution.latestRunId !== sourceRunId || execution.status !== 'active') throw new Error('The latest logical stage must own its next physical Run.');
    assertCurrent(execution, authority);
    return deps.executions.update(execution.revision, { ...execution, latestRunId: runId, targets: targets(deps.state.read(authority.projectId)), report: null });
  }
  async function start(runId: string, authority: Authority, initialTaskRunId?: string): Promise<DesignGenerationExecution> {
    const existing = deps.executions.forRun(runId);
    if (existing) { if (existing.latestRunId !== runId) throw new Error('A stale physical Run cannot resume the logical task.'); if (existing.status === 'terminal') throw new Error('This design execution is terminal; start a new logical task.'); assertCurrent(existing, authority); return existing; }
    if (initialTaskRunId) {
      const original = deps.executions.forRun(initialTaskRunId);
      if (!original || original.status !== 'active') throw new Error('The logical task has no active frozen design execution.');
      assertCurrent(original, authority);
      return deps.executions.update(original.revision, { ...original, latestRunId: runId, targets: targets(deps.state.read(authority.projectId)), report: null });
    }
    return claim(runId, await prepare(authority));
  }
  async function captureBaseline(runId: string, authority: Authority): Promise<DesignGenerationExecution> {
    const execution = deps.executions.forRun(runId);
    if (!execution || execution.latestRunId !== runId || execution.status !== 'active') throw new Error('A stale Run cannot capture a generation baseline.');
    assertCurrent(execution, authority);
    if (execution.baselineStatus === 'ready') return execution;
    const captured = await capture(deps.root(execution.projectId));
    assertCurrent(execution, authority);
    return deps.executions.update(execution.revision, { ...execution, baselineStatus: 'ready', baseline: captured.inventory });
  }
  async function complete(runId: string, authority: Authority, options: DesignGenerationCompletionOptions): Promise<DesignGenerationReport> {
    const execution = deps.executions.forRun(runId);
    if (!execution || execution.latestRunId !== runId) throw new Error('A stale Run cannot complete a design execution.');
    if (execution.baselineStatus !== 'ready') throw new Error('Generation cannot complete before its pre-agent baseline is captured.');
    const prior = execution.status === 'terminal' ? execution.report : null;
    if (execution.status === 'terminal' && (!prior || !['accepted', 'advisory'].includes(prior.decision))) throw new Error('A terminal failed or canceled execution cannot be completed again.');
    const state = deps.state.read(execution.projectId);
    let captured: CapturedGenerationInventory = { inventory: execution.baseline, sources: [] };
    const diagnostics = [...execution.baseline.diagnostics, ...(options.externalDiagnostics ?? [])]; const reasons: string[] = [];
    let validation: DesignGenerationReport['validation'] = null;
    let changed: string[] = []; let deleted: string[] = []; let applicable = options.production || !!options.externalSources?.length || !!options.externalDiagnostics?.length;
    const finalTargets = targets(state);
    const outputs = structuredClone(finalTargets.outputs);
    const sourceDigest = (inventory: CapturedGenerationInventory['inventory']) => options.externalSources?.length || options.externalDiagnostics?.length
      ? digest({ project: inventory.digest, external: (options.externalSources ?? []).map((source) => ({ path: source.sourcePath, language: source.language, digest: generationDigest(source.sourceText) })), diagnostics: options.externalDiagnostics ?? [] })
      : inventory.digest;
    if (!deps.executions.isCurrent(execution.id)) { applicable = true; diagnostics.push(generationInventoryDiagnostic('Concurrent project writes prevent attribution to this logical task. Explore delivery remains advisory.')); }
    try {
      assertCurrent(execution, authority);
      if (prior && prior.projectRevision !== state.revision) throw new Error('Project state changed after the publication candidate was validated.');
      captured = await capture(deps.root(execution.projectId));
      if (prior && prior.inventory.sourceDigest !== sourceDigest(captured.inventory)) throw new Error('Publication source or original external evidence changed after candidate validation.');
      ({ changed, deleted } = generationInventoryChanges(execution.baseline, captured.inventory));
      diagnostics.push(...captured.inventory.diagnostics);
      const external = options.externalSources ?? [];
      for (const source of external) {
        if (captured.inventory.files.some((entry) => entry.path === source.sourcePath)) throw new Error('An external artifact path collides with a project source.');
        changed.push(source.sourcePath);
      }
      const allSources = [...captured.sources, ...external];
      applicable ||= !execution.baseline.complete || !captured.inventory.complete || changed.length > 0 || deleted.length > 0 || semantic(state) !== execution.semanticDigest;
      if (applicable && !options.canceled()) {
        if (!outputs.length && options.canonicalEntry) outputs.push({ sourcePath: options.canonicalEntry });
        if (options.canonicalEntry && !outputs.some((entry) => entry.sourcePath === options.canonicalEntry)) diagnostics.push(generationInventoryDiagnostic('The delivered canonical entry is absent from the saved output declarations.', options.canonicalEntry));
        for (const output of outputs) if (!allSources.some((source) => source.sourcePath === output.sourcePath)) diagnostics.push(generationInventoryDiagnostic('A declared output is absent or excluded from the complete source inventory.', output.sourcePath));
        const bytes = new Map(allSources.map((source) => [source.sourcePath, source.sourceText]));
        const facts = await collectProjectValidationFacts({ store: deps.state, projectId: execution.projectId, state,
          sources: allSources.map(({ sourceText: _text, ...source }) => source), outputs,
          readSource: async (path) => { const value = bytes.get(path); if (value === undefined) throw new Error('Source is absent from this inventory.'); return value; },
          observeTargetPackages: (names) => deps.observeTargetPackages(execution.projectId, names) });
        diagnostics.push(...facts.failures);
        if (!options.canceled()) validation = validateStructuredDesign(facts.request, { auditPaths: changed });
      }
      const finalInventory = await capture(deps.root(execution.projectId));
      if (!finalInventory.inventory.complete || finalInventory.inventory.digest !== captured.inventory.digest) diagnostics.push(generationInventoryDiagnostic('Project source changed or became incomplete during generation validation.'));
      assertCurrent(execution, authority);
      const current = deps.state.read(execution.projectId);
      if (current.revision !== state.revision || digest(targets(current)) !== digest(finalTargets)) throw new Error('Design document, definitions or output targets changed during final validation.');
    } catch (error) { reasons.push('DESIGN_GENERATION_AUTHORITY_CONFLICT'); diagnostics.push(generationInventoryDiagnostic(error instanceof Error ? error.message : String(error))); }
    const canceled = options.canceled();
    const latest = deps.executions.forRun(runId);
    if (!latest || latest.latestRunId !== runId || latest.revision !== execution.revision) throw new Error('Another Run claimed this generation execution.');
    const complete = execution.baseline.complete && captured.inventory.complete && !diagnostics.some((issue) => issue.severity === 'error');
    let decision: DesignGenerationReport['decision'] = canceled ? 'canceled' : reasons.length ? 'blocked' : !applicable ? 'not_applicable'
      : execution.policy.mode === 'explore' ? 'advisory' : complete && validation?.accepted && (execution.policy.mode !== 'strict' || validation.strictReady) ? 'accepted' : 'blocked';
    if (decision === 'blocked' && !reasons.length) reasons.push('DESIGN_GENERATION_VALIDATION_FAILED');
    if (decision === 'blocked' && options.allowRepair && !prior && execution.attempt === 0 && reasons.length === 1 && reasons[0] === 'DESIGN_GENERATION_VALIDATION_FAILED') decision = 'repair_required';
    const report = DesignGenerationReportSchema.parse({ schemaVersion: 1, executionId: execution.id, runId, attempt: execution.attempt,
      mode: execution.policy.mode, policyDigest: execution.policy.digest, projectRevision: state.revision, decision, reasonCodes: reasons,
      diagnostics, inventory: { baselineDigest: execution.baseline.digest, sourceDigest: sourceDigest(captured.inventory), complete, changed: [...new Set(changed)].sort(), deleted }, outputs, validation });
    const next: DesignGenerationExecution = { ...execution, awaitingContinuation: options.retainActive === true, status: !prior && (decision === 'repair_required' || decision === 'not_applicable' || options.retainActive && (decision === 'advisory' || decision === 'accepted')) ? 'active' : 'terminal', report };
    if (prior) deps.executions.reproveTerminal(execution.revision, next);
    else deps.executions.update(execution.revision, next);
    return report;
  }
  function abort(runId: string, status: 'failed' | 'canceled'): DesignGenerationReport | null {
    const execution = deps.executions.forRun(runId);
    if (!execution || execution.latestRunId !== runId) return null;
    if (execution.status === 'terminal') return execution.report;
    const report = DesignGenerationReportSchema.parse({ schemaVersion: 1, executionId: execution.id, runId, attempt: execution.attempt,
      mode: execution.policy.mode, policyDigest: execution.policy.digest, projectRevision: deps.state.read(execution.projectId).revision,
      decision: status === 'canceled' ? 'canceled' : 'blocked', reasonCodes: [status === 'canceled' ? 'DESIGN_GENERATION_CANCELED' : 'DESIGN_GENERATION_PROCESS_FAILED'],
      diagnostics: [generationInventoryDiagnostic('The physical Run ended before accepting current source validation.')],
      inventory: { baselineDigest: execution.baseline.digest, sourceDigest: execution.baseline.digest, complete: false, changed: [], deleted: [] },
      outputs: execution.targets.outputs, validation: null });
    deps.executions.update(execution.revision, { ...execution, status: 'terminal', report });
    return report;
  }
  function repairText(runId: string, authority: Authority, strategy: DesignRepairTurnV1['strategy'], context: DesignRepairTurnV1['context'] = null): { execution: DesignGenerationExecution; text: string } {
    const execution = deps.executions.forRun(runId);
    if (!execution || execution.latestRunId !== runId || execution.status !== 'active' || execution.attempt !== 0 || execution.report?.decision !== 'repair_required') throw new Error('Only the current initial failed validation can request a host repair.');
    assertCurrent(execution, authority);
    if (execution.report.projectRevision !== deps.state.read(execution.projectId).revision) throw new Error('Project state changed before repair could be claimed.');
    return { execution, text: serializeDesignRepairTurnV1({ executionId: execution.id, sourceRunId: runId, policy: execution.policy, report: execution.report, strategy, context }) };
  }
  function claimRepair(sourceRunId: string, runId: string, authority: Authority, expectedRevision: number, text: string): DesignGenerationExecution {
    const { execution } = repairText(sourceRunId, authority, null);
    return deps.executions.claimRepair(expectedRevision, { executionId: execution.id, sourceRunId, runId, finalText: text });
  }
  function projection(viewedRunId: string, physicalStatus: (runId: string) => string | null): DesignGenerationTaskProjection | null {
    const execution = deps.executions.forRun(viewedRunId); if (!execution) return null;
    const status = physicalStatus(execution.latestRunId);
    const report = execution.report ?? execution.repair?.sourceReport ?? null;
    const delivered = status === 'succeeded' && !!report && report.runId === execution.latestRunId && report.attempt === execution.attempt
      && (execution.status === 'terminal' && ['accepted', 'advisory'].includes(report.decision) || report.decision === 'not_applicable' && !execution.awaitingContinuation);
    return DesignGenerationTaskProjectionSchema.parse({ schemaVersion: 1, executionId: execution.id, projectId: execution.projectId, conversationId: execution.conversationId,
      initialRunId: execution.initialRunId, activeRunId: execution.latestRunId, nextRunId: viewedRunId === execution.latestRunId ? null : execution.latestRunId,
      attempt: execution.attempt, repairLimit: 1,
      status: status === 'canceled' || report?.decision === 'canceled' ? 'canceled' : status === 'failed' || report?.decision === 'blocked' ? 'blocked'
        : delivered ? 'succeeded' : execution.attempt === 1 ? 'repairing' : 'running', latestReport: report });
  }
  return { prepare, claim, start, bindContinuation, captureBaseline, complete, abort, repairText, claimRepair, projection, markContended: deps.executions.markContended, forRun: deps.executions.forRun };
}
