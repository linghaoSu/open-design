import { DESIGN_LOOM_PRODUCT, assertDesignLoomNamespace } from "@open-design/release";
import type { ToolPackConfig } from "../config/index.js";

export type MacInstallIdentity = {
  appId: string;
  executableName: string;
  installerTitle: string;
  productName: string;
  publicAppBundleName: string;
  systemAppBundleName: string;
};


export function resolveMacInstallIdentity(config: Pick<ToolPackConfig, "namespace" | "appVersion">): MacInstallIdentity {
  assertDesignLoomNamespace(config.namespace);
  return {
    appId: DESIGN_LOOM_PRODUCT.appId,
    executableName: DESIGN_LOOM_PRODUCT.name,
    installerTitle: DESIGN_LOOM_PRODUCT.name,
    productName: DESIGN_LOOM_PRODUCT.name,
    publicAppBundleName: `${DESIGN_LOOM_PRODUCT.name}.app`,
    systemAppBundleName: `${DESIGN_LOOM_PRODUCT.name}.app`,
  };
}
