import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "@/config/index.js";
import { resolveMacInstallIdentity } from "@/mac/identity.js";
import { resolveMacPaths } from "@/mac/paths.js";

function makeConfig(root: string, namespace: string): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace,
    platform: "mac",
    portable: true,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    requireVelaCli: false,
    roots: {
      output: {
        appBuilderRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace, "builder"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace),
        platformRoot: join(root, ".tmp", "tools-pack", "out", "mac"),
        root: join(root, ".tmp", "tools-pack", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces", namespace),
      },
      cacheRoot: join(root, ".tmp", "tools-pack", "cache"),
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    signed: false,
    silent: true,
    to: "dmg",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

describe("resolveMacInstallIdentity", () => {
  it.each([undefined, "0.1.0-beta.1", "0.1.0"])("keeps the fork app identity independent of version %s", (appVersion) => {
    const config = { ...makeConfig("/work", "design-loom"), ...(appVersion ? { appVersion } : {}) };
    expect(resolveMacInstallIdentity(config)).toEqual({
      appId: "io.github.linghaosu.designloom", executableName: "Design Loom",
      installerTitle: "Design Loom", productName: "Design Loom",
      publicAppBundleName: "Design Loom.app", systemAppBundleName: "Design Loom.app",
    });
    const paths = resolveMacPaths(config);
    expect(paths.installedAppPath).toBe("/work/.tmp/tools-pack/out/mac/namespaces/design-loom/install/Applications/Design Loom.app");
    expect(paths.appPath).toMatch(/Design Loom\.app$/);
    expect(paths.systemApplicationsAppPath).not.toContain("Open Design");
    expect(paths.dmgPath).toBe("/work/.tmp/tools-pack/out/mac/namespaces/design-loom/dmg/Design Loom-design-loom.dmg");
  });
  it.each(["default", "open-design", "release-stable", "release-beta"])("refuses to construct upstream install identity %s", (namespace) => {
    expect(() => resolveMacInstallIdentity(makeConfig("/work", namespace))).toThrow(/Design Loom requires/);
  });
});
