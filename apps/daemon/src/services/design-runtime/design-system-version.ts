import { createHash } from 'node:crypto';
import {
  DesignSystemPackageSchema,
  DesignSystemSourceBundleSchema,
  DesignSystemSemVerSchema,
  DesignSystemVersionCatalogSchema,
  DesignSystemVersionRangeSchema,
  DesignSystemVersionSchema,
  ProjectDesignSystemDependenciesSchema,
  ProjectDesignSystemLockSchema,
  type ComponentPropDefinition,
  type DesignPatternDefinition,
  type DesignSystemLockedDependency,
  type DesignSystemPackage,
  type DesignSystemResolutionResult,
  type DesignSystemSourceBundle,
  type DesignSystemVersion,
  type DesignSystemVersionCatalog,
  type JsonValue,
  type ProjectDesignSystemDependencies,
  type ProjectDesignSystemLock,
  type UIIRNode,
  type ValidationDiagnostic,
} from '@open-design/contracts';
import { CompilerError } from './react-compiler.js';
import { extractSourceCodeComponent } from './source-compiler.js';
import { resolveComponentBinding } from './binding-resolver.js';
import { acceptsComponentPropertyDomain, validateComponentProperties } from './component-validator.js';
import { validateDesignSystemMigrationRules } from './migration-rule-validation.js';
import { compareDesignRuntimeKeys } from './reference-graph.js';

export class DesignSystemVersionError extends Error {
  constructor(readonly diagnostics: ValidationDiagnostic[]) {
    super(diagnostics.map((entry) => entry.message).join(' '));
    this.name = 'DesignSystemVersionError';
  }
}

function error(code: ValidationDiagnostic['code'], message: string, path?: (string | number)[]): ValidationDiagnostic {
  return { schemaVersion: 1, severity: 'error', code, message, ...(path === undefined ? {} : { path }) };
}

/** Canonical object ordering; arrays retain declared order. Undefined optional fields encode as absence. */
export function canonicalDesignSystemJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const object = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(object).sort(compareDesignRuntimeKeys).map((key) => [key, object[key]]));
    }
    return item;
  });
}

function sourceBytes(bundle: DesignSystemSourceBundle): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const file of bundle.files) {
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.toString(file.encoding === 'base64' ? 'base64' : 'utf8') !== file.content) {
      throw new DesignSystemVersionError([error('ODDS5005', `Source ${file.path} has noncanonical base64 or malformed UTF-8 text.`, ['source', 'files', file.path])]);
    }
    files.set(file.path, bytes);
  }
  return files;
}

