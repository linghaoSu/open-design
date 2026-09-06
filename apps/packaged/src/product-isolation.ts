import { join } from 'node:path';
import { DESIGN_LOOM_PRODUCT, assertDesignLoomNamespace } from '@open-design/release';

/** Ambient Open Design launch settings must not redirect this fork's storage or updater. */
export function isolateDesignLoomEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('OD_UPDATE_') || key.startsWith('POSTHOG_') || key.startsWith('LANGFUSE_') || key.startsWith('OPEN_DESIGN_TELEMETRY_') || key.startsWith('OPEN_DESIGN_OBJECT_RELAY_')) delete env[key];
  }
  for (const key of ['OD_DATA_DIR', 'OD_LEGACY_DATA_DIR', 'OD_PACKAGED_NAMESPACE_BASE_ROOT', 'OD_MEDIA_CONFIG_DIR', 'OD_WHATS_NEW_URL', 'OD_PACKAGED_ALLOW_WEB_OUTPUT_MODE_OVERRIDE', 'OD_WEB_STANDALONE_ROOT', 'OD_WEB_OUTPUT_MODE']) {
    delete env[key];
  }
  env.OD_UPDATE_ENABLED = '0';
  env.OD_UPDATE_AUTO_CHECK = '0';
  env.OPEN_DESIGN_VELA_TELEMETRY = '0';
}

export function designLoomUserDataRoot(appDataRoot: string): string {
  return join(appDataRoot, DESIGN_LOOM_PRODUCT.name);
}

export function resolveDesignLoomLaunchNamespace(configNamespace: string, stampNamespace?: string): string {
  assertDesignLoomNamespace(configNamespace);
  const namespace = stampNamespace ?? configNamespace;
  assertDesignLoomNamespace(namespace);
  return namespace;
}

export function assertDesignLoomPackagedIdentity(raw: { productId?: string; namespace?: string }, namespace: string): void {
  if (raw.productId !== DESIGN_LOOM_PRODUCT.id) {
    throw new Error('This application requires a Design Loom packaged configuration.');
  }
  assertDesignLoomNamespace(namespace);
}
