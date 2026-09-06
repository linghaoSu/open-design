import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context as createBuildContext, type Loader, type Plugin } from 'esbuild';
import { parse as parseTypeScript } from '@babel/parser';
import { compileScript, compileStyle, parse as parseSfc } from '@vue/compiler-sfc';
import {
  codeImportPackageName, DesignSystemSemVerSchema, SourcePathSchema,
  type DesignPreviewBundle, type DesignPreviewKind, type DesignPreviewRuntime, type DesignPreviewSourceEvidence,
  type HandoffCodeFile, type HandoffSnapshot, type HandoffTargetPackage, type ValidationDiagnostic, type JsonValue, type ComponentPreviewCallback,
} from '@open-design/contracts';
import { previewDiagnostic, previewDigest } from './preview-preparation.js';

const MAX_FILE = 4 * 1024 * 1024; const MAX_BYTES = 24 * 1024 * 1024; const MAX_FILES = 256;
const toolDirectory = fileURLToPath(new URL('../../../', import.meta.url));
const assetMime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const frameworkPackages = { react: ['react', 'react-dom', 'scheduler'], vue: ['vue', '@vue/runtime-core', '@vue/runtime-dom', '@vue/reactivity', '@vue/shared'] };
export const previewRuntimePackages = (framework: 'react' | 'vue'): DesignPreviewRuntime[] => framework === 'react'
  ? [{ name: 'react', version: '18.3.1', origin: 'tool-runtime' }, { name: 'react-dom', version: '18.3.1', origin: 'tool-runtime' }]
  : [{ name: 'vue', version: '3.5.42', origin: 'tool-runtime' }];

interface PackageRoot { name: string; version: string; root: string; manifest: Uint8Array }
interface Module {
  path: string; origin: DesignPreviewSourceEvidence['origin']; contents?: Uint8Array | undefined;
  package?: PackageRoot | undefined; loader?: Loader | undefined;
}
export interface PreviewBundleAuthority {
  /** Inject the workspace-authorized file reader. No caller supplies this function or root. */
  readProjectSource(path: string): Promise<string>;
  /** Optional exact-byte reader for project CSS assets and fonts. */
  readProjectFile?(path: string): Promise<Uint8Array>;
  /** Only used for verified installed package resolution; ordinary project reads use the callback. */
  projectRoot?: string | undefined;
}
export interface PreviewBundleResult {
  bundle: DesignPreviewBundle | null; sourceEvidence: DesignPreviewSourceEvidence[];
  targetPackages: HandoffTargetPackage[]; diagnostics: ValidationDiagnostic[];
  /** Re-read only the installed bytes actually bundled; the service separately verifies project bytes. */
  verifyInstalledSources(): Promise<boolean>;
}

class UnsupportedPreviewSource extends Error {}
const unsupported = (message: string): never => { throw new UnsupportedPreviewSource(message); };
const bytes = (text: string) => new TextEncoder().encode(text);
const decoded = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(value);
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };

/** File contents are data. This module never imports, evaluates or launches project/package code. */
async function readBounded(path: string): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_FILE) return unsupported('Preview source must be a bounded regular file.');
    const data = Buffer.alloc(metadata.size + 1); let offset = 0;
    while (offset < data.length) { const { bytesRead } = await file.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== metadata.size) return unsupported('Preview source changed while being read.');
    return data.subarray(0, offset);
  } finally { await file.close(); }
}

