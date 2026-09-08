# Deploying od-hub with Docker

`od-hub` is the self-hosted, Vela-compatible collaboration hub for OpenDesign
and Design Loom (`tools/od-hub`). It authenticates users against **your
GitLab** (OAuth Device Flow), mirrors GitLab groups as team workspaces, and
stores shared project versions, comments, invites, and audit rows in **one
SQLite file plus one blob directory**. There is no Postgres, Redis, or object
store to run.

This directory ships:

| File | Purpose |
|---|---|
| `Dockerfile` | multi-stage build; runtime is `node:24-slim` + tini with `dist/`, `migrations/`, `templates/`, and the production `better-sqlite3` module only |
| `docker-compose.yml` | one `od-hub` service, one `od_hub_data` volume, health check on `/healthz`, read-only root fs |
| `.env.example` | every hub environment variable with a comment; copy to `.env` |

Client-side wiring (pointing an OpenDesign daemon or Design Loom at this hub)
is documented separately in
[`docs/deployment/self-hosted-hub.md`](../../docs/deployment/self-hosted-hub.md).

## 10-minute start

Prerequisites: Docker Engine 24+ with Compose v2, a GitLab 17.2+ instance you
administer, and a DNS name with TLS in front of the hub (`hub.example.com`
below).

```bash
git clone https://github.com/nexu-io/open-design.git
cd open-design/deploy/od-hub
cp .env.example .env
```

1. **Create the GitLab OAuth application** (next section) and paste
   `GITLAB_URL`, `GITLAB_OAUTH_CLIENT_ID`, `GITLAB_OAUTH_CLIENT_SECRET` into
   `.env`.
2. **Generate the token-encryption key** and paste it into `TOKEN_ENC_KEY`:

   ```bash
   openssl rand -base64 32
   ```

3. **Set the public origin(s)**: `HUB_PUBLIC_URL=https://hub.example.com`
   (and `HUB_CONSOLE_URL` if the browser-facing console is served from a
   different origin; otherwise leave it empty).
4. **Build and start**:

   ```bash
   docker compose build
   docker compose up -d
   docker compose ps          # od-hub ... (healthy)
   curl -s http://127.0.0.1:18790/healthz
   # {"ok":true,"service":"od-hub","listenerEpoch":"...","gitlab":true,"at":"..."}
   ```

   `"gitlab":true` confirms the OAuth variables were read. The first start
   creates `/data/hub.sqlite` and applies every migration.
5. **Put the reverse proxy in front** (section below) so
   `https://hub.example.com/healthz` answers, then hand `HUB_PUBLIC_URL` to
   your users per `docs/deployment/self-hosted-hub.md`.

The compose file publishes on `127.0.0.1:18790` only. Do not publish the hub
directly on a public interface: the OAuth cookie is marked `Secure` only when
`HUB_CONSOLE_URL` is `https`, and bearer keys travel in plain HTTP otherwise.

## GitLab OAuth application

In GitLab, as an instance admin (**Admin Area → Applications**) or a group
owner (**Group → Settings → Applications**):

| Field | Value |
|---|---|
| Name | `OpenDesign Hub` (anything) |
| Redirect URI | `https://hub.example.com/console/oauth/callback` — exactly `<HUB_CONSOLE_URL or HUB_PUBLIC_URL>/console/oauth/callback` |
| Confidential | recommended **yes** → copy the secret into `GITLAB_OAUTH_CLIENT_SECRET`. A public app works too; then leave the secret empty |
| Scopes | `read_user`, `read_api` |
| **Device Authorization Grant** | **enabled** (GitLab 17.2+). Without it `od amr login` / `od-vela login` fails at `POST /api/v1/auth/device` with 501 |

Two grants are used:

- **Device flow** — desktop/CLI login (`od amr login`). The hub proxies
  `authorize_device`, shows the user a `gitlab.example.com/oauth/device` URL
  and code, and polls for the token. No redirect URI is involved.
- **Authorization code + PKCE** — browser acceptance of workspace invites
  (`GET /console/invites/<token>/accept`). This is the flow that needs the
  redirect URI above; it must match byte for byte, including scheme and
  absence of a trailing slash.

### Group Access Token (`GITLAB_GROUP_TOKEN`, optional)

