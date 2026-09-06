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
| 9 | Machine-readable handoff and persistent project-component code bindings | Manifest includes lock, target, IR, registry, bindings and change context; deterministic round-trip, package compatibility, UI/CLI export | Complete |
| 10 | Explore/Guided project modes and generation repair loop | Structured diagnostics after generation; bounded repair; normal Explore behavior preserved; equivalent generation paths validated | Complete |
| 11 | Pattern registry and design grammar | Pattern retrieval/configuration and slot composition validated deterministically; reusable resource-list fixture | Complete |
| 12 | Strict mode semantic UI generation and source enforcement | Intent → retrieve → IR → validate → render/source → source validation → preview; unknown components/props/variants/slots/tokens/raw forbidden styles/reimplemented bound controls rejected | Complete |
| 13 | Visual impact preview of representative affected screens | Current/proposed side-by-side uses graph-selected screens and the locked production component runtime; UI exercised with screenshot evidence | Complete |

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

## Delivery status

Multi-component compilation, index/binding operations, project-local inheritance,
reference graphs and staged shared changes have accepted web/CLI/HTTP surfaces.
Immutable versions, reviewed upgrades, compiler format selection, persistent handoff
bindings and explicit artifact validation now have matching web/CLI/HTTP surfaces.
Locked pattern retrieval and screen composition are also accepted through all three
surfaces. Real component previews, generation completion enforcement, bounded repair
and logical-task reporting are accepted. All roadmap phases now have their required
contract, runtime, product-surface and validation evidence. The records below retain
the intermediate checkpoints and the final integration acceptance.

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
daemon source/test typechecks passed. The CLI and workspace Handoff tab now expose
registration, source refresh, readiness inspection and manifest/source export through
the same endpoints. Explicit property mappings preserve typed and legacy value
conversions. Acceptance includes 65 real CLI dispatcher cases, 22 focused web cases
and all 19 locale checks. Root's full browser workflow registered two actual local
implementations, reopened their separate code index, emitted two React screens with
production component calls, and verified that handoff/emission did not mutate state.
The browser passed in 26.7 seconds (1.3 minutes including the shared harness), and
the handoff screenshot was inspected. Full `pnpm guard` and `pnpm typecheck` passed.

The pre-generation validator and eight-case benchmark foundation are accepted.
The validator checks exact lock/source evidence, semantic resolution, production
imports, effective properties, ordered slots, local implementation conformance,
tokens and protected CSS values. Unhandled source syntax remains incomplete and
cannot certify Strict. Root ran 68 validator/benchmark/diff daemon cases, three
contract cases and full `pnpm guard`. The authored React/Vue cases cover all eight
required page categories; each records an invalid source, an evaluated repair and
a valid result across three file-order permutations. Reported variance describes
validator repeatability; model-generation variance remains unmeasured.

Saved Explore/Guided/Strict settings and explicit artifact validation are accepted
through HTTP, CLI and the Validation tab. The daemon reads actual source bytes and
installed package observations, uses the saved mode and verified locked constraints,
and rejects caller-injected evidence and revision races. Clearing a verified lock
preserves its constraints and mode; recovery from an unavailable Guided/Strict lock
requires an explicit change to Explore. UI conflict handling preserves local edits
while rebasing independently changed settings. Root ran five HTTP cases, nine focused
web cases and 48 contract cases; the agent's combined checks include 72 daemon and
51 contract cases. The full browser workflow saved Guided, reopened it, diagnosed
an actual forbidden color under locked policy, saved Strict and confirmed rejection,
then verified policy retention after clearing. Its 26.7-second case passed, the
validation screenshot was inspected, and full `pnpm guard` and `pnpm typecheck`
passed. At this checkpoint, automatic generation completion and bounded repair
still required integration; these explicit operations alone did not complete
Phase 10 or 12.

The saved-mode authority also covers instance detachment. A real route regression
first reproduced a saved Strict project accepting a caller's Explore override; the
service now uses the stored mode, and Structure displays that mode without an
override control. Root ran all six validation HTTP cases and four focused
detach/deletion web cases. The pure engine retains its explicit mode input for
internal callers; the legacy public field is accepted only for compatibility.

