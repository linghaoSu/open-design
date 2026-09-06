import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import {
  MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER,
  MAC_PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES,
  MAC_PREBUNDLE_ESBUILD_TARGET,
  MAC_PREBUNDLE_POLICIES,
  MAC_PREBUNDLE_RUNTIME_DEPENDENCIES,
  MAC_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH,
  MAC_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH,
  MAC_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH,
  assertMacPrebundleMetafile,
  findForbiddenMacPrebundleInputs,
  renderMacPackagedMainEntry,
  shouldInstallInternalPackageForMacPrebundle,
  shouldUseMacStandalonePrebundle,
} from "@/mac/prebundle.js";

// Materialize the installed runtime closure into an OS temp directory. No
// workspace symlinks or NODE_PATH fallback can make the preview probe pass.
async function copyInstalledPackageClosure(appRoot: string, packageNames: string[], importer: string): Promise<void> {
  const copied = new Set<string>();
  async function copyPackage(name: string, from: string, nodeModules = join(appRoot, "node_modules"), optional = false): Promise<void> {
    const require = createRequire(from);
    let manifestPath: string | null = null;
    for (const directory of require.resolve.paths(name) ?? []) {
      const candidate = join(directory, name, "package.json");
      if (await readFile(candidate).then(() => true, () => false)) { manifestPath = await realpath(candidate); break; }
    }
    if (!manifestPath) { if (optional) return; throw new Error(`Missing installed runtime package ${name}`); }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
    };
    const identity = `${encodeURIComponent(name)}@${manifest.version}`;
    const packageModules = join(appRoot, "node_modules", ".runtime", identity, "node_modules");
    const target = join(packageModules, name);
    const link = join(nodeModules, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), target), link).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    if (copied.has(identity)) return;
    copied.add(identity);
    await mkdir(dirname(target), { recursive: true });
    await cp(dirname(manifestPath), target, { dereference: true, recursive: true });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      await copyPackage(dependency, manifestPath, packageModules, Object.hasOwn(manifest.optionalDependencies ?? {}, dependency));
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) await copyPackage(dependency, manifestPath, packageModules, true);
  }
  for (const name of packageNames) await copyPackage(name, importer);
}