/** Includes exact bytes and unambiguous path/byte-length framing; file ordering is not source content. */
export function digestDesignSystemSource(bundle: DesignSystemSourceBundle): string {
  const files = sourceBytes(DesignSystemSourceBundleSchema.parse(bundle));
  const hash = createHash('sha256').update('open-design/source-bundle/v1\0');
  for (const [path, bytes] of [...files].sort(([a], [b]) => compareDesignRuntimeKeys(a, b))) {
    hash.update(JSON.stringify([path, bytes.length])).update('\n').update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function sample(prop: ComponentPropDefinition): JsonValue {
  return prop.default !== undefined ? prop.default : (prop.type === 'enum' ? prop.values[0]! : prop.type === 'number' ? 0 : prop.type === 'boolean' ? false : '');
}

function patternDiagnostics(pkg: DesignSystemPackage, pattern: DesignPatternDefinition): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const nodes = new Map<string, UIIRNode>();
  const definitions = new Map(pkg.registry.components.map((component) => [`ds:${pkg.id}/${component.id}`, component]));
  const visit = (node: UIIRNode): void => {
    nodes.set(node.id, node);
    if (node.type === 'component') for (const children of Object.values(node.slots ?? {})) children.forEach(visit);
  };
  visit(pattern.template);
  const mappedProps = new Map<string, Record<string, JsonValue>>();
  for (const mapping of pattern.propMappings) {
    const node = nodes.get(mapping.nodeId)!;
    if (mapping.path[0] === 'text') continue;
    const targetProps = node.type === 'text' ? undefined : definitions.get(node.ref)?.props;
    const target = targetProps && Object.hasOwn(targetProps, mapping.path[1]) ? targetProps[mapping.path[1]] : undefined;
    const source = pattern.props[mapping.prop]!;
    if (!target || !acceptsComponentPropertyDomain(source, target)) diagnostics.push(error('ODDS4005', `Pattern ${pattern.id} prop ${mapping.prop} has an incompatible template target.`, ['patterns', pattern.id, 'propMappings']));
    const props = mappedProps.get(mapping.nodeId) ?? {};
    if (source.required || source.default !== undefined) props[mapping.path[1]] = sample(source);
    mappedProps.set(mapping.nodeId, props);
  }
  const mappedSlots = new Map<string, Set<string>>();
  for (const mapping of pattern.slotMappings) {
    const node = nodes.get(mapping.nodeId)!;
    const slots = node.type === 'component' ? definitions.get(node.ref)?.slots : undefined;
    const target = slots && Object.hasOwn(slots, mapping.targetSlot) ? slots[mapping.targetSlot] : undefined;
    const source = pattern.slots[mapping.slot]!;
    if (!target || (source.multiple && !target.multiple) || (!source.required && target.required)
      || source.accepts.some((ref) => !target.accepts.includes(ref))) diagnostics.push(error('ODDS1004', `Pattern ${pattern.id} slot ${mapping.slot} has an incompatible template slot.`, ['patterns', pattern.id, 'slotMappings']));
    const targets = mappedSlots.get(mapping.nodeId) ?? new Set<string>();
    targets.add(mapping.targetSlot);
    mappedSlots.set(mapping.nodeId, targets);
  }
  for (const node of nodes.values()) {
    if (node.type === 'text') continue;
    const definition = definitions.get(node.ref);
    if (!definition) { diagnostics.push(error('ODDS4002', `Pattern ${pattern.id} refers to missing component ${node.ref}.`)); continue; }
    const explicit = node.type === 'instance' ? Object.fromEntries(node.overrides.map((override) => [override.path[1], override.value])) : node.props ?? {};
    diagnostics.push(...validateComponentProperties(definition, { component: node.ref, nodeId: node.id, props: { ...explicit, ...mappedProps.get(node.id) } }));
    const slots = node.type === 'component' ? node.slots ?? {} : {};
    for (const [name, children] of Object.entries(slots)) {
      const slot = definition.slots && Object.hasOwn(definition.slots, name) ? definition.slots[name] : undefined;
      if (!slot || (!slot.multiple && children.length > 1) || children.some((child) => !slot.accepts.includes(child.type === 'text' ? 'text' : child.ref))) diagnostics.push(error('ODDS1004', `Pattern ${pattern.id} has invalid composition in ${node.id}.${name}.`));
    }
    for (const [name, slot] of Object.entries(definition.slots ?? {})) {
      if (slot.required && !mappedSlots.get(node.id)?.has(name) && !(Object.hasOwn(slots, name) && slots[name]!.length)) diagnostics.push(error('ODDS1004', `Pattern ${pattern.id} is missing required slot ${node.id}.${name}.`));
    }
  }
  return diagnostics;
}

/** Verifies enforceable metadata against the complete frozen bundle without executing source. */
export function validateDesignSystemPackage(input: DesignSystemPackage): ValidationDiagnostic[] {
  const parsed = DesignSystemPackageSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((issue) => error('ODDS5007', issue.message, issue.path));
  const pkg = parsed.data;
  const diagnostics: ValidationDiagnostic[] = [];
  let files: Map<string, Buffer>;
  try { files = sourceBytes(pkg.source); } catch (caught) {
    if (caught instanceof DesignSystemVersionError) return caught.diagnostics;
    throw caught;
  }
  const components = new Map(pkg.registry.components.map((component) => [`ds:${pkg.id}/${component.id}`, component]));
  const codes = new Map(pkg.codeIndex.components.map((component) => [component.id, component]));
  const checkedPaths = new Set<string>();
  const verifyPath = (path: string | undefined): void => {
    if (path === undefined || checkedPaths.has(path)) return;
    checkedPaths.add(path);
    if (!files.has(path)) diagnostics.push(error('ODDS5005', `Source provenance ${path} is absent from the immutable bundle.`, ['source', path]));
  };
  const verifyPropSources = (props: Record<string, ComponentPropDefinition>): void => {
    for (const prop of Object.values(props)) verifyPath(prop.source?.sourcePath);
  };
  // Visit canonical provenance fields only. Template props, defaults, and mapping values are data.
  for (const component of pkg.registry.components) {
    verifyPath(component.source?.sourcePath);
    verifyPropSources(component.props);
    for (const slot of Object.values(component.slots ?? {})) verifyPath(slot.source?.sourcePath);
    for (const story of component.stories ?? []) {
      verifyPath(story.source.sourcePath);
      for (const argType of Object.values(story.argTypes)) verifyPath(argType.source.sourcePath);
    }
  }
  for (const component of pkg.codeIndex.components) {
    verifyPath(component.sourcePath);
    verifyPath(component.source?.sourcePath);
    verifyPropSources(component.props);
    for (const slot of Object.values(component.slots ?? {})) verifyPath(slot.source?.sourcePath);
  }
  for (const binding of pkg.bindings.bindings) {
    verifyPath(binding.source?.sourcePath);
    for (const mapping of binding.slotMappings ?? []) verifyPath(mapping.source?.sourcePath);
  }
  for (const token of pkg.tokens.tokens) verifyPath(token.source?.sourcePath);
  for (const pattern of pkg.patterns.patterns) {
    verifyPropSources(pattern.props);
    for (const slot of Object.values(pattern.slots)) verifyPath(slot.source?.sourcePath);
  }
  for (const component of pkg.registry.components) for (const [name, slot] of Object.entries(component.slots ?? {})) {
    for (const ref of slot.accepts) if (ref !== 'text' && !components.has(ref)) diagnostics.push(error('ODDS4002', `Slot ${component.id}.${name} accepts missing or external component ${ref}.`));
  }
  const verifiedCodeIds = new Set<string>();
  for (const binding of pkg.bindings.bindings) {
    if (!components.has(binding.componentRef)) diagnostics.push(error('ODDS3001', `Packaged binding ${binding.id} refers to a missing design component.`));
    if ('codeComponentId' in binding) {
      const code = codes.get(binding.codeComponentId);
      if (!code || code.framework !== binding.framework) diagnostics.push(error('ODDS3001', `Packaged binding ${binding.id} has a missing or mismatched code target.`));
    }
    if (binding.status === 'bound') {
      const code = codes.get(binding.codeComponentId);
      if (code && !verifiedCodeIds.has(code.id)) {
        verifiedCodeIds.add(code.id);
        const bytes = files.get(code.sourcePath);
        if (bytes) {
          try {
            const text = bytes.toString('utf8');
            if (!Buffer.from(text, 'utf8').equals(bytes)) throw new DesignSystemVersionError([error('ODDS5005', `Code source ${code.sourcePath} is not UTF-8 text.`)]);
            const extracted = extractSourceCodeComponent({ framework: code.framework, sourceText: text, sourcePath: code.sourcePath, exportName: code.exportName, codeComponentId: code.id, ...(code.packageName === undefined ? {} : { packageName: code.packageName }) });
            const propFacts = (props: typeof code.props) => Object.fromEntries(Object.entries(props).map(([name, { source: _source, ...definition }]) => [name, definition]));
            const slotFacts = (slots: typeof code.slots) => Object.fromEntries(Object.entries(slots ?? {}).map(([name, { source: _source, ...definition }]) => [name, definition]));
            if (canonicalDesignSystemJson(propFacts(extracted.props)) !== canonicalDesignSystemJson(propFacts(code.props))) diagnostics.push(error('ODDS5007', `Verified code metadata ${code.id} contradicts its frozen source props.`, ['codeIndex', code.id, 'props']));
            if (canonicalDesignSystemJson(slotFacts(extracted.slots)) !== canonicalDesignSystemJson(slotFacts(code.slots))) diagnostics.push(error('ODDS5007', `Verified code metadata ${code.id} contradicts its frozen source slots.`, ['codeIndex', code.id, 'slots']));
          } catch (caught) {
            if (caught instanceof DesignSystemVersionError) diagnostics.push(...caught.diagnostics);
            else if (caught instanceof CompilerError) diagnostics.push(error('ODDS5007', `Frozen code cannot verify ${code.id}: ${caught.message}`, ['codeIndex', code.id]));
            else throw caught;
          }
        }
      }
      const result = resolveComponentBinding(binding, pkg.registry, pkg.codeIndex.components);
      if (!result.ok) diagnostics.push(...result.diagnostics);
    }
  }
  for (const pattern of pkg.patterns.patterns) {
    for (const [name, slot] of Object.entries(pattern.slots)) for (const ref of slot.accepts) if (ref !== 'text' && !components.has(ref)) diagnostics.push(error('ODDS4002', `Pattern ${pattern.id} slot ${name} accepts missing component ${ref}.`));
    diagnostics.push(...patternDiagnostics(pkg, pattern));
  }
  for (const [index, recipe] of (pkg.migrations ?? []).entries()) {
    diagnostics.push(...validateDesignSystemMigrationRules(undefined, pkg.registry, recipe.rules).map((diagnostic) => ({ ...diagnostic, path: ['migrations', index, ...(diagnostic.path ?? [])] })));
    for (const decision of recipe.packageBindingDecisions) if (decision.type === 'use-target-package') {
      const target = pkg.bindings.bindings.find((binding) => binding.id === decision.targetBindingId);
      if (!target || target.status !== 'bound') diagnostics.push(error('ODDS5002', `Recipe ${recipe.id} requires a verified published target binding ${decision.targetBindingId}.`, ['migrations', index, 'packageBindingDecisions']));
    }
  }
  return diagnostics;
}

export function createDesignSystemVersion(input: DesignSystemPackage): DesignSystemVersion {
  const diagnostics = validateDesignSystemPackage(input);
  if (diagnostics.length) throw new DesignSystemVersionError(diagnostics);
  const pkg = DesignSystemPackageSchema.parse(input);
  pkg.source.files.sort((a, b) => compareDesignRuntimeKeys(a.path, b.path));
  return { schemaVersion: 1, package: pkg, digest: `sha256:${createHash('sha256').update(canonicalDesignSystemJson(pkg), 'utf8').digest('hex')}`, sourceDigest: digestDesignSystemSource(pkg.source) };
}

export function verifyDesignSystemVersion(input: DesignSystemVersion): ValidationDiagnostic[] {
  const parsed = DesignSystemVersionSchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((issue) => error('ODDS5004', issue.message, issue.path));
  let computed: DesignSystemVersion;
  try { computed = createDesignSystemVersion(parsed.data.package); } catch (caught) {
    if (caught instanceof DesignSystemVersionError) return caught.diagnostics;
    throw caught;
  }
  const diagnostics: ValidationDiagnostic[] = [];
  if (computed.sourceDigest !== parsed.data.sourceDigest) diagnostics.push(error('ODDS5005', 'Frozen source bytes do not match the published source digest.'));
  if (computed.digest !== parsed.data.digest) diagnostics.push(error('ODDS5004', 'Design-system package content does not match its published digest.'));
  return diagnostics;
}

/** Same-content publication is idempotent; an existing version can never be replaced. */
export function publishDesignSystemVersion(catalog: DesignSystemVersionCatalog, pkg: DesignSystemPackage): DesignSystemVersionCatalog {
  const current = DesignSystemVersionCatalogSchema.parse(catalog);
  for (const version of current.versions) {
    const diagnostics = verifyDesignSystemVersion(version);
    if (diagnostics.length) throw new DesignSystemVersionError(diagnostics);
  }
  const version = createDesignSystemVersion(pkg);
  const previous = current.versions.find((entry) => entry.package.id === pkg.id && entry.package.version === pkg.version);
  if (previous && previous.digest !== version.digest) throw new DesignSystemVersionError([error('ODDS5006', `Published version ${pkg.id}@${pkg.version} is immutable.`)]);
  return previous ? current : { ...current, versions: [...current.versions, version].sort((a, b) => compareDesignRuntimeKeys(a.package.id, b.package.id) || compareDesignRuntimeKeys(a.package.version, b.package.version)) };
}

function semver(input: string) {
  DesignSystemSemVerSchema.parse(input);
  const [coreAndPre] = input.split('+');
  const separator = coreAndPre!.indexOf('-');
  const core = separator < 0 ? coreAndPre! : coreAndPre!.slice(0, separator);
  return { core: core.split('.').map((part) => BigInt(part)), pre: separator < 0 ? [] : coreAndPre!.slice(separator + 1).split('.') };
}
function compareVersions(left: ReturnType<typeof semver>, right: ReturnType<typeof semver>): number {
  for (let index = 0; index < 3; index++) if (left.core[index] !== right.core[index]) return left.core[index]! < right.core[index]! ? -1 : 1;
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const a = left.pre[index]; const b = right.pre[index];
    if (a === b) continue;
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const numericA = /^[0-9]+$/.test(a); const numericB = /^[0-9]+$/.test(b);
    if (numericA && numericB) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return compareDesignRuntimeKeys(a, b);
  }
  return 0;
}

