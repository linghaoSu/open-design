# feat/selfhosted-hub — 分支总结

> 基于 `codex/structured-design-runtime` @ `fe1388f72`（期间上游无新提交）。**不开 PR**（用户决定，2026-09-08）。
> 目标：让企业内网在不依赖闭源 OpenDesign Cloud（Vela）的情况下跑通团队协作，身份由自建 GitLab 提供。

## 结果

8 个 commit、134 个文件、约 +24.9k 行。daemon 自身只改了 1 个 commit（19 个文件、+318 行，全部是配置钩子，现有行为零变化）；其余是新工具包 `tools/od-hub`、e2e 一致性套件抽取、部署物料与文档。

| # | commit | 内容 |
|---|---|---|
| F1 | `6058e7b18` | daemon：`OD_AMR_API_UPSTREAM_ORIGIN` 可配置的 AMR API 反代上游（带自引用保护，未配置时行为逐字节不变）；`selfhost` profile 贯通 daemon / packaged / tools-pack / desktop 菜单 / web 徽标 / mocks / fixtures |
| F2 | `2d64ce53f` | `e2e/lib/collab-hub-core/`：把 1144 行的 fake collab hub 抽成无框架依赖的纯模块（状态机 + CLI 命令解释器 + HTTP/SSE handler + fake vela 生成器），补齐 sync-digest / wallet / access-revoked / `--activity-json` / `--live-dir`；`conformance.ts` 可对任意 hub URL + vela 可执行文件跑 17 项契约检查 |
| F3 | `5cc57c570` | `tools/od-hub` 骨架：node:http 服务（零运行时依赖）、`HubStore` 接口 + 内存 + SQLite（迁移 `migrations/*.sql`）、`od-vela` CLI shim（argv 路由、`Error: <scope>: API request failed with status NNN: <code>` stderr 约定、所有 stub 同时满足 daemon 两个 `billing summary` 解析器）、`--seed-dev` |
| F4+F5 | `f44a9a4a7` | GitLab OAuth **Device Flow** 登录（`od-vela login` stdout 逐字匹配 daemon 的 `parseVelaLoginActivation`，写 `$AMR_HOME/config.json`）；controlKey/runtimeKey 自签并只存 hash、30 天滑动过期；GitLab token AES-256-GCM 信封加密、按用户加锁静默刷新，**只有 GitLab 明确拒绝才吊销**（5xx/网络错误返回 503 不吊销）；`/api/v1/workspaces` 由 GitLab groups → workspace、access_level → role（50 owner / 40 admin / 20-30 member / ≤15 不可见）；SSE `ready/heartbeat/access-revoked/workspace-directory-changed` + transactional outbox |
| F6 | `cbb042c82` | sha256 内容寻址 blob、manifest + CAS（`expectedVersion` 不匹配 409）、tombstone、`resource push/head/pull/pull-batch/remove/shared/list`、`team-projects list/get/upsert/remove/pull`、2 秒 pull receipt（先拉 blob 再签 receipt）；1600 文件大树回归测试；stdout 全部经 daemon 解析函数的逐字拷贝校验 |
| F7 | `23e69ef98` | `collab member/comment/presence`：seq 单调、tombstone 优先、`updatedAt` 夹逼 now+5s；presence 30s TTL、驱逐时发事件、8s 内部超时；**完整 e2e conformance 17/17 对真实进程通过**（`pnpm --filter @open-design/tools-od-hub conformance`） |
| F8 | `a0150f18f` | 邀请（创建 → 落地页 → GitLab 授权码+PKCE → 加入 GitLab group → continuation nonce → `opendesign://` deeplink → consume 返回完整 `currentWorkspaceContext`）；公开快照匿名文件路由（raw path 防穿越、nosniff、redact 后 404）；`admin audit export`；**4 个 console 页面由 Design Loom 设计**（本机 Design Loom.app 项目 `737bf4d4`），落地为 `tools/od-hub/templates/*.html`，渲染器对所有变量 HTML 转义、剥离注释 |
| F9 | `c39527c30` | `deploy/od-hub/`（三阶段 Dockerfile、compose、`.env.example`、运维 README：GitLab OAuth 应用配置、反代 SSE 注意事项、备份/升级）；`docs/deployment/self-hosted-hub.md`（daemon 接入：dev / packaged / 登录 / 验证 / 限制）；CI planner 新增 `od-hub` source unit → `workspace_unit_tests` 内跑 od-hub build+test（medium 置信度，merge queue 升级为全量；决策记录在 `specs/current/ci.md`） |

