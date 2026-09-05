# Structured design runtime

Projects can compile selected React/TypeScript exports and Vue SFCs into a structured component
registry, inspect their properties, manage explicit code bindings, and validate
property values. They can also compose semantic screens and reusable project
components, inspect affected screens, and explicitly publish shared revisions.
Open **Design runtime** from the project file workspace's tab
bar, select source files and their framework/exports, then choose **Compile registry**.
The same operations are available through `od design-runtime` and the project HTTP
API. Existing design-system discovery, generation, and rendering retain their
current behavior.

The [active delivery plan](../specs/current/structured-design-runtime.md) tracks
acceptance and the remaining upgrade, handoff, compiler, and generation work.

## Existing extension points

- `packages/contracts/src/design-systems/components-manifest.ts` owns the
  fixture-derived HTML/CSS inventory. It is a cache of selectors and token usage,
  not a component definition registry.
- `design-systems/_schema/manifest.schema.ts` describes existing design-system
  package discovery. `packages/contracts/src/design-systems/token-schema.ts`
  owns the shared token slots.
- `apps/daemon/src/design-systems/index.ts` discovers systems and resolves their
  prose, tokens, usage guides, and fixture inventory. Daemon routes and project
  selection consume this service.
- `apps/daemon/src/design-systems/server-services.ts` owns scoped catalog reads
  and project eligibility; `packages/contracts/src/api/projects.ts` carries the
  current `designSystemId`. `apps/daemon/src/routes/project/index.ts` validates
  selection, and `apps/daemon/src/runtimes/chat-prompt-inputs.ts` resolves it for
  generation. That selection is not a version lock.
- `apps/daemon/src/routes/static-resource.ts` and `routes/design-systems.ts`
  expose catalog/detail operations; `routes/design-system-tool.ts` exposes
  scoped agent file reads. `apps/daemon/src/cli.ts` registers `design-systems`,
  and `apps/web/src/providers/registry.ts` consumes the daemon HTTP boundary.
- `apps/daemon/src/prompts/` and `packages/contracts/src/prompts/` compose legacy
  and API/BYOK prompts; OD Next takes an independent path documented in
  `docs/prompt-composition.md`. This milestone changes none of those paths.
- Contracts already depend on Zod. The daemon already depends on
  `@babel/parser`, including TypeScript/JSX parsing support.

## Placement and scope

- `packages/contracts/src/design-runtime/`: canonical Zod schemas and inferred
  types for component definitions/registries, code components, explicit bindings,
  instances/overrides, semantic UI documents/nodes, and validation diagnostics.
- `apps/daemon/src/services/design-runtime/`: deterministic compilation,
  component/binding validation, index operations, and project orchestration.
  `routes/design-runtime.ts` authorizes requests and exposes these services;
  `storage/design-runtime-store.ts` persists aggregate snapshots in the daemon
  database. Keep contracts free of I/O and compiler dependencies.
- Contract tests live under `packages/contracts/tests/design-runtime/`; daemon
  tests and the source fixture live under
  `apps/daemon/tests/services/design-runtime/`. The fixture proves the Button
  registry, explicit binding, and `ODDS1003` rejection.

No new workspace package is needed. A later milestone can extract pure runtime
algorithms once actual shared consumers justify that boundary. Prompt integration,
migrations, production rendering, and handoff remain tracked separately in the
active plan. Immutable versions and exact resolution live in the same daemon
service boundary.

## Project workflow and persistence

Compilation replaces the project's registry using the complete selection list.
Each selection contains a project-relative source path, export name, and stable
component/code IDs. React is the default framework; Vue selects the SFC default
export. An optional named metadata export supplies semantic slots. Expand
**Storybook examples** to select CSF3 source files and named stories; each story
keeps an independent stable ID. The daemon reads each component and story file once and compiles every
export before atomically saving the new registry, code index, and bindings. A
failed source read, unsupported type, or invalid selection leaves the prior
snapshot intact. Source text is not copied into registry storage.
Recompilation also validates the existing project definitions and document against
the proposed registry before committing it.

