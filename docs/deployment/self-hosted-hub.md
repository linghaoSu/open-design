# Connecting OpenDesign to a self-hosted hub (od-hub)

This guide is for the **client side**: pointing an OpenDesign daemon (dev
checkout or packaged Design Loom) at an `od-hub` instance you run instead of
the public `amr-api.open-design.ai`. Running the hub itself is covered in
[`deploy/od-hub/README.md`](../../deploy/od-hub/README.md); the protocol and
every hub flag live in [`tools/od-hub/README.md`](../../tools/od-hub/README.md).

Once connected, the team-workspace surfaces — workspace directory, member
list, shared team projects, comments, presence, invites, public snapshots —
run against your GitLab-backed hub. Model inference is **not** provided by
od-hub (see "Known limitations").

## How the pieces fit

```
OpenDesign daemon ──spawns──▶ od-vela (VELA_BIN shim) ──HTTP──▶ od-hub ──▶ GitLab
        │                                                       │
        └── /api/integrations/vela/api-proxy ───────────────────┘  (OD_AMR_API_UPSTREAM_ORIGIN)
```

The daemon never speaks the hub protocol directly. It spawns the `od-vela`
binary for every collaboration command and reads the profile it writes to
`$AMR_HOME/config.json`; the only direct HTTP path is the daemon's API proxy,
which must be pointed at the same hub so it never leaves your network.

Two variables select the hub, one selects the transport:

| Variable | Value | Why |
|---|---|---|
| `VELA_BIN` | absolute path to `tools/od-hub/bin/od-vela.mjs` (or `dist/od-vela.mjs` / a wrapper) | the daemon spawns this instead of the public `vela` CLI |
| `VELA_API_URL` | hub origin, e.g. `https://hub.example.com` | where the shim logs in; written into the profile as `apiUrl` |
| `OPEN_DESIGN_AMR_PROFILE` | `selfhost` | profile slot in `config.json`; `selfhost` is in the packaged workspace-team allowlist (`apps/packaged/src/workspace-team.ts`) |
| `OD_WORKSPACE_CONTEXT_SOURCE` | `vela` | switches the daemon's workspace context to the Vela-backed transport |
| `OD_VELA_WEB_URLS` | `{"selfhost":"https://hub.example.com/console"}` | console origin for the profile (invite links, "open console" actions) |
| `OD_AMR_API_UPSTREAM_ORIGIN` | `https://hub.example.com` | target of the daemon's `/api/integrations/vela/api-proxy` fallback |
| `OPEN_DESIGN_VELA_TELEMETRY` | `0` | optional; the hub accepts and discards telemetry anyway |

## Development checkout (`tools-dev`)

`tools-dev` loads `.env.development.local` from the repository root
(`tools/dev/src/local-env.ts`, `loadWorkspaceLocalEnv`; it also reads
`.env.local`, `.env.development`, and `.env` in that order, earlier files
winning, and `--no-env-file` / `--env-file <name>` override the list). Put
the daemon-side variables there rather than exporting them by hand:

```dotenv
# .env.development.local
OD_WORKSPACE_CONTEXT_SOURCE=vela
OPEN_DESIGN_AMR_PROFILE=selfhost
VELA_BIN=/abs/path/to/open-design/tools/od-hub/bin/od-vela.mjs
VELA_API_URL=https://hub.example.com
OD_AMR_API_UPSTREAM_ORIGIN=https://hub.example.com
OD_VELA_WEB_URLS={"selfhost":"https://hub.example.com/console"}
OPEN_DESIGN_VELA_TELEMETRY=0
```

Build the shim once (the `bin/` wrapper refuses a stale `dist/`), then start
the web runtime:

```bash
pnpm --filter @open-design/tools-od-hub build
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
```

Also turn product telemetry off in the daemon's app config so nothing is
reported to the public service: Settings → Privacy, or set
`telemetry.metrics` to `false` in `app-config.json` under the daemon data
root (`OD_DATA_DIR`; see root `AGENTS.md`, "Daemon data directory contract").