The exact-lock pattern runtime core is accepted. Search and retrieval verify the
immutable package; instantiation applies declared defaults, property mappings and
slot configuration, then validates the complete destination document. Supplied local
instances retain their sparse overrides. Deterministic node identities include the
project, pattern, instance and source location; collisions anywhere in the document
fail without silently renaming nodes. Public slot rules inspect resolved local roots,
and every returned node retains its source origin. The existing local engine shares
the extracted default/mapping materializer. Root ran 24 daemon cases and 56 contract
cases; package build and daemon source/test typechecks passed. Public pattern
retrieval and configuration now use matching HTTP/CLI operations and the Structure
screen editor. Preview validates the whole authored draft against daemon-owned
package and local-definition facts; Add edits only the draft, and Save is explicit.
Root ran 13 daemon HTTP/core cases, 5 contract cases, 23 pattern/semantic editor
cases and 2 provider cases; the agent's combined regression includes 69 CLI and
64 web/locale cases. The full browser workflow published and locked a ResourceList
pattern, configured a title and two slot items, checked that Preview and Add left
persisted state unchanged, saved the result and reopened identical node identities.
It passed in 31.2 seconds (1.1 minutes with the shared harness), and the screenshot
was inspected. The first attempt correctly rejected a test publication that omitted
required constraints; the fixture was corrected without changing product behavior.
Full `pnpm guard` and `pnpm typecheck` passed.

Generation target authoring is accepted through Validation, the raw settings API
and two matching CLI commands. Its independent canonical schema permits future
paths/screens without certifying them; aggregate revision checks protect writes,
and missing-only legacy backfill does not rewrite stored bytes. Root ran 48 contract
cases, 10 HTTP/store cases and 11 UI/provider cases. Agent acceptance additionally
covered real CLI dispatch, all locales and source/test typechecks. The existing
browser workflow saved two future TSX outputs against Applications and Dashboard,
reopened them and verified the same daemon declarations. It passed in 33.8 seconds
(1.3 minutes with the shared harness); the entry and saved targets screenshot was
inspected. This checkpoint covered target authoring; generation execution and
repair have their own acceptance records below.
Repository guard and workspace/root-script typechecks passed at this checkpoint.

Generation completion enforcement is accepted as the first integration slice.
The host freezes saved policy and exact dependency facts before the initial OD Next
bundle, then captures one bounded source baseline after host resource staging and
before child execution. Changed files and unselected JSX participate in source
auditing independently of output declarations. Current IR and target declarations
may be authored during the run; changes during final validation invalidate its proof.
Explore remains advisory, including concurrent independent conversations with
incomplete attribution. Guided/Strict block invalid or incomplete deliveries.
Question-only runs remain non-applicable, while actual Full Plan planning edits and
production share one durable policy and baseline. All legacy/BYOK/OD Next prompt
paths consume one host directive, documented in `docs/prompt-composition.md`.

Critique validates its exact external artifact bytes before publication and reproves
authority, source, state and installed packages after asynchronous persistence.
Missing candidates, unsupported MIME, write failures, cancellation and timeout
cannot announce a validated delivery. Root ran 131 daemon cases across generation,
source validation and Critique, plus 3 canonical contract cases. Two actual Full Plan
and serialization-continuation witnesses also passed. Read-only audit regressions
close Vue export/null-text mismatches and protected CSS property omissions. Full
repository guard and workspace/root-script typechecks passed. The
bounded automatic repair coordinator and final UI/CLI logical-task reporting were
still required at that checkpoint; the first slice alone did not complete Phase 10
or 12.

The final generation integration, accepted in `99a047559`, completes Phase 10 and
12. A host-only atomic
claim permits one repair using the same policy, original baseline, exact prompt,
model/provider configuration, native session and locked strategy plan. Normal Full
Plan stages retain attempt zero; only the repair advances to one. Failed transport,
exhaustion and cancellation cannot replenish that budget. UI and CLI follow current
authenticated task projections, recover the same report after reload, and preserve
physical attempt identity. Clarification uses `awaiting_input` and ends the current
stream without claiming delivery or allocating another Run.

| Final generation witness | Verified behavior |
| --- | --- |
| `apps/daemon/tests/services/design-runtime/generation-repair.test.ts` | Real database and message/Run claims roll back together on stale authority, cancellation or rejected strategy proof |
| `apps/daemon/tests/runtimes/design-generation-server.test.ts` | Real source writes, successful/exhausted repair, cancellation through the parent, transport failure, configuration drift and unchanged questions |
| `apps/daemon/tests/runtimes/design-generation-byok-repair.test.ts` | Actual local provider requests preserve model, authentication and endpoint; durable repair text reaches stdin and provider unchanged |
| `apps/daemon/tests/runtimes/design-generation-critique-repair.test.ts` | Stdin-consuming generator, withheld invalid publication, corrected public artifact bytes and exhausted repair with no published artifact |
| `apps/daemon/tests/od-next-automatic-simple-server.test.ts` | Simple/complex Full Plan and Direct Edit preserve stage, baseline and exact text; complex repair proves fresh native child packages; questions with/without planning edits wait for input |
| `apps/daemon/tests/runtimes/design-generation-projection.test.ts` | Status/SSE/message/restart/result/cancel scope and physical/logical identity agree; client-supplied claims are rejected |
| `e2e/ui/real-daemon-run.test.ts` | One user request drives Guided repair success or exhaustion and restores the report after reload; Strict retrieves, authors IR, validates source and renders the verified production component |

