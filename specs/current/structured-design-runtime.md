# Structured design runtime delivery plan

The active delivery scope is the complete structured design runtime roadmap.
The original first-change limit was satisfied by commits `4ed6bd08c`, `ca21aeb6f`,
and `8530200b5`. The user subsequently requested completion of all remaining work,
with delegated implementation, root coordination/acceptance, and a commit for
each accepted task. The scope below must not be reduced to whichever subset is
currently implemented.

The first implementation and its executable evidence are documented in
[`docs/structured-design-runtime.md`](../../docs/structured-design-runtime.md).
The original user brief is retained in
[`structured-design-runtime-brief.md`](structured-design-runtime-brief.md).
This plan governs the current delivery sequence; first-change restrictions in
the original brief describe the already completed first milestone.

## Completion rule

An internal algorithm is complete when its canonical contracts, deterministic
behavior, negative cases, and package checks pass. A user-facing capability is
complete only when the daemon service, shared HTTP contract, web UI, and `od`
CLI use the same authority and the real user flow has been exercised. An internal
module alone does not satisfy a product milestone below.

Each accepted task receives a scoped commit with no co-author metadata. The root
agent reviews dependencies and evidence before committing. Keep the goal active
until every required milestone and invariant has direct current-state evidence.

## Invariants

- The daemon owns identity, registries, dependency resolution, state, and legality.
  Shared schemas live in `packages/contracts`; web and CLI consume HTTP contracts.
- Daemon-owned persistence follows the root `AGENTS.md` **Daemon data directory
  contract**, using an explicitly supplied resolved root. No guessed data paths.
- Existing `components.manifest.json` remains the derived fixture inventory.
  Structured registry/state is additive; legacy projects remain Explore by default.
- Component, code, pattern, token, document, and instance IDs survive display-name
  changes. Component references contain no resolved design-system version.
- Instances persist overrides only. Reference traversal, legality, diffs, upgrade
  impact, migrations, and handoff binding resolution are deterministic.
- Published versions are immutable. Projects render against exact locked versions.
  Shared revisions and dependency upgrades require explicit publication/application.
- Unknown or unsupported input is diagnosed; it cannot silently certify an
  incomplete registry, valid binding, safe deletion, or strict handoff.
- Source code remains the production source of truth. No vector editor,
  multiplayer canvas, pixel round-trip synchronization, or custom layout engine.
- Prompt instructions may describe operations, but code enforces structural rules.
  Read `docs/prompt-composition.md` before any generation integration and reach all
  affected legacy/BYOK/OD Next paths through shared host contracts.

## Milestones and acceptance

| Phase | Required result | Acceptance evidence | State |
| --- | --- | --- | --- |
| 0 | Current discovery, project selection, prompt paths, API, CLI, schemas and baseline inspected | First implementation note and recorded baseline checks | Complete |
| 1 | Versioned component, binding, instance/override, semantic UI and diagnostic schemas | Canonical schema, JSON round-trip and rejection tests | Complete |
| 2 | Component registry compiler using deterministic React/TypeScript extraction; reusable multi-component source fixture | Multiple selected exports compile atomically; names, exports, paths, requiredness, enums, reliable defaults and provenance retained; no source execution | Complete |
| 3 | Code component index, search/inspect, explicit bind/unbind/resolve/validate, persisted binding state | Stable ID resolution; missing/changed source marks broken/stale on recompile; HTTP, UI, CLI and restart persistence tests | Complete |
| 4 | Project component definitions, override-only instances, deterministic reference graph | Button → ApplicationCard → two screens traversal; inheritance/reset, direct/transitive usage, cycles, dangling refs and safe delete/detach rules | In progress |
| 5 | Staged shared component revisions, usage/affected-screen impact, explicit publish and undo/history | A draft leaves live instances unchanged; publish changes all non-overridden instances; conflict/invalid-override tests and discoverable UI/CLI | Pending |
| 6 | Immutable design-system versions, project dependencies, exact lock and digest/source verification | Reopen resolves same content until explicit upgrade; tampering/missing locked version diagnosed | Pending |
| 7 | Semantic diff using stable component/token IDs | Added/removed/renamed/changed classification; removed variant/prop/token and incompatible slot are breaking | Pending |
| 8 | Upgrade impact, deterministic migrations, review and explicit apply | Diff + graph + overrides identifies affected nodes/screens; migration validates before atomic lock/document update; failure/conflict leaves live state intact | Pending |
| 9 | Machine-readable handoff and persistent project-component code bindings | Manifest includes lock, target, IR, registry, bindings and change context; deterministic round-trip, package compatibility, UI/CLI export | Pending |
| 10 | Explore/Guided project modes and generation repair loop | Structured diagnostics after generation; bounded repair; normal Explore behavior preserved; equivalent generation paths validated | Pending |
| 11 | Pattern registry and design grammar | Pattern retrieval/configuration and slot composition validated deterministically; reusable resource-list fixture | Pending |
| 12 | Strict mode semantic UI generation and source enforcement | Intent → retrieve → IR → validate → render/source → source validation → preview; unknown components/props/variants/slots/tokens/raw forbidden styles/reimplemented bound controls rejected | Pending |
| 13 | Visual impact preview of representative affected screens | Current/proposed side-by-side uses graph-selected screens and the locked production component runtime; UI exercised with screenshot evidence | Pending |

