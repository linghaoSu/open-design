/** Authored distribution identity for this fork; never inferred from environment or a release feed. */
export const DESIGN_LOOM_PRODUCT = Object.freeze({
  name: 'Design Loom',
  id: 'design-loom',
  appId: 'io.github.linghaosu.designloom',
  protocol: 'designloom',
  repositoryUrl: 'https://github.com/linghaoSu/open-design',
  namespace: 'design-loom',
  cliName: 'designloom',
  updatesEnabled: false,
} as const);

/** A fork process must never discover, stop, or mutate an upstream namespace. */
export function assertDesignLoomNamespace(namespace: string): void {
  const suffix = namespace.slice(DESIGN_LOOM_PRODUCT.namespace.length + 1);
  if (namespace !== DESIGN_LOOM_PRODUCT.namespace
    && (!namespace.startsWith(`${DESIGN_LOOM_PRODUCT.namespace}-`) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(suffix))) {
    throw new Error(`Design Loom requires namespace ${DESIGN_LOOM_PRODUCT.namespace} or a namespace prefixed with ${DESIGN_LOOM_PRODUCT.namespace}-`);
  }
}
