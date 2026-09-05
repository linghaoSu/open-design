import type { DesignGenerationPolicy, DesignGenerationTargets } from '../design-runtime/design-generation.js';

/** Host-issued facts; request bodies never supply a frozen policy or acceptance result. */
export interface DesignGenerationPromptFacts { policy: DesignGenerationPolicy; targets: DesignGenerationTargets }
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, stable(entry)])) : value;
export function renderDesignGenerationDirective(facts?: DesignGenerationPromptFacts): string {
  if (!facts) return '';
  return `## Host design generation policy

The host froze the following saved design policy for this logical task. Keep the user's intended design and reuse verified production bindings and declared tokens. Inspect the project design runtime through the existing design-runtime API or od CLI when component, binding, document or target details are needed. A successful process exit is a completion candidate: the host validates current source and semantic facts before accepting delivery.

All added or modified UI and CSS sources are inspected, including sources outside declared outputs. Output declarations are authoring mappings, never an exclusion list. Strict delivery requires complete semantic screen mappings, exact source/import/binding proof, matching effective props and ordered slots, and no unresolved coverage. Guided delivery must satisfy its configured error policies. Explore findings are advisory. Do not change saved mode, constraints, dependency or lock to evade this frozen policy; such a change conflicts with the in-flight task. Questions and planning without source or semantic edits do not certify a generated artifact.

${JSON.stringify(stable(facts), null, 2)}`;
}