## Cross-milestone closure

The following are part of the final result, not optional placeholders:

- Design-system detail: components, patterns, bindings, versions, constraints and
  coverage/readiness derived from real metadata, with source/prop/slot/state detail.
- Project component detail: revision, code binding, usages and affected screens;
  shared edits clearly communicate global effects, and reset restores inheritance.
- Deletion with live references cannot silently break instances. Replacement and
  detach paths are explicit; Strict policy may forbid DS component detachment.
- Dependency upgrades show semantic changes, affected screens, migration plan and
  current/new preview before application. No automatic latest-version selection.
- Handoff reuses declared production imports and prop mappings; subsequent design
  runs see persisted code bindings. Code API drift and package mismatch are visible.
- Agent operations expose component/pattern/code retrieval, binding/usage/affected
  screen queries, document/artifact validation, version/diff and handoff through
  daemon + `od`. CLI supports `--json` and long prompts via `--prompt-file` where
  applicable. A custom MCP server is not necessary.
- Compiler expansion follows React/TypeScript, then deterministic Storybook
  metadata, then Vue/TypeScript. Unsupported features remain explicit diagnostics;
  provenance distinguishes extracted facts from any later inferred candidates.
- A deterministic evaluation fixture suite covers resource list/detail, settings,
  form, dialog, dashboard, empty and error states before Guided/Strict completion.
  Record component/binding reuse, unknown components/tokens, raw literals,
  duplicates, repair steps and repeatability; do not substitute visual appeal for
  structural validity.

## Current task boundary

Multi-component compilation, index/binding operations, and their persisted
web/CLI/HTTP feature are accepted. Current work adds project-local inheritance and
the reference graph, followed by staged shared changes and versioning on the same
canonical identities. Internal foundation commits can land independently; their
corresponding phase remains incomplete until its listed product and validation
evidence exists.

Phase 2/3 acceptance includes 88 focused contract tests, 147 daemon design-runtime
tests, the existing 16 project CLI tests, 30 web provider/panel/locale tests, and
one real browser workflow through the production project API. The browser witness
creates source files, compiles from the workspace entry, unbinds/rebinds, validates,
and reloads persisted state. It ran with the shared tools-dev harness and installed
Chrome through a local scratch configuration because the pinned Playwright browser
was unavailable. `pnpm install --frozen-lockfile`, `pnpm guard`, and full
`pnpm typecheck` passed. See `docs/structured-design-runtime.md` for the public
workflow and `e2e/ui/design-runtime.test.ts` for the browser witness.

The original brief's conceptual names describe responsibilities, not a demand to
create empty packages or placeholder files. Keep algorithms inside the daemon
until a real second consumer justifies an additive shared runtime package.