/** Full-version exact/^/~ subset of npm range semantics; prereleases require intent on the same core. */
export function satisfiesDesignSystemRange(version: string, range: string): boolean {
  DesignSystemVersionRangeSchema.parse(range);
  const operator = range[0] === '^' || range[0] === '~' ? range[0] : '';
  const current = semver(version); const base = semver(operator ? range.slice(1) : range);
  if (current.pre.length && (!base.pre.length || current.core.some((value, index) => value !== base.core[index]))) return false;
  if (!operator) return compareVersions(current, base) === 0;
  if (compareVersions(current, base) < 0) return false;
  const upper = [...base.core];
  const changed = operator === '~' ? 1 : base.core[0] !== 0n ? 0 : base.core[1] !== 0n ? 1 : 2;
  upper[changed] = upper[changed]! + 1n;
  for (let index = changed + 1; index < 3; index++) upper[index] = 0n;
  return compareVersions(current, { core: upper, pre: [] }) < 0;
}

/** Callers explicitly select versions; this helper performs no search, latest lookup, or upgrade. */
export function createProjectDesignSystemLock(projectId: string, versions: readonly DesignSystemVersion[]): ProjectDesignSystemLock {
  for (const version of versions) {
    const diagnostics = verifyDesignSystemVersion(version);
    if (diagnostics.length) throw new DesignSystemVersionError(diagnostics);
  }
  return ProjectDesignSystemLockSchema.parse({ schemaVersion: 1, id: projectId, dependencies: versions.map((version) => ({ designSystemId: version.package.id, version: version.package.version, digest: version.digest, source: { type: 'bundle', digest: version.sourceDigest } })).sort((a, b) => compareDesignRuntimeKeys(a.designSystemId, b.designSystemId)) });
}