Final contract checks passed 8/8; core/prompt/lifecycle checks passed 78/78, and the
projection/runtime regression passed 144 cases. Web acceptance passed 100 cases and
CLI acceptance passed 40 subprocess cases. Root independently repeated the atomic,
source inventory, ordinary/BYOK/Critique and five actual OD Next witnesses. The two
Guided browser cases passed in 10.0 and 7.8 seconds (38.7 seconds with the harness).
The final Strict browser case passed in 7.7 seconds (36.7 seconds with the harness).
All three screenshots were inspected. Full `pnpm guard` and `pnpm typecheck` passed.

These witnesses also exposed and closed integration defects in analytics header
preservation, host HTML history inventory, Critique stdin/publication paths,
BYOK model normalization, Direct Edit route adoption and clarification recovery.
Unsupported source remains explicit incomplete evidence; a claimed native repair
whose launch evidence is lost on restart fails closed. These limits preserve the
single-attempt and Strict proof contracts.

The Phase 13 preview core was accepted before its public surface.
Canonical results preserve the full graph/review impact roster alongside selected
screen samples, current/proposed locks, exact source evidence and explicitly named
tool runtimes. Semantic previews expand shared definitions through frozen DS source;
production handoff previews require current implementation and installed-package
proof. The shared emitter supplies actual React/Vue calls to a bounded browser bundle
without executing component code in the daemon. Source and authority drift abort the
response. Root ran 61 preview/emitter/upgrade daemon cases and 3 contract cases;
the agent also ran the broader handoff/validator regression set and a frozen install.
Guard and workspace typechecks passed.

The public Preview tab, shared-impact entry and reviewed-upgrade entry now use one
read-only API and matching CLI command. Frames run actual React/Vue bundles with
visible runtime/error status in opaque-origin sandboxes. Root ran 80 HTTP/CLI cases
and 6 focused web/provider cases; agent regression covered 60 web/provider/UI cases,
all 19 locales and source/test typechecks. The complete browser workflow passed in
40.3 seconds (60 seconds with the shared tools-dev harness). It verified both exact
upgrade versions before Apply, one shared template change across two screens without
publishing, explicit stale implementation diagnostics, and an actual Vue SFC title
and slot. All three screenshots were inspected. Installed Chromium 149 was used
because local Chrome 152 lost nested-frame tracking with this Playwright client;
DOM assertions were retained, and capture waits for renderer paint after scrolling.
Full repository guard and workspace/root-script typechecks passed at acceptance.

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

## Integration acceptance boundaries

Handoff preserves project-owned code alongside the immutable package index.
Package publication and activation separate package-owned bindings from local
bindings, and reads preserve that separation. Local binding verification
records the exact shared definition revision; changing only its template still
requires code revalidation. Handoff checks current registered source evidence and
distinguishes an observed installed package version from a declared dependency
range. Missing implementations remain actionable manifest diagnostics, while code
emission requires complete bindings and produces no partial files.

Generation modes belong to saved project runtime state. Request bodies cannot
weaken the saved mode when detaching, clearing dependencies or validating output.
Explore keeps the existing normal generation path. Guided runs the structural
validator and a bounded repair loop; Strict additionally requires validated semantic
IR and validated production source before accepting delivery. Repair attempts
preserve analytics lineage and use the existing physical-run creation service.

The generation host contract has one canonical contracts implementation, consumed
by daemon legacy slim/classic, contracts API/BYOK and OD Next runtime context.
The generation gate enforces structural rules alongside the existing OD Next
deliverable-presence check. Acceptance exercises the actual completion path for
each affected generation
mode, including exhaustion and cancellation, with deterministic agent fixtures.

The evaluation suite contains resource list,
resource detail, settings, form, dialog, dashboard, empty and error states. Metrics
come from parsed source/IR and binding resolution: reuse, unknown components and
tokens, raw literals, duplicate controls, repair attempts and repeatability. Visual
impact renders graph-selected current/proposed screens through the locked
React/Vue production runtime.

## Legacy design-system migration

Implemented and accepted on 2026-09-06. Existing catalog and brand workspaces expose
their files through the project API and `FileWorkspace`. Legacy packages commonly
contain `DESIGN.md`, `tokens.css`, HTML fixtures and derived selector inventories;
brand workspaces may instead use `system/variables.css`. Their selector inventories
are reference evidence, not typed component definitions. Imported source snippets
may also lack the original dependency graph.