For a hub without GitLab (trial, `--seed-dev`), add
`VELA_CONTROL_KEY=<the seeded odc_ key>` to the same file; the shim inherits
it and skips login entirely. Remove it as soon as GitLab is configured.

## Packaged app (Design Loom)

A packaged build ships with its own AMR profile baked in. Two facts constrain
how a self-hosted hub can be wired:

1. **The daemon merges Settings-backed agent env for `amr`** from app-config
   `agentCliEnv.amr`. The allowed keys are enumerated in
   `apps/daemon/src/app-config.ts` (`AGENT_CLI_ENV_KEYS`, the `'amr'` entry
   around lines 203–212): `VELA_BIN`, `VELA_API_URL`, `VELA_LINK_URL`,
   `VELA_RUNTIME_KEY`, `VELA_OPENCODE_BIN`, `OPEN_DESIGN_AMR_PROFILE`,
   `OPENCODE_TEST_HOME`. Anything else in that object is dropped. These
   values override the inherited shell environment for login and every
   `od-vela` invocation (`apps/daemon/src/integrations/vela-command.ts`,
   `configuredAmrEnv`).
2. **The packaged launcher does not forward arbitrary host env to the
   daemon.** `apps/packaged/src/sidecars.ts` builds the daemon environment
   from an explicit allowlist (`PACKAGED_CHILD_ENV_ALLOWLIST`, lines 44–63:
   proxies, locale, `HOME`, `CODEX_HOME`, `VP_HOME`, ...) plus values it
   computes itself. `OD_WORKSPACE_CONTEXT_SOURCE`, `OD_VELA_WEB_URLS`, and the
   transport switches come from the packaged config (`amrProfile`,
   `velaWebUrl`, `velaWebUrls` in `apps/packaged/src/config.ts`) via
   `workspaceTeamTransportEnv`, **not** from your shell. Exporting
   `OD_WORKSPACE_CONTEXT_SOURCE=vela` before launching the app has no effect.

Consequently, with a stock packaged build you can redirect *where the shim
logs in* through Settings, but the workspace-team transport is only enabled
when the build's packaged config carries `amrProfile: "selfhost"` together
with a `velaWebUrl`/`velaWebUrls.selfhost` pointing at your hub's `/console`.
Teams that want a fully self-hosted packaged client should produce a build
with that packaged config (see `tools/pack/AGENTS.md`), or run the daemon from
a development checkout as above.

The one packaged entry that does read these values from the host environment
is the Linux headless runtime (`apps/packaged/src/headless.ts`,
`resolveHeadlessConfig`): it has no packaged config file, so it builds
`amrProfile` from `OPEN_DESIGN_AMR_PROFILE` and `velaWebUrl` / `velaWebUrls`
from `OD_VELA_WEB_URL` / `OD_VELA_WEB_URLS`. Exporting
`OPEN_DESIGN_AMR_PROFILE=selfhost` and
`OD_VELA_WEB_URLS={"selfhost":"https://hub.example.com/console"}` before
starting a headless install therefore does enable the transport there, while
the Electron shell keeps ignoring them.

What you *can* set is `agentCliEnv.amr` in the daemon's app config. The
Settings dialog exposes CLI-environment fields for Claude and Codex only, so
for AMR write it through the daemon API (`GET`/`PUT /api/app-config`) or edit
`app-config.json` under the daemon data root (`OD_DATA_DIR`) while the daemon
is stopped:

```json
{
  "agentCliEnv": {
    "amr": {
      "VELA_BIN": "/abs/path/to/tools/od-hub/dist/od-vela.mjs",
      "VELA_API_URL": "https://hub.example.com",
      "OPEN_DESIGN_AMR_PROFILE": "selfhost"
    }
  }
}
```

`OD_AMR_API_UPSTREAM_ORIGIN` is not on the allowlist; the daemon derives the
proxy upstream from the profile's `apiUrl` when the env var is absent
(`apps/daemon/src/integrations/vela-selfhost.ts`,
`resolveAmrApiUpstreamOrigin`), so a successful `selfhost` login is enough to
keep the proxy on your hub.