async function findPackage(name: string, directory: string): Promise<PackageRoot> {
  if (codeImportPackageName(name) !== name) return unsupported(`Unsupported package identity ${name}.`);
  const require = createRequire(join(resolve(directory), 'package.json'));
  const lookups = new Set<string>(); for (let parent = resolve(directory); ; parent = dirname(parent)) { lookups.add(join(parent, 'node_modules')); if (dirname(parent) === parent) break; }
  for (const lookup of require.resolve.paths(name) ?? []) {
    if (!lookups.has(lookup)) continue;
    const candidate = join(lookup, name);
    try { if (!(await stat(candidate)).isDirectory()) continue; } catch { continue; }
    const root = await realpath(candidate); const manifest = await readBounded(join(root, 'package.json'));
    const metadata: unknown = JSON.parse(decoded(manifest));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return unsupported(`Invalid installed metadata for ${name}.`);
    const record = metadata as Record<string, unknown>; const version = DesignSystemSemVerSchema.safeParse(record.version);
    if (record.name !== name || !version.success) return unsupported(`Installed package ${name} lacks exact identity/version evidence.`);
    return { name, root, version: version.data, manifest };
  }
  return unsupported(`Package ${name} is not installed in the authorized project lookup path.`);
}

/** Reject unresolved runtime imports explicitly; never leave them for a network-capable browser loader. */
function checkStaticImports(source: string, path: string): void {
  const ast = parseTypeScript(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'], allowReturnOutsideFunction: true });
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const node = value as Record<string, unknown>;
    if (node.type === 'CallExpression') {
      const callee = node.callee as Record<string, unknown> | undefined; const arguments_ = node.arguments as Record<string, unknown>[];
      if (callee?.type === 'Import' || callee?.type === 'Identifier' && callee.name === 'require') {
        if (arguments_.length !== 1 || arguments_[0]?.type !== 'StringLiteral') unsupported(`Dynamic import/require is unsupported in ${path}.`);
      }
    }
    if (node.type === 'ImportExpression' && (node.source as Record<string, unknown>)?.type !== 'StringLiteral') unsupported(`Dynamic import is unsupported in ${path}.`);
    Object.values(node).forEach(visit);
  }
  visit(ast.program);
}

interface PreviewSourcePolicy {
  frozen: Map<string, Uint8Array>;
  sourceProof: Map<string | undefined, string>;
  generatedProjectPaths: Set<string>;
  generatedFrozenPaths: Set<string>;
  semantic: boolean;
  targetPackages: HandoffTargetPackage[];
}
export interface ComponentPreviewBootstrap {
  props: Record<string, JsonValue>;
  callbacks: ComponentPreviewCallback[];
}
type PreviewEntry = Pick<HandoffCodeFile, 'sourcePath' | 'exportName' | 'language' | 'content'>;

export function bundleDesignPreview(file: HandoffCodeFile, snapshot: HandoffSnapshot, kind: DesignPreviewKind, authority: PreviewBundleAuthority): Promise<PreviewBundleResult> {
  return bundlePreview(file, {
    frozen: new Map(snapshot.versions.flatMap((version) => version.package.source.files.map((source) => [source.path, source.encoding === 'utf8' ? bytes(source.content) : Buffer.from(source.content, 'base64')] as const))),
    sourceProof: new Map(snapshot.projectSources.map((entry) => [snapshot.projectCodeIndex.components.find((code) => code.id === entry.codeComponentId)?.sourcePath, entry.sourceText])),
    generatedProjectPaths: new Set(snapshot.projectCodeIndex.components.map((code) => code.sourcePath)),
    generatedFrozenPaths: new Set(snapshot.baseCodeIndex.components.map((code) => code.sourcePath)),
    semantic: kind === 'semantic-design', targetPackages: snapshot.targetPackages,
  }, authority);
}

/** Standalone component preview shares the loader, but every project import uses current authorized bytes. */
export function bundleComponentPreview(input: { sourcePath: string; sourceText: string; exportName: string } & ComponentPreviewBootstrap, authority: PreviewBundleAuthority): Promise<PreviewBundleResult> {
  return bundlePreview({ sourcePath: input.sourcePath, content: input.sourceText, exportName: input.exportName, language: 'tsx' }, {
    frozen: new Map(), sourceProof: new Map(), generatedProjectPaths: new Set(), generatedFrozenPaths: new Set(), semantic: false, targetPackages: [],
  }, authority, input);
}