describe("mac standalone prebundle policy", () => {
  it("is enabled only for standalone web output", () => {
    expect(shouldUseMacStandalonePrebundle("standalone")).toBe(true);
    expect(shouldUseMacStandalonePrebundle("server")).toBe(false);
  });

  it("keeps server-mode package topology unchanged", () => {
    expect(
      shouldInstallInternalPackageForMacPrebundle({
        packageName: "@open-design/web",
        webOutputMode: "server",
      }),
    ).toBe(true);
    expect(
      shouldInstallInternalPackageForMacPrebundle({
        packageName: "@open-design/packaged",
        webOutputMode: "server",
      }),
    ).toBe(true);
  });

  it("excludes internal packages replaced by mac standalone prebundles", () => {
    for (const packageName of [
      "@open-design/daemon",
      "@open-design/desktop",
      "@open-design/packaged",
      "@open-design/sidecar-proto",
      "@open-design/web",
    ]) {
      expect(
        shouldInstallInternalPackageForMacPrebundle({
          packageName,
          webOutputMode: "standalone",
        }),
      ).toBe(false);
    }
    for (const packageName of [
      "@open-design/contracts",
      "@open-design/platform",
      "@open-design/sidecar",
    ]) {
      expect(
        shouldInstallInternalPackageForMacPrebundle({ packageName, webOutputMode: "standalone" }),
      ).toBe(true);
    }
  });

  it("documents the explicit code-level bundle boundaries", () => {
    expect(MAC_PREBUNDLE_ESBUILD_TARGET).toBe("node24");
    expect(MAC_PREBUNDLE_POLICIES.packagedMain.externals).toEqual(["@open-design/sidecar", "electron"]);
    expect(MAC_PREBUNDLE_POLICIES.daemonCli.externals).toEqual([
      "@ffmpeg-installer/ffmpeg",
      "@open-design/sidecar",
      "@vue/compiler-sfc",
      "better-sqlite3",
      "blake3-wasm",
      "esbuild",
      "fsevents",
      "hyperframes",
      "node-pty",
    ]);
    expect(MAC_PREBUNDLE_POLICIES.daemonSidecar.externals).toEqual([
      "@ffmpeg-installer/ffmpeg",
      "@open-design/sidecar",
      "@vue/compiler-sfc",
      "better-sqlite3",
      "blake3-wasm",
      "esbuild",
      "fsevents",
      "hyperframes",
      "node-pty",
    ]);
    expect(MAC_PREBUNDLE_POLICIES.webSidecar.externals).toEqual(["@open-design/sidecar"]);
    expect(MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER).toContain("createRequire");
    // Must match apps/daemon/package.json / the pnpm lockfile, or
    // electron-builder's collector drops the module from the shipped app and
    // the daemon dies at boot with ERR_MODULE_NOT_FOUND (issue #4638).
    expect(MAC_PREBUNDLE_RUNTIME_DEPENDENCIES).toEqual({
      "@ffmpeg-installer/ffmpeg": "1.1.0",
      "@vue/compiler-sfc": "3.5.42",
      "better-sqlite3": "12.10.0",
      "blake3-wasm": "2.1.5",
      "esbuild": "0.28.0",
      "hyperframes": "0.8.1",
      "node-pty": "1.1.0",
      "react": "18.3.1",
      "react-dom": "18.3.1",
      "sharp": "0.35.3",
      "vue": "3.5.42",
    });
    expect(MAC_PREBUNDLE_COPIED_RUNTIME_DEPENDENCIES).toEqual({ "fsevents": "2.3.3" });
    expect(MAC_PREBUNDLED_DAEMON_CLI_RELATIVE_PATH).toBe("app/prebundled/daemon/daemon-cli.mjs");
    expect(MAC_PREBUNDLED_DAEMON_SIDECAR_RELATIVE_PATH).toBe("app/prebundled/daemon/daemon-sidecar.mjs");
    expect(MAC_PREBUNDLED_WEB_SIDECAR_RELATIVE_PATH).toBe("app/prebundled/web-sidecar.mjs");
  });

  it.skipIf(process.platform !== "darwin")(
    "keeps chokidar's native fsevents binding outside daemon bundles",
    async () => {
      const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const result = await build({
        banner: { js: MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER },
        bundle: true,
        external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        stdin: {
          contents: 'import "chokidar";',
          loader: "js",
          resolveDir: join(workspaceRoot, "apps", "daemon"),
        },
        target: MAC_PREBUNDLE_ESBUILD_TARGET,
        write: false,
      });

      expect(Object.keys(result.metafile.inputs).some((input) => input.includes("/node_modules/fsevents/"))).toBe(
        false,
      );
    },
  );

  it(
    "preserves Vue's optional preprocessor loading and esbuild's native binary boundary",
    async () => {
      const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const result = await build({
        bundle: true,
        external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        stdin: {
          contents: 'export { parse, compileScript, compileStyle } from "@vue/compiler-sfc"; export { context } from "esbuild";',
          loader: "js",
          resolveDir: join(workspaceRoot, "apps", "daemon"),
        },
        target: MAC_PREBUNDLE_ESBUILD_TARGET,
        write: false,
      });
      expect(Object.keys(result.metafile.inputs)).toEqual(["<stdin>"]);
      expect(result.outputFiles[0]?.text).toContain('from "@vue/compiler-sfc"');
      expect(result.outputFiles[0]?.text).toContain('from "esbuild"');
    },
  );

  it(
    "keeps node-pty's native runtime outside daemon bundles",
    async () => {
      const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const result = await build({
        banner: { js: MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER },
        bundle: true,
        external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        platform: "node",
        entryPoints: [join(workspaceRoot, "apps", "daemon", "src", "terminals.ts")],
        target: MAC_PREBUNDLE_ESBUILD_TARGET,
        write: false,
      });

      expect(
        Object.keys(result.metafile.inputs).some((input) => input.includes("/node_modules/node-pty/")),
      ).toBe(false);
    },
  );

  it("builds React and Vue previews from real runtime packages beside an isolated split daemon chunk", async () => {
    const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const root = await mkdtemp(join(tmpdir(), "design-loom-preview-runtime-"));
    const appRoot = join(root, "app");
    const outdir = join(appRoot, "prebundled", "daemon");
    const previewModule = join(workspaceRoot, "apps/daemon/src/services/design-runtime/preview-bundler.ts");
    const runtimeNames = ["@vue/compiler-sfc", "esbuild", "react", "react-dom", "vue"] as const;
    try {
      const daemonManifest = JSON.parse(await readFile(join(workspaceRoot, "apps/daemon/package.json"), "utf8"));
      for (const name of runtimeNames) expect(MAC_PREBUNDLE_RUNTIME_DEPENDENCIES[name]).toBe(daemonManifest.dependencies[name]);
      await copyInstalledPackageClosure(appRoot, [...runtimeNames], join(workspaceRoot, "apps/daemon/package.json"));
      await writeFile(join(root, "first.ts"), `export { bundleComponentPreview, bundleDesignPreview } from ${JSON.stringify(previewModule)};`);
      await writeFile(join(root, "second.ts"), `export { bundleComponentPreview } from ${JSON.stringify(previewModule)};`);
      const built = await build({
        entryPoints: [join(root, "first.ts"), join(root, "second.ts")],
        outdir, entryNames: "[name]", chunkNames: "chunks/[name]-[hash]", outExtension: { ".js": ".mjs" },
        bundle: true, splitting: true, platform: "node", format: "esm", target: MAC_PREBUNDLE_ESBUILD_TARGET,
        banner: { js: MAC_DAEMON_PREBUNDLE_ESM_REQUIRE_BANNER },
        external: [...MAC_PREBUNDLE_POLICIES.daemonSidecar.externals], metafile: true, logLevel: "silent",
      });
      const previewOutput = Object.entries(built.metafile.outputs).find(([, output]) =>
        Object.keys(output.inputs).some((input) => input.endsWith("/preview-bundler.ts")))?.[0];
      expect(previewOutput).toContain("/prebundled/daemon/chunks/");
      const probe = join(root, "probe.mjs");
      await writeFile(probe, `
        import { bundleComponentPreview, bundleDesignPreview } from './app/prebundled/daemon/first.mjs';
        const authority = { readProjectSource: async () => { throw new Error('No project imports'); } };
        const react = await bundleComponentPreview({sourcePath:'Card.tsx', exportName:'Card', sourceText:'export function Card(){return <button>Isolated React</button>}',props:{},callbacks:[]}, authority);
        const vue = await bundleDesignPreview({sourcePath:'Card.vue',exportName:'default',language:'vue',content:'<script setup>const label="Isolated Vue"</script><template><button>{{label}}</button></template><style scoped>button{color:red}</style>'},
          {versions:[],projectSources:[],projectCodeIndex:{components:[]},baseCodeIndex:{components:[]},targetPackages:[]}, 'semantic-design', authority);
        const summarize = async (result) => ({bundle:!!result.bundle,css:result.bundle?.css,diagnostics:result.diagnostics,packages:[...new Set(result.sourceEvidence.map(e=>e.packageName).filter(Boolean))],verified:await result.verifyInstalledSources()});
        console.log(JSON.stringify({react:await summarize(react),vue:await summarize(vue)}));
      `);
      const { stdout } = await promisify(execFile)(process.execPath, [probe], {
        cwd: root, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000,
      });
      const result = JSON.parse(stdout);
      expect(result.react).toMatchObject({ bundle: true, diagnostics: [], verified: true });
      expect(result.react.packages).toEqual(expect.arrayContaining(["react", "react-dom", "scheduler"]));
      expect(result.vue).toMatchObject({ bundle: true, diagnostics: [], verified: true });
      expect(result.vue.packages).toEqual(expect.arrayContaining(["vue", "@vue/runtime-dom", "@vue/runtime-core"]));
      expect(result.vue.css).toContain("color:red");
      // Removing an installed framework must fail, rather than finding the
      // developer checkout's copy and hiding an incomplete app payload.
      await rm(join(appRoot, "node_modules", "react"));
      const missing = await promisify(execFile)(process.execPath, [probe], {
        cwd: root, env: { ...process.env, NODE_PATH: "" }, timeout: 30_000,
      });
      const missingReact = JSON.parse(missing.stdout).react;
      expect(missingReact.bundle).toBe(false);
      expect(missingReact.diagnostics.some((entry: { message: string }) => entry.message.includes("react is not installed"))).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 45_000);
});

describe("findForbiddenMacPrebundleInputs", () => {
  it("matches forbidden dependency roots after path normalization", () => {
    expect(
      findForbiddenMacPrebundleInputs({
        forbiddenInputs: MAC_PREBUNDLE_POLICIES.webSidecar.forbiddenInputs,
        inputs: [
          "src/index.ts",
          "C:\\repo\\node_modules\\next\\dist\\server.js",
          "/repo/node_modules/openai/index.mjs",
        ],
      }),
    ).toEqual([
      "C:/repo/node_modules/next/dist/server.js",
      "/repo/node_modules/openai/index.mjs",
    ]);
  });
});

describe("assertMacPrebundleMetafile", () => {
  it("accepts a safe web sidecar metafile", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-mac-prebundle-"));
    const metafilePath = join(root, "safe.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({ inputs: { "/repo/apps/web/sidecar/index.ts": {} } }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "webSidecar" }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a packaged main metafile that pulled in web runtime closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-mac-prebundle-"));
    const metafilePath = join(root, "unsafe.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({ inputs: { "/repo/node_modules/@open-design/web/dist/sidecar/index.js": {} } }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "packagedMain" }),
      ).rejects.toThrow(/packaged main prebundle included forbidden inputs/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a daemon metafile that bundled wasm-backed runtime dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-mac-prebundle-"));
    const metafilePath = join(root, "unsafe-daemon.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({ inputs: { "/repo/node_modules/blake3-wasm/dist/node/index.js": {} } }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "daemonSidecar" }),
      ).rejects.toThrow(/daemon sidecar prebundle included forbidden inputs/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a daemon metafile that bundled native runtime dependencies", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-mac-prebundle-"));
    const metafilePath = join(root, "unsafe-native-daemon.json");

    try {
      await writeFile(
        metafilePath,
        JSON.stringify({
          inputs: {
            "/repo/node_modules/fsevents/fsevents.js": {},
            "/repo/node_modules/node-pty/lib/index.js": {},
          },
        }),
        "utf8",
      );

      await expect(
        assertMacPrebundleMetafile({ metafilePath, policyName: "daemonSidecar" }),
      ).rejects.toThrow(/daemon sidecar prebundle included forbidden inputs/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("renderMacPackagedMainEntry", () => {
  it("renders the prebundled runtime entry shim", () => {
    expect(renderMacPackagedMainEntry(true)).toContain("./prebundled/packaged-main.mjs");
    expect(renderMacPackagedMainEntry(true)).not.toContain("@open-design/packaged");
  });

  it("renders the package entry shim for non-prebundled mode", () => {
    expect(renderMacPackagedMainEntry(false)).toContain("@open-design/packaged");
    expect(renderMacPackagedMainEntry(false)).not.toContain("./prebundled/packaged-main.mjs");
  });
});
