import { DESIGN_LOOM_PRODUCT } from "@open-design/release";

export function resolvePackagedWindowTitle(_config: { appVersion: string | null; namespace: string }): string {
  return DESIGN_LOOM_PRODUCT.name;
}