async function bundlePreview(file: PreviewEntry, policy: PreviewSourcePolicy, authority: PreviewBundleAuthority, component?: ComponentPreviewBootstrap): Promise<PreviewBundleResult> {
  const framework = file.language === 'vue' ? 'vue' : 'react';
  const modules = new Map<string, Module>(); const loaded = new Map<string, Uint8Array>(); const installed = new Map<string, Uint8Array>();
  const evidence = new Map<string, DesignPreviewSourceEvidence>(); const packages = new Map<string, HandoffTargetPackage>();
  const { frozen, sourceProof } = policy;
  const packageCache = new Map<string, Promise<PackageRoot>>(); let totalBytes = 0;
  const add = (module: Module) => { const key = JSON.stringify([module.origin, module.package?.root, module.path]); if (!modules.has(key)) modules.set(key, module); return key; };
  const record = (module: Module, data: Uint8Array) => {
    const key = JSON.stringify([module.origin, module.package?.name, module.package?.version, module.path]);
    if (!evidence.has(key)) {
      totalBytes += data.length; if (data.length > MAX_FILE || totalBytes > MAX_BYTES || evidence.size >= MAX_FILES) unsupported('Preview source traversal exceeded its file or byte budget.');
      evidence.set(key, { origin: module.origin, sourcePath: module.path, byteLength: data.length, digest: previewDigest(Buffer.from(data).toString('base64')),
        ...(module.package ? { packageName: module.package.name, version: module.package.version } : {}) });
    }
  };
  const locate = (name: string, directory: string) => {
    const key = JSON.stringify([name, directory]); let cached = packageCache.get(key);
    if (!cached) { cached = findPackage(name, directory); packageCache.set(key, cached); }
    return cached;
  };
  async function project(path: string): Promise<Module> {
    if (!SourcePathSchema.safeParse(path).success) return unsupported('Preview import escapes the project source namespace.');
    if (!authority.readProjectFile && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2'].includes(extname(path).toLowerCase())) return unsupported(`Binary project asset ${path} requires a byte-preserving source reader and is not supported.`);
    const data = authority.readProjectFile ? await authority.readProjectFile(path) : bytes(await authority.readProjectSource(path));
    if (sourceProof.has(path) && sourceProof.get(path) !== decoded(data)) return unsupported(`Current source ${path} changed after binding proof.`);
    return { origin: 'current-project', path, contents: data };
  }
  async function virtualRelative(parent: Module, specifier: string): Promise<Module> {
    const path = posix.normalize(posix.join(posix.dirname(parent.path), specifier));
    if (!SourcePathSchema.safeParse(path).success) return unsupported('Preview import escapes the source namespace.');
    const candidates = extname(path) ? [path] : [path, ...['.tsx', '.ts', '.jsx', '.js', '.vue', '.json', '/index.tsx', '/index.ts', '/index.jsx', '/index.js', '/index.vue'].map((suffix) => path + suffix)];
    for (const candidate of candidates) {
      // Generated calls have explicit DS/project ownership. Transitive project imports
      // always read current project bytes, even when a frozen file has the same path.
      const generatedProject = parent.origin === 'generated' && policy.generatedProjectPaths.has(candidate);
      const useFrozen = parent.origin === 'frozen-design-system' || parent.origin === 'generated' && !generatedProject && (policy.semantic || policy.generatedFrozenPaths.has(candidate));
      if (useFrozen && frozen.has(candidate)) {
        const source = frozen.get(candidate)!;
        if (sourceProof.has(candidate) && !Buffer.from(source).equals(Buffer.from(sourceProof.get(candidate)!))) return unsupported(`Frozen and project code collide at ${candidate}.`);
        return { origin: 'frozen-design-system', path: candidate, contents: source };
      }
      if (parent.origin === 'frozen-design-system' || parent.origin === 'generated' && !generatedProject) continue;
      try { return await project(candidate); } catch (error) { if (error instanceof UnsupportedPreviewSource) throw error; }
    }
    return unsupported(`Source import ${specifier} from ${parent.path} is unavailable.`);
  }
  const resolvedModule = async (module: Module, kind: string) => {
    if (kind !== 'url-token') return { namespace: 'od-preview', path: add(module) };
    const mime = assetMime[extname(module.path).toLowerCase()];
    if (!mime) return unsupported(`Unsupported CSS asset ${module.path}.`);
    const data = module.contents ?? await readBounded(join(module.package!.root, module.path));
    record(module, data);
    if (module.origin === 'installed-package') installed.set(join(module.package!.root, module.path), data);
    return { path: `data:${mime};base64,${Buffer.from(data).toString('base64')}`, external: true };
  };
  const screenKey = add({ origin: component ? 'current-project' : 'generated', path: file.sourcePath, contents: bytes(file.content) });
  const reactGlobalKey = component ? add({ origin: 'generated', path: '.od-preview/react-global.ts', contents: bytes("import React from 'react'; globalThis.React=React;") }) : null;
  const bootstrapKey = add({ origin: 'generated', path: '.od-preview/bootstrap.tsx', contents: bytes(component ? componentBootstrap(file.exportName, component) : bootstrap(framework, file.exportName)) });
  const plugin: Plugin = { name: 'verified-design-preview', setup(build) {
    build.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.defaultResolution === true) return;
      try {
        if (args.kind === 'entry-point') return { namespace: 'od-preview', path: bootstrapKey };
        const parent = modules.get(args.importer); if (!parent) return unsupported('Unknown preview source namespace.');
        if (args.path === 'od-preview:screen' && args.importer === bootstrapKey) return { namespace: 'od-preview', path: screenKey };
        if (args.path === 'od-preview:react-global' && args.importer === bootstrapKey && reactGlobalKey) return { namespace: 'od-preview', path: reactGlobalKey };
        if (modules.has(args.path) && args.path.startsWith('[')) return { namespace: 'od-preview', path: args.path };
        if (/^(?:https?:|data:|node:|file:|\/|\\|#)/.test(args.path) || args.path.includes('\\') || args.path.includes('?') || args.path.includes('#')) return unsupported(`Unsupported preview import ${args.path}.`);
        if (args.path.startsWith('.')) {
          if (!parent.package) return resolvedModule(await virtualRelative(parent, args.path), args.kind);
          const resolved = await build.resolve(args.path, { resolveDir: dirname(join(parent.package.root, parent.path)), kind: args.kind, pluginData: { defaultResolution: true } });
          if (resolved.errors.length || !resolved.path || resolved.external || resolved.namespace !== 'file') return unsupported(`Cannot resolve package-relative import ${args.path}.`);
          const absolute = await realpath(resolved.path); if (!inside(parent.package.root, absolute)) return unsupported(`Package import ${args.path} escapes its verified package root.`);
          return resolvedModule({ origin: parent.origin, package: parent.package, path: relative(parent.package.root, absolute).split(sep).join('/') }, args.kind);
        }
        const name = codeImportPackageName(args.path); if (!name) return unsupported(`Unsupported package import ${args.path}.`);
        const runtime = frameworkPackages[framework].includes(name) && (name === 'react' || name === 'react-dom' || name === 'vue' || parent.origin === 'tool-runtime');
        if (!runtime && parent.origin === 'tool-runtime') return unsupported(`Unexpected framework runtime dependency ${name}.`);
        const directRuntime = name === 'react' || name === 'react-dom' || name === 'vue';
        const directory = runtime ? directRuntime ? toolDirectory : parent.package?.root ?? toolDirectory : parent.package?.root ?? authority.projectRoot;
        if (!directory) return unsupported(`Installed package ${name} cannot be resolved without daemon project authority.`);
        const owner = await locate(name, directory);
        const pinned = runtime ? previewRuntimePackages(framework).find((entry) => entry.name === name) : undefined;
        if (pinned && owner.version !== pinned.version) return unsupported(`Framework runtime ${name} does not match the declared preview runtime version.`);
        const expected = policy.targetPackages.find((entry) => entry.name === name);
        if (!runtime && expected?.installation.status === 'observed' && expected.installation.version !== owner.version) return unsupported(`Installed ${name} changed after its exact version was observed.`);
        const observed = packages.get(name);
        if (observed?.installation.status === 'observed' && observed.installation.version !== owner.version) return unsupported(`Multiple installed versions of ${name} cannot be represented by one preview package observation.`);
        if (!runtime) packages.set(name, { name, ...(expected?.declaredRange ? { declaredRange: expected.declaredRange } : {}), installation: { status: 'observed', version: owner.version } });
        const origin = runtime ? 'tool-runtime' : 'installed-package';
        record({ origin, path: 'package.json', package: owner }, owner.manifest);
        if (!runtime) installed.set(join(owner.root, 'package.json'), owner.manifest);
        // All templates are compiled by the daemon's SFC compiler; the browser needs
        // Vue's runtime-only entry, which does not compile templates with eval.
        const importPath = runtime && args.path === 'vue' ? 'vue/dist/vue.runtime.esm-bundler.js' : args.path;
        const resolved = await build.resolve(importPath, { resolveDir: directory, kind: args.kind, pluginData: { defaultResolution: true } });
        if (resolved.errors.length || !resolved.path || resolved.external || resolved.namespace !== 'file') return unsupported(`Cannot resolve installed export ${args.path}.`);
        const absolute = await realpath(resolved.path); if (!inside(owner.root, absolute)) return unsupported(`Export ${args.path} escapes its verified package root.`);
        return { namespace: 'od-preview', path: add({ origin, package: owner, path: relative(owner.root, absolute).split(sep).join('/') }) };
      } catch (error) { return { errors: [{ text: error instanceof Error ? error.message : String(error), detail: error }] }; }
    });
    build.onLoad({ filter: /.*/, namespace: 'od-preview' }, async (args) => {
      try {
        const module = modules.get(args.path)!; let data = loaded.get(args.path);
        if (!data) {
          data = module.contents ?? await readBounded(join(module.package!.root, module.path)); loaded.set(args.path, data); record(module, data);
          if (module.origin === 'installed-package') installed.set(join(module.package!.root, module.path), data);
        }
        const extension = extname(module.path).toLowerCase(); const loader = module.loader ?? loaderFor(extension);
        if (loader === 'dataurl') {
          // Esbuild sees an opaque virtual ID, so preserve MIME from the proven source path.
          return { contents: `export default ${JSON.stringify(`data:${assetMime[extension]};base64,${Buffer.from(data).toString('base64')}`)};`, loader: 'js' };
        }
        let source = decoded(data);
        if (extension === '.vue') {
          const compiled = compileVueSource(source, module.path);
          source = compiled.javascript;
          for (let index = 0; index < compiled.styles.length; index++) {
            const style = add({ ...module, path: `${module.path}.style${index}.css`, contents: bytes(compiled.styles[index]!), loader: 'css' });
            source = `import ${JSON.stringify(style)};\n${source}`;
          }
        }
        if (module.origin !== 'tool-runtime' && (loader === 'tsx' || loader === 'ts' || loader === 'js' || loader === 'jsx')) checkStaticImports(source, module.path);
        return { contents: source, loader };
      } catch (error) { return { errors: [{ text: error instanceof Error ? error.message : String(error), detail: error }] }; }
    });
  } };
  const diagnostics: ValidationDiagnostic[] = []; let bundle: DesignPreviewBundle | null = null;
  const ctx = await createBuildContext({ entryPoints: ['od-preview:entry'], bundle: true, write: false, outfile: 'preview.js', platform: 'browser', format: 'iife', target: 'es2022',
    jsx: 'automatic', minify: true, sourcemap: false, legalComments: 'none', logLevel: 'silent', plugins: [plugin],
    tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } },
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
  });
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; void ctx.cancel(); }, 20_000);
  try {
    const built = await ctx.rebuild();
    if (timedOut) unsupported('Preview bundling exceeded its time budget.');
    if (built.warnings.length) return unsupported(built.warnings.map((warning) => warning.text).join(' '));
    const javascript = built.outputFiles.find((output) => output.path.endsWith('.js'))?.text ?? '';
    const css = built.outputFiles.find((output) => output.path.endsWith('.css'))?.text ?? '';
    if (javascript.length > 8 * 1024 * 1024 || css.length > 2 * 1024 * 1024) unsupported('Preview output exceeded its byte budget.');
    bundle = { javascript, css, digest: previewDigest({ javascript, css }) };
  } catch (error) {
    const errors = error && typeof error === 'object' && 'errors' in error ? error.errors as { text: string; detail?: unknown }[] : [{ text: error instanceof Error ? error.message : String(error), detail: error }];
    diagnostics.push(previewDiagnostic(errors.some((entry) => entry.detail instanceof UnsupportedPreviewSource) ? 'ODDS8002' : 'ODDS8003', errors.map((entry) => entry.text).join(' ').slice(0, 8000)));
  } finally { clearTimeout(timer); await ctx.dispose(); }
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  return { bundle, diagnostics, sourceEvidence: [...evidence.values()].sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right))), targetPackages: [...packages.values()].sort((left, right) => compare(left.name, right.name)),
    verifyInstalledSources: async () => { for (const [path, data] of installed) { try { if (!Buffer.from(await readBounded(path)).equals(Buffer.from(data))) return false; } catch { return false; } } return true; },
  };
}