function failedResolution(diagnostics: ValidationDiagnostic[]): DesignSystemResolutionResult {
  return { schemaVersion: 1, ok: false, versions: [], diagnostics };
}

function prepareLockedResolution(dependencies: ProjectDesignSystemDependencies, lock: ProjectDesignSystemLock):
  { entries: DesignSystemLockedDependency[]; diagnostics: ValidationDiagnostic[] } {
  const declared = ProjectDesignSystemDependenciesSchema.safeParse(dependencies);
  const locked = ProjectDesignSystemLockSchema.safeParse(lock);
  if (!declared.success || !locked.success) return { entries: [], diagnostics: [error('ODDS5001', 'Dependency or exact lock metadata is invalid.')] };
  if (declared.data.id !== locked.data.id) return { entries: [], diagnostics: [error('ODDS5001', 'Dependency declaration and lock must belong to the same project.')] };
  const intent = new Map(declared.data.dependencies.map((entry) => [entry.designSystemId, entry.version]));
  const diagnostics: ValidationDiagnostic[] = [];
  for (const entry of locked.data.dependencies) {
    const range = intent.get(entry.designSystemId);
    if (!range || !satisfiesDesignSystemRange(entry.version, range)) diagnostics.push(error('ODDS5001', `Locked ${entry.designSystemId}@${entry.version} does not satisfy declared dependency intent.`));
    intent.delete(entry.designSystemId);
  }
  for (const id of intent.keys()) diagnostics.push(error('ODDS5001', `Declared dependency ${id} has no exact lock.`));
  return { entries: [...locked.data.dependencies].sort((a, b) => compareDesignRuntimeKeys(a.designSystemId, b.designSystemId)), diagnostics };
}

