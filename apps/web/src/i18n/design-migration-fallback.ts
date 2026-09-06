import type { Dict } from './types';

/** English fallback for this migration namespace until each locale translates it. */
export const designMigrationFallback: Pick<Dict, Extract<keyof Dict, `designMigration.${string}`>> = {
  "designMigration.title": "Migration",
  "designMigration.htmlReference": "HTML files are preserved as visual references. They do not become code components.",
  "designMigration.description": "Review existing design system files, then publish and activate a structured version.",
  "designMigration.sources": "Project sources",
  "designMigration.sourcesHint": "Select the files to preserve in the package. CSS variables can become tokens; DESIGN.md and HTML remain source references.",
  "designMigration.tokenStylesheet": "Token stylesheet",
  "designMigration.noStylesheet": "No token stylesheet",
  "designMigration.codeTitle": "Code components (optional)",
  "designMigration.codeHint": "Select existing React or Vue exports to compile. HTML references do not become code components.",
  "designMigration.addComponent": "Add code component",
  "designMigration.constraints": "Validation constraints",
  "designMigration.review": "Review migration",
  "designMigration.apply": "Publish and activate reviewed version",
  "designMigration.ready": "Ready to publish and activate",
  "designMigration.blocked": "Resolve the review issues before applying",
  "designMigration.applied": "Published {version} and activated its exact dependency. Original files are preserved.",
  "designMigration.stale": "The project or source files changed. Review again before applying.",
  "designMigration.invalidResponse": "The migration response does not match this project and review.",
  "designMigration.converted": "Converted base tokens",
  "designMigration.unresolved": "Unresolved tokens",
  "designMigration.compiled": "Compiled components",
  "designMigration.packaged": "Packaged sources",
  "designMigration.tokenFoundation": "This is a token foundation without code components. It is not Strict ready.",
  "designMigration.readiness": "Migration activates Explore or Guided. Strict readiness requires verified code components and a validated semantic screen.",
  "designMigration.proof": "Review details",
  "designMigration.defaultName": "Migrated design system",
  "designMigration.noFiles": "Add existing design system files to this project before reviewing a migration."
};