function loaderFor(extension: string): Loader {
  if (extension === '.vue' || extension === '.ts') return 'ts';
  if (extension === '.tsx') return 'tsx'; if (extension === '.jsx') return 'jsx';
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') return 'js';
  if (extension === '.json') return 'json'; if (extension === '.css') return 'css';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.woff', '.woff2'].includes(extension)) return 'dataurl';
  return unsupported(`Unsupported preview asset/source type ${extension || '(none)'}.`);
}

function compileVueSource(source: string, filename: string): { javascript: string; styles: string[] } {
  const parsed = parseSfc(source, { filename }); if (parsed.errors.length) return unsupported(`Cannot parse Vue source ${filename}.`);
  let { descriptor } = parsed;
  if (descriptor.script?.src || descriptor.scriptSetup?.src || descriptor.template?.src || descriptor.styles.some((style) => style.src || style.lang && style.lang !== 'css' || style.module) || descriptor.customBlocks.length) return unsupported(`Vue external blocks, preprocessors, CSS modules and custom blocks are unsupported in ${filename}.`);
  if (descriptor.template?.lang && descriptor.template.lang !== 'html') return unsupported(`Unsupported Vue template language in ${filename}.`);
  const id = previewDigest(filename).slice(7, 19); const scoped = descriptor.styles.some((style) => style.scoped);
  // A template-only SFC uses an empty script setup to share the actual Vue compiler path.
  if (!descriptor.script && !descriptor.scriptSetup) {
    descriptor = parseSfc(`<script setup>const __preview = true;</script>\n${source}`, { filename }).descriptor;
  }
  if (!descriptor.scriptSetup) return unsupported(`Vue preview currently requires script setup or a template-only component in ${filename}.`);
  const script = compileScript(descriptor, { id, genDefaultAs: '__component', inlineTemplate: true, sourceMap: false, fs: { fileExists: () => false, readFile: () => undefined }, templateOptions: { transformAssetUrls: true, compilerOptions: { scopeId: scoped ? `data-v-${id}` : null } } });
  const styles = descriptor.styles.map((style) => {
    const compiled = compileStyle({ source: style.content, filename, id: `data-v-${id}`, scoped: style.scoped ?? false });
    if (compiled.errors.length) return unsupported(`Cannot compile Vue style in ${filename}.`);
    return compiled.code;
  });
  return { javascript: `${script.content}\n${scoped ? `__component.__scopeId = ${JSON.stringify(`data-v-${id}`)};` : ''}\nexport default __component;`, styles };
}