## Login flow

```bash
od amr login            # or Settings → sign in
```

1. The daemon spawns `od-vela login` with the resolved env. The shim calls
   `POST /api/v1/auth/device` on the hub, which proxies GitLab's Device
   Authorization Grant.
2. The daemon shows the returned URL (`https://gitlab.example.com/oauth/device`)
   and user code; `od amr login` prints them as `Open` / `Code` lines and
   tries to open the browser.
3. You approve in GitLab. The shim polls `POST /api/v1/auth/device/token`
   honouring `interval`/`slow_down`; on success the hub mints `odc_`/`odr_`
   keys and the shim atomically writes
   `$AMR_HOME/config.json` → `profiles.selfhost.{controlKey,runtimeKey,apiUrl,linkUrl,user}`.
4. The daemon watches for `runtimeKey` in that file and flips to logged in.

Keys have a sliding lifetime (`CONTROL_KEY_TTL_DAYS`, hub-side, default 30
days). `od amr logout` revokes the presented key at the hub and strips it from
the profile.

## Verification

```bash
# Who am I, which profile, which console
od amr status
od amr status --json | jq '{loggedIn, profile, consoleOrigin, user}'

# The daemon's view of your workspaces (personal u<gitlabId> + one g<groupId>
# per GitLab group at or above GITLAB_MIN_ACCESS_LEVEL)
curl -s http://127.0.0.1:17456/api/workspace/directory | jq

# Straight to the hub with the minted key
curl -s -H "authorization: Bearer $(jq -r .profiles.selfhost.controlKey ~/.amr/config.json)" \
  https://hub.example.com/api/v1/me
```

Expected: `od amr status` shows `Profile selfhost`, the directory response
lists your GitLab groups as team workspaces, and the hub answers `/api/v1/me`
with your GitLab identity and `plan: "team"`. If the directory is empty,
check `GITLAB_MIN_ACCESS_LEVEL` and `GITLAB_WORKSPACE_GROUP_MODE` on the hub.

## Known limitations

- **No model hosting.** od-hub answers `model list` and `run terminal` only as
  far as the daemon's compatibility contract needs; `image *` / `video *`
  return a non-retryable `not_supported`. The profile's `linkUrl` defaults to
  the hub itself; set `LLM_GATEWAY_URL` on the hub to a Vela-compatible
  gateway if you operate one, otherwise use BYOK/local agents for
  generation.
- **Single writer store.** The hub opens `hub.sqlite` with better-sqlite3 in
  WAL mode and expects to be the only process writing it. Keep the `/data`
  volume (SQLite file, WAL, and `blobs/`) on a local filesystem: do not place
  it on NFS/SMB or another network filesystem, and never point two hub
  processes (replicas, a staging copy, a migration dry run) at the same
  directory. SQLite's locking is not reliable across network mounts, and a
  second writer can corrupt the database or the blob index.
- **Presence is per hub process.** Rosters live in memory; a hub restart
  clears them and clients rebuild them with their next 10 s heartbeat. Running
  several hub replicas behind one proxy would split presence.
- **One owner identity per hub user, keyed to GitLab.** `workspaceMemberId` is
  derived from `(gitlabUserId, workspaceId)`, so the same person on several
  devices shares one member identity; there is no per-device member row, and
  a device that logs in overwrites nothing but its own `config.json`.
- **Invite acceptance without `GITLAB_GROUP_TOKEN` is mirror-only** and is
  undone by the next GitLab-backed refresh of that user.
- **Packaged clients** cannot enable the workspace-team transport from the
  shell (see above); a `selfhost`-profiled build or a dev checkout is
  required.
- Closed on purpose (typed 501 from the shim): `billing checkout`,
  `collab invite *` via CLI (invites go through the hub's HTTP API and
  console pages instead), `agent run`.
