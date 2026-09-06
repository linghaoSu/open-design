import { defaultProjectDesignValidationSettings, type DesignSystemSourceFile, type LegacyDesignSystemMigrationPlan, type LegacyDesignSystemMigrationReview } from '@open-design/contracts';
import { mixedProjectCompilerRequest } from './compiler-selections.js';

export function legacyMigrationFixture() {
  const { request, sources } = mixedProjectCompilerRequest();
  const files = new Map<string, DesignSystemSourceFile>([...sources].map(([path, content]) => [path, { path, encoding: 'utf8', content }]));
  files.set('tokens.css', { path: 'tokens.css', encoding: 'utf8', content: ':root { --accent: #ff3366; --space-4: 16px; --radius-md: 8px; --accent-hover: color-mix(in srgb, red, blue); }' });
  files.set('DESIGN.md', { path: 'DESIGN.md', encoding: 'utf8', content: '\ufeff# Legacy Acme\r\n\r\nKeep the existing brand guidance.\r\n' });
  files.set('assets/logo.png', { path: 'assets/logo.png', encoding: 'base64', content: Buffer.from([137, 80, 78, 71, 0, 255, 254, 1]).toString('base64') });
  const plan: LegacyDesignSystemMigrationPlan = { schemaVersion: 1, designSystemId: 'test', name: 'Legacy Acme', version: '1.0.0', mode: 'guided',
    sourcePaths: [...files.keys()], tokenStylesheet: 'tokens.css', selections: request.selections,
    constraints: defaultProjectDesignValidationSettings().projectConstraints, codeCompatibility: [] };
  return { files, plan };
}
export const legacyMigrationProof = (plan: LegacyDesignSystemMigrationPlan, review: LegacyDesignSystemMigrationReview) => ({
  expectedRevision: review.baseRevision, plan, reviewId: review.id, baseDigest: review.baseDigest, planDigest: review.planDigest, sourceDigest: review.sourceDigest,
});