function bootstrap(framework: 'react' | 'vue', exportName: string): string {
  const imported = exportName === 'default' ? 'import Screen from "od-preview:screen";' : `import { ${exportName} as Screen } from "od-preview:screen";`;
  const report = 'const report=(status,message)=>globalThis.__OD_PREVIEW_REPORT__?.(status,message);';
  if (framework === 'vue') return `${imported}\nimport {createApp} from 'vue'; ${report} let failed=false; const app=createApp(Screen); app.config.errorHandler=(error)=>{failed=true;report('error',String(error));}; app.mount('#od-preview-root'); queueMicrotask(()=>{if(!failed)report('rendered');});`;
  return `${imported}\nimport React,{useEffect} from 'react'; import {createRoot} from 'react-dom/client'; ${report}
class Boundary extends React.Component { constructor(props){super(props);this.state={failed:false};} static getDerivedStateFromError(){return {failed:true};} componentDidCatch(error){report('error',String(error));} render(){return this.state.failed?null:this.props.children;} }
function Preview(){useEffect(()=>{report('rendered');},[]);return <Screen/>;} createRoot(document.getElementById('od-preview-root')).render(<Boundary><Preview/></Boundary>);`;
}

function componentBootstrap(exportName: string, input: ComponentPreviewBootstrap): string {
  // JSON.parse retains own __proto__/constructor keys as data rather than object-literal semantics.
  const json = (value: unknown) => `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
  return `import 'od-preview:react-global';
import * as Exports from 'od-preview:screen';
import React,{useEffect} from 'react'; import {createRoot} from 'react-dom/client';
const Screen=Exports[${JSON.stringify(exportName)}];
const report=(status,message)=>globalThis.__OD_PREVIEW_REPORT__?.(status,message);
const callbacks=${json(input.callbacks)};
function materialize(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Preview props must be a JSON object.');
  const result=JSON.parse(JSON.stringify(value));
  for(const callback of callbacks){
    let owner=result;const path=callback.path;
    for(let index=0;index<path.length-1;index++){
      if(!owner||typeof owner!=='object'||!Object.hasOwn(owner,path[index])){owner=null;break;}
      owner=owner[path[index]];
    }
    const name=path[path.length-1];
    if(!owner||typeof owner!=='object'||!Object.hasOwn(owner,name)||owner[name]!==null)continue;
    const value=()=>callback.returnValue===undefined?undefined:JSON.parse(JSON.stringify(callback.returnValue));
    Object.defineProperty(owner,name,{value:callback.async?async()=>value():()=>value(),enumerable:true,configurable:true,writable:true});
  }
  return result;
}
class Boundary extends React.Component{
  constructor(props){super(props);this.state={failed:false};}
  static getDerivedStateFromError(){return {failed:true};}
  componentDidCatch(error){report('error',String(error));}
  render(){return this.state.failed?null:this.props.children;}
}
function Preview({values}){useEffect(()=>{report('rendered');},[]);return React.createElement(Screen,values);}
const root=createRoot(document.getElementById('od-preview-root'));let revision=0;
const update=(value)=>{try{const values=materialize(value);root.render(<Boundary key={++revision}><Preview values={values}/></Boundary>);}catch(error){report('error',String(error));}};
Object.defineProperty(globalThis,'__OD_COMPONENT_PREVIEW_UPDATE_PROPS__',{value:update,writable:false,configurable:false});
update(${json(input.props)});`;
}
