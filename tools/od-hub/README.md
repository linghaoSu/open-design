# tools/od-hub

Self-hosted, Vela-compatible collaboration hub for OpenDesign plus the
`od-vela` CLI shim the daemon spawns as `VELA_BIN`. Together they let a
daemon run the team-workspace code paths (directory, SSE, billing gates,
sync digest) against infrastructure you control instead of
`amr-api.open-design.ai`.

This package is the **M0/M1 skeleton** from
`PLAN-selfhosted-hub-gitlab-oauth.md`: argv routing, error formats, storage
interface, and the stubs that keep the daemon happy. GitLab OAuth, resource
blobs, comments, presence, and invites are declared (see
`migrations/0001_init.sql`) but not yet implemented; the shim
answers those subcommands with the typed `501: not_supported` line so the
daemon degrades cleanly instead of guessing.

Dependencies: `better-sqlite3` (same pin as `apps/daemon`) for the optional
`--sqlite` store; the HTTP layer is plain `node:http` + `fetch`. Dev deps
mirror `tools/serve`.

## Layout

```
src/index.ts              od-hub CLI entry (`od-hub start`, node:util parseArgs)
src/server/http.ts        HTTP + SSE routes (node:http)
src/server/store.ts       HubStore interface + row types (PLAN §3.2)
src/server/memory-store.ts in-memory HubStore
src/server/sqlite-store.ts better-sqlite3 HubStore + schema_migrations runner
src/server/dev-seed.ts    `--seed-dev` identity (idempotent)
src/server/ids.ts         key hashing, odc_/odr_ minting, memberId derivation
migrations/               NNNN_*.sql applied in order, tracked in schema_migrations
src/cli/main.ts           od-vela bin entry
src/cli/shim.ts           argv router (PLAN §6.2) and stub payloads
src/cli/config.ts         VELA_* / $AMR_HOME/config.json resolution
src/cli/http.ts           hub client + stderr error contract (PLAN §6.3)
src/shared/wire.ts        constants pinned to daemon parsers (file:line cited)
tests/                    server endpoint + exhaustive shim contract tests
```

## Server endpoints

| Method + path | Auth | Behavior |
|---|---|---|
| `GET /healthz` | no | `{ok, service, listenerEpoch, at}` |
| `GET /api/v1/me` | Bearer | `{user:{id, email, name?, image?}}` for the key owner |
| `GET /api/v1/workspaces` | Bearer | caller's membership directory (`{items: WorkspaceDirectoryItem[]}`) |
| `GET /api/v1/collab/events` | Bearer + `x-vela-workspace-id` | SSE: `ready` (5 capabilities, `listenerEpoch/listenerHealth/sourceGap`), immediate `heartbeat`, then every 10 s |
| `GET /api/v1/collab/sync-digest` | Bearer + workspace | `{catalogToken, membersToken, contextToken, billingToken}` |
| `GET /api/v1/wallet/balance` | Bearer | stub `{balanceUsd:"999999.00", updatedAt}` |
| `GET /api/v1/billing/workspace-snapshot` | Bearer + workspace | internal; feeds `od-vela billing workspace-snapshot`; `workspaceMemberId` equals the directory row |
| `POST /api/v1/open-design/telemetry` | Bearer | 202, body discarded |
| `POST /api/v1/analytics/events` | no | 204, body discarded |
| `/api/v1/message-center/*` | Bearer | empty message lists |
| any other `/api/v1/*` | — | `501 {error:"not_supported"}` (never a bare 404) |

Auth failures return `401 {"error":"invalid_api_key"}`; a non-member asking
for a workspace gets `403 {"error":"workspace_not_authorized"}`.

## od-vela shim contract

Implemented now: `--version`, `billing summary`, `billing
workspace-snapshot`, `model list|preset`, `models`, `media models`,
`run terminal`, `team-projects --help`. Closed on purpose (exit 1, typed
stderr): `billing workspace-balance|team-catalog|checkout`. `image *` /
`video *` exit 1 with
`{"error":{"code":"not_supported","message":"od-hub does not provide media generation","retryable":false}}`
on stdout, which the daemon surfaces as a non-retryable provider verdict.
Everything else — `login`, `collab *`, `resource *`, `team-projects` data
commands, `agent run` — is a TODO stub emitting:

```
Error: <verb> <noun>: API request failed with status 501: not_supported
```

The shim never prints `unknown command`, `unknown flag:`,
`billing_workspace_snapshot_unsupported`, or a bare `status 404` without a
colon; those strings flip the daemon into compatibility fallbacks. Local
validation failures exit 2 with `Error: <scope>: <message>`; an unexpected
exception inside the shim is caught at the process entry and rendered as
`Error: <scope>: <message>` with exit 1, never as a stack trace.

Request headers on every hub call: `authorization: Bearer <controlKey>`,
`x-vela-workspace-id`, `x-vela-invocation-source` (default `open-design`),
`user-agent: od-vela/0.0.35-odhub`.

## Environment variables

