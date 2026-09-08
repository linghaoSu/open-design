# 设计稿：按用户模型凭证 + 多用户中央 daemon + 本地登录同步（F10–F13）

> 状态：**仅设计，未实现**（用户决定：功能复杂，先只做设计）。基线 `feat/selfhosted-hub` @ c39527c30。
> 产出方式：3 名代码阅读代理分别追踪 daemon 凭据注入链路、请求身份链路、hub 侧密钥存储落点（全部带 file:line）→ 3 名评审按安全 / 工程可行性 / 用户体验给出约束 → 综合稿 → 1 名审查代理逐条 grep 核对综合稿引用的 file:line，并列出与代码不符的假设与遗漏（见文末"可行性审查结论"，**实现前必须先按该节修正**）。
> 需求原文（2026-09-08）：GitLab 登录用户在 hub 配置自己的 API key；以该用户身份运行时使用其 key；期望一个中央 daemon+web 供全员用浏览器使用；也支持本地部署登录后同步。

# 最终推荐方案：Hub 托管的按用户模型凭证 + daemon 多用户 principal 层

> 基线：`/Users/linghao/workspace/dce5/GitHub/open-design/.claude/worktrees/github-pr-6476-merge-progress-0d1f8a`（feat/selfhosted-hub @ a0150f18f）。所有 file:line 已对该 worktree 抽样核对（`server.ts:11471-11479`、`:2980`、`http.ts:497`、`app-config.ts:233`、`routes/media.ts:584/598`）。hub 迁移目录实际为 `tools/od-hub/migrations/`（0001–0006 已存在）。
> 评审说明：三位 judge 中两位指出候选设计稿正文缺失，其评分基于 Ground A/B/C 隐含形态。本方案因此直接以 Ground A/B/C 为一等输入、judge graft 为约束条件综合而成。

---

## 0) 一页结论

**路线：hub-brokered 密钥 + daemon 内建 principal 层（"B 的身份、C 的密钥库、A 的注入 seam"）。**

- **身份**：daemon 引入 `OD_MULTI_USER=1` 开关。开启时 `/api` 中间件无条件安装、关闭 loopback 免检、拒绝把任何 `X-Forwarded-*` 当身份；principal 只来自 (1) daemon 签发的 HttpOnly session cookie（背后是 hub 的 GitLab 授权码+PKCE 登录）或 (2) `Authorization: Bearer odc_…`。自报的 `x-od-workspace-*` 头降级为"选择器"，由 principal 的 hub 目录校验；无头请求由服务端派生默认头注入 `req.headers`，使 112 个鉴权调用点和 ~200 个 web 调用点零改动。
- **密钥**：用户在 hub 存 `user_secrets`（AES-256-GCM 信封，复用 `TokenCipher`）与 `user_settings`（非密：base URL、默认模型、BYOK profile 元数据）。daemon **永不把用户 key 写入 `app-config.json`/磁盘**；每个 run 启动时用该用户的 `odr_` runtimeKey 调 `POST /api/v1/me/secrets/reveal`，结果只进子进程 env。
- **注入点**：唯一 seam = `server.ts:11471-11479`，替换为 `runCredentials.resolve(run.actor, def.id)`。下游 launch/mmd/codex 归一/能力探测/spawn 全部消费局部变量，`runtimes/env.ts` 不动。
- **两种部署共享**：中央模式与本地模式使用**同一个** `RunCredentialSource` hub 实现和同一份 hub 数据；区别仅在 principal 来源（中央=cookie/Bearer；本地=`~/.amr/config.json` 里本机登录的 controlKey 作为隐式 principal）。本地模式**不**把 key 拉进 app-config（否定 minimal-first 做法）。
- **中央模式的硬伤与对策**：所有用户子进程共享同一 OS uid，用户 A 的 agent 可读 `/proc/<pid>/environ` 拿到 B 的 key。第一阶段接受并文档化此风险（内网可信团队），第二阶段提供"网关模式"（子进程只拿 `odr_` + hub linkUrl，真实 provider key 留 hub 网关）作为中央模式推荐默认。
- **先做**：`GET /api/app-config` 脱敏（F10a）→ principal 层（F10b/c）→ hub 密钥库（F11a/b）→ per-run 注入（F11c）→ web 设置页与 CLI（F12）→ 媒体通路/routines/网关（F13+）。

---

## 1) 目标 / 非目标

**目标**
- (a) GitLab 用户在 hub 中管理自己的模型 API key / base URL / 默认模型 / BYOK profile。
- (b) run "以用户 X 身份"执行时，子进程 env 中的凭证类 key 只来自 X。
- (c) 单个中央 daemon+web 服务多浏览器用户，互相不可伪装、不可读他人 personal 项目、不可读他人 key。
- (d) 本地 daemon 登录 hub 后使用同一份 per-user 配置；两种模式不分叉。
- 审计：hub 端有"谁在何时用了哪把 key（tail）"唯一账本。

**非目标（本轮）**
- 不做 per-user OS 账号/容器沙箱（网关模式作为替代，F13c）。
- 不改 `desktop-auth.ts` / `import-export-routes.ts`（与用户身份正交）。
- 不重写 `project-request-authority.ts`、`workspace-resource-mutation.ts` 内部规则。
- 不为 `projects/conversations/messages` 加 owner 列（`workspace_projects.created_by_workspace_member_id` 已足够）；只给 `routines` 加 owner。
- 不向上游开 PR。

---

## 2) 架构

```
浏览器 ──cookie──▶ daemon(/api/*) ──Bearer odc_(X)──▶ hub(/api/v1/me, /workspaces)   [身份+目录]
CLI/agent ─Bearer odc_(X)─▶ daemon                                     
                              │ run 启动
                              └─ RunCredentialSource(hub) ──Bearer odr_(X)──▶ hub POST /me/secrets/reveal
                                   → configuredAgentEnv(X) → spawnEnvForAgent → 子进程 env
本地 daemon: principal = ~/.amr/config.json profile（隐式），其余路径完全相同
```

