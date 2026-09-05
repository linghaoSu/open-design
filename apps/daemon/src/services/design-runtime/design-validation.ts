import {
  ValidateStructuredDesignRequestSchema, StructuredDesignValidationResultSchema,
  type ValidateStructuredDesignRequest, type StructuredDesignValidationResult, type DesignValidationMetrics,
  type DesignConstraintPolicy, type ValidationDiagnostic, type CodeComponentDefinition, type DesignControlRole,
  type DesignReuseMetric, type UIIRNode, type UIIRDocument,
} from '@open-design/contracts';
import { analyzeDesignSources, type AnalyzedDesignNode } from './design-source-analysis.js';
import { analyzeDesignStyles } from './style-validation.js';
import { resolveProjectDocument } from './project-components.js';
import { resolveComponentBinding } from './binding-resolver.js';
import { validateComponentProperties } from './component-validator.js';
import { composeProjectCodeIndex, verifyProjectCodeSources } from './local-component-binding.js';
import { canonicalDesignSystemJson, resolveLockedDesignSystemsSync } from './design-system-version.js';
import { createHandoff } from './handoff.js';
import { materializeHandoffCalls, type HandoffCodeNode } from './handoff-emitter.js';

const same = (a: unknown, b: unknown) => canonicalDesignSystemJson(a) === canonicalDesignSystemJson(b);
const reuse = (reused = 0, total = 0): DesignReuseMetric => ({ reused, total, rate: total === 0 ? null : reused / total });
function emptyMetrics(): DesignValidationMetrics { return { componentReuse: reuse(), bindingReuse: reuse(), unknownComponents: 0, unknownTokens: 0, rawColors: 0, rawSpacing: 0, rawRadius: 0, intrinsicControls: 0, duplicateControls: 0, duplicateStructures: 0, unsupported: 0, unresolvedImports: 0 }; }
const diagnostic = (code: ValidationDiagnostic['code'], message: string): ValidationDiagnostic => ({ schemaVersion: 1, code, severity: 'error', message });

function severity(policy: DesignConstraintPolicy, issue: ValidationDiagnostic, mode: string): ValidationDiagnostic['severity'] | 'off' {
  if (issue.code === 'ODDS1001') return policy.unknownComponents;
  if (['ODDS1002', 'ODDS1005', 'ODDS1006'].includes(issue.code)) return policy.unknownProps;
  if (issue.code === 'ODDS1003') return policy.invalidVariants;
  if (issue.code === 'ODDS1004') return policy.invalidSlots;
  if (issue.code === 'ODDS2001' || issue.code === 'ODDS2005') return policy.tokens.undeclared;
  if (issue.code === 'ODDS2002') return policy.rawCss.colors;
  if (issue.code === 'ODDS2003') return policy.rawCss.spacing;
  if (issue.code === 'ODDS2004') return policy.rawCss.radius;
  if (issue.code === 'ODDS3003') return policy.interactiveHtml.customControlsWhenBoundComponentExists;
  if (['ODDS6002', 'ODDS6003', 'ODDS6004', 'ODDS6005'].includes(issue.code)) return mode === 'strict' ? 'error' : 'warning';
  return issue.severity;
}
function intrinsicRole(node: Extract<AnalyzedDesignNode, { type: 'element' }>): DesignControlRole | undefined {
  const role = node.props.role;
  if (role === 'button' || role === 'link' || role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'dialog') return role;
  if (node.tag === 'button' || node.tag === 'select' || node.tag === 'textarea' || node.tag === 'dialog') return node.tag;
  if (node.tag === 'a' && Object.hasOwn(node.props, 'href')) return 'link';
  if (node.tag === 'input') {
    const type = node.props.type;
    return type === 'checkbox' || type === 'radio' ? type : type === 'button' || type === 'submit' || type === 'reset' ? 'button' : type === 'hidden' ? undefined : 'text-input';
  }
  return undefined;
}
function effectiveProps(code: CodeComponentDefinition, props: object): object {
  return { ...Object.fromEntries(Object.entries(code.props).flatMap(([name, prop]) => prop.default === undefined ? [] : [[name, prop.default]])), ...props };
}
function expectedTree(node: HandoffCodeNode): unknown {
  return node.type === 'text' ? { text: node.text } : { codeId: node.codeComponent.id, framework: node.codeComponent.framework, props: effectiveProps(node.codeComponent, node.props),
    slots: Object.fromEntries(Object.entries(node.slots).map(([name, children]) => [name, children.map(expectedTree)])) };
}
function observedTree(node: AnalyzedDesignNode): unknown {
  return node.type === 'text' ? { text: node.text } : { codeId: node.code?.id ?? `intrinsic:${node.tag}`, framework: node.code?.framework,
    props: node.code ? effectiveProps(node.code, node.props) : node.props,
    slots: Object.fromEntries(Object.entries(node.slots).map(([name, children]) => [name, children.map(observedTree)])) };
}

