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

Strict only: use the following IR-first operational sequence. Explore keeps ordinary generation with advisory findings. Guided keeps ordinary source generation followed by its configured validation and bounded repair; it does not require creating IR.
1. Resolve the user's intent into screens and behaviors. Retrieve the effective component registry and available patterns first (od design-runtime components/project-components/patterns, or GET /api/projects/:id/design-runtime/components, /project-components and /patterns). Inspect exact props, slots, bindings and token names; do not invent a component API.
2. Author semantic UI IR with stable screen/node identities and override-only local instances. Reuse a suitable pattern through instantiate-pattern when available, then explicitly adopt its returned subtree. Validate the document with validate-document (POST /document/validate), correct diagnostics, and persist it with save-document (PUT /document using the current expectedRevision). Do not save unpublished component references.
3. Save generation-targets mappings from each intended output file/export to its semantic screen using save-generation-targets (PUT /generation/targets). New paths may be declared before writing them. Cover every generated screen and delivered output; these mappings never exempt other changed sources from inspection.
4. Generate React/Vue code using verified production imports, effective bound props, declared tokens and ordered slot children that match the saved IR. A ready handoff plus emit-handoff can materialize these production calls. Keep frozen library source bytes intact; custom local implementation still needs proof.
5. Run validate-artifacts (POST /validation/artifacts with expectedRevision, selected source paths and output mappings). The daemon reads source, package and lock facts. Correct errors and incomplete coverage, then rerun; a report about an unrelated file does not validate delivery.
6. Request preview (POST /previews, kind production-handoff, framework and semantic screenIds) and inspect the actual runtime rendering. A semantic-design preview is useful while authoring but does not establish a production binding. Report unavailable preview or source proof explicitly; do not claim it passed.

All listed CLI commands take the projectId; payload commands accept --prompt-file <path|-> and --json. Read od design-runtime --help for the canonical payload shape. API suffixes above share /api/projects/:id/design-runtime and the current workspace authority. Preserve CAS conflicts: refresh and reconcile explicit drafts instead of overwriting concurrent work. The host independently repeats completion validation and permits at most one host-authored design repair.

${JSON.stringify(stable(facts), null, 2)}`;
}