测试：`tools/od-hub` 20 个文件 449 个用例；`deploy/tests/od-hub-deploy.test.ts` 含真实 docker build + 容器冒烟；e2e planner 测试 92 通过。每个 commit 均通过 `pnpm guard`、`pnpm typecheck` 与对应包测试后推送。

## 工作方式

每个功能：2 个候选实现在隔离 worktree 并行 → 2 名对抗评审（分别从契约正确性 / 安全与健壮性视角，实际重跑候选的验证命令）→ 采纳胜者 → 把落选方案的优点移植进胜者 → 门禁 → 一个 commit 推送。评审共拦下 8 处阻塞级缺陷（例：GitLab 瞬时故障会误吊销全部用户密钥；`team-projects remove` 不幂等导致 unshare 重试永不完成；设备授权完成页可按 GitLab 数字 id 枚举任意用户邮箱；compose build context 指错目录；`seatSummary` 让 daemon 判定席位已满从而隐藏邀请入口）。

## 如何接入

见 `docs/deployment/self-hosted-hub.md`（daemon 侧）与 `deploy/od-hub/README.md`（hub 侧）。最短路径：

```bash
cd deploy/od-hub && cp .env.example .env   # 填 GITLAB_URL / OAuth client / TOKEN_ENC_KEY
docker compose build && docker compose up -d
```

daemon 开发态在 `.env.development.local` 设 `OD_WORKSPACE_CONTEXT_SOURCE=vela`、`VELA_BIN=<repo>/tools/od-hub/bin/od-vela.mjs`、`VELA_API_URL=<hub>`、`OPEN_DESIGN_AMR_PROFILE=selfhost`、`OD_VELA_WEB_URLS={"selfhost":"<hub>/console"}`，然后 `od amr login`。

## 已知限制（第一阶段）

- daemon 仍是**单账号进程**：一台 daemon 对应一个已登录 GitLab 用户；中央多用户部署、按用户 API key 见下方设计稿，未实现。
- owner 多设备 last-push-wins（上游既有问题）；hub 侧已提供 CAS 409，daemon 侧尚未携带 `expectedVersion`。
- presence 为进程内存；hub 重启后到下一次心跳前名单为空。
- 不托管模型（`LLM_GATEWAY_URL` 可选，未做 `agent run` 桥）；`image/video` 子命令返回 not_supported。
- SMTP 仅 smtps 隐式 TLS（无 STARTTLS）；未配 SMTP 时邀请链接只打到日志。
- 打包版（Design Loom.app / Open Design.app）不能仅靠环境变量指向自建 hub（子进程 env 白名单），需通过 app-config `agentCliEnv.amr` 与 `config.json.apiUrl`；详见接入文档。

## 后续（仅设计）

`docs/deployment/self-hosted-hub/per-user-credentials-design.md`：GitLab 用户在 hub 配置自己的模型 API key、以用户身份运行时使用其 key、中央多用户 daemon、本地登录后同步。含 daemon 凭据注入 seam（`server.ts:11471-11479`）、请求身份层、hub 密钥库 schema/端点、切片 F10a–F13d 与验收方式，以及一份逐条 grep 核对后的可行性审查（实现前须先按其修正）。

## 研究材料（未入库，在 `/tmp/od-research/`）

`REPORT-enterprise-collab.md`（企业协作可行性调研，25 条缺陷）、`PLAN-selfhosted-hub-gitlab-oauth.md`（复刻规划）、`extract-*.md`（6 份 daemon↔Vela 契约切片，逐端点/逐 argv）、`LOOP-STATE.md`（执行日志）。