/** Facts first, policy second. No filesystem, source execution, cached readiness or inferred component names. */
export function validateStructuredDesign(input: ValidateStructuredDesignRequest, host?: { auditPaths: readonly string[] }): StructuredDesignValidationResult {
  const parsed = ValidateStructuredDesignRequestSchema.safeParse(input);
  const coverage = { semantic: false, source: false, imports: false, styles: false, bindings: false, conformance: false };
  const metrics = emptyMetrics();
  if (!parsed.success) return { schemaVersion: 1, mode: 'explore', policySource: 'project', diagnostics: [diagnostic('ODDS6005', `Validation request is malformed: ${parsed.error.message}`)], coverage, metrics, semanticReuse: reuse(), accepted: false, strictReady: false };
  const request = parsed.data; const snapshot = request.snapshot; const mode = request.settings.mode;
  const issues: ValidationDiagnostic[] = [];
  const locked = resolveLockedDesignSystemsSync(snapshot.dependencies, snapshot.lock, (entry) => snapshot.versions.find((version) => version.package.id === entry.designSystemId && version.package.version === entry.version) ?? null);
  issues.push(...locked.diagnostics);
  if (snapshot.versions.length !== snapshot.lock.dependencies.length || snapshot.lock.dependencies.length > 1) issues.push(diagnostic('ODDS5004', 'Validation requires exactly one supplied version per active lock and supports one design system.'));
  const version = locked.ok ? locked.versions[0] : undefined;
  const policySource = snapshot.lock.dependencies.length ? 'locked' as const : 'project' as const;
  const policy = (version?.package.constraints ?? request.settings.projectConstraints)[mode];
  const tokens = version?.package.tokens ?? snapshot.tokens;
  if (version && (!same(snapshot.registry, version.package.registry) || !same(snapshot.baseCodeIndex.components, version.package.codeIndex.components) || !same(snapshot.tokens, version.package.tokens))) issues.push(diagnostic('ODDS5004', 'Registry, code index and tokens must match the exact locked package.'));
  let codes: CodeComponentDefinition[] = [];
  try { codes = composeProjectCodeIndex(snapshot.baseCodeIndex, snapshot.projectCodeIndex).components; }
  catch (error) { issues.push(diagnostic('ODDS3001', `Code identities cannot be composed: ${error instanceof Error ? error.message : String(error)}`)); }
  const frozenSources = new Map<string, string>();
  if (version) for (const file of version.package.source.files) if (file.encoding === 'utf8') frozenSources.set(file.path, file.content);
  const provenCodeSources = new Map<string, string>();
  const proofPaths = new Map<string, string>();
  for (const code of codes) {
    const frozen = version?.package.codeIndex.components.some((entry) => entry.id === code.id) ? frozenSources.get(code.sourcePath) : undefined;
    if (frozen !== undefined) { provenCodeSources.set(code.id, frozen); continue; }
    const evidence = snapshot.projectSources.filter((source) => source.codeComponentId === code.id);
    const sourceIssues = verifyProjectCodeSources({ schemaVersion: 1, id: request.projectId, components: [code] }, evidence);
    issues.push(...sourceIssues);
    if (!sourceIssues.length && evidence[0]) {
      if (proofPaths.has(code.sourcePath) && proofPaths.get(code.sourcePath) !== evidence[0].sourceText) issues.push(diagnostic('ODDS6005', 'Project code source paths must identify one exact byte snapshot.'));
      proofPaths.set(code.sourcePath, evidence[0].sourceText);
      provenCodeSources.set(code.id, evidence[0].sourceText);
    }
  }
  const availableRoles = { react: new Set<DesignControlRole>(), vue: new Set<DesignControlRole>() }; const boundCodes = new Set<string>();
  const roleUnknownCodes = { react: new Set<string>(), vue: new Set<string>() };
  for (const binding of snapshot.bindings.bindings) {
    const resolution = resolveComponentBinding(binding, snapshot.registry, codes, snapshot.projectComponents);
    if (!resolution.ok) { issues.push(...resolution.diagnostics); continue; }
    if (!provenCodeSources.has(resolution.codeComponent.id)) continue;
    boundCodes.add(resolution.codeComponent.id);
    const definition = snapshot.registry?.components.find((component) => binding.componentRef === `ds:${snapshot.registry!.id}/${component.id}`);
    const framework = resolution.codeComponent.framework;
    if (definition?.controlRole) availableRoles[framework].add(definition.controlRole); else roleUnknownCodes[framework].add(resolution.codeComponent.id);
  }
  coverage.bindings = provenCodeSources.size === codes.length && !issues.some((issue) => issue.severity === 'error');
  let semanticTotal = 0; let semanticKnown = 0;
  const visitSemantic = (node: UIIRNode): void => {
    if (node.type === 'text') return;
    semanticTotal++;
    if (snapshot.registry?.components.some((component) => node.ref === `ds:${snapshot.registry!.id}/${component.id}`) || snapshot.projectComponents.components.some((component) => node.ref === `local:${component.id}`)) semanticKnown++;
    if (node.type === 'component') Object.values(node.slots ?? {}).forEach((children) => children.forEach(visitSemantic));
  };
  let resolvedDocument: UIIRDocument | null = null;
  if (snapshot.document) {
    const resolution = resolveProjectDocument({ registry: snapshot.registry, projectComponents: snapshot.projectComponents, document: snapshot.document });
    issues.push(...resolution.diagnostics);
    resolvedDocument = resolution.document;
    coverage.semantic = !!resolution.document && !resolution.diagnostics.some((issue) => issue.severity === 'error');
    snapshot.document.screens.forEach((screen) => screen.children.forEach(visitSemantic));
  }
  const visitTokens = (node: UIIRNode): void => {
    if (node.type === 'text') return;
    const values = node.type === 'component' ? Object.values(node.props ?? {}) : node.overrides.map((override) => override.value);
    for (const value of values) if (typeof value === 'string' && value.startsWith('token:') && !tokens.tokens.some((token) => value === `token:${tokens.id}/${token.id}`)) { metrics.unknownTokens++; issues.push({ ...diagnostic('ODDS2001', `Token ${value} is not declared.`), nodeId: node.id }); }
    if (node.type === 'component') Object.values(node.slots ?? {}).forEach((children) => children.forEach(visitTokens));
  };
  (resolvedDocument ?? snapshot.document)?.screens.forEach((screen) => screen.children.forEach(visitTokens));
  const source = analyzeDesignSources({ sources: request.sources, codes, provenCodeSources, frozenSources, ...(host ? { auditPaths: host.auditPaths } : {}) }, request.outputs);
  issues.push(...source.diagnostics); coverage.source = source.complete && request.outputs.length > 0; coverage.imports = source.importsComplete;
  coverage.styles = true;
  for (const style of source.styles) {
    const report = analyzeDesignStyles(style.content, style.sourcePath, tokens, style.inline);
    coverage.styles &&= report.complete;
    metrics.unknownTokens += report.unknownTokens; metrics.rawColors += report.rawColors; metrics.rawSpacing += report.rawSpacing; metrics.rawRadius += report.rawRadius;
    issues.push(...report.findings.map((finding) => ({ ...diagnostic(finding.code, finding.message), location: { sourcePath: finding.sourcePath, line: finding.line, column: finding.column } })));
  }
  let componentTotal = 0; let reusedComponents = 0; let bindingTotal = 0; let reusedBindings = 0;
  const duplicates = new Map<string, number>();
  const visitSource = (node: AnalyzedDesignNode): void => {
    if (node.type === 'text') return;
    if (node.code) {
      componentTotal++; bindingTotal++;
      if (boundCodes.has(node.code.id)) { reusedComponents++; reusedBindings++; }
      issues.push(...validateComponentProperties(node.code, { component: node.code.id, props: node.props }).map((issue) => ({ ...issue, location: node.location })));
      for (const [name, children] of Object.entries(node.slots)) {
        const slot = Object.hasOwn(node.code.slots ?? {}, name) ? node.code.slots![name] : undefined;
        if (!slot || !slot.multiple && children.length > 1) issues.push({ ...diagnostic('ODDS1004', `Code slot ${name} is undeclared or exceeds its cardinality.`), location: node.location });
      }
      for (const [name, slot] of Object.entries(node.code.slots ?? {})) if (slot.required && !(Object.hasOwn(node.slots, name) && node.slots[name]!.length)) issues.push({ ...diagnostic('ODDS1004', `Code slot ${name} is required.`), location: node.location });
    } else if (/^[A-Z]|-/.test(node.tag)) { componentTotal++; bindingTotal++; metrics.unknownComponents++; }
    const role = !node.code ? intrinsicRole(node) : undefined;
    if (role) {
      metrics.intrinsicControls++; componentTotal++;
      const signature = canonicalDesignSystemJson(observedTree(node)); duplicates.set(signature, (duplicates.get(signature) ?? 0) + 1);
      const language = request.sources.find((file) => file.sourcePath === node.location.sourcePath)?.language;
      const framework = language === 'tsx' ? 'react' : language === 'vue' ? 'vue' : codes.find((code) => code.sourcePath === node.location.sourcePath)?.framework;
      const alternatives = language === 'html' ? ['react', 'vue'] as const : framework ? [framework] : [];
      const replacements = alternatives.filter((target) => availableRoles[target].has(role));
      if (replacements.length) { metrics.duplicateControls++; issues.push({ ...diagnostic('ODDS3003', `${language === 'html' ? 'HTML' : 'Application'} ${role} reimplements an available verified bound ${replacements.join('/')} control; use the bound production path.`), location: node.location }); }
      else if (alternatives.some((target) => roleUnknownCodes[target].size)) issues.push({ ...diagnostic('ODDS6005', `Intrinsic ${role} is recorded, but available bindings lack complete authored control-role evidence.`), location: node.location });
    }
    Object.values(node.slots).forEach((children) => children.forEach(visitSource));
  };
  source.outputs.forEach((output) => output.nodes.forEach(visitSource));
  source.implementations.forEach((implementation) => implementation.nodes.forEach(visitSource));
  source.audits.forEach((nodes) => nodes.forEach(visitSource));
  metrics.componentReuse = reuse(reusedComponents, componentTotal); metrics.bindingReuse = reuse(reusedBindings, bindingTotal);
  metrics.duplicateStructures = [...duplicates.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  // Re-prove the exact expected production calls independently for each output framework.
  if (snapshot.document && request.outputs.length) {
    let matches = true; const seenScreens = new Set<string>();
    for (const framework of ['react', 'vue'] as const) {
      const selected = source.outputs.filter((entry) => request.sources.find((file) => file.sourcePath === entry.output.sourcePath)?.language === (framework === 'react' ? 'tsx' : 'vue'));
      if (!selected.length) continue;
      const { tokens: _tokens, ...handoffSnapshot } = snapshot;
      const handoff = createHandoff({ id: 'validation', projectId: request.projectId, projectRevision: request.projectRevision, framework, snapshot: { ...handoffSnapshot, document: snapshot.document } });
      const calls = handoff.manifest ? materializeHandoffCalls(handoff.manifest) : undefined;
      issues.push(...(calls?.diagnostics ?? handoff.diagnostics));
      if (!calls?.ok) { matches = false; continue; }
      const localCodeIds = new Set(snapshot.bindings.bindings.flatMap((binding) => binding.status === 'bound' && binding.componentRef.startsWith('local:') ? [binding.codeComponentId] : []));
      const expandImplementations = (nodes: AnalyzedDesignNode[], seen = new Set<string>()): AnalyzedDesignNode[] => nodes.flatMap((node) => {
        if (node.type === 'text') return [node];
        if (node.code && localCodeIds.has(node.code.id)) {
          const identity = canonicalDesignSystemJson([node.code.id, effectiveProps(node.code, node.props)]);
          const implementation = source.implementations.find((entry) => entry.codeId === node.code!.id && same(entry.props, effectiveProps(node.code!, node.props)));
          if (!implementation || seen.has(identity)) return [node];
          return expandImplementations(implementation.nodes, new Set([...seen, identity]));
        }
        return [{ ...node, slots: Object.fromEntries(Object.entries(node.slots).map(([name, children]) => [name, expandImplementations(children, seen)])) }];
      });
      const containsLocal = (nodes: HandoffCodeNode[]): boolean => nodes.some((node) => node.type === 'component' && (node.componentRef.startsWith('local:') || Object.values(node.slots).some(containsLocal)));
      let expandedCalls: ReturnType<typeof materializeHandoffCalls> | undefined;
      if (resolvedDocument && calls.screens.some((screen) => containsLocal(screen.nodes))) {
        const expanded = createHandoff({ id: 'validation-expanded', projectId: request.projectId, projectRevision: request.projectRevision, framework, snapshot: { ...handoffSnapshot, document: resolvedDocument } });
        expandedCalls = expanded.manifest ? materializeHandoffCalls(expanded.manifest) : undefined;
        issues.push(...(expandedCalls?.diagnostics ?? expanded.diagnostics));
        if (!expandedCalls?.ok) matches = false;
      }
      for (const actual of selected) {
        const id = actual.output.screenId;
        const expected = calls.screens.find((screen) => screen.id === id);
        if (!id || seenScreens.has(id) || !expected || !same(expected.nodes.map(expectedTree), actual.nodes.map(observedTree))) {
          matches = false; issues.push({ ...diagnostic('ODDS6004', 'Source call tree, slot order or effective props do not match the selected semantic screen.'), location: { sourcePath: actual.output.sourcePath, line: 1, column: 1 } });
        }
        if (expandedCalls?.ok) {
          const expanded = expandedCalls.screens.find((screen) => screen.id === id);
          if (!expanded || !same(expanded.nodes.map(expectedTree), expandImplementations(actual.nodes).map(observedTree))) {
            matches = false; issues.push({ ...diagnostic('ODDS6004', 'Registered local implementation does not match its resolved semantic template and effective values.'), location: { sourcePath: actual.output.sourcePath, line: 1, column: 1 } });
          }
        }
        if (id) seenScreens.add(id);
      }
    }
    coverage.conformance = matches && seenScreens.size === snapshot.document.screens.length && source.outputs.length === seenScreens.size;
  }
  if (!coverage.conformance) issues.push(diagnostic('ODDS6004', 'Strict certification requires every semantic screen to match one analyzed React/Vue source output.'));
  if (!coverage.semantic || !coverage.source || !coverage.bindings) issues.push(diagnostic('ODDS6005', 'Strict certification requires complete semantic, source and production binding evidence.'));
  metrics.unsupported = issues.filter((issue) => issue.code === 'ODDS6002').length;
  metrics.unresolvedImports = issues.filter((issue) => issue.code === 'ODDS6003').length;
  metrics.unknownComponents = Math.max(metrics.unknownComponents, issues.filter((issue) => issue.code === 'ODDS1001').length);
  const strictReady = Object.values(coverage).every(Boolean) && issues.length === 0;
  const diagnostics = issues.flatMap((issue) => { const level = severity(policy, issue, mode); return level === 'off' ? [] : [{ ...issue, severity: level }]; });
  if (mode === 'strict' && !strictReady && !diagnostics.some((issue) => issue.severity === 'error')) diagnostics.push(diagnostic('ODDS6005', 'Strict acceptance requires complete proof without unresolved validation warnings.'));
  diagnostics.sort((a, b) => { const left = canonicalDesignSystemJson([a.location ?? null, a.path ?? null, a.code, a.message]); const right = canonicalDesignSystemJson([b.location ?? null, b.path ?? null, b.code, b.message]); return left < right ? -1 : left > right ? 1 : 0; });
  return StructuredDesignValidationResultSchema.parse({ schemaVersion: 1, mode, policySource, diagnostics, coverage, metrics,
    semanticReuse: reuse(semanticKnown, semanticTotal), accepted: !diagnostics.some((issue) => issue.severity === 'error'), strictReady });
}
