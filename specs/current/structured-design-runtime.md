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
| 6 | Immutable design-system versions, project dependencies, exact lock and digest/source verification | Reopen resolves same content until explicit upgrade; tampering/missing locked version diagnosed | Complete |
| 7 | Semantic diff using stable component/token IDs | Added/removed/renamed/changed classification; removed variant/prop/token and incompatible slot are breaking | Complete |
| 8 | Upgrade impact, deterministic migrations, review and explicit apply | Diff + graph + overrides identifies affected nodes/screens; migration validates before atomic lock/document update; failure/conflict leaves live state intact | Complete |
| 9 | Machine-readable handoff and persistent project-component code bindings | Manifest includes lock, target, IR, registry, bindings and change context; deterministic round-trip, package compatibility, UI/CLI export | In progress |
| 10 | Explore/Guided project modes and generation repair loop | Structured diagnostics after generation; bounded repair; normal Explore behavior preserved; equivalent generation paths validated | In progress |
| 11 | Pattern registry and design grammar | Pattern retrieval/configuration and slot composition validated deterministically; reusable resource-list fixture | In progress |
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
Immutable versions now have matching web/CLI/HTTP surfaces. Current work adds
reviewed upgrades, public compiler format selection and persistent handoff bindings
on the same canonical identities. Internal foundation commits can land independently; their
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
cases; full `pnpm guard` and `pnpm typecheck` passed again. The discoverable Versions
tab now publishes, imports, exports, pins, verifies and explicitly clears a lock,
including recovery when a locked package is unavailable. Root ran 29 focused web
cases plus 19 locale cases. The real browser workflow publishes 1.0.0, pins it,
changes production source, publishes 1.1.0, reopens the old exact lock and verifies
both frozen source snapshots. Direct version switching remains gated on reviewed
upgrades. The final browser run passed in 12.6 seconds (37.3 seconds with the shared
tools-dev harness); screenshot review and checkbox layout assertions passed.

React slot proof and explicit Storybook CSF3 metadata are accepted in `db264c5b0`.
Code slot capability and semantic slot acceptance have separate provenance and an
explicit one-to-one binding. Frozen versions verify both prop and slot source
facts, while reindexing detects slot API drift. Story args remain example presets.
Root ran 152 related daemon cases, then 40 targeted cases after three additional
source/Storybook regressions (155 cases in the final combined set), plus 4 new
canonical contract cases. Vue extraction is accepted in `58b44dd2e`, using the
pinned SFC parser without source execution or imported type reads. It covers local
scalar props, literal defaults, Boolean omission semantics, typed unscoped slots,
explicit semantic metadata and frozen-source verification. Root ran 195 combined
compiler cases, a frozen-lock install, full `pnpm guard` and full `pnpm typecheck`.
The public compiler now accepts explicit React/Vue selection, semantic slot exports
and grouped Storybook selections through the same UI/API/CLI contract. The daemon
reads each selected path once and refuses injected source text. Reopening preserves
original compiler provenance after manual binding changes. The real browser flow
compiled React and Vue examples together, retained production defaults, rebound
both slot conventions and reopened saved state; it passed in 19.3 seconds.
Root also ran a combined 161 daemon cases, 61 contract cases and 44 web/locale cases
covering compilation and the concurrent upgrade API integration.

Semantic diff is accepted internally in `69989178f`: stable-ID comparison,
complete before/after snapshots, breaking property/slot/token changes, and a
SemVer recommendation. Source provenance and Storybook examples remain distinct
from production compatibility. Root ran 6 contract and 20 daemon cases. The public
Versions review now displays named semantic changes and full before/after values,
including breaking variant changes, through the real browser workflow.

Phase 8's pure migration/review/apply core is accepted in `de70e1f57`. It preserves
authored identities and override-only instances, propagates finite value migrations
through local public mappings, records shared revisions and requires explicit
binding transitions. Exact package, plan and full project digests bind application
to the reviewed snapshot. Root ran 52 daemon migration/history/diff cases and 16
contract cases. Source/token coverage remains explicitly conservative; public
review/application now have canonical HTTP, CLI and web-provider operations.
Root's combined acceptance includes five real HTTP/SQLite cases exercising
read-only reviews, reopen/history, exact-source tampering, authority, invalid
application and CAS race preservation; five CLI cases, three provider cases and
three API schema cases also pass. Full `pnpm guard` and `pnpm typecheck` passed.
The Versions panel now exposes an exact-target migration editor, read-only review,
current/proposed diagnostics, named affected screens, binding/code impact and
explicit apply. Edits, catalog refreshes and authority changes invalidate review
proofs. Root ran 41 web/provider/locale cases and the full browser workflow, which
rejected an incomplete plan, reviewed a breaking variant migration, applied it,
preserved overrides and reopened the exact new lock. The browser case passed in
19.7 seconds, followed by full `pnpm guard` and `pnpm typecheck`.