三层分别对应：
1. **Principal 层**（新）：`apps/daemon/src/auth/principal.ts` + `auth/session-store.ts`（SQLite 表 `daemon_sessions` 落 `RUNTIME_DATA_DIR`），中间件写 `req.principal`。
2. **目录/选择器层**（改）：`server.ts:3483-3518` 的 `configuredAmrEnv()` 改为 `(principal) => ({VELA_CONTROL_KEY, VELA_API_URL})`；`verifyExplicitWorkspaceRequestContext`（`:3524`）用 `req.principal` 绑定；无头请求注入默认 workspace 头。
3. **凭证层**（新）：`apps/daemon/src/services/run-credentials.ts` 的 `RunCredentialSource`；hub 实现 + 本地默认实现；`run.actor` 记入 run 对象并被重试/续跑/repair 继承。

hub 侧新增 `user_secrets`/`user_settings` 表、`/api/v1/me/settings|secrets/*` 端点、浏览器 code-flow 签发 `odc_/odr_`、`od-vela settings|secret` 子命令。

---

## 3) hub：schema、端点、CLI（精确到字段）

### 3.1 Migration `tools/od-hub/migrations/0007_user_settings_secrets.sql`

```sql
CREATE TABLE user_secrets (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,               -- 必须 ∈ 白名单（见下），例 ANTHROPIC_API_KEY
  value_enc   BLOB NOT NULL,               -- TokenCipher 信封 iv|tag|ct
  key_id      TEXT NOT NULL,               -- cipher.keyId（AAD 绑定）
  tail        TEXT NOT NULL,               -- 明文末 4 位
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);
CREATE TABLE user_settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,             -- UserSettingsDoc（非密）
  revision      INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL
);
CREATE TABLE browser_sessions (            -- 供 /console/oauth/callback 签发 api_key 后的一次性交付
  code        TEXT PRIMARY KEY,            -- 随机 32B url-safe，5 分钟过期，单次消费
  user_id     TEXT NOT NULL,
  control_key_id TEXT NOT NULL,
  runtime_key_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);
```

**secret name 白名单**（hub 端常量 `SECRET_NAMES`，与 daemon `AGENT_CLI_AUTH_ENV_KEYS` app-config.ts:233-244 一致，daemon 侧导出后由 e2e parity 测试对齐）：
`ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENAI_API_KEY, CODEX_API_KEY, VELA_RUNTIME_KEY`，以及 BYOK：`BYOK_API_KEY:<profileId>`（profileId `[a-z0-9-]{1,32}`），媒体（F13a 启用）：`MEDIA_API_KEY:<providerId>`。

**`UserSettingsDoc`（settings_json）**
```ts
{
  schemaVersion: 1,
  agentEnv: {                       // 仅非密 key；白名单 = AGENT_CLI_ENV_KEYS 减去 AUTH 集合，且排除 *_BIN/CLAUDE_CONFIG_DIR/CODEX_HOME
    claude?: { ANTHROPIC_BASE_URL?: string; MMD_MODEL_ROUTES_FILE?: never },
    codex?:  { OPENAI_BASE_URL?: string },
    amr?:    { VELA_API_URL?: string; VELA_LINK_URL?: string; OPEN_DESIGN_AMR_PROFILE?: string }
  },
  agentModels: Record<agentId, string>,   // 与 daemon AgentModelPrefs 同形
  defaultAgentId?: string,
  byokProfiles: Array<{ id: string; label: string; protocol: 'anthropic'|'openai'|'openai-responses'; baseUrl: string; model: string; apiVersion?: string; requiresApiKey: boolean }>,
  defaultByokProfileId?: string,
  mediaProviders?: Record<providerId, { baseUrl?: string; model?: string }>   // F13a
}
```

### 3.2 HubStore 新方法（`store.ts` 接口；`memory-store.ts` 与 `sqlite-store.ts` 双实现，`tests/store.test.ts` parity）
- `putUserSecret(userId, name, valueEnc, keyId, tail, now)`
- `listUserSecrets(userId) → {name, tail, updatedAt}[]`
- `getUserSecretsDecryptable(userId, names[]) → {name, valueEnc, keyId}[]`
- `deleteUserSecret(userId, name) → boolean`
- `getUserSettings(userId) → {doc, revision, updatedAt} | null`
- `putUserSettings(userId, doc, expectedRevision|null, now) → {revision} | 'conflict'`
- `createBrowserSession(...)` / `consumeBrowserSession(code, now)`

### 3.3 TokenCipher 扩展（`token-cipher.ts`）
- `createTokenCipher({ current: key, previous: key[] })`；`decrypt(blob, keyId)` 查 `Map<keyId,key>`。env：`TOKEN_ENC_KEY`（current）、`TOKEN_ENC_KEYS_PREVIOUS`（逗号分隔）。
- `config.ts`：`HUB_REQUIRE_TOKEN_ENC_KEY=1`（生产默认）时缺 `TOKEN_ENC_KEY` 启动失败；否则打印 WARN "user secrets will be lost on restart"。
- 解密失败 → `secret_unavailable`，**不**吊销会话。

### 3.4 端点（`http.ts` 用 `route(method, path, authRequired, handler)`）

| 方法/路径 | 鉴权 | 请求 | 响应 | 审计 |
|---|---|---|---|---|
| `GET /api/v1/me/settings` | Bearer（odc_ 或 odr_），**只查 api_key，不经 gitlabAccessOr401** | — | `{settings: UserSettingsDoc, revision, secrets: [{name, tail, updatedAt}]}` | — |
| `PUT /api/v1/me/settings` | odc_ only | `{settings, revision}` | 200 `{revision}`；409 `resource_version_conflict` | `settings_put{revision}` |
| `PUT /api/v1/me/secrets/:name` | odc_ only | `{value: string}`（1–4096 字符，name ∈ 白名单否则 400 `invalid_secret_name`） | 200 `{name, tail, updatedAt}` | `secret_set{name,tail}` |
| `DELETE /api/v1/me/secrets/:name` | odc_ only | — | 204 | `secret_delete{name}` |
| `POST /api/v1/me/secrets/reveal` | **odr_ only**（`api_keys.kind='runtime'`，否则 403 `runtime_key_required`）；不经 GitLab | `{names: string[], purpose: {kind:'run'|'sync', runId?, daemonInstanceId, agentId?}}` | `{values: Record<name,string>, unavailable: string[]}` | `secret_read{names, tails, daemonInstanceId, runId, ua}` |
| `GET /api/v1/me/keys` | odc_ | — | `[{id, kind, deviceLabel, createdAt, lastSeenAt}]` | — |
| `DELETE /api/v1/me/keys/:id` | odc_ | — | 204 | `key_revoked{id,kind}` |
| `GET /console/oauth/authorize?redirect_uri=&state=&code_challenge=` | 无 | — | 302 GitLab（复用现有 PKCE 实现） | — |
| `GET /console/oauth/callback`（扩展） | 无 | — | upsert 用户 → 签发 odc_+odr_ → 写 `browser_sessions` → 302 `redirect_uri?code=&state=` | `session_issued{controlKeyId,runtimeKeyId,deviceLabel:'browser:<daemonInstanceId>'}` |
| `POST /api/v1/auth/browser/exchange` | 无（daemon 服务端调用） | `{code, code_verifier}` | `{controlKey, runtimeKey, user:{id,gitlabId,username,name,avatarUrl}}`；单次消费 | — |

