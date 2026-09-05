import {
  CreateHandoffRequestSchema, HandoffBuildResultSchema, HandoffManifestSchema,
  type CreateHandoffRequest, type HandoffBuildResult, type HandoffBindingCoverage, type HandoffManifest,
  type UIIRNode, type ValidationDiagnostic,
} from '@open-design/contracts';
import { resolveComponentBinding } from './binding-resolver.js';
import { composeProjectCodeIndex, LocalComponentBindingError, verifyProjectCodeSources } from './local-component-binding.js';
import { resolveProjectDocument } from './project-components.js';
import { canonicalDesignSystemJson, resolveLockedDesignSystemsSync, satisfiesDesignSystemRange } from './design-system-version.js';

export function handoffDiagnostic(code: ValidationDiagnostic['code'], message: string, componentRef?: string): ValidationDiagnostic {
  return { schemaVersion: 1, code, severity: 'error', message, ...(componentRef === undefined ? {} : { componentRef }) };
}

/** Builds a portable, machine-readable contract without executing source or accessing a repository. */
export function createHandoff(input: CreateHandoffRequest): HandoffBuildResult {
  const parsed = CreateHandoffRequestSchema.safeParse(input);
  if (!parsed.success) return { schemaVersion: 1, manifest: null, diagnostics: [handoffDiagnostic('ODDS7001', `Invalid handoff snapshot: ${parsed.error.message}`)] };
  const request = parsed.data; const snapshot = request.snapshot;
  const diagnostics: ValidationDiagnostic[] = [];
  const resolved = resolveProjectDocument({ registry: snapshot.registry, projectComponents: snapshot.projectComponents, document: snapshot.document });
  diagnostics.push(...resolved.diagnostics);
  if (!resolved.document) return { schemaVersion: 1, manifest: null, diagnostics };
  const locked = resolveLockedDesignSystemsSync(snapshot.dependencies, snapshot.lock, (entry) => snapshot.versions.find((version) => version.package.id === entry.designSystemId && version.package.version === entry.version) ?? null);
  diagnostics.push(...locked.diagnostics);
  if (snapshot.versions.length !== snapshot.lock.dependencies.length || snapshot.lock.dependencies.length > 1) diagnostics.push(handoffDiagnostic('ODDS5004', 'Handoff requires exactly the supplied locked versions and supports one active design system.'));
  const version = locked.ok ? locked.versions[0] : undefined;
  if (version) {
    if (canonicalDesignSystemJson(snapshot.registry) !== canonicalDesignSystemJson(version.package.registry)
      || canonicalDesignSystemJson(snapshot.baseCodeIndex.components) !== canonicalDesignSystemJson(version.package.codeIndex.components)) {
      diagnostics.push(handoffDiagnostic('ODDS5004', 'Handoff registry and package-owned code must match the exact frozen design-system version.'));
    }
  } else if (snapshot.registry?.components.length || snapshot.baseCodeIndex.components.length) {
    diagnostics.push(handoffDiagnostic('ODDS5003', 'Freeze and explicitly lock the design system before engineering handoff.'));
  }
  diagnostics.push(...verifyProjectCodeSources(snapshot.projectCodeIndex, snapshot.projectSources));
  let codeIndex;
  try { codeIndex = composeProjectCodeIndex(snapshot.baseCodeIndex, snapshot.projectCodeIndex); }
  catch (error) { return { schemaVersion: 1, manifest: null, diagnostics: [...diagnostics, ...(error instanceof LocalComponentBindingError ? error.diagnostics : [handoffDiagnostic('ODDS7001', String(error))])] }; }

  const coverage = new Map<string, HandoffBindingCoverage>();
  const packageNames = new Set<string>();
  const visit = (node: UIIRNode): void => {
    if (node.type === 'text') return;
    let entry = coverage.get(node.ref);
    if (!entry) {
      const binding = snapshot.bindings.bindings.find((candidate) => candidate.componentRef === node.ref && candidate.framework === request.framework) ?? null;
      const resolution = binding ? resolveComponentBinding(binding, snapshot.registry, codeIndex.components, snapshot.projectComponents) : undefined;
      const issues = !binding ? [handoffDiagnostic('ODDS3004', `Component ${node.ref} has no ${request.framework} production binding. Implement and explicitly bind it before code emission.`, node.ref)] : resolution && !resolution.ok ? resolution.diagnostics : [];
      if (resolution?.ok) {
        if (resolution.codeComponent.packageName) packageNames.add(resolution.codeComponent.packageName);
        if (snapshot.projectCodeIndex.components.some((code) => code.id === resolution.codeComponent.id)) {
          issues.push(...verifyProjectCodeSources({ ...snapshot.projectCodeIndex, components: [resolution.codeComponent] }, snapshot.projectSources.filter((source) => source.codeComponentId === resolution.codeComponent.id)));
        }
      }
      entry = { componentRef: node.ref, binding, ready: issues.length === 0, diagnostics: issues };
      coverage.set(node.ref, entry);
      if (node.ref.startsWith('local:') && !entry.ready) {
        const definition = snapshot.projectComponents.components.find((component) => node.ref === `local:${component.id}`);
        if (definition) visit(definition.template);
      }
    }
    if (node.type === 'component') for (const name of Object.keys(node.slots ?? {}).sort()) for (const child of node.slots![name]!) visit(child);
  };
  for (const screen of snapshot.document.screens) screen.children.forEach(visit);

  for (const name of [...packageNames].sort()) {
    const observation = snapshot.targetPackages.find((entry) => entry.name === name);
    const compatibility = version?.package.codeCompatibility.find((entry) => entry.framework === request.framework && entry.packageName === name);
    if (!observation || observation.installation.status === 'unknown') diagnostics.push(handoffDiagnostic('ODDS7003', `Installed exact version of ${name} is unknown. A declared dependency range is not installation evidence.`));
    else if (compatibility && !satisfiesDesignSystemRange(observation.installation.version, compatibility.version)) diagnostics.push(handoffDiagnostic('ODDS7002', `Installed ${name}@${observation.installation.version} does not satisfy design-system code compatibility ${compatibility.version}.`));
    if (!compatibility) diagnostics.push({ ...handoffDiagnostic('ODDS7002', `No design-system compatibility range is declared for ${name}; package compatibility remains unverified.`), severity: 'warning' });
  }
  const change = request.changeContext;
  for (const diff of [change?.semanticDiff, change?.upgradeReview?.diff]) {
    if (diff && !snapshot.lock.dependencies.some((entry) => canonicalDesignSystemJson(entry) === canonicalDesignSystemJson(diff.to))) diagnostics.push(handoffDiagnostic('ODDS5001', 'Handoff change context targets a different exact design-system lock.'));
  }
  if (change?.upgradeReview && (change.upgradeReview.projectId !== request.projectId || change.upgradeReview.baseRevision >= request.projectRevision || !change.upgradeReview.canApply)) diagnostics.push(handoffDiagnostic('ODDS7001', 'Historical upgrade context must be a valid earlier review for this project.'));
  for (const revision of change?.sharedRevisions ?? []) {
    const current = snapshot.projectComponents.components.find((component) => revision.componentRef === `local:${component.id}`);
    if (current && revision.definition.revision > current.revision) diagnostics.push(handoffDiagnostic('ODDS7001', 'Shared change context cannot claim a future local definition revision.', revision.componentRef));
  }
  const entries = [...coverage.values()].sort((left, right) => left.componentRef < right.componentRef ? -1 : left.componentRef > right.componentRef ? 1 : 0);
  diagnostics.push(...entries.flatMap((entry) => entry.diagnostics));
  const manifest = HandoffManifestSchema.parse({ schemaVersion: 1, ...request, coverage: entries,
    ready: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'), diagnostics });
  return HandoffBuildResultSchema.parse({ schemaVersion: 1, manifest, diagnostics });
}

/** Deliberately discards cached coverage/readiness when rebuilding proof for an emitter. */
export function handoffRequest(manifest: HandoffManifest): CreateHandoffRequest {
  return { id: manifest.id, projectId: manifest.projectId, projectRevision: manifest.projectRevision, framework: manifest.framework, snapshot: manifest.snapshot,
    ...(manifest.changeContext === undefined ? {} : { changeContext: manifest.changeContext }) };
}