When an invited user accepts, the hub adds them to the GitLab group (access
level 40 for `admin`, 30 for `member`). That call needs a **Group Access
Token** created on the *top-level* group (**Group → Settings → Access
tokens**) with scope `api` and role **Owner** (adding members at level 40
requires Owner). Without the token the accepted membership lives only in the
hub's mirror and is removed again on that user's next GitLab-backed refresh;
the hub logs a warning on each such accept.

Rotate the token before its GitLab expiry; the hub reads it at start, so a
`docker compose up -d` after editing `.env` picks the new value up.

### Which GitLab members become workspace members

Every top-level group (or every group with `GITLAB_WORKSPACE_GROUP_MODE=include-subgroups`)
in which a user has at least `GITLAB_MIN_ACCESS_LEVEL` (default 20, Reporter)
appears as a team workspace. GitLab Owner (50) → hub `owner`, Maintainer (40)
→ `admin`, everything else at or above the minimum → `member`. Memberships are
re-read from GitLab at most every 60 s per user.

## Reverse proxy

The hub is plain HTTP on `18790` and needs TLS termination in front. Two
routes have special requirements:

- `GET /api/v1/collab/events` is a **long-lived SSE stream**. The daemon
  treats a stream without a heartbeat for ~45 s as dead; the hub sends one
  every 10 s and sets `x-accel-buffering: no` plus `cache-control: no-cache,
  no-transform` itself. The proxy must **not buffer** the response and must
  keep idle upstream connections open for **longer than 45 s** (use 3600 s).
- `PUT /api/v1/blobs/:sha256` streams project files; the hub accepts bodies up
  to **512 MiB**. Raise the proxy body limit accordingly.

The hub honours `x-forwarded-proto` and `x-forwarded-host` when
`HUB_PUBLIC_URL` is not set; setting it is still recommended.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name hub.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    client_max_body_size 512m;

    location / {
        proxy_pass         http://127.0.0.1:18790;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host  $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   Connection        "";
    }

    location /api/v1/collab/events {
        proxy_pass          http://127.0.0.1:18790;
        proxy_http_version  1.1;
        proxy_set_header    Host              $host;
        proxy_set_header    X-Forwarded-Proto $scheme;
        proxy_set_header    X-Forwarded-Host  $host;
        proxy_set_header    Connection        "";
        proxy_buffering     off;          # SSE: forward each frame immediately
        proxy_cache         off;
        proxy_read_timeout  3600s;        # idle timeout must exceed the 45 s daemon budget
        proxy_send_timeout  3600s;
        chunked_transfer_encoding on;
    }
}
```

### Caddy

```caddyfile
hub.example.com {
    request_body {
        max_size 512MB
    }
    reverse_proxy 127.0.0.1:18790 {
        flush_interval -1          # SSE: no buffering
        transport http {
            read_timeout 3600s
        }
    }
}
```

### Traefik

Traefik does not buffer responses by default. Set
`--entryPoints.websecure.transport.respondingTimeouts.readTimeout=3600s` (or
the equivalent `respondingTimeouts` block) so idle SSE connections are not cut,
and raise `buffering.maxRequestBodyBytes` only if you enabled the buffering
middleware.

## Operations

### Logs

```bash
docker compose logs -f od-hub
```

The hub logs one line per start (`od-hub listening on ... (store: sqlite
/data/hub.sqlite, blobs: /data/blobs, gitlab: https://gitlab.example.com)` —
or `gitlab: disabled` when the OAuth variables are missing), warnings for
mirror-only invite accepts and unset `SMTP_URL`, and — when `SMTP_URL` is unset
— every invite landing URL at info level so an operator can hand it over by
other means. Tokens, nonces, and raw emails are never logged.

### Backup

Everything lives in the `od_hub_data` volume (`/data` in the container):

- `hub.sqlite` (+ `-wal`/`-shm` while running) — users, encrypted GitLab
  grants, key hashes, workspaces, resource manifests, comments, invites,
  audit.
- `blobs/<aa>/<sha256>` — content-addressed project files referenced by the
  manifests. Blobs are immutable and never deleted by the hub.

Take a consistent SQLite snapshot with the online backup API, then copy the
blob tree. Blobs are write-once, so copying them *after* the SQLite snapshot
cannot miss a file the snapshot references:

