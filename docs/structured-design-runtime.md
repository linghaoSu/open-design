# Structured design runtime

Projects can compile selected React/TypeScript exports into a structured component
registry, inspect their properties, manage explicit code bindings, and validate
property values. Open **Design runtime** from the project file workspace's tab
bar, select source files and named exports, then choose **Compile registry**.
The same operations are available through `od design-runtime` and the project HTTP
API. Existing design-system discovery, generation, and rendering retain their
current behavior.

The [active delivery plan](../specs/current/structured-design-runtime.md) tracks
the remaining inheritance, versioning, upgrade, handoff, and generation work.

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
reference graphs, inheritance, version resolution, migrations, rendering, and
handoff remain tracked separately in the active plan.

## Project workflow and persistence

Compilation replaces the project's registry using the complete selection list.
Each selection contains a project-relative source path, export name, and stable
component/code IDs. The daemon reads each selected file once and compiles every
export before atomically saving the new registry, code index, and bindings. A
failed source read, unsupported type, or invalid selection leaves the prior
snapshot intact. Source text is not copied into registry storage.

The UI assigns identities once per selection and preserves them when source paths
or exports are edited. Existing manual bindings and explicit unbound states survive
recompilation. Removed targets become broken; changed public APIs become stale.
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

CLI commands begin with `od design-runtime` and support `--json`, `--daemon-url`,
`--workspace`, and `--workspace-member`. Compile/bind/validate read JSON from a
file or stdin. A write can provide `expectedRevision` in its input or
`--expected-revision`; if both are omitted, the CLI reads the current revision once
and sends it without retrying conflicts. Invalid usage diagnostics and unresolved
bindings exit 1; malformed CLI input exits 2. Run `od design-runtime help` for
complete input examples. Canonical request/response schemas live in
`packages/contracts/src/api/design-runtime.ts`; errors use `error.details`.

For example, after compiling the matching stable identities, this validates a
usage through the same endpoint as the UI:

```bash
od design-runtime validate <projectId> --json --prompt-file - <<'JSON'
{"component":"ds:acme/button","props":{"variant":"primary"}}
JSON
```

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

Unsupported syntax throws `CompilerError` with source context. This includes
imported types, inheritance, generics, intersections, callbacks/object/array
props, wrappers, overloads, TypeScript receiver (`this`) parameters, export
specifiers, default exports, and computed defaults. This is not yet a production
React library importer. Storybook, Vue extraction, project scanning, identity
reconciliation, and inference are deferred.

`validateComponentUsage(registry, { component, props, nodeId? })` checks exact
design-system references, unknown/required properties, scalar types, and enum
values. It emits structured diagnostics, including `ODDS1003` for a value outside
the declared enum. It does not validate slots, raw CSS, tokens, local instances,
or whole artifacts. The other diagnostic codes reserve the intended namespace;
their presence in the schema does not mean those validators ship here.

`resolveComponentBinding(binding, registry, codeComponents)` resolves supplied
metadata by exact identity and verifies the current binding state, framework,
property compatibility, and one-to-one property renames. It rejects slots and
value transformations until those mappings can be checked. It also rejects
diverging defaults on omittable design props: this spike does not materialize
design defaults before calling a code component. It does not inspect the
filesystem for stale/broken exports.

V1 instance overrides are an array of versioned records such as
`{ schemaVersion: 1, path: ['props', 'title'], value: 'Production' }`.
The tuple path avoids dotted-key ambiguity. Only whole-prop overrides are
represented; removing a record expresses reset. Resolution, inheritance, and
editing are future work. UI documents contain versioned screens and semantic
component/text/instance nodes, with unique node IDs across all screens.

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
corepack pnpm --filter @open-design/web test tests/providers/design-runtime.test.ts tests/components/DesignRuntimePanel.test.tsx
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
