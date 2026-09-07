# tools/od-hub

Self-hosted, Vela-compatible collaboration hub for OpenDesign plus the
`od-vela` CLI shim the daemon spawns as `VELA_BIN`. Together they let a
daemon run the team-workspace code paths (directory, SSE, billing gates,
sync digest) against infrastructure you control instead of
`amr-api.open-design.ai`.

This package is the **M0-M2 hub** from
`PLAN-selfhosted-hub-gitlab-oauth.md`: argv routing, error formats, storage
interface, GitLab OAuth Device Flow login, the GitLab-mirrored workspace
directory, the outbox-backed SSE event stream, content-addressed resource
versions (blobs + manifests + CAS publish), the team-project catalog, and
member-side pull receipts. Comments, presence, public snapshots, and invites
are declared (see `migrations/`) but not yet implemented; the shim answers
those subcommands with the typed `501: not_supported` line so the daemon
degrades cleanly instead of guessing.

Dependencies: `better-sqlite3` (same pin as `apps/daemon`) for the optional
`--sqlite` store; the HTTP layer is plain `node:http` + `fetch`; token
encryption is `node:crypto` AES-256-GCM. Dev deps mirror `tools/serve`.

## Layout

```
src/index.ts              od-hub CLI entry (`od-hub start`, node:util parseArgs)
src/server/http.ts        HTTP + SSE routes (node:http)
src/server/blob-store.ts  content-addressed blob files (<BLOB_DIR>/<aa>/<sha256>, tmp+rename)
src/server/resource-service.ts publish (CAS) / head / manifest / tombstone / catalog / pull receipts
src/server/config.ts      env -> HubConfig (GitLab, TTLs, public URL)
src/server/gitlab.ts      injectable GitLabClient interface + fetch implementation
src/server/auth-service.ts device flow, odc_/odr_ minting, encrypted grants, refresh lock
src/server/directory-service.ts GitLab groups -> workspaces/members mirror + diff events
src/server/event-relay.ts events_outbox -> SSE fan-out (workspace / directory / access)
src/server/digest.ts      event -> sync-digest face mapping (mirrors e2e fake hub)
src/server/token-cipher.ts AES-256-GCM envelope for GitLab tokens (key id bound as AAD)
src/server/store.ts       HubStore interface + row types (PLAN §3.2)
src/server/memory-store.ts in-memory HubStore
src/server/sqlite-store.ts better-sqlite3 HubStore + schema_migrations runner
src/server/dev-seed.ts    `--seed-dev` identity (idempotent)
src/server/ids.ts         key hashing, odc_/odr_ minting, memberId derivation
migrations/               NNNN_*.sql applied in order, tracked in schema_migrations
src/cli/main.ts           od-vela bin entry
src/cli/shim.ts           argv router (PLAN §6.2) and stub payloads
src/cli/login.ts          `od-vela login|logout` device flow + atomic config.json write
src/cli/config.ts         VELA_* / $AMR_HOME/config.json resolution and profile writer
src/cli/http.ts           hub client + stderr error contract (PLAN §6.3)
src/cli/resources.ts      `resource *` / `team-projects *` subcommands
src/cli/tree.ts           directory snapshot (exclude rules), verified materialize, atomic dir swap
src/shared/wire.ts        constants pinned to daemon parsers (file:line cited)
src/shared/manifest.ts    manifest entries, digest, versionId, exclude matcher (shared by hub + shim)
tests/                    server endpoint, GitLab flow, SSE, and shim contract tests
tests/helpers/fake-gitlab.ts node:http fake GitLab (device flow, /user, /groups)
tests/helpers/fake-gitlab-main.ts the same fake as a standalone process (used by the smoke)
scripts/smoke-login.ts    out-of-process login smoke: fake GitLab + od-hub --sqlite + od-vela login
```

## Server endpoints