The package-authored recipe core is accepted. Optional recipe metadata retains
legacy package bytes when absent, pins an exact source version/digest and obtains
its target from the containing immutable package. Instantiation produces an editable
ordinary migration plan; it does not apply the upgrade. Only unchanged published
bindings receive proposed recipe decisions, and manual overlays are skipped with
diagnostics. Recipe-only metadata changes do not invent affected screens, while
selected transforms contribute their actual references to impact analysis. Root
ran 64 daemon recipe/upgrade/diff/version cases and 15 contract cases. Public recipe
listing and instantiation now share canonical HTTP, CLI and web-provider operations.
The Versions editor loads matching recipes from the exact target package and fills
an editable plan without reviewing or applying it. Selection changes invalidate
existing review proof. Acceptance includes 56 CLI, 3 HTTP, 2 API contract and 34
web/provider/locale cases. Root's full browser workflow passed in 20 seconds,
including unchanged live state after choosing a recipe, explicit review/application,
preserved overrides and the exact lock after reload.

The prerequisite local-binding/value-transform foundation is accepted in
`a76e97412`. It verifies exact local revisions, preserves project code in an explicit
index composition, proves current registered source and applies typed scalar
transforms with design defaults. Existing binding identities cannot be taken over
by another component/framework relationship. Root ran 83 daemon binding/index/version
cases and 79 contract cases. Full `pnpm guard` and `pnpm typecheck` passed for both
foundations. Handoff emission and persistent public local bindings remain in progress.

The portable handoff builder and React/Vue emitter are accepted as the next pure
foundation. They verify exact package/source and current local-revision evidence,
distinguish installed observations from declared ranges, retain missing implementation
work, and reuse bound local components as production calls. One shared materializer
owns defaults, scalar transformations and ordered code slots. Emission reparses each
output and is atomic across all requested screens. Root ran 62 daemon cases and four
contract cases, then reran all 21 emitter cases after a Vue interpolation-brace
regression was fixed. Public persistence, export and generation integration remain
in progress.

Persistent local-code ownership and the handoff HTTP boundary are accepted.
Project implementations survive package publication, pinning, clearing and upgrades
in a separate index. Registration reads actual project files; refresh retains broken
selections and never silently promotes them to verified bindings. Exact local revision
and current source proof are checked again for resolution, upgrade and handoff.
The daemon observes installed package-root metadata without executing package code;
public callers select stored history instead of supplying evidence. Handoff and code
emission are read-only and reject revision races. Root ran 49 focused daemon cases,
then 13 final handoff/observer cases and 53 API contract cases. Contracts build and
daemon source/test typechecks passed. The CLI and workspace handoff panel remain
in progress.

The pre-generation validator and eight-case benchmark foundation are accepted.
The validator checks exact lock/source evidence, semantic resolution, production
imports, effective properties, ordered slots, local implementation conformance,
tokens and protected CSS values. Unhandled source syntax remains incomplete and
cannot certify Strict. Root ran 68 validator/benchmark/diff daemon cases, three
contract cases and full `pnpm guard`. The authored React/Vue cases cover all eight
required page categories; each records an invalid source, an evaluated repair and
a valid result across three file-order permutations. Reported variance describes
validator repeatability; model-generation variance remains unmeasured. Saved mode
settings, public artifact validation and generation completion/repair remain pending.

The exact-lock pattern runtime core is accepted. Search and retrieval verify the
immutable package; instantiation applies declared defaults, property mappings and
slot configuration, then validates the complete destination document. Supplied local
instances retain their sparse overrides. Deterministic node identities include the
project, pattern, instance and source location; collisions anywhere in the document
fail without silently renaming nodes. Public slot rules inspect resolved local roots,
and every returned node retains its source origin. The existing local engine shares
the extracted default/mapping materializer. Root ran 24 daemon cases and 56 contract
cases; package build and daemon source/test typechecks passed. Public pattern
retrieval and insertion into the screen editor remain in progress.

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

## Remaining integration seams

Handoff must preserve project-owned code alongside the immutable package index.
Package publication and activation must separate package-owned bindings from local
bindings as well as preserving that separation on reads. Local binding verification
records the exact shared definition revision; changing only its template still
requires code revalidation. Handoff checks current registered source evidence and
distinguishes an observed installed package version from a declared dependency
range. Missing implementations remain actionable manifest diagnostics, while code
emission requires complete bindings and produces no partial files.

Generation modes belong to saved project runtime state. Request bodies cannot
weaken the saved mode when detaching, clearing dependencies or validating output.
Explore keeps the existing normal generation path. Guided runs the structural
validator and a bounded repair loop; Strict additionally requires validated semantic
IR and validated production source before accepting the preview. Repair attempts
must preserve analytics lineage and use the existing physical-run creation service.

The generation host contract needs one canonical contracts implementation, consumed
by daemon legacy slim/classic, contracts API/BYOK and OD Next runtime context.
The existing OD Next deliverable check proves artifact presence rather than these
structural rules, so it cannot serve as the new validator or its repair gate.
Acceptance must exercise the actual completion path for each affected generation
mode, including exhaustion and cancellation, with deterministic agent fixtures.

Before Guided/Strict acceptance, the evaluation suite must contain resource list,
resource detail, settings, form, dialog, dashboard, empty and error states. Metrics
come from parsed source/IR and binding resolution: reuse, unknown components and
tokens, raw literals, duplicate controls, repair attempts and repeatability. Visual
impact compares graph-selected current/proposed screens through the locked
production runtime; symbolic boxes or only serialized IR do not satisfy Phase 13.