Read by the shim (precedence mirrors `apps/daemon/src/integrations/vela.ts:751-795`):

| Variable | Meaning |
|---|---|
| `VELA_CONTROL_KEY` | bearer token; when set, wins over config.json |
| `VELA_API_URL` | hub origin; used when set via env key, or as fallback when config.json has no `apiUrl` |
| `VELA_WORKSPACE_ID` / `OPEN_DESIGN_WORKSPACE_ID` | ambient workspace header (`--workspace-id` overrides) |
| `VELA_INVOCATION_SOURCE` | header value, default `open-design` |
| `OPEN_DESIGN_AMR_PROFILE` / `VELA_PROFILE` | profile key inside `$AMR_HOME/config.json` (`selfhost` recommended) |
| `AMR_HOME` | directory holding `config.json` (default `~/.amr`) |

Read by the daemon to point at this hub:

| Variable | Meaning |
|---|---|
| `VELA_BIN` | absolute path to `tools/od-hub/bin/od-vela.mjs` (or a wrapper) |
| `VELA_API_URL` | hub origin, e.g. `http://127.0.0.1:18790` |
| `OD_AMR_API_UPSTREAM_ORIGIN` | same origin, so the daemon's `api-proxy` fallback never leaves your network |
| `OPEN_DESIGN_AMR_PROFILE=selfhost` | selects the self-hosted profile slot |
| `OD_VELA_WEB_URLS` | JSON map of profile to console origin, e.g. `{"selfhost":"http://127.0.0.1:18790/console"}` |
| `OD_WORKSPACE_CONTEXT_SOURCE=vela` | enables the Vela-backed team transport |
| `OPEN_DESIGN_VELA_TELEMETRY=0` | optional; the hub accepts telemetry with 202 anyway |

## Server flags

```
od-hub start [--port <n>] [--host <addr>] [--sqlite <path>]
             [--seed-dev [--control-key <odc_...>]] [--seed <file.json>]
```

| Flag | Meaning |
|---|---|
| `--port` / `OD_HUB_PORT` | listen port (default 18790) |
| `--host` / `OD_HUB_HOST` | bind address (default 127.0.0.1) |
| `--sqlite <path>` | persist to a better-sqlite3 file (created and migrated on open) instead of memory |
| `--seed-dev` | create user `u1`, personal workspace `u1`, team workspace `g1`, and one control key. Idempotent: pass it on every start of a `--sqlite` hub |
| `--control-key <key>` | plaintext key for `--seed-dev`; must be `odc_` + at least 8 url-safe chars. Without it a random `odc_` key is minted and printed once on stdout (sha256 only is stored) |
| `--seed <file.json>` | explicit `{users, workspaces}` for the memory store |

There is no default control key: a hub started without `--seed-dev`/`--seed`
rejects every bearer.

## Pointing a dev daemon at it

```bash
pnpm --filter @open-design/tools-od-hub build
pnpm tools-od-hub start --port 18790 --sqlite .tmp/od-hub/hub.sqlite \
  --seed-dev --control-key odc_dev_local_control_key          # terminal 1
```

`tools-dev` loads `.env.development.local` from the repo root, so put the
daemon-side variables there instead of exporting them by hand:

```dotenv
# .env.development.local
OD_WORKSPACE_CONTEXT_SOURCE=vela
OPEN_DESIGN_AMR_PROFILE=selfhost
VELA_BIN=/abs/path/to/open-design/tools/od-hub/bin/od-vela.mjs
VELA_API_URL=http://127.0.0.1:18790
VELA_CONTROL_KEY=odc_dev_local_control_key
OD_AMR_API_UPSTREAM_ORIGIN=http://127.0.0.1:18790
OD_VELA_WEB_URLS={"selfhost":"http://127.0.0.1:18790/console"}
OPEN_DESIGN_VELA_TELEMETRY=0
```

```bash
pnpm tools-dev run web --daemon-port 17456 --web-port 17573   # terminal 2
```

`VELA_CONTROL_KEY` in the daemon environment is inherited by the shim; once
`od-vela login` exists you will instead write `$AMR_HOME/config.json`
`profiles.selfhost.{controlKey,runtimeKey,apiUrl}` and drop the env key.

Quick manual check without a daemon:

```bash
VELA_API_URL=http://127.0.0.1:18790 VELA_CONTROL_KEY=odc_dev_local_control_key \
  node tools/od-hub/bin/od-vela.mjs billing workspace-snapshot --workspace-id g1 --format json
curl -H 'authorization: Bearer odc_dev_local_control_key' http://127.0.0.1:18790/api/v1/me
curl -N -H 'authorization: Bearer odc_dev_local_control_key' -H 'x-vela-workspace-id: g1' \
  http://127.0.0.1:18790/api/v1/collab/events
```

## Verify

```bash
pnpm --filter @open-design/tools-od-hub typecheck
pnpm --filter @open-design/tools-od-hub test
pnpm --filter @open-design/tools-od-hub build
```