| Method + path | Auth | Behavior |
|---|---|---|
| `GET /healthz` | no | `{ok, service, listenerEpoch, gitlab, at}` |
| `POST /api/v1/auth/device` | no | `{profile}` -> proxies GitLab `authorize_device` (scope `read_user read_api`); returns `{deviceCode, userCode, verificationUri, verificationUriComplete, interval, expiresIn}`. `deviceCode` is hub-minted (256-bit); only its sha256 is stored, and GitLab's own code is stored encrypted and never leaves the server. 501 when GitLab is not configured |
| `POST /api/v1/auth/device/token` | no | `{deviceCode}` -> polls GitLab. `428 {error:"authorization_pending"}`, `429 {error:"slow_down"}`, `400 access_denied|expired_token|invalid_grant|invalid_request`; on success upserts the user, encrypts the GitLab grant, mints `odc_`/`odr_` keys and returns `{controlKey, runtimeKey, apiUrl, linkUrl, user:{id,email,name,image,plan:"team"}}` |
| `POST /api/v1/auth/revoke` | Bearer | revokes the presented key only |
| `GET /api/v1/me` | Bearer | `{user:{id, email, name?, image?, plan, balanceUsd}}` for the key owner |
| `GET /api/v1/workspaces` | Bearer | membership directory (`{items: WorkspaceDirectoryItem[]}`): personal `u<gitlabId>` + one `g<groupId>` row per GitLab group at or above `GITLAB_MIN_ACCESS_LEVEL`. GitLab listing cached 60 s per user; removed memberships stay visible as `memberStatus:"removed"` for 7 days |
| `GET /api/v1/collab/events` | Bearer + `x-vela-workspace-id` | SSE: `ready` (5 capabilities, `listenerEpoch/listenerHealth/sourceGap`), immediate `heartbeat`, then every 10 s; `workspace-event`, `workspace-directory-changed`, `access-revoked` frames from the outbox |
| `GET /api/v1/collab/sync-digest` | Bearer + workspace | `{catalogToken, membersToken, contextToken, billingToken}`; faces move per event exactly like the e2e fake hub |
| `GET /api/v1/wallet/balance` | Bearer | stub `{balanceUsd:"999999.00", updatedAt}` |
| `GET /api/v1/billing/workspace-snapshot` | Bearer + workspace | internal; feeds `od-vela billing workspace-snapshot`; `workspaceMemberId` equals the directory row |
| `POST /api/v1/open-design/telemetry` | Bearer | 202, body discarded |
| `POST /api/v1/analytics/events` | no | 204, body discarded |
| `/api/v1/message-center/*` | Bearer | empty message lists |
| `POST /api/v1/blobs/missing` | Bearer + workspace | `{sha256:[hex...]}` -> `{missing:[hex...]}` (input order, de-duplicated) |
| `PUT /api/v1/blobs/:sha256` | Bearer + workspace | raw body streamed to disk while hashing; `201 {sha256,size}` when new, `200` when already stored (the body is drained and nothing is written or re-verified), `400 blob_digest_mismatch` when the body does not hash to the path (nothing is kept), `413 payload_too_large` above 512 MiB |
| `GET /api/v1/blobs/:sha256` | Bearer + workspace | `application/octet-stream`; `404 blob_not_found` |
| `POST /api/v1/resources/:kind/:id/versions` | Bearer + workspace | `{manifest:[{path,sha256,size,mode}], expectedVersion?, metadata?, manifestDigest?}`. Validates paths (no `..`, leading `/`, `\`, NUL, duplicates), requires every blob to be stored (`409 blobs_missing`), then in one transaction: CAS against `published_version` (`409 resource_version_conflict`), insert the immutable version, move `published`, write outbox + digest bump + audit. `201 {version, versionId, manifestDigest, entryCount, ownerMemberId}`. `404 resource_not_found` once tombstoned; `403 resource_forbidden` when a plain member publishes over another member's resource (workspace owner/admin may); `409 resource_kind_conflict` when the kind differs from the stored one |
| `GET /api/v1/resources/:id/head?ref=published` | Bearer + workspace | `{version, versionId}`, or `{version:null, versionId:null}` for unknown and unpublished ids; `404 resource_not_found` once tombstoned (the daemon reads that as retracted); any other ref `404 ref_not_found` |
| `GET /api/v1/resources/:id/versions/:versionId/manifest` | Bearer + workspace | one immutable version (`published` accepted as alias); `404 version_not_found` |
| `DELETE /api/v1/resources/:id` | Bearer + workspace | tombstone (`deleted_at`); `{ok:true}` on the first call and idempotently on every later call (no event, no audit row the second time); an id that never existed is `404 resource_not_found`; non-project kinds emit `team-resources-changed{resourceStatus:"retracted"}` on the first call |
| `GET /api/v1/resources/shared` | Bearer + workspace | `{resources:[{id, teamId, kind, ownerMemberId, metadata, createdAt, deletedAt:null, publishedVersion:{id,version}}]}` — live resources of the workspace |
| `GET /api/v1/team-projects` | Bearer + workspace | `{workspaceId, projects:[TeamProjectWire]}`; `publishedVersionId` is read from the referenced resource (null when it has no published ref or is tombstoned) |
| `GET /api/v1/team-projects/:projectId` | Bearer + workspace | one `TeamProjectWire`; `404 team_project_not_found` |
| `PUT /api/v1/team-projects/:projectId` | Bearer + workspace | upsert `{resourceId, displayName?, syncState?, lastSyncedVersionId?, metadata?}`; owner fixed to the first writer (`403 team_project_forbidden` for other plain members); first write emits `team-projects-changed`, later writes `project-metadata-changed` |
| `DELETE /api/v1/team-projects/:projectId` | Bearer + workspace | `{ok:true}`, idempotent: a missing row is also `{ok:true}` with no event, because the daemon's unshare path retries the DELETE after a lost response and expects `{ok:true}`; `403 team_project_forbidden` when the row exists and the caller is neither its owner nor a workspace owner/admin; emits `team-projects-changed` when a row was removed |
| `POST /api/v1/team-projects/:projectId/pull-authorization` | Bearer + workspace | `{ref:"published", expectedVersion}` -> pull receipt (schema below). The viewer must be an active member other than the owner and `expectedVersion` must equal the current published version, else `409 authorized_team_project_pull_rejected`. Receipts are persisted (`pull_receipts`) and single-use |
| any other `/api/v1/*` | — | `501 {error:"not_supported"}` (never a bare 404) |

Auth failures return `401 {"error":"invalid_api_key"}` **only** for a missing,
revoked, or expired key, or when GitLab *rejects* the user's refresh token
(HTTP 400/401 such as `invalid_grant`; then every key of that user is revoked
first). When GitLab merely cannot be reached while a token needs refreshing
(timeout, connection error, 5xx) the request answers
`503 {"error":"gitlab_unavailable"}` and keys and grant stay intact, so a
GitLab outage never logs users out. A GitLab `401` on an API call made with a
token the hub still believed valid triggers one locked refresh and a retry
before anything is revoked. A non-member or a removed member asking for a
workspace gets `403 {"error":"workspace_not_authorized"}`; membership loss is
never expressed as 401.

JSON request bodies must be objects: malformed JSON answers
`400 {"error":"invalid_json"}` and bodies over the route limit (64 KiB by
default, 64 MiB for manifests) `413 {"error":"payload_too_large"}`.

### Resource model (PLAN §3.4)

- Blobs are content-addressed files under `BLOB_DIR/<aa>/<sha256>`, written to
  `BLOB_DIR/tmp` while hashing and renamed into place only when the digest
  matched. Blobs are never deleted; versions reference them by digest.
- `manifest` is the sorted list of `{path, sha256, size, mode}`;
  `manifestDigest = 'sha256:' + sha256(concat(path + '\0' + sha256 + '\n'))`
  (identical to `e2e/lib/collab-hub-core/snapshots.ts`);
  `versionId = 'v<version>-<manifestDigest[7:19]>'`. Version rows are immutable.
- The `published` ref is the only ref. `head` reports `{version:null}` before
  the first publish. A publish carrying `expectedVersion` is a compare-and-set
  on `published_version`; the shim always sends the head it observed, so two
  concurrent authors cannot both win (the loser sees
  `Error: resource push: API request failed with status 409: resource_version_conflict`
  and the daemon retries).
- Tombstone gate: after `DELETE`, every resource-scoped call (`head`, manifest,
  blobs-by-version, publish under the same id, pull authorization) answers
  `404 resource_not_found`. Only `DELETE` itself stays idempotent.
- Manifests are rejected when a path is both a file and a directory prefix
  (`a` together with `a/b`): such a tree cannot be materialized, so the version
  must never be published.
- Events: a `project` publish with a catalog row emits
  `project-content-changed{projectId, version}`; other kinds emit
  `team-resources-changed{resourceId, resourceKind, resourceStatus}`; every
  mutation bumps `catalogToken`. Outbox rows, digest bumps, and audit entries
  (`resource_publish`, `resource_remove`, `team_project_create|update|remove`,
  `team_project_pull_authorize`) commit in the mutation's transaction.
- Pull receipt (authorized-team-project-pull.ts:26-41):
  `{schemaVersion:1, workspaceId, resourceTeamId, viewerMemberId, ownerMemberId, projectId, resourceId, ref:"published", version, versionId, manifestDigest, manifestEntryCount, lifecycleState:"active", authorizedAt, expiresAt}`
  with `expiresAt = authorizedAt + 2000 ms`. The HTTP reply additionally carries
  `nonce`; the shim strips it before printing.

### GitLab mapping (PLAN §3.1, §5.2)

| Hub | GitLab |
|---|---|
| `user.id` | `String(user.id)`; email falls back to `public_email`, then `<username>@<gitlab-host>` |
| personal workspace | `u<gitlabId>`, `"<name>'s workspace"`, role `owner` |
| team workspace | `g<groupId>`, `workspaceName = full_name`, `workspaceIconKey = avatar_url`; top-level groups only unless `GITLAB_WORKSPACE_GROUP_MODE=include-subgroups` |
| `workspaceMemberId` | `m_<sha256(userId:workspaceId)[:24]>` (identical in directory and billing snapshot) |
| role | access_level 50 -> `owner`, 40 -> `admin`, >= `GITLAB_MIN_ACCESS_LEVEL` (20) -> `member`, below -> no row |
| `lifecycleState` | `marked_for_deletion_on` -> `deleting`, `archived` -> `locked`, else `active` |

Directory diffs on refresh emit `workspace-directory-changed`
(`created|updated|membership-added|membership-updated|membership-removed`) to
the user's streams and `workspace-context-changed` +
`workspace-members-changed{memberId, memberChange}` to the workspace. A
removal additionally sends `access-revoked{reason:"workspace_membership_removed"}`
to the removed user's streams of that workspace and closes them. Outbox rows
are written in the same store transaction as the mutation.

## od-vela shim contract

Implemented now: `--version`, `login`, `logout`, `billing summary`, `billing
workspace-snapshot`, `model list|preset`, `models`, `media models`,
`run terminal`, `resource push|head|pull|pull-batch|remove|shared|list`,
`team-projects --help|list|get|upsert|remove|pull`. Closed on purpose (exit 1,
typed stderr): `billing workspace-balance|team-catalog|checkout`. `image *` /
`video *` exit 1 with
`{"error":{"code":"not_supported","message":"od-hub does not provide media generation","retryable":false}}`
on stdout, which the daemon surfaces as a non-retryable provider verdict.
Everything else — `collab *`, `resource snapshot|snapshot-redact`, `agent run`
— is a TODO stub emitting:

```
Error: <verb> <noun>: API request failed with status 501: not_supported
```

### resource / team-projects

Argv and output follow `apps/daemon/src/collab/vela-cli-resource-adapter.ts`,
`vela-cli-resource-pull-batcher.ts`, `vela-cli-team-projects.ts` and
`authorized-team-project-pull.ts`. Every call needs `VELA_WORKSPACE_ID` (or
`OPEN_DESIGN_WORKSPACE_ID`); a missing scope is a local exit-2 error.

| argv | behavior |
|---|---|
| `resource push <kind> <id> <dir> --ref published --json [--exclude N]* [--exclude-prefix P]* [--metadata-json J]` | walks `dir` (symlinks skipped) applying the adapter's exclude semantics — a bare name matches any entry of that name at any depth, `name/` matches directories only, `--exclude-prefix` likewise on entry names — hashes files, asks `/blobs/missing`, uploads missing blobs 8 at a time (each streamed from disk, never buffered), then `POST .../versions` with `expectedVersion` = the head it read first. stdout `{version, versionId}` |
| `resource head <id> --ref published --json` | `{version, versionId}` or `{version:null, versionId:null}` |
| `resource pull <kind> <id> <dir> --ref published --json` | downloads the published manifest and blobs into a sibling temp directory, verifies every sha256 and the manifest digest, then swaps `dir` atomically (`dir -> dir.od-old-*`, `tmp -> dir`, remove old): the directory inode changes and readers never see a partial tree. Refuses a symlinked `dir`. stdout `{version, versionId}` |
| `resource pull-batch --requests-file - --json` | stdin `{requests:[{key, kind, resourceId, dir, ref?}]}` (at most 128, unique keys) -> stdout `{results:[{...request, ok:true, version, versionId} or {...request, ok:false, error, errorCode}], succeeded, failed}`, exit 0 whenever the batch itself was well-formed |
| `resource remove <id> --json` | `{ok:true}`, also on a second call (idempotent); an id that never existed reports `status 404: resource_not_found`, which the daemon reads as "retracted" |
| `resource shared --json` / `resource list --json` | `GET /api/v1/resources/shared` |
| `team-projects list` / `get <p> --json` / `upsert <p> --resource-id R [--display-name --sync-state --last-synced-version-id --metadata-json]` / `remove <p>` | the catalog endpoints above; `--json` is accepted everywhere and ignored. An omitted `--sync-state` stores `synced`; `remove` is idempotent (`{ok:true}` for a row that is already gone) |
| `team-projects pull <p> --authorize-only --ref published --expected-version N --json` | receipt only (with `manifestEntryCount`); nothing is downloaded |
| `team-projects pull <p> <stageDir> --live-dir <live> --ref published --expected-version N --json` | `stageDir` must be an existing, empty, real directory. The shim downloads the manifest and blobs FIRST (hard-linking files from `--live-dir` whose sha256 matches), verifies every digest, then requests the receipt and replaces the `stageDir` inode with the verified tree, so the 2 s receipt window is never spent on transfer. If the published version moved between download and receipt the pull fails with `authorized_team_project_pull_rejected` and nothing is staged |

Error code strings the daemon classifies are passed through verbatim:
`resource_not_found`, `ref_not_found`, `resource_version_conflict`,
`team_project_not_found`, `workspace_not_authorized`, `invalid_api_key`,
`authorized_team_project_pull_rejected`.

`od-vela login` prints, to stdout and before anything else, exactly what
`apps/daemon/src/integrations/vela.ts` `parseVelaLoginActivation` reads:

```
Open this URL to continue:
<verificationUriComplete>

Code: <userCode>
```

then tries to open the browser (failure -> stderr
`could not open browser automatically: <reason>`), polls
`/api/v1/auth/device/token` honouring `interval` and `slow_down`, atomically
rewrites `$AMR_HOME/config.json` with
`profiles[<profile>] = {controlKey, runtimeKey, apiUrl, linkUrl, user}` (other
profiles and keys preserved), prints `Login successful for <email>.` and exits
0. The daemon spawns it with stdin ignored and decides success by `runtimeKey`
appearing in the file. `od-vela logout` calls `POST /api/v1/auth/revoke` and
strips `controlKey/runtimeKey/user` from the profile.

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

Read by the hub server:

| Variable | Meaning |
|---|---|
| `GITLAB_URL` | GitLab origin, e.g. `https://gitlab.example.com`. Together with the client id this enables `od-vela login` |
| `GITLAB_OAUTH_CLIENT_ID` | OAuth application id (Device Authorization Grant must be enabled on the application; GitLab 17.2+) |
| `GITLAB_OAUTH_CLIENT_SECRET` | optional; omit for a public (confidential = false) application |
| `GITLAB_MIN_ACCESS_LEVEL` | minimum access level that yields a workspace row (default `20`, Reporter) |
| `GITLAB_WORKSPACE_GROUP_MODE` | `top-level` (default) or `include-subgroups` |
| `HUB_PUBLIC_URL` | origin written into `config.json.apiUrl`; defaults to the request `Host` (honours `x-forwarded-proto/host`) |
| `LLM_GATEWAY_URL` | written as `linkUrl`; defaults to `HUB_PUBLIC_URL` |
| `TOKEN_ENC_KEY` | base64 of 32 random bytes (`openssl rand -base64 32`); AES-256-GCM key for stored GitLab tokens. Unset = process-lifetime key, every restart forces re-login |
| `CONTROL_KEY_TTL_DAYS` | sliding lifetime of `odc_`/`odr_` keys (default `30`); every authenticated request extends it |
| `BLOB_DIR` | root of the content-addressed blob store (takes precedence over `--blob-dir`; default `<dir of --sqlite>/blobs` with `--sqlite`, else `<OD_HUB_DATA_DIR>/blobs`, falling back to `.tmp/od-hub/blobs` relative to the working directory). Its `tmp/` subdirectory lives on the same filesystem so the final rename is atomic; back it up together with the SQLite file |
| `OD_HUB_DATA_DIR` | parent directory for hub-owned data when `BLOB_DIR` is not set |
| `OD_HUB_PORT` / `OD_HUB_HOST` | listen defaults (`18790`, `127.0.0.1`) |

Read by the shim (precedence mirrors `apps/daemon/src/integrations/vela.ts:751-795`):

| Variable | Meaning |
|---|---|
| `VELA_CONTROL_KEY` | bearer token; when set, wins over config.json |
| `VELA_API_URL` | hub origin; used when set via env key, or as fallback when config.json has no `apiUrl` |
| `VELA_WORKSPACE_ID` / `OPEN_DESIGN_WORKSPACE_ID` | ambient workspace header (`--workspace-id` overrides) |
| `VELA_INVOCATION_SOURCE` | header value, default `open-design` |
| `OPEN_DESIGN_AMR_PROFILE` / `VELA_PROFILE` | profile key inside `$AMR_HOME/config.json` (`selfhost` recommended) |
| `AMR_HOME` | directory holding `config.json` (default `~/.amr`) |
| `OD_VELA_OPEN_BROWSER` | `0` makes `od-vela login` skip the browser launch (headless hosts, smoke); it prints the same `could not open browser automatically: ...` stderr line, so the daemon shows the URL itself |

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
od-hub start [--port <n>] [--host <addr>] [--sqlite <path>] [--blob-dir <dir>]
             [--seed-dev [--control-key <odc_...>]] [--seed <file.json>]
```

| Flag | Meaning |
|---|---|
| `--port` / `OD_HUB_PORT` | listen port (default 18790) |
| `--host` / `OD_HUB_HOST` | bind address (default 127.0.0.1) |
| `--sqlite <path>` | persist to a better-sqlite3 file (created and migrated on open) instead of memory |
| `--blob-dir <dir>` | root of the content-addressed blob store. Defaults to `<dir of --sqlite>/blobs` when `--sqlite` is given (the SQLite file and its blobs back up together), else the `BLOB_DIR` env default. `BLOB_DIR`, when set, always wins over the flag |
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

`VELA_CONTROL_KEY` in the daemon environment is inherited by the shim. With
GitLab configured, drop the env key and let the daemon run `od-vela login`
instead (Settings -> sign in): the shim writes
`$AMR_HOME/config.json` `profiles.selfhost.{controlKey,runtimeKey,apiUrl,linkUrl,user}`.

### GitLab login locally

```bash
GITLAB_URL=https://gitlab.example.com \
GITLAB_OAUTH_CLIENT_ID=<application id> GITLAB_OAUTH_CLIENT_SECRET=<secret> \
TOKEN_ENC_KEY=$(openssl rand -base64 32) HUB_PUBLIC_URL=http://127.0.0.1:18790 \
  pnpm tools-od-hub start --port 18790 --sqlite .tmp/od-hub/hub.sqlite

VELA_API_URL=http://127.0.0.1:18790 VELA_PROFILE=selfhost AMR_HOME=~/.amr \
  node tools/od-hub/bin/od-vela.mjs login
```

The GitLab application needs the `read_user` and `read_api` scopes and the
Device Authorization Grant enabled (GitLab 17.2+). `od-vela logout` revokes
the key at the hub and removes it from the profile.

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
pnpm --filter @open-design/tools-od-hub smoke
```

`smoke` (`scripts/smoke-login.ts`) is the out-of-process login check, run the
way a deployment is wired rather than in-process like the tests: it starts the
fake GitLab (`tests/helpers/fake-gitlab-main.ts`) and `od-hub start --sqlite
<tmp>` as separate processes, runs `bin/od-vela.mjs login` with
`AMR_HOME=<tmp>` and `OD_VELA_OPEN_BROWSER=0` exactly as the daemon spawns it,
asserts stdout against the daemon's activation regexes, approves the code on
the fake (`POST /__fake/approve`), waits for the success line and exit 0, then
calls `GET /api/v1/workspaces` with the minted key and checks every item passes
the daemon's directory validation. It exits non-zero on the first mismatch and
needs a prior `build` (the shim runs from `dist/`).
