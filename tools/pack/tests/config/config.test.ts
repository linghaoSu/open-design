import { afterEach, describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import { assertDesignLoomPackagedPlatform, resolveToolPackConfig, WORKSPACE_ROOT } from "@/config/index.js";

const savedTelemetryRelayUrl = process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL;
const savedPosthogKey = process.env.POSTHOG_KEY;
const savedPosthogHost = process.env.POSTHOG_HOST;
const savedAmrProfile = process.env.OPEN_DESIGN_AMR_PROFILE;
const savedVelaWebUrl = process.env.OD_VELA_WEB_URL;
const savedVelaWebUrlProd = process.env.OD_VELA_WEB_URL_PROD;
const savedVelaWebUrlTest = process.env.OD_VELA_WEB_URL_TEST;
const savedVelaWebUrlFeatureTest = process.env.OD_VELA_WEB_URL_FEATURE_TEST;

afterEach(() => {
  if (savedVelaWebUrl == null) {
    delete process.env.OD_VELA_WEB_URL;
  } else {
    process.env.OD_VELA_WEB_URL = savedVelaWebUrl;
  }
  if (savedVelaWebUrlProd == null) delete process.env.OD_VELA_WEB_URL_PROD;
  else process.env.OD_VELA_WEB_URL_PROD = savedVelaWebUrlProd;
  if (savedVelaWebUrlTest == null) delete process.env.OD_VELA_WEB_URL_TEST;
  else process.env.OD_VELA_WEB_URL_TEST = savedVelaWebUrlTest;
  if (savedVelaWebUrlFeatureTest == null) delete process.env.OD_VELA_WEB_URL_FEATURE_TEST;
  else process.env.OD_VELA_WEB_URL_FEATURE_TEST = savedVelaWebUrlFeatureTest;
  if (savedTelemetryRelayUrl == null) {
    delete process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL;
  } else {
    process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL = savedTelemetryRelayUrl;
  }
  if (savedPosthogKey == null) {
    delete process.env.POSTHOG_KEY;
  } else {
    process.env.POSTHOG_KEY = savedPosthogKey;
  }
  if (savedPosthogHost == null) {
    delete process.env.POSTHOG_HOST;
  } else {
    process.env.POSTHOG_HOST = savedPosthogHost;
  }
  if (savedAmrProfile == null) {
    delete process.env.OPEN_DESIGN_AMR_PROFILE;
  } else {
    process.env.OPEN_DESIGN_AMR_PROFILE = savedAmrProfile;
  }
});

describe("resolveToolPackConfig AMR profile", () => {
  it("bakes OPEN_DESIGN_AMR_PROFILE into packaged config when set at build time", () => {
    process.env.OPEN_DESIGN_AMR_PROFILE = "feature-test";
    const config = resolveToolPackConfig("mac", { namespace: "design-loom-amr-profile-test" });
    expect(config.amrProfile).toBe("feature-test");
  });

  it("rejects unsupported AMR profiles before packaging", () => {
    process.env.OPEN_DESIGN_AMR_PROFILE = "staging";
    expect(() => resolveToolPackConfig("mac")).toThrow(
      /OPEN_DESIGN_AMR_PROFILE must be prod, test, feature-test, or local/,
    );
  });
});

describe("resolveToolPackConfig Vela CLI requirement", () => {
  it("defaults to optional Vela CLI bundling", () => {
    const config = resolveToolPackConfig("mac", { namespace: "design-loom-vela-optional-test" });
    expect(config.requireVelaCli).toBe(false);
  });

  it("reads --require-vela-cli from build options", () => {
    const config = resolveToolPackConfig("mac", {
      namespace: "design-loom-vela-required-test",
      requireVelaCli: true,
    });
    expect(config.requireVelaCli).toBe(true);
  });
});

describe("resolveToolPackConfig mac signing requirements", () => {
  it.each([undefined, false])("rejects notarization without explicit signing (%s)", (signed) => {
    expect(() => resolveToolPackConfig("mac", { notarize: true, ...(signed === undefined ? {} : { signed }) }))
      .toThrow(/--notarize requires --signed/);
  });

  it("retains explicitly unsigned local builds and accepts signed notarized builds", () => {
    expect(resolveToolPackConfig("mac", { signed: false })).toMatchObject({ signed: false, macNotarize: false });
    expect(resolveToolPackConfig("mac", { signed: true, notarize: true })).toMatchObject({ signed: true, macNotarize: true });
  });
});

describe("resolveToolPackConfig win build target", () => {
  it("accepts the portable zip target and rejects unsupported values", () => {
    expect(resolveToolPackConfig("win", { to: "zip" }).to).toBe("zip");
    expect(resolveToolPackConfig("win", { to: "all" }).to).toBe("all");
    expect(resolveToolPackConfig("win", { to: "nsis" }).to).toBe("nsis");
    expect(() => resolveToolPackConfig("win", { to: "dmg" })).toThrow(/unsupported win --to target: dmg/);
  });
});

describe("resolveToolPackConfig cache root", () => {
  it("keeps the default cache outside custom tools-pack roots", () => {
    const config = resolveToolPackConfig("win", {
      dir: "C:\\odqa-release-4ch",
      namespace: "design-loom-cache-root-test",
    });

    expect(config.roots.toolPackRoot).toBe(resolve("C:\\odqa-release-4ch"));
    expect(config.roots.cacheRoot).toBe(resolve(join(WORKSPACE_ROOT, ".tmp", "tools-pack", "cache")));
  });

  it("uses an explicit cache-dir when supplied", () => {
    const config = resolveToolPackConfig("win", {
      cacheDir: "C:\\odqa-tools-pack-cache",
      dir: "C:\\odqa-release-4ch",
      namespace: "design-loom-cache-root-test",
    });

    expect(config.roots.toolPackRoot).toBe(resolve("C:\\odqa-release-4ch"));
    expect(config.roots.cacheRoot).toBe(resolve("C:\\odqa-tools-pack-cache"));
  });
});

describe("Design Loom build isolation", () => {
  it("does not expose unbranded platform installers from this fork", () => {
    expect(() => assertDesignLoomPackagedPlatform("win")).toThrow(/macOS packaging only/);
    expect(() => assertDesignLoomPackagedPlatform("linux")).toThrow(/macOS packaging only/);
    expect(() => assertDesignLoomPackagedPlatform("mac")).not.toThrow();
  });
  it.each(["mac", "win", "linux"] as const)("uses the independent namespace and portable config for %s", (platform) => {
    const config = resolveToolPackConfig(platform, { appVersion: "0.1.0-beta.1", portable: false });
    expect(config.namespace).toBe("design-loom");
    expect(config.portable).toBe(true);
    expect(config.roots.runtime.namespaceBaseRoot).toContain(join("runtime", "design-loom", platform, "namespaces"));
  });
  it.each(["default", "open-design", "release-beta", "release-stable", "release-preview"])("rejects upstream namespace %s before lifecycle work", (namespace) => {
    expect(() => resolveToolPackConfig("mac", { namespace })).toThrow(/Design Loom requires namespace/);
  });
  it("allows explicit isolated acceptance namespaces", () => {
    expect(resolveToolPackConfig("mac", { namespace: "design-loom-acceptance" }).namespace).toBe("design-loom-acceptance");
  });
  it("ignores upstream telemetry and update build credentials", () => {
    process.env.OPEN_DESIGN_TELEMETRY_RELAY_URL = "https://telemetry.open-design.ai/api/langfuse";
    process.env.POSTHOG_KEY = "phc_upstream";
    process.env.POSTHOG_HOST = "https://us.i.posthog.com";
    const config = resolveToolPackConfig("mac");
    expect(config.telemetryRelayUrl).toBeUndefined();
    expect(config.posthogKey).toBeUndefined();
    expect(config.posthogHost).toBeUndefined();
    expect(config.posthogCliApiKey).toBeUndefined();
    expect(config.updateMetadataUrl).toBeUndefined();
  });
});

// The vela web origin of an internal (non-public) environment must never be a
// literal in this public repository. It is injected at packaging time from a CI
// secret keyed by AMR profile, exactly like POSTHOG_KEY, and flows on into
// open-design-config.json -> the packaged daemon spawn env (OD_VELA_WEB_URL).
describe("resolveToolPackConfig vela web origin", () => {
  it("bakes every supplied profile origin for runtime environment switching", () => {
    process.env.OD_VELA_WEB_URL_PROD = "https://prod.example.invalid";
    process.env.OD_VELA_WEB_URL_TEST = "https://test.example.invalid/";
    process.env.OD_VELA_WEB_URL_FEATURE_TEST = "https://feature.example.invalid";
    const config = resolveToolPackConfig("mac", { namespace: "design-loom-vela-web-test" });
    expect(config.velaWebUrls).toEqual({
      prod: "https://prod.example.invalid",
      test: "https://test.example.invalid",
      "feature-test": "https://feature.example.invalid",
    });
  });

  it("bakes OD_VELA_WEB_URL into packaged config when set at build time", () => {
    process.env.OD_VELA_WEB_URL = "https://vela.example.invalid";
    const config = resolveToolPackConfig("mac", { namespace: "design-loom-vela-web-test" });
    expect(config.velaWebUrl).toBe("https://vela.example.invalid");
  });

  it("omits the vela web origin for builds without the secret", () => {
    delete process.env.OD_VELA_WEB_URL;
    const config = resolveToolPackConfig("mac", { namespace: "design-loom-vela-web-test" });
    expect(config.velaWebUrl).toBeUndefined();
  });

  it("strips trailing slashes so the daemon can append console paths", () => {
    process.env.OD_VELA_WEB_URL = "https://vela.example.invalid///";
    const config = resolveToolPackConfig("mac", { namespace: "design-loom-vela-web-test" });
    expect(config.velaWebUrl).toBe("https://vela.example.invalid");
  });

  it("rejects a vela web origin that is not an absolute http(s) URL", () => {
    process.env.OD_VELA_WEB_URL = "vela.example.invalid";
    expect(() => resolveToolPackConfig("mac")).toThrow(
      /OD_VELA_WEB_URL must be an absolute URL/,
    );
  });
});