function finishLockedResolution(entries: DesignSystemLockedDependency[], loaded: (DesignSystemVersion | null)[]): DesignSystemResolutionResult {
  const versions: DesignSystemVersion[] = [];
  const diagnostics: ValidationDiagnostic[] = [];
  for (const [index, entry] of entries.entries()) {
    const version = loaded[index];
    if (!version) { diagnostics.push(error('ODDS5003', `Locked design system ${entry.designSystemId}@${entry.version} is unavailable.`)); continue; }
    const checked = verifyDesignSystemVersion(version);
    diagnostics.push(...checked);
    if (checked.length) continue;
    if (version.package.id !== entry.designSystemId || version.package.version !== entry.version) diagnostics.push(error('ODDS5001', 'Exact loader returned a different design-system identity or version.'));
    else if (version.digest !== entry.digest) diagnostics.push(error('ODDS5004', 'Exact loader returned content that does not match the project lock.'));
    else if (version.sourceDigest !== entry.source.digest) diagnostics.push(error('ODDS5005', 'Exact loader returned source that does not match the project lock.'));
    else versions.push(DesignSystemVersionSchema.parse(version));
  }
  return diagnostics.length ? failedResolution(diagnostics) : { schemaVersion: 1, ok: true, versions, diagnostics: [] };
}