```bash
# 1. consistent SQLite copy (safe while the hub is running; WAL-aware)
docker compose exec od-hub node -e '
  const D=require("/app/tools/od-hub/node_modules/better-sqlite3");
  new D("/data/hub.sqlite",{readonly:true}).backup("/tmp/hub-backup.sqlite").then(()=>console.log("ok"))'
docker compose cp od-hub:/tmp/hub-backup.sqlite ./backup/hub-$(date +%F).sqlite

# 2. blob tree (rsync-friendly: files never change once written)
docker run --rm -v od-hub_od_hub_data:/data:ro -v "$PWD/backup":/backup alpine \
  tar czf /backup/blobs-$(date +%F).tgz -C /data blobs
```

`/tmp` is a tmpfs in the compose file, so the intermediate copy disappears
with the container. If you prefer host-side tooling, `sqlite3 /path/hub.sqlite
".backup /path/out.sqlite"` on a bind-mounted volume is equivalent.

Restore: stop the service, replace `/data/hub.sqlite` (delete stale `-wal` and
`-shm` files), untar `blobs/` next to it, start. Because `TOKEN_ENC_KEY` is
bound to the stored GitLab grants, a restore onto a host with a different key
forces every user to log in again but loses no data.

### Upgrade

```bash
cd open-design && git pull
cd deploy/od-hub
docker compose build
docker compose up -d           # recreates the container; the volume is kept
docker compose logs --tail 20 od-hub
```

Schema migrations (`tools/od-hub/migrations/NNNN_*.sql`) are applied
automatically on start, in order, and recorded in `schema_migrations`; a
migration runs exactly once. There is no downgrade path — take the backup
above before upgrading. Presence rosters are process memory and empty after a
restart; clients rebuild them with their next heartbeat within 10 s.
Connected SSE streams reconnect on their own.

Because the image is built from the checked-out tree, `docker compose build`
after `git pull` is the whole upgrade; there is no separately versioned
image tag unless you push one yourself (`OD_HUB_IMAGE`).

### Rotating `TOKEN_ENC_KEY`

The key is used as AES-256-GCM key (and its id as AAD) for stored GitLab
tokens. Changing it makes every stored grant undecryptable: on the next request
that needs a GitLab refresh, the hub revokes that user's keys and they log in
again. Nothing else is affected. Rotate by editing `.env` and
`docker compose up -d`; announce the forced re-login.

### Trial without GitLab

To try the hub before wiring GitLab, start it with a seeded development
identity (user `u1`, personal workspace `u1`, team workspace `g1`) and a fixed
control key. **Never do this on a hub that faces real users** — the key is a
full bearer credential.

```bash
docker compose run --rm --service-ports od-hub \
  start --sqlite /data/hub.sqlite --seed-dev --control-key odc_trial_local_key_1

curl -H 'authorization: Bearer odc_trial_local_key_1' http://127.0.0.1:18790/api/v1/me
```

`--seed-dev` is idempotent on a `--sqlite` store, and a hub started without it
(the compose default) rejects every bearer until a GitLab login has minted one.

### Health and readiness

`GET /healthz` returns `200 {"ok":true,...,"gitlab":<bool>}` as soon as the
listener is up; `gitlab` is `true` when `GITLAB_URL` and
`GITLAB_OAUTH_CLIENT_ID` are both set. It does not call GitLab. Use it for the
container health check (already wired) and for the reverse proxy's upstream
probe.

A GitLab outage does **not** log users out: requests that need a token refresh
answer `503 {"error":"gitlab_unavailable"}` until GitLab returns, and cached
directory listings keep serving for 60 s.

### Resource limits

Defaults: `OD_HUB_MEM_LIMIT=512m`, `NODE_OPTIONS=--max-old-space-size=256`.
Blob uploads stream to disk and are never buffered in memory, so memory
scales with concurrent SSE streams and directory caches, not with project
size. Disk grows with every published version (deduplicated by content hash).

## Files this image contains

The runtime image is intentionally minimal. After `docker compose exec od-hub
ls /app/tools/od-hub` you should see exactly `dist`, `migrations`,
`node_modules` (only `better-sqlite3` and its runtime dependency chain),
`package.json`, and `templates`. There is no pnpm, no TypeScript, no source
tree, and no test code. The process runs as uid 1001 (`od-hub`) on a read-only
root filesystem; `/data` is the only writable mount.