`redirect_uri` 必须在 hub 配置 `HUB_ALLOWED_DAEMON_REDIRECTS`（逗号分隔 origin 列表）内。

### 3.5 `od-vela` 子命令（`tools/od-hub/src/cli/`，新文件 `settings.ts`、`secret.ts`，注册于 `shim.ts:183-211`）
- `od-vela settings get [--json]`
- `od-vela settings set --json-file <path|->`（读→合并→PUT，带 revision CAS，冲突退出码 3）
- `od-vela secret list [--json]`
- `od-vela secret set <NAME> --value-file <path|->`（**禁止** `--value` 明文 argv）
- `od-vela secret rm <NAME>`
- `od-vela keys list [--json]` / `od-vela keys revoke <id>`

daemon 侧 `od` CLI（AGENTS.md 双轨）：`od settings get|set`、`od secret list|set|rm`、`od auth login|logout|whoami`，走 daemon `/api/user/*`（§4），支持 `--json`、`--prompt-file`/`--value-file -`。

---

## 4) daemon 改动清单

标记：**[必须]** / [建议]。行号为 a0150f18f。

### 4.1 Principal 层（新）
- **[必须]** 新文件 `apps/daemon/src/auth/principal.ts`：
  ```ts
  type Principal = { kind:'user'; hubUserId; username; controlKey; runtimeKey; sessionId?: string }
               | { kind:'service' }          // 旧 OD_API_TOKEN
               | { kind:'local-implicit' }   // 本地模式：~/.amr profile
  ```
  `resolvePrincipal(req, deps)`：顺序 Bearer `odc_` → hub `GET /api/v1/me`（缓存 60 s，key=sha256(token)）；cookie `od_session` → `daemon_sessions` 表；`OD_API_TOKEN` → `service`。
- **[必须]** 新文件 `apps/daemon/src/auth/session-store.ts`：SQLite 表 `daemon_sessions(id PK, hub_user_id, control_key_enc, runtime_key_enc, key_id, user_json, created_at, last_seen_at, expires_at, revoked_at)`，信封复刻 hub `TokenCipher`（密钥 `OD_SESSION_ENC_KEY`，缺失时 ephemeral + WARN）。数据库使用 `openDatabase(RUNTIME_DATA_DIR)` 显式传根（遵守数据根契约）。
- **[必须]** `server.ts:2911-2923`：新增 `multiUser = process.env.OD_MULTI_USER==='1'`；`multiUser && !OD_SESSION_ENC_KEY` 时 WARN；`multiUser` 且 `process.env` 含任一 `AGENT_CLI_AUTH_ENV_KEYS` → **启动失败**（"central daemon must have zero provider keys"；可用 `OD_MULTI_USER_ALLOW_PROCESS_KEYS=1` 逃生）。
- **[必须]** `server.ts:2963-3002` `/api` 中间件：条件由 `apiTokenAuthEnabled` 改为 `apiTokenAuthEnabled || multiUser`；`multiUser` 时删除 `:2980` loopback 直通，新增 `resolvePrincipal` → `req.principal`；无 principal → 401 `PRINCIPAL_REQUIRED`（JSON）。health/ready/version/preview-asset 放行不变；tool token export 分支不变。
- **[必须]** `server.ts:3007-3016` SPA challenge：`multiUser` 时无 cookie → 302 `/api/auth/login?next=<path>`，删 Basic challenge。
- **[必须]** 新路由文件 `apps/daemon/src/routes/auth.ts`：
  - `GET /api/auth/login` → 生成 PKCE + state（cookie `od_oauth_state`，HttpOnly，10 min）→ 302 hub `/console/oauth/authorize`。
  - `GET /api/auth/callback?code&state` → `POST hub /api/v1/auth/browser/exchange` → 写 `daemon_sessions` → Set-Cookie `od_session`（HttpOnly; SameSite=Lax; Secure when https; Path=/; 30 d 滑动）→ 302 `next`。
  - `POST /api/auth/logout` → revoke 本地 session + hub `POST /api/v1/auth/revoke`。
  - `GET /api/auth/me` → `{principal: {hubUserId, username, name, avatarUrl}, mode:'multi-user'|'local'}`。
  - 契约类型加到 `packages/contracts/src/api/auth.ts`。
- [建议] `server.ts:1392` 附近：`multiUser` 时 `app.set('trust proxy', OD_TRUST_PROXY)` 仅用于 `Secure` cookie 判断与日志，**永不**用于身份。