The migration extends the existing project runtime with a read-only review and an
explicit apply operation. Canonical contracts belong in `packages/contracts`, CSS
extraction and orchestration in the daemon's existing design-runtime service, and
the entry point in the Design runtime panel with matching `od design-runtime`
commands. No new package or prompt implementation is required.

Review freezes the selected source bytes, converts supported root CSS token values
with provenance, and compiles explicitly selected React/Vue components through the
existing compiler. Unsupported values and theme overrides remain visible in the
report and preserved sources. Existing HTML fixtures remain reference material.
The review contains an immutable package candidate. Applying it installs an exact
lock and the explicitly selected Explore or Guided mode; migration itself supplies
no Strict certification.

Apply rechecks the reviewed project revision, plan and selected source bytes before
atomically saving the package and runtime state. It leaves the original project
files and catalog selection unchanged. Existing structured registries or locks
must use the normal upgrade workflow. Documentation-only inputs without convertible
tokens or components receive actionable diagnostics instead of an empty migration.

Acceptance completed:

- Contracts and daemon tests cover token conversion and unsupported values,
  binary assets, BOM/CRLF preservation, source/revision drift, review tampering,
  project authority and atomic writes. The route regression revokes write authority
  during the last source read and proves that application returns 403 without
  publishing a version or changing state.
- Web/provider/locale tests cover 54 cases; CLI suites cover 82 cases. Full
  repository type checking and `pnpm guard` pass. Independent review found no
  outstanding correctness, permission or data-integrity blocker.
- The running Electron app was operated from **Your systems → Edit with agent →
  Design runtime → Migration** using the existing Stripe package. Review converted
  45 base tokens, reported 11 unresolved declarations, and preserved all nine
  selected source/asset files. Apply created and activated `migrated-stripe@1.0.0`.
  The exact lock survived reload and the original HTML preview remained usable.
  All nine original and frozen-file SHA-256 hashes matched their pre-migration
  values, including the binary image; the catalog selection was unchanged.
- Real CLI review/apply migrated a React component plus brand `system/variables.css`.
  A changed source rejected the old review with zero publication; a fresh review
  installed three base tokens, one bound component and the exact version. A dark
  override remained unresolved. BOM, CRLF and binary bytes survived unchanged.
  Both the CLI and the native UI accepted `tone: primary` and rejected the
  undeclared `tone: filled` with `ODDS1003`.
- Native visual inspection caught the global input-width rule stretching migration
  checkboxes. A scoped CSS reset corrected the file list; the running app was
  visually rechecked after the fix.

## Standalone JSX and TSX props preview

Implemented and accepted on 2026-09-06. File Preview now discovers component exports and infers
preview controls from local TypeScript declarations, parameter/default props and
recognizable JSX usage. Missing values receive deterministic mocks; source defaults
are preserved. This preview analyzer is separate from the verified registry compiler
and does not create registry entries, locks or project-runtime revisions.

The shared read-only component-preview endpoint bundles real local source, styles
and supported assets with the existing bounded project reader and bundled React.
Authority and source evidence are rechecked before returning the bundle. Source
analysis does not execute project code. Rendering and declarative callback mocks
run inside the isolated preview sandbox. Unsupported dependencies, context providers
and ambiguous types remain diagnostics or require user-provided mock data.

The UI offers scalar/enum controls, JSON editing, export selection, individual/all
prop resets and retry. Valid edits update the sandbox without rebuilding source.
Invalid JSON preserves the last valid values; correcting a runtime error resets the
render boundary. The matching `od design-runtime preview-component` command supports
JSON output and file/stdin input through the same endpoint.

Acceptance includes contract, analyzer, actual bundled rendering, route authority,
UI/provider/frame and CLI regression tests. The CLI suite contains 82 cases,
including a real-process 541 KB response that reproduced stdout truncation before
the output-drain fix. Repository guard and full type checking pass.

Native Electron operation verified a TSX component with required nested objects,
arrays and a callback, plus local module, CSS and binary-image imports. Editing
text, object, array, enum, number and boolean controls changed the rendered output;
clicking the mocked callback updated component state. Invalid JSON retained the
last valid render, an intentionally invalid array item produced a contained error,
and resetting the prop recovered the component. Retry and Reset props also worked.
Untyped JSX preserved defaults, provided a callable mock and switched between two
named component exports while excluding metadata. CLI requests verified the same
exports and explicit props; all five fixture source/asset hashes stayed unchanged.
Native acceptance also corrected JSX classification under Scripts and removed the
Required badge from props that have source defaults. Both fixes were rechecked in
the restarted application, including the normal and expanded preview layouts.
