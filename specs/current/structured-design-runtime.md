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
| 4 | Project component definitions, override-only instances, deterministic reference graph | Button → ApplicationCard → two screens traversal; inheritance/reset, direct/transitive usage, cycles, dangling refs and safe delete/detach rules | Complete |
| 5 | Staged shared component revisions, usage/affected-screen impact, explicit publish and undo/history | A draft leaves live instances unchanged; publish changes all non-overridden instances; conflict/invalid-override tests and discoverable UI/CLI | Complete |
| 6 | Immutable design-system versions, project dependencies, exact lock and digest/source verification | Reopen resolves same content until explicit upgrade; tampering/missing locked version diagnosed | In progress |
| 7 | Semantic diff using stable component/token IDs | Added/removed/renamed/changed classification; removed variant/prop/token and incompatible slot are breaking | In progress |
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

Multi-component compilation, index/binding operations, project-local inheritance,
reference graphs and staged shared changes have accepted web/CLI/HTTP surfaces.
Current work adds immutable versions, semantic diff and the remaining compiler
formats on the same canonical identities. Internal foundation commits can land independently; their
corresponding phase remains incomplete until its listed product and validation
evidence exists.

The Phase 4 reference/resolution core and semantic tree editor are accepted, as is
the Phase 5 immutable draft, impact, publication and undo core (`3c68936db`).
The project structure UI and 14 additional HTTP/CLI operations are accepted with
48 focused contract cases, 29 state/core daemon cases, 39 dispatcher cases,
49 web cases and the existing 19 locale checks. The real browser workflow now
stages and publishes a shared Button default through the live UI, displays two
affected screens, verifies retained overrides, reopens persisted state, and stages
and publishes undo as revision 3. The shared tools-dev browser test passed in
12.8 seconds (45.5 seconds including harness startup/cleanup) using installed
Chrome; screenshots cover the workspace entry and staged impact panel.
Full `pnpm guard` and `pnpm typecheck` passed. Subsequent accepted foundations
are recorded below; their public workflows remain separately gated.

Phase 6's pure package/version/lock foundation is accepted in `07c57b9a0`.
Packages cover registry metadata, tokens, patterns, constraints, production package
compatibility and frozen source bytes. Exact resolution verifies source/package
digests and bound React source facts without latest fallback. Root acceptance ran
59 contract/mapping cases and 35 version/project-engine cases. Project-scoped
catalog persistence and exact dependency activation are accepted in `c3016293d`,
including seven matching CLI operations and the web provider boundary. Root ran
45 API contract cases, 48 daemon cases, 47 CLI dispatcher cases and 7 provider
cases; full `pnpm guard` and `pnpm typecheck` passed again. The discoverable versions
UI and real browser publication/pinning/reopen witness are in progress, so Phase 6
is not complete yet.

React slot proof and explicit Storybook CSF3 metadata are accepted in `db264c5b0`.
Code slot capability and semantic slot acceptance have separate provenance and an
explicit one-to-one binding. Frozen versions verify both prop and slot source
facts, while reindexing detects slot API drift. Story args remain example presets.
Root ran 152 related daemon cases, then 40 targeted cases after three additional
source/Storybook regressions (155 cases in the final combined set), plus 4 new
canonical contract cases. Vue extraction and public compiler selection wiring are
active follow-on work through the shared source compiler boundary.

Semantic diff is accepted internally in `69989178f`: stable-ID comparison,
complete before/after snapshots, breaking property/slot/token changes, and a
SemVer recommendation. Source provenance and Storybook examples remain distinct
from production compatibility. Root ran 6 contract and 20 daemon cases. Its public
review surface is part of the exact-version upgrade workflow being implemented
next; Phase 7 remains in progress until that surface is exercised.

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