### 4.2 目录/选择器层
- **[必须]** `server.ts:3483-3518`：`configuredAmrEnv()` 改为 `configuredAmrEnvFor(principal)`：`kind==='user'` → `{...appConfig.agentCliEnv.amr(去掉 VELA_RUNTIME_KEY), VELA_CONTROL_KEY: principal.controlKey, VELA_RUNTIME_KEY: principal.runtimeKey, VELA_API_URL: hubUrl}`；其他 kind 保持现状。`fetchWorkspaceDirectory(principal)`；`identityKey` 已按 controlKey 分区。
- **[必须]** `server.ts:3524-3580` `verifyExplicitWorkspaceRequestContext(req)`：用 `req.principal` 构造 `fetchWorkspaceDirectory` 闭包传入 `verifyWorkspaceRequestContext`（`collab/request-workspace-context.ts:31`）。`multiUser` 时 `OD_WORKSPACE_CONTEXT_SOURCE` 强制视为 `'vela'`（不再信任自报）。
- **[必须]** 新中间件 `injectDefaultWorkspaceHeaders`（`collab/default-workspace-headers.ts`，挂在 principal 之后）：当 `req.principal.kind==='user'` 且请求无 `x-od-workspace-id`/`x-od-workspace-member-id` 时，从该用户目录取 personal workspace 行（`u<gitlabId>`），把 8 个 `x-od-workspace-*` 头写入 `req.headers`（role/permission 以目录为准）；同时 `x-od-app-user-id = hubUserId`。有头时：校验 `(workspaceId, memberId)` ∈ 目录，否则 403 `WORKSPACE_ACCESS_DENIED`。**效果**：`workspace-resource-mutation.ts:393-424`、`created-project-workspace.ts:53-58`、`project-request-authority.ts:42-179` 零改动。
- **[必须]** `routes/collab-context.ts:1056-1072` `PUT /api/workspace/context` 与 `workspace-resource-mutation.ts:930-960` `headerlessMutationAllowed` ambient 回落：`multiUser` 时前者 403 `NOT_AVAILABLE_IN_MULTI_USER`，后者不触发（因为默认头已注入）。
- **[必须]** `routes/project/index.ts:3199` `GET /api/projects`：`multiUser` 时返回空数组（unbound legacy 项目不对多用户可见）。
- [建议] SSE `routes/collab-context.ts:483` / `routes/project/index.ts:5314`：无需改；query 的 memberId 经 `requestWithWorkspaceNavigationScope` 提升为头后被上一条校验。