/** The loader receives an exact identity and digests and must load frozen package bytes only. */
export async function resolveLockedDesignSystems(
  dependencies: ProjectDesignSystemDependencies,
  lock: ProjectDesignSystemLock,
  loadExact: (entry: DesignSystemLockedDependency) => DesignSystemVersion | null | Promise<DesignSystemVersion | null>,
): Promise<DesignSystemResolutionResult> {
  const prepared = prepareLockedResolution(dependencies, lock);
  if (prepared.diagnostics.length) return failedResolution(prepared.diagnostics);
  const loaded: (DesignSystemVersion | null)[] = [];
  for (const entry of prepared.entries) {
    try { loaded.push(await loadExact(structuredClone(entry))); } catch { loaded.push(null); }
  }
  return finishLockedResolution(prepared.entries, loaded);
}

/** SQLite callers use the same exact-lock evaluator without making synchronous project operations async. */
export function resolveLockedDesignSystemsSync(
  dependencies: ProjectDesignSystemDependencies,
  lock: ProjectDesignSystemLock,
  loadExact: (entry: DesignSystemLockedDependency) => DesignSystemVersion | null,
): DesignSystemResolutionResult {
  const prepared = prepareLockedResolution(dependencies, lock);
  if (prepared.diagnostics.length) return failedResolution(prepared.diagnostics);
  return finishLockedResolution(prepared.entries, prepared.entries.map((entry) => {
    try { return loadExact(structuredClone(entry)); } catch { return null; }
  }));
}