The UI assigns identities once per selection and preserves them when source paths
or exports are edited. Existing manual bindings and explicit unbound states survive
recompilation. Removed targets become broken; changed public APIs become stale.
Reopening the compiler restores original source provenance even when a manual
binding points to a different production component. The binding editor exposes
explicit design-slot to code-slot targets for both frameworks.
Recompilation does not automatically revalidate stale, broken, or candidate
bindings. **Bind** and **Revalidate** check the current registry and code index;
**Unbind** retains the binding's design identity while removing its code target.
Drift is assessed when the index is recompiled, not by a background file watcher.

Every write carries `expectedRevision`. A concurrent change returns HTTP 409 with
the expected and current revisions; callers must review the refreshed state before
trying again. Registry identity changes require the future explicit upgrade flow.
Read-only project members can browse metadata and validate values. Mutations use
the existing project write authority. Persistence uses the daemon database and
follows the root [daemon data directory contract](../AGENTS.md#daemon-data-directory-contract).

All paths below are relative to `/api/projects/:id/design-runtime`:

| Operation | HTTP | CLI |
| --- | --- | --- |
| Read persisted snapshot | `GET /` | `get <projectId>` |
| Compile project sources | `POST /compile` | `compile <projectId> --prompt-file <path\|->` |
| Search design/code components | `GET /components`, `GET /code-components` | `components`, `code-components` with `<projectId> --query <text>` |
| Bind or unbind | `PUT`, `DELETE /bindings/:bindingId` | `bind <projectId> --prompt-file <path\|->`, `unbind <projectId> <bindingId>` |
| Revalidate or resolve | `POST /bindings/:bindingId/revalidate`, `GET /bindings/:bindingId/resolve` | `revalidate`, `resolve` with `<projectId> <bindingId>` |
| Validate property usage | `POST /validate` | `validate <projectId> --prompt-file <path\|->` |
| Save or validate a semantic document | `PUT /document`, `POST /document/validate` | `save-document`, `validate-document` with `<projectId> --prompt-file <path\|->` |
| Resolve the saved document | `GET /document/resolve` | `resolve-document <projectId>` |
| Search project definitions | `GET /project-components` | `project-components <projectId> --query <text>` |
| Inspect references and affected screens | `GET /references?componentRef=...` | `references <projectId> <componentRef>` |
| Review deletion or published history | `GET /project-components/:componentId/deletion`, `GET /project-components/:componentId/history` | `deletion`, `history` with `<projectId> <componentId>` |
| Stage a shared definition | `POST /component-changes` | `stage <projectId> --prompt-file <path\|->` |
| Inspect or discard a staged definition | `GET`, `DELETE /component-changes/:draftId` | `inspect`, `discard` with `<projectId> <draftId>` |
| Publish a reviewed definition | `POST /component-changes/:draftId/publish` | `publish <projectId> <draftId> --prompt-file <path\|->` |
| Stage an earlier revision as new content | `POST /project-components/:componentId/undo` | `undo <projectId> <componentId> --prompt-file <path\|->` |
| Delete, replace, detach or remove referencing instances | `DELETE /project-components/:componentId` | `delete <projectId> <componentId> --prompt-file <path\|->` |
| Derive a detached subtree for review | `POST /instances/detach` | `detach <projectId> --prompt-file <path\|->` |
| List published versions | `GET /versions` | `versions <projectId>` |
| Export an exact version | `GET /versions/:designSystemId/:version` | `version <projectId> <designSystemId> <exactVersion> --json` |
| Import a complete immutable package | `POST /versions` | `import-version <projectId> --prompt-file <path\|->` |
| Publish the current metadata and selected sources | `POST /versions/publish-current` | `publish-version <projectId> --prompt-file <path\|->` |
| Activate an exact version and declared range | `POST /dependency` | `activate-dependency <projectId> --prompt-file <path\|->` |
| Resolve the exact lock | `GET /dependency/resolve` | `resolve-dependency <projectId>` |
| Clear the active dependency explicitly | `DELETE /dependency` | `clear-dependency <projectId>` |
| Review an exact-version migration | `POST /upgrades/review` | `review-upgrade <projectId> --prompt-file <path\|->` |
| Apply the reviewed migration | `POST /upgrades/apply` | `apply-upgrade <projectId> --prompt-file <path\|->` |

CLI commands begin with `od design-runtime` and support `--json`, `--daemon-url`,
`--workspace`, and `--workspace-member`. Commands with request bodies read JSON from a
file or stdin. A write can provide `expectedRevision` in its input or
`--expected-revision`; if both are omitted, the CLI reads the current revision once
and sends it without retrying conflicts. Invalid usage diagnostics and unresolved
bindings exit 1; malformed CLI input exits 2. Staging can return exit 1 for blocking
impact diagnostics while retaining the draft for repair. Definition revisions are
explicit in stage, publish and undo inputs. Run `od design-runtime help` for
complete input examples. Canonical request/response schemas live in
`packages/contracts/src/api/design-runtime.ts`; errors use `error.details`.

For example, after compiling the matching stable identities, this validates a
usage through the same endpoint as the UI:

```bash
od design-runtime validate <projectId> --json --prompt-file - <<'JSON'
{"component":"ds:acme/button","props":{"variant":"primary"}}
JSON
```

## Screens and shared revisions

Open the **Project structure** tab to add screens, text, design-system components
and local component instances. The editor keeps edits in a local document draft;
**Validate document** checks it, and **Save document** persists it. A reset removes
an instance's explicit override, restoring the currently published inherited value.

Project definitions have a single semantic template and an explicit public property
schema. Map each public property to a template property or text node; mapped values
are supplied by the public default or instance override. A mapped template target
cannot also carry a competing static value. Local definitions can reference other
local definitions through instances. The daemon rejects cycles, dangling references,
invalid mappings and incompatible slot composition.

Select a shared component, edit its template or public defaults, and choose
**Stage change**. The published definition and live instances remain unchanged.
The impact panel lists direct usages, dependency chains, affected screens and
proposed validation errors. **Publish change** requires the current reviewed
snapshot and a valid whole project. It advances the definition revision, records
immutable history and preserves all source instance overrides. **Stage undo**
copies an earlier revision into a new draft; publishing it advances the revision
again instead of rewriting history.

**Extract shared component** copies the selected subtree into a component draft.
Stage and publish it, then explicitly adopt the published component in the screen
draft and save the document. Adoption checks that the selected source is unchanged.
Detachment follows the same review/adopt/save flow. Referenced definitions cannot
be silently deleted: choose replacement, detachment or instance removal explicitly.
Rewrites of surviving shared definitions advance their revisions and history in the
same transaction. Pending drafts on removed or rewritten definitions block deletion.

Refresh and conflict handling preserve edited drafts. The user explicitly rebases
or discards conflicting content before saving again. The aggregate includes the
local registry, source document, pending changes and history. Older snapshots gain
the new empty fields on read without changing their revision; the next successful
write persists the complete shape.

## Published versions and exact locks

Open **Design runtime → Versions** to publish selected source files, inspect exact
published versions and pin one to the project. The panel shows the active version,
declared range and verified metadata/source digests. Publishing newer content
leaves the active lock unchanged. **Package import and export** accepts
a complete package JSON file for preview and explicit import, or downloads the
selected immutable package. Version details include components, properties, slots,
states, bindings, source provenance, tokens, patterns and constraint policies.

The project catalog stores immutable packages containing registry metadata, code
bindings, tokens, patterns, constraints, production package compatibility and
frozen source bytes. A package digest covers all metadata and source; a separate
source digest covers exact path/byte pairs. Publication and the project revision
advance together in one transaction. Republishing an exact version with different
content fails and leaves both records intact. Catalogs are scoped to the project.

`publish-version` reads only explicitly selected project source paths. Those files
must be valid UTF-8; the daemon preserves the BOM and line endings. Supply explicit
constraints for the initial publication. Subsequent publication from a locked
version preserves its tokens, patterns, constraints and compatibility declarations
unless the request provides typed replacements. `import-version` accepts a full
package and supports base64 entries for binary assets. The list and project
snapshot omit frozen source bytes; exact version export includes the full package.

Publishing a version does not activate it. Activation selects an exact version
and a declared range such as `^1.0.0`, then validates the current project against
that snapshot. This project runtime supports one active design system. The generic
lock contracts support multiple entries for other consumers. Initial activation
requires an empty registry or the same working component, code and binding
snapshot. Directly switching an existing lock is blocked until the reviewed
upgrade flow is applied.

Every ordinary document, reference, shared-change and binding operation verifies
the active package and source digests and uses the frozen registry/code index.
Publishing a newer version, editing project source or reopening the project cannot
change its lock. Compilation is disabled while a dependency is active. Project
binding overrides remain editable without changing the published package.

A missing or tampered locked version returns structured diagnostics. The dependency
resolution endpoint remains readable and returns the current revision for recovery.
Explicitly clearing the dependency retains the stored working registry and document;
it does not claim the unavailable package was verified. There is no latest-version
fallback or automatic upgrade.

`diffDesignSystemVersions` compares verified packages by stable entity identity.
Names can change without replacing an entity. Removed props/variants/tokens and
narrower slot contracts are breaking; new compatible members are additive.
The result retains full before/after values and recommends a SemVer bump.
Storybook presets and source provenance remain visible without being treated as
production API breakage.

`review-upgrade` accepts an exact source/target migration plan and a project
revision. It returns semantic differences, current/proposed document diagnostics,
affected usages/screens, binding transitions and code impact without writing state.
A well-formed plan that cannot be applied still returns its review; the CLI exits 1.
`apply-upgrade` requires the unchanged plan plus `reviewId`, `baseDigest` and
`planDigest` from that review. The daemon verifies both immutable packages again,
recomputes the review, and commits the lock, document, local definitions, bindings
and shared revision history in one revision. Conflicts and invalid proposals leave
live state intact. The web provider uses these same endpoints; the discoverable
upgrade interface and reusable package recipes remain in the active delivery plan.

## Compatibility and identity

The new schema is additive and independent of `components.manifest.json` and the
existing package manifest. Existing design-system packages need no migration.
Persisted roots and independently persisted entities carry `schemaVersion: 1`.
Names are display metadata; callers supply stable IDs. Design references use
`ds:<system-id>/<component-id>` or `local:<component-id>` with no resolved version.
For the acceptance fixture, `Button` is an explicitly assigned stable ID, not an
ID regenerated from the display name. Production import identity reconciliation
remains future work.

The compiler is deterministic and syntax-only. It accepts explicitly selected
exports and identities, does not execute source, and does not infer bindings from
appearance. Unsupported source types must be reported rather than represented as
a complete, permissive component contract. The semantic IR describes hierarchy,
props, slots, and override-only instances; it is not a pixel or round-trip model.

## Implemented API and limits

The schemas are exported from `@open-design/contracts`. Call `.parse(unknown)` or
`.safeParse(unknown)` on the appropriate schema at a wire boundary; their inferred
types are the canonical types for consumers. Parsing checks shape, JSON safety,
versions, unique component/node identities, enum defaults, and binding lifecycle
consistency. It does not resolve references or enforce design legality. A
well-formed reference to an unknown component can be parsed and then diagnosed.

`compileReactComponent` in the internal daemon service accepts source text, a
repository-relative POSIX source path, the selected export, and explicit
design-system/component/code identities. It returns a registry, code component,
and verified explicit binding. Verification here means the selected source
declaration was extracted; it is not a repository-wide typecheck, dependency
resolution, or proof that the component renders correctly. The compiler does
not read files or execute source.

Supported extraction is deliberately small:

- Direct named exported functions and `const` arrows, with no props or one typed
  identifier/object-pattern props parameter.
- Local interfaces, type literals, and aliases; required/optional properties;
  string, boolean, finite number, and scalar literal unions.
- Scalar literal defaults in parameter destructuring, including renamed props.
- Source path, export name, line, and deterministic provenance.
- Source-proven `ReactNode` imports, local aliases and namespace references as code
  slot capabilities. Semantic accepted child references come from an explicitly
  selected static metadata export and bind to code slots one-to-one.

Unsupported syntax throws `CompilerError` with source context. This includes
imported prop types other than the supported React slot types, inheritance,
generics, intersections, callbacks/object/array props, wrappers, overloads,
TypeScript receiver (`this`) parameters, export specifiers, default React exports,
computed defaults, selected-export writes and namespace augmentation. Project scanning, identity reconciliation, and inference
remain outside this deterministic subset.

The shared internal `extractSourceCodeComponent` boundary proves code props and
slots without inventing a semantic binding. `compileSourceComponent` additionally
requires valid semantic slot mappings. `compileStorybookMetadata` reads explicitly
selected CSF3 story exports, literal args/argTypes and tags from a directly imported
component. It keeps stable story IDs and provenance; presets never replace source
prop defaults. Dynamic spreads, callbacks, selected render/decorator metadata and
mutable metadata aliases are rejected. React stories use a direct named relative
component import; Vue stories use a direct default relative SFC import. The same
selection contract drives the compiler UI, project API and CLI JSON input. Source
bytes are always read by the daemon; requests cannot inject component or story text.

The Vue path parses literal `<script setup lang="ts">` SFCs with the pinned Vue
compiler. It selects the default export explicitly and accepts local scalar props,
literal `withDefaults` or destructured defaults, and typed unscoped slots. Optional
Boolean props retain Vue's implicit `false` default. Semantic slot metadata must be
explicitly selected from a normal TypeScript script block and identify
`component: 'default'`. Imported/generic prop types, scoped or dynamic slots,
competing normal-script component options, model/emits macros, external templates
and preprocessed templates are rejected. Frozen-source proof uses this same parser;
neither application source nor imported modules execute during extraction.

`validateComponentUsage(registry, { component, props, nodeId? })` checks exact
design-system references, unknown/required properties, scalar types, and enum
values. It emits structured diagnostics, including `ODDS1003` for a value outside
the declared enum. It does not validate slots, raw CSS, tokens, local instances,
or whole artifacts. The other diagnostic codes reserve the intended namespace;
their presence in the schema does not mean those validators ship here.

`resolveComponentBinding(binding, registry, codeComponents, projectComponents?)` resolves supplied
metadata by exact identity and verifies the current binding state, framework,
property compatibility, one-to-one property renames and explicit slot mappings.
Every design slot must map to a declared code slot with compatible requiredness and
cardinality. Value transformations require complete finite enum or Boolean domains.
Typed scalar maps distinguish values such as `1` and `'1'`; legacy string-keyed maps
are accepted only when their domains are unambiguous. `materializeBindingProps`
resolves the binding, validates input and applies the same proven mapping plan,
including design defaults before a code component is called. Defaultless omission
must remain compatible with the code contract. The resolver does not read files.

The local-binding foundation verifies an explicit shared definition revision and
source-selected code contract. A template revision makes the binding stale even
when its public properties are unchanged. Explicit project code ownership prevents
collision with package-owned code, and current source evidence detects registered
API drift. These internal operations are accepted; project persistence and handoff
UI/CLI wiring remain part of Phase 9.

The internal `createHandoff` builder produces a portable snapshot containing the
exact lock and frozen package, semantic document, local definitions, code indexes,
bindings, current registered source and target package observations. Missing local
implementations remain actionable diagnostics. A declared dependency range never
counts as an observed installed version. Optional historical change context is
separate from current source and lock verification.

`materializeHandoffCalls` rechecks these facts and computes production imports,
effective scalar props and ordered code slots. `emitHandoffCode` uses that same
plan to return React TSX or Vue SFC screen files. Bound local instances remain
production component calls. The emitter reparses the generated source and returns
no files if any required binding, output path or framework construct is invalid.
This pure service does not write files or establish the later public workflow.

V1 instance overrides are an array of versioned records such as
`{ schemaVersion: 1, path: ['props', 'title'], value: 'Production' }`.
The tuple path avoids dotted-key ambiguity. Only whole-prop overrides are
represented; removing a record expresses reset. Resolution, inheritance, and
editing are implemented by the project component service and semantic editors.
UI documents contain versioned screens and semantic
component/text/instance nodes, with unique node IDs across all screens.

`resolveProjectDocument` expands local definitions, materializes defaults and
overrides, validates slot composition and returns deterministic node origins.
`queryReferenceGraph` follows actual source references with bounded traversal.
The shared-change service validates every proposed definition and screen before
publication. These checks are independent of production source rendering, token
validation and generation repair, which remain separate milestones.

The executable acceptance test is
`apps/daemon/tests/services/design-runtime/acceptance.test.ts`. It compiles the
Button source fixture, round-trips the three outputs through their schemas,
resolves `ds:test/Button` to `fixture/Button`, accepts `variant: 'primary'`, and
rejects `variant: 'filled'` with `ODDS1003` and the allowed values.

## Validation

Run the existing contracts suite and focused daemon design-system tests before
source changes. Then run the new narrow schema/compiler/validation tests, contract
serialization and package export checks, and the repository-required `pnpm guard`
and `pnpm typecheck`. Rebuild generated contract exports before testing package
runtime imports. Pure compiler tests require no source execution or LLM. Project
service, storage, route, and CLI tests use temporary SQLite/HTTP fixtures; the UI
witness uses the shared tools-dev Playwright suite. None require provider accounts.

Focused commands:

```bash
corepack pnpm --filter @open-design/contracts build
corepack pnpm --filter @open-design/contracts test
corepack pnpm --filter @open-design/daemon exec vitest run -c vitest.config.ts tests/services/design-runtime tests/storage/design-runtime-store.test.ts tests/routes/design-runtime.test.ts
corepack pnpm --filter @open-design/web test tests/providers/design-runtime.test.ts tests/components/DesignRuntimePanel.test.tsx tests/components/SemanticTreeEditor.test.tsx tests/components/ProjectStructurePanel.test.tsx
corepack pnpm --filter @open-design/e2e exec playwright test -c playwright.config.ts ui/design-runtime.test.ts --workers=1
corepack pnpm guard
corepack pnpm typecheck
```

## First-milestone acceptance map

This map covers Phase 1 and the minimal React compiler spike. Later roadmap
subsystems remain outside this milestone; their schema vocabulary does not
establish runtime support.

| Requirement | Implementation | Executable evidence |
| --- | --- | --- |
| Versioned component definitions and registry with stable IDs | [component-registry.ts](../packages/contracts/src/design-runtime/component-registry.ts) | [contracts.test.ts](../packages/contracts/tests/design-runtime/contracts.test.ts): parsing, duplicate IDs, rename stability, serialization, and rejected schema versions |
| Canonical code component and binding contracts | [component-binding.ts](../packages/contracts/src/design-runtime/component-binding.ts) | [contracts.test.ts](../packages/contracts/tests/design-runtime/contracts.test.ts): code component and binding round-trips, lifecycle states, and prop mappings |
| Semantic UI document/node and override-only instance contracts | [ui-ir.ts](../packages/contracts/src/design-runtime/ui-ir.ts) | [contracts.test.ts](../packages/contracts/tests/design-runtime/contracts.test.ts): document/instance/override round-trips, unique node IDs, and rejection of copied inherited fields or graphical geometry |
| Structured validation diagnostics | [validation.ts](../packages/contracts/src/design-runtime/validation.ts) | [contracts.test.ts](../packages/contracts/tests/design-runtime/contracts.test.ts): diagnostic serialization, locations, allowed values, and repair payloads |
| Canonical schemas available through the contracts package | [index.ts](../packages/contracts/src/index.ts) | [package-runtime.test.ts](../packages/contracts/tests/package-runtime.test.ts): built-package schema/version exports |
| Deterministic export, name, path, prop, enum, optionality, and reliable default extraction | [react-compiler.ts](../apps/daemon/src/services/design-runtime/react-compiler.ts) | [react-compiler.test.ts](../apps/daemon/tests/services/design-runtime/react-compiler.test.ts): Button metadata, literal defaults, explicit identity, repeatability, and unsupported-source rejection |
| Exact binding resolution and property legality | [binding-resolver.ts](../apps/daemon/src/services/design-runtime/binding-resolver.ts), [component-validator.ts](../apps/daemon/src/services/design-runtime/component-validator.ts) | [binding-resolver.test.ts](../apps/daemon/tests/services/design-runtime/binding-resolver.test.ts), [component-validator.test.ts](../apps/daemon/tests/services/design-runtime/component-validator.test.ts): exact identities, compatible props, binding failures, and invalid values |
| End-to-end first fixture without an LLM | [Button.tsx](../apps/daemon/tests/services/design-runtime/fixtures/Button.tsx) | [acceptance.test.ts](../apps/daemon/tests/services/design-runtime/acceptance.test.ts): compile and serialize, resolve `ds:test/Button` to `fixture/Button`, accept `primary`, reject `filled` with `ODDS1003` |