### 4.3 凭证层（需求 b 核心）
- **[必须]** `apps/daemon/src/app-config.ts:233`：`export` `AGENT_CLI_AUTH_ENV_KEYS`，并新增 `export const CREDENTIAL_ENV_NAMES: ReadonlySet<string>`（扁平集合）。
- **[必须]** 新文件 `apps/daemon/src/services/run-credentials.ts`：
  ```ts
  export type RunActor = { hubUserId: string; runtimeKey: string; hubUrl: string } | null;
  export interface RunCredentialSource {
    resolve(actor: RunActor, agentId: string, ctx:{runId:string}): Promise<{
      agentCliEnv: Record<string,string>; agentModels?: AgentModelPrefs; byokProfiles?: ByokProfile[]; defaultByokProfileId?: string;
      source: 'hub'|'local'; unavailable: string[];
    }>;
  }
  ```
  - `LocalAppConfigCredentialSource`：现状（`readAppConfig(RUNTIME_DATA_DIR)` → `agentCliEnvForAgent`）。
  - `HubCredentialSource`：`GET /me/settings`（TTL 缓存 60 s，key=hubUserId）+ `POST /me/secrets/reveal`（**不缓存**）→ 合并规则：`*_BIN`、`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`MMD_MODEL_ROUTES_FILE` 取全局 app-config；`AGENT_CLI_AUTH_ENV_KEYS` 与 BASE_URL 类取用户；经 `validateAgentCliEnv`（借鉴 `routes/chat.ts:392-401`→`connectionTest.ts` 先例）；返回的 env 视为已带 `apiKeyOverride=true` 语义（**不经过** `normalizeAgentCliEnvPrefs`，因为不落盘）。hub 不可达：有缓存且 ≤ `OD_HUB_GRACE_MS`（默认 10 min）用缓存 settings，但 reveal 失败 → run 以 `HUB_UNAVAILABLE` 失败，**绝不回退全局 key**。
  - 本地模式（`OD_MULTI_USER` 未设）也用 `HubCredentialSource`，actor 由 `~/.amr/config.json` profile 推导；hub 未登录 → 退回 `Local` 实现（现状）。
- **[必须]** `server.ts:11471-11479` 替换为：
  ```ts
  const creds = await runCredentials.resolve(run.actor, def.id, { runId: run.id });
  configuredAgentEnv = creds.agentCliEnv;
  appConfigForRun = { ...(await readAppConfig(RUNTIME_DATA_DIR)), agentModels: creds.agentModels ?? appConfig.agentModels };
  ```
  `:11480-11485`（`resolveAmrProfile`）、`:12819-12827`（mmd）、`:13028-13034`（codex 归一）、`:13160`、`:13692-13703` 无改动。
- **[必须]** `run.actor`：`routes/runs.ts:3538` `POST /api/chat` 从 `req.principal` 派生 `actor`，随 `executionMeta` 进 `startChatRun`；`server.ts:10504` 处存 `run.actor`；重试 `:12186`、续跑 `:12602-12617` 从 `run.actor` 继承；`services/internal-run-service.ts:104-107 start(run, analytics, starter)` 加第四参数 `actor`（`null` 显式）。`routes/runs.ts:773-780 withoutSensitiveRunInput` 落库时剥 `actor.runtimeKey`，只留 `actorUserId`。
- **[必须]** `server.ts:11527-11534` digest：自动包含用户 env；repair 复用 `run.actor` → 一致性成立，无需改。
- **[必须]** `server.ts:1721-1731` `createAgentRuntimeEnv`：`multiUser` 时从 baseEnv 剥离 `CREDENTIAL_ENV_NAMES` 全集（双保险）。
- **[必须]** BYOK：`routes/runs.ts:3874-3876`：`multiUser` 时忽略 body 中 `byokProvider.apiKey`，要求 `byokProfileId`，由 `HubCredentialSource` 按 profile 组装 `ByokChatProviderConfig`（reveal `BYOK_API_KEY:<id>`）再进 `server.ts:10739-10749`。`routes/chat.ts:223-234` `/api/proxy/*/stream` 同样服务端注入。本地模式保留客户端上送（兼容）但 web 改为从 hub 拉 profile（§5）。
- **[必须]** per-user CLI home：`multiUser` 时 `HubCredentialSource` 追加 `CLAUDE_CONFIG_DIR=RUNTIME_DATA_DIR/users/<hubUserId>/claude`、`CODEX_HOME=.../codex`、AMR `HOME`/`OPENCODE_TEST_HOME=.../amr`（`runtimes/env.ts:98-124` 已读 env）；目录 `mkdir -p` 0700。`runtimes/detection.ts:757-790` 缓存键追加 `sha256(configuredEnv 非凭证部分)`。
- **[必须]** Orbit/自动化 `server.ts:16413-16416, 16834-16837`、`memory-llm.ts:969-975`：`actor` = routine 的 `owner_hub_user_id`（§8 迁移）→ 从 `daemon_sessions` 最近有效会话取 runtimeKey；无 owner 且 `multiUser` → 拒绝启动并记事件 `routine_skipped_no_owner`。`memory-llm` 在 multiUser 下以调用 run 的 actor 运行。
- [建议] `services/run-analytics-lifecycle.ts:269,370`：`requestAnalyticsContext` 加 `userId`；`run_finished` 带 `principalId`。

### 4.4 app-config 面（REPORT §5#3）
- **[必须]** `routes/media.ts:584-596` `GET /api/app-config`：对 `agentCliEnv` 中 `CREDENTIAL_ENV_NAMES` 只返回 `{tail}`（仿 `media/config.ts:393 readMaskedConfig`）；响应加 `credentialSource:'hub'|'local'`。**所有模式生效**。
- **[必须]** `routes/media.ts:598-660` `PUT /api/app-config`：`multiUser` 时若 body 含任何凭证键 → 400 `USE_USER_SETTINGS`；`agentModels`/BASE_URL 类代理到 hub `PUT /me/settings`；其余 UI 偏好写本地。
- **[必须]** 新路由 `apps/daemon/src/routes/user-settings.ts`：`GET/PUT /api/user/settings`、`GET /api/user/secrets`、`PUT/DELETE /api/user/secrets/:name`、`GET/DELETE /api/user/keys[/:id]` → 用 `req.principal.controlKey` 透传 hub；契约 `packages/contracts/src/api/user-settings.ts`。本地模式用 profile controlKey。
- **[必须]** `routes/vela.ts:840-867` logout：`multiUser` 时改为只登出当前 session，不清全局 `agentCliEnv.amr`；`:673` login：`multiUser` 时 403（登录走 `/api/auth/login`）。

### 4.5 媒体通路（F13a）
- [建议] `media/config.ts:356 resolveProviderConfig(projectRoot, providerId, actor?)`；`routes/media.ts` 用 `toolTokenRegistry.validate(token)` 反查 run→actor；`MEDIA_API_KEY:<providerId>` 走 reveal。第一阶段明示"媒体 key 仍是共享 key"。

---

## 5) web 改动 + Design Loom 页面清单

### 5.1 代码改动
- `apps/web/src/providers/daemon.ts`：新增 `fetchAuthMe`、`userSettings.*`、`userSecrets.*`；所有 fetch 加 `credentials:'include'`（同源默认已带，EventSource 同）。401 `PRINCIPAL_REQUIRED` → 全局跳 `/api/auth/login?next=`。
- `apps/web/src/state/config.ts`：新增 `credentialSource` 状态；`multiUser` 或 hub 已登录时 `apiKey` 字段只读且不写 localStorage（`RETIRED_SECURE_BYOK_KEYS` 追加 `apiKey`，迁移时清除）；BYOK profile 列表来自 `/api/user/settings.byokProfiles`。
- `components/ProjectView.tsx:1752-1783` `byokOpenCodeProviderFromConfig`：改为传 `byokProfileId`，`apiKey` 仅本地兼容分支。
- `collab/workspace-identity.ts`：不改；`useWorkspaceContext.ts:250-260` 目录来自服务端按 principal 返回，自动生效。
- `SettingsDialog.tsx`：Agent/Model 节按 `credentialSource` 渲染掩码与"来自 Hub"徽标；新增 "账户与密钥" 节。
- `AvatarMenu.tsx`/`EntryShell.tsx`：显示当前 principal（用户名、头像），登出。
- i18n：新增 key 到 `i18n/types.ts` 与 19 个 locale。

### 5.2 Design Loom 页面清单

| 页面 | 字段 | 状态 |
|---|---|---|
| **P1 登录门（多用户）** `/` 未登录 | 产品名、"使用 GitLab 登录"按钮、hub origin 提示、错误文案 | 默认 / 跳转中 / `state` 不匹配错误 / hub 不可达 |
| **P2 账户与密钥（Settings → Account & Keys）** | 头像/用户名/GitLab id/hub origin；**密钥表**：行 = name（人类标签+env 名）、tail `••••ab12`、更新时间、[更新][删除]；**添加密钥**弹层：name 下拉（白名单）、值（password 输入、粘贴清空）、保存；**设备/会话表**：kind、deviceLabel、lastSeen、[吊销] | 空态 / 已配置 / `secret_unavailable`（红标"需要重新输入"）/ 保存中 / 409 冲突 / hub 只读（本地未登录） |
| **P3 模型与 BYOK profile（Settings → Models）** | 每 agent：默认模型、base URL（非密）、凭证状态徽标（来自 Hub / 缺失 / 本机进程 env-仅本地）；BYOK profile 列表：label、protocol、baseUrl、model、apiVersion、密钥 tail、[设为默认] | 有 profile / 无 / 缺密钥 |
| **P4 头像菜单** | 用户名、"多用户模式"标签、我的 workspace、登出 | 本地模式 / 多用户模式 |
| **P5 run 错误横幅（ChatPane 顶部）** | 错误码映射文案 + CTA：`HUB_UNAVAILABLE`→重试；`SECRET_MISSING:<name>`→"去设置"；`ROUTINE_NO_OWNER`→"绑定所有者" | 可关闭 / 持续 |
| **P6 自动化所有者（Automations 详情）** | owner 用户名/头像、"以此用户凭证运行"说明、[更改为我] | 有 owner / 无 owner（红） |
| **P7 hub 控制台密钥页**（hub `/console/settings`，可选，与 P2 同字段） | 同 P2 | 同 P2 |

---

## 6) 两种模式时序

**中央模式（c）**
1. 浏览器 `GET /` → 无 cookie → 302 `/api/auth/login` → 302 hub `/console/oauth/authorize`（PKCE）→ GitLab → hub callback：upsert 用户、签发 `odc_/odr_`、写 `browser_sessions` → 302 daemon `/api/auth/callback?code`。
2. daemon `POST hub /auth/browser/exchange` → 得 keys → 写 `daemon_sessions`（信封加密）→ Set-Cookie → 302 `/`。
3. 后续每请求：cookie → `req.principal`（内存缓存 60 s）→ 目录按 controlKey 拉（缓存）→ 注入默认 workspace 头 → 现有鉴权。
4. `POST /api/chat`：`actor={hubUserId, runtimeKey}` → `startChatRun` → `runCredentials.resolve` → hub `reveal`（写 `secret_read`）→ env → spawn。重试/repair 复用 `run.actor`。
5. 登出：`POST /api/auth/logout` → 本地 revoke + hub revoke；进行中的 run 不受影响。

**本地模式（d）**
1. `od-vela login`（或 UI Vela 登录）→ `~/.amr/config.json` 存 `controlKey/runtimeKey`。
2. daemon 每请求 principal = `local-implicit`（loopback 免检保持），actor 从 profile 推导。
3. `POST /api/chat` → 同一 `HubCredentialSource` → reveal → env。**不写 app-config.json**。
4. 设置页 `GET /api/user/settings` 用 profile controlKey 透传；用户在本地 UI 改的 key 立刻对中央模式可见（同一 hub 行）。
5. hub 未登录 → `Local` 实现（现状），设置页显示"未连接 hub，使用本机配置"。

---

## 7) 安全模型与审计

**信任边界**
- 身份真值：hub `api_keys`；daemon 只持有加密引用，session 表 revoke 或 hub 401 → 立即失效（缓存 ≤60 s）。
- `X-Forwarded-User`/任何代理头永不作身份；`OD_API_TOKEN` 只映射 `service` principal（无 workspace、无 reveal 权）。
- 密钥只在：hub 磁盘（加密）→ TLS → daemon 内存 → 子进程 env。daemon 不落盘、`GET /api/app-config` 无明文。
- reveal 需 `odr_`，管理需 `odc_`：浏览器 cookie 背后两把都有但只由 daemon 服务端使用；CLI 用户拿到的 `odc_` 无法 reveal 别人（api_key 绑 user）。
- 中央模式已知残余风险：同 uid 子进程 env 互读；run 存活期内 key 不轮换。缓解：F13c 网关模式；文档标注。

**审计事件（hub `audit_log`，details 永不含值）**

| action | actor | target | details |
|---|---|---|---|
| `session_issued` | user | controlKeyId | runtimeKeyId, deviceLabel, redirectOrigin |
| `session_revoked` / `key_revoked` | user | keyId | kind, by:'self'\|'admin' |
| `settings_put` | user | user | revision |
| `secret_set` / `secret_delete` | user | user | name, tail |
| `secret_read` | user(odr_) | user | names[], tails[], daemonInstanceId, runId, agentId, ua |
| `reveal_denied` | key | user | reason:'runtime_key_required'\|'invalid_name' |
| `secret_unavailable` | user | user | name, keyId |

daemon 侧：run 元数据 `actorUserId`；analytics `run_finished.userId`；日志事件 `routine_skipped_no_owner`、`hub_unavailable_grace_used`。

---

## 8) 隔离与迁移

- **数据根**：`RUNTIME_DATA_DIR/users/<hubUserId>/{claude,codex,amr}`，`daemon_sessions` 表在同一 SQLite；均从 `RUNTIME_DATA_DIR` 派生。
- **routines**：daemon migration 加 `routines.owner_hub_user_id TEXT NULL`；创建时写 principal；旧行 null → 多用户模式拒绝运行 + UI 标红（P6）。
- **现有 app-config 中的 key**：本地模式提供 `od settings migrate-to-hub`（读本地 `agentCliEnv` 凭证 → `PUT /me/secrets/*` → 删除本地键并写 `agentCliEnvIntent` 清理）；中央模式启动自检拒绝进程 env 中的 key。
- **browser localStorage `apiKey`**：web 首次检测到 hub 登录时提示"迁移到 Hub"，成功后清除。
- **legacy unbound 项目**：多用户模式不可见；提供 `od project claim <id>` 写 `workspace_projects` 归属当前 principal。
- **hub**：0007 migration 幂等；`TOKEN_ENC_KEY` 轮换流程 = 设置 `TOKEN_ENC_KEYS_PREVIOUS` → 后台 `rewrap` 任务（可选 F13d）。

---

## 9) 功能切片与验收

| 切片 | 内容 | 验收 |
|---|---|---|
| **F10a** app-config 脱敏 | `routes/media.ts:584` 掩码；导出 `AGENT_CLI_AUTH_ENV_KEYS`/`CREDENTIAL_ENV_NAMES` | daemon vitest：`GET /api/app-config` 响应体中不含任何写入的明文 key，仅 tail；`pnpm guard && pnpm typecheck` |
| **F10b** hub 浏览器登录签发 | 0007 `browser_sessions`；`/console/oauth/authorize|callback` 扩展；`POST /auth/browser/exchange`；`me/keys` | hub tests：callback 后 exchange 单次成功、二次 410；`session_issued` 审计存在；redirect 白名单 403 |
| **F10c** daemon principal 层 | `auth/principal.ts`、`session-store.ts`、`routes/auth.ts`、中间件、`OD_MULTI_USER` 启动自检、SPA 302 | e2e vitest（`OD_MULTI_USER=1` + fake hub 扩展双用户）：loopback 无 cookie → 401；带 A cookie 访问 → 200；`X-Forwarded-User: B` 无效；进程 env 含 `ANTHROPIC_API_KEY` 时启动失败 |
| **F10d** 目录按 principal + 默认头注入 | `configuredAmrEnvFor`、`verifyExplicitWorkspaceRequestContext`、`injectDefaultWorkspaceHeaders`、禁 `PUT /workspace/context`、`GET /api/projects` 空 | e2e：A 创建 personal 项目，B 伪造 `x-od-workspace-member-id: A` 读取 → 403；B 无头创建项目 → `created_by_workspace_member_id = uB`；`GET /api/workspaces/:id/projects` 各见各的；扩展 `e2e/tests/collab/workspace-project-isolation.test.ts`、`headerless-mutation.test.ts` |
| **F11a** hub 密钥库 | `user_secrets/user_settings`、HubStore 双实现、TokenCipher 多 keyId、`HUB_REQUIRE_TOKEN_ENC_KEY` | `tests/store.test.ts` parity；轮换后旧 keyId 可解；错误 keyId 解密失败返回 `secret_unavailable` |
| **F11b** hub 端点 + od-vela 子命令 | `/me/settings|secrets|reveal`、审计、`od-vela settings|secret|keys` | hub http tests：odc_ 调 reveal → 403；odr_ 调 reveal → 值 + `secret_read` 审计；PUT revision 冲突 409；CLI `secret set --value-file -` 从 stdin 写入且 `ps` 不含值（测试断言 argv） |
| **F11c** per-run 注入 seam | `run-credentials.ts`、`server.ts:11471` 替换、`run.actor`、`internal-run-service.start` 参数、BYOK 服务端注入、per-user CLI home、baseEnv 剥离 | e2e（mock CLI `mocks/bin` + fake hub）：A/B 各设不同 `ANTHROPIC_API_KEY`，各发 `/api/chat`，用 mock claude 录 env 断言子进程 `ANTHROPIC_API_KEY` == 各自 key 且 `CLAUDE_CONFIG_DIR` 含 hubUserId；hub 不可达 → run 失败码 `HUB_UNAVAILABLE`，不含全局 key；重试 run 复用同一 actor（digest 无 `DESIGN_GENERATION_AUTHORITY_CONFLICT`）；`pnpm guard` "run start choke point" 通过 |
| **F11d** 本地模式复用 | 本地 principal 推导、hub 未登录回退、`od settings migrate-to-hub` | e2e：本地 daemon（无 `OD_MULTI_USER`）登录 fake hub 后，`/api/chat` 子进程 key 来自 hub 且 `app-config.json` 无该 key；未登录时现状测试全绿 |
| **F12a** daemon `/api/user/*` + `od settings|secret|auth` CLI | `routes/user-settings.ts`、契约、`SUBCOMMAND_MAP` | daemon vitest 透传与 403 路径；`od secret set X --value-file - --json` 往返 |
| **F12b** web 设置/登录/头像 UI | P1–P5 实现、i18n 19 locale、localStorage apiKey 迁移 | `pnpm --filter @open-design/web typecheck/test`；Playwright（`@/playwright/suite`）：未登录跳转、密钥表显示 tail、添加密钥后 run 可用；截图附 PR |
| **F13a** 媒体通路 actor | `resolveProviderConfig(..., actor)`、tool token 反查、`MEDIA_API_KEY:*` | e2e：A 的 run 调 `od media generate` 使用 A 的 key（fake provider 记录 Authorization） |
| **F13b** routines owner | migration、P6、拒绝无 owner | vitest：无 owner routine 在 multiUser 触发 → 跳过 + 事件；有 owner → 使用 owner key |
| **F13c** 网关模式（可选） | 子进程仅拿 `odr_`+linkUrl，hub 代理 provider | e2e：子进程 env 不含任何 `CREDENTIAL_ENV_NAMES` |
| **F13d** 密钥 rewrap 任务 / admin 审计视图 | — | hub tests |

每片：`pnpm guard`、`pnpm typecheck`、对应 `pnpm --filter` 测试；依赖顺序 F10a → F10b → F10c → F10d → F11a → F11b → F11c → F11d → F12 → F13。

---

## 10) 风险

1. **同 uid 子进程 env 互读**（中央模式）：无法在本方案内根治；F13c 网关或容器隔离才是终解。文档必须明示"第一阶段适用于互信团队内网"。
2. **hub/GitLab 可用性成为 run 启动依赖**：reveal 不经 GitLab 缓解大半；hub 宕机仍阻断新 run（有意为之，不回退共享 key）。需监控 + `HUB_UNAVAILABLE` UI。
3. **ephemeral cipher 误配**：TOKEN_ENC_KEY 缺失导致全员重录 key；用 `HUB_REQUIRE_TOKEN_ENC_KEY` 默认开兜底。
4. **默认头注入依赖上游三处鉴权函数内部规则不变**：`project-request-authority.ts`、`workspace-resource-mutation.ts`、`created-project-workspace.ts`；rebase 时需回归 F10d 用例。
5. **`server.ts` 中间件与 `:11471` seam 是上游高频改动区**：保持改动为"调用一个新模块"的最小形态以降低冲突。
6. **run 存活期内 key 不轮换**：`spawnedAgentEnv` 复用（`:14796/15445/15739`）；吊销后进行中的 run 继续；记录事件，接受。
7. **detection 缓存分键后首次探测变慢**：每用户首 run 多一次 CLI 版本/能力探测；可预热。
8. **本地模式行为变化**：登录 hub 后本机 `app-config` 的 key 不再被用（hub 优先），可能让老用户困惑；设置页需明确标示来源并提供迁移命令。
9. **BYOK 客户端上送兼容分支**保留在本地模式，形成两条代码路径；计划在 F12b 迁移完成后一个版本移除。
10. **审计量**：每 run 一条 `secret_read`；hub `audit_log` 需分页/保留策略（已有 `admin/audit` 分页）。

---

# 可行性审查结论

**基线偏差**：worktree HEAD 实际为 `c39527c30`（在 a0150f18f 之上多一提交 "feat(od-hub): deployment, self-host docs and CI route"，仅 hub 部署/文档），daemon 行号全部核对一致，方案中引用的 `server.ts:11471-11479`、`:2980`、`:3007-3016`、`:3483-3518`、`:13692-13703`、`:13786`、`routes/runs.ts:3538/3874-3880`、`routes/media.ts:584/598`、`app-config.ts:233`、`internal-run-service.ts:104-107`、`media/config.ts:356`、hub `http.ts:365/378/497/989`、`token-cipher.ts:36` 均存在且语义相符。迁移目录 `tools/od-hub/migrations/0001-0006` 属实，0007 命名无冲突。

## 与代码不符的假设（需修正）

1. **`configuredAmrEnv()` 不是单一注入口** — `server.ts:3483` 定义后被 `workspaceExactAuthorityCache.identity`、`createWorkspaceDirectoryAuthorityBroker.fetchDirectory/identityKey`（`:3491-3502`）三处闭包捕获，且 broker 的 `read/fresh/backgroundFresh` 是**无参**函数（`:3519-3522`），按 identityKey 做单例缓存。改成 `configuredAmrEnvFor(principal)` 需要把 broker 改为按 principal 分区（`Map<identityKey, broker>` 或 `read(principal)`），否则 A 的后台 refresh 会用 B 的 key。方案 4.2 第一条低估了改动面。

2. **`VELA_CONTROL_KEY` 不在 `agentCliEnv.amr` 白名单**（`app-config.ts:204-212` 只有 `VELA_RUNTIME_KEY` 等），但 `readRawVelaControlApiContext`（`vela.ts:766-784`）合并的是 `configuredEnv` 参数而非经白名单过滤的值，所以通过 `configuredEnv` 注入 `VELA_CONTROL_KEY` 可行——**前提是不走 `validateAgentCliEnv`**。方案 4.3 说 HubCredentialSource 输出"经 `validateAgentCliEnv`"，那样 `VELA_CONTROL_KEY` 会被过滤掉。修正：目录层的 `configuredAmrEnvFor(principal)` 直接构造，不过白名单；或把 `VELA_CONTROL_KEY` 加入 amr 白名单。

3. **`readVelaControlApiContext` 有 10 个文件、~34 处调用**，其中 `sync-digest.ts`、`invite-create/continue.ts`、`vela-wallet.ts`、`langfuse-trace.ts`、`vela-workspace-context.ts:277/341/455`（读 `process.env` + `selectedEnv`）都是无请求上下文的注入。方案只覆盖 `server.ts:3483`。这些在 multiUser 下会以 daemon 进程身份（或 null）调 hub：invite/sync/wallet 必须显式接 principal，否则"邀请由谁发出"变成 daemon 身份。需在 F10d 增加：为这些 `readSession` 注入点统一传 `principal → VelaControlApiContext` 适配器。

4. **`verifyExplicitWorkspaceRequestContext` 只有 `OD_WORKSPACE_CONTEXT_SOURCE==='vela'` 时走目录验证**（`server.ts:3528`，另 `:3591/:3605/:5728` 三处同样判断）。方案说"multiUser 强制视为 vela"，需覆盖这 4 处，建议抽 `workspaceContextSourceIsVela()` 一并替换。

5. **`isLocalSameOrigin`（`origin-validation.ts:212`）在中央部署下会拒绝** — 它按 `OD_BIND_HOST`/端口/`OD_ALLOWED_ORIGINS` 校验 Host/Origin。中央域名（如 `https://od.corp`）若未配 `OD_ALLOWED_ORIGINS`，`GET/PUT /api/app-config` 直接 403。F10c 需把中央部署的 origin 配置纳入启动自检/文档，不只是 cookie Secure 判定。

6. **`amrVelaProfileEnv` 只产 `VELA_PROFILE`**（`vela-profile.ts:24`），不是方案 3.4 暗示的"读 controlKey/runtimeKey 的 env 组装点"。AMR 子进程的 hub 身份来自 `configuredAgentEnv` 中的 `VELA_RUNTIME_KEY/VELA_LINK_URL` 和 `~/.amr/config.json`。多用户下 per-user AMR 需 `HubCredentialSource` 输出 `VELA_RUNTIME_KEY=principal.runtimeKey`+`VELA_LINK_URL`+`VELA_API_URL`，并注意 `HOME` 回填（`env.ts:98-101`）指向 daemon 用户 home，`~/.amr/config.json` 仍是共享文件——env 优先级（`vela.ts:773`）让 env 胜出，但 vela CLI 自身也读 `$AMR_HOME`，需同时设 `AMR_HOME=RUNTIME_DATA_DIR/users/<id>/amr`（方案未列 `AMR_HOME`）。

7. **`OD_MULTI_USER` 时启动拒绝进程 env 含 `AGENT_CLI_AUTH_ENV_KEYS`** 会与 mocks/e2e 冲突：现有 e2e 通过 `process.env` 注入 mock CLI 路径，不注入 key，问题不大；但 `packaged`/`tools-dev` 下 `inheritedEnvironment`（`server-context.ts:194`）由桌面壳注入，中央模式不涉及桌面壳，可行。

## 遗漏的注入/消费点

- **`agentCliEnvForAgent` 调用面**：`readAppConfig*` 共 21 个文件，除方案列的 `memory-llm.ts`、`agent-companion-setup.ts`、`routes/vela.ts` 外还有 `routes/static-resource.ts:454`（`GET /api/agents` 检测——multiUser 下检测应按 principal 的 base URL 做，否则模型列表用全局）、`routes/chat.ts:392` connection test（当前接受 body 传入 `agentCliEnv`，multiUser 下等于任意用户可用任意 key 做出网探测，需改为按 principal 解析）。
- **`/api/proxy/*/stream`（`routes/chat.ts:223-234`）强制 `body.apiKey`**：方案提到"服务端注入"，但校验在最前面，改动需先放宽校验再注入，且要拒绝客户端明文 key（否则用户可绕过 hub 用自带 key，审计不完整）。
- **`routines` 表无 owner 列**（`db.ts:334-348` 确认）——方案已覆盖；但 `agent_sessions.model`/resume-identity guard（`server.ts:11465` 注释）以模型为键，同一 project 两个用户复用 session 会串；需把 `actorUserId` 加入 resume 匹配键，或 personal 项目天然隔离即可（team 项目不隔离）。
- **`media/config.ts:356`** 已无 actor 参数，方案标为 F13a 正确；但 `memory-llm.ts:348-658` 直接调它，中央模式下记忆抽取也用共享 media key——需在文档中明示。

## 会破坏单机模式/e2e 的点

- 本地模式改为"hub 登录后 hub 优先、不用本机 app-config key"（4.3/F11d）会让现有 Vela 用户（已 `od-vela login` 但从未在 hub 配 key）的 claude/codex run 突然失去本机 key。**修正**：本地模式合并策略应为"用户 hub key 存在则覆盖，否则回退本机 app-config"（与中央模式"绝不回退"区分），否则登录 Vela 等于打断现有工作流。
- `GET /api/app-config` 脱敏（F10a）"所有模式生效"会破坏 web `SettingsDialog` 回显与 `PUT` 整体写回（web 读回 tail 再原样 PUT 会把 key 覆盖成 `••••`）。需同步改 web：PUT 时省略未变更的凭证字段，或 daemon 在 PUT 时识别掩码占位符不覆盖。F10a 不能单独落地为纯 daemon 切片。
- `internal-run-service.start` 加第四参数会触发 `pnpm guard` "run start choke point" 的签名检查（`scripts/guard.ts`），需同步更新 guard 规则与 `tests/` 中所有 `start(run, analytics, starter)` 调用。
- `GET /api/projects` 在 multiUser 返回空：`e2e/tests` 中依赖 unbound 项目列表的用例仅在 `OD_MULTI_USER=1` 时受影响，可接受。

## 建议的顺序微调

F10a 与 F12b 的 web 掩码回显部分合并；F10d 前先做"principal → VelaControlApiContext 适配器 + broker 按 identity 分区"（否则 F10d 的双用户 e2e 会因缓存串键而假阳/假阴）；`VELA_CONTROL_KEY`/`AMR_HOME` 明确加入 HubCredentialSource 输出且绕过 `validateAgentCliEnv`。
