# Design Loom 本地安装版验收

本报告记录 **2026-09-07** 的 macOS Apple Silicon 本地验收，应用版本为 **0.1.0-beta.1**。操作方法见[使用 Design Loom](design-loom.md)。当前候选源码检查点为 `f6c5911c5`，已重新构建并安装到系统应用目录；此前 `f2f99950b` 的完整原生验收记录保留在下表。

当前结论：`f6c5911c5` 已从 `/Applications/Design Loom.app` 冷启动，并完成概览、分类明细、版本解除与重新锁定、设置状态、文件链接及真实主题组件预览的原生操作。验收同时发现两个后续问题：JSON 未声明值在属性下拉框中回显错误，以及历史失败在最新成功回复后被误显示为当前失败。前者已按真实设计稿实施并通过回归，后者已在应用内生成设计稿并补齐失败复现测试，但 Mac 再次锁屏，原生审阅及产品实施仍待继续。两项修复均需重新构建后验收，因此尚不标记整体验收完成。独立应用未启用上游更新；此包**仅具 ad hoc 签名，未经 Developer ID 签名与公证**，尚未满足公开分发门槛。

## 已完成的实际操作

| 路径 | 观察与核验结果 |
| --- | --- |
| 原生应用启动 | 最终 DMG 经工具安装并启动，原生欢迎页显示 Design Loom、本地代理主入口及第三方 Cloud 来源；点击本地代理后正确显示已安装 CLI 列表。 |
| Stripe 旧设计系统迁移 | 在原生界面审阅并应用为 `1.0.0`：45 个结构化 tokens，6 份冻结来源，包含 PNG 二进制资产。原项目的六份文件与迁移前 SHA-256 一致；不会把旧 HTML 示例认证为代码组件。 |
| 解除版本锁并刷新 | 运行时 revision 从 1 变为 2，锁已解除，精确 `authoringBase` 仍指向 `1.0.0`。刷新后保留可编辑系统和原资产。 |
| 选择性发布 `1.0.1` | 仅选中已修改的 `USAGE.md`。新版本仍有 45 个 tokens、6 份来源；其余五份文件，包括二进制资产，字节不变。tokens、patterns、constraints、codeCompatibility、origin、migrations 均保留。 |
| 零来源更新发布 `1.0.2` | 不重复选择上一轮文件，仍继承 `1.0.1` 的全部六份来源及上述元数据；保留修改后的 `USAGE.md`，未回退到 `1.0.0`。revision 为 4，编辑基线准确推进到 `1.0.2`；各不可变版本的摘要与来源摘要核验通过。 |
| 真实生产 Button 预览 | 使用实际生产组件源码与 CSS Module。完整 JSON props 输入无效时保留最后有效渲染；修正后恢复更新。源分析无法确认的继承类型显示诊断，未被伪装成已验证契约。 |
| 生成页面编辑 | 在原生界面完成 `Page.tsx` 的编辑、保存与还原。沙箱存储降级为每次预览会话内的状态，并明确提示，不宣称跨会话持久化。 |
| 未发布系统的真实生成 | 由原生界面启动真实 Codex，Guided 任务在一次有界修复后仍有 49 项错误，逻辑终态为 `blocked`。首个物理运行结束不被当作整个任务成功。 |
| 发布后再次生成 | 在原生界面将 6 份原始来源发布并锁定为 `Design Loom Core 1.0.0`，未放宽验证策略。后续真实 Codex 运行 `e669e3ca-b554-4b3e-b194-c2edb9e0c3dc` 的物理及逻辑终态均为 `succeeded`：Guided、attempt 0、`accepted`、0 错误、46 条警告，`strictReady: false`。 |
| 独立安装完整性 | Finder 将最终应用复制到 `/Applications/Design Loom.app`。对全部 18,704 个目录、文件及符号链接核对内容、链接目标与执行权限，安装副本与最终构建完全一致。原 OpenDesign 的 Info.plist、可执行文件和安装配置三项 SHA-256 均与操作前一致。 |
| 系统安装位置冷启动 | 运行检查确认实际可执行文件为 `/Applications/Design Loom.app/Contents/MacOS/Design Loom`，版本 `0.1.0-beta.1`，上游更新关闭。冷启动后的只读 API 检查全部通过：Stripe revision 5、锁和编辑基线均为 `1.0.2`、45 个 tokens 与 6 份来源；组件预览项目 revision 0 的 7 份原始文件及真实代理项目 revision 8 的 6 份原始来源均与基线一致。Stripe 三版的选择性更新与零更新继承关系不变。 |
| 已迁移入口与普通页面 | 冷启动后打开已迁移的 `components.html` 可进入设计系统，不再提示重复迁移；普通 `index.html` 没有迁移提示。 |
| 聊天报告与文件链接 | 原生点击 CommonMark 相对路径链接打开正确的 `Page.tsx`，真实渲染标题“工作区偏好”。绝对路径链接点击时目标文件已打开，仅确认未出现错误，仍需从其他文件切换验证导航。报告可展开其余 31 条诊断并重新收起。 |
| 冷启动后的 props 预览 | 在 `production/button.tsx` 预览中修改 JSON 的 `children`、`variant`、`size` 会更新真实组件；输入无效的 `{` 时保留最后有效画面并显示错误，恢复有效 JSON 后成功更新。 |
| 本轮先设计后实施 | 在安装的 Design Loom 中启动两次真实 Codex 设计运行，均成功完成。原生查看概览稿，操作锁定、可编辑基线、空项目及只读版本详情；设置文案来自同项目后续设计说明。设计过程见[界面设计记录](design-loom-interface-design.md)。 |
| 新候选安装与启动检查 | `f6c5911c5` 的 DMG 经工具安装，再在应用完全停止后更新系统目录中的独立应用，保留旧副本可回退。18,704 个目录、文件与链接核验一致，原 OpenDesign 三项哈希不变。工具管理的安装副本成功启动，公开版本 API 返回 HTTP 200、macOS arm64、packaged、`0.1.0-beta.1`；该检查使用测试数据空间，不能代替系统安装位置的冷启动与原生点击验收。工具测试实例已停止。 |
| 新候选系统目录冷启动与概览 | `f6c5911c5` 实际运行的可执行文件来自系统安装位置，原生主页显示四个已有项目。Stripe 默认进入概览，准确显示 `1.0.2`、45 个 tokens、6 份来源、零代码组件与页面；tokens 明细、含 PNG 的来源清单、完整版本内容及版本管理均可打开。空设计项目显示开始指引。 |
| 新候选解除与重新锁定 | 原生解除 Stripe 锁后 revision 从 5 变为 6，刷新仍显示基于 `1.0.2` 编辑及原资产；在版本管理中重新启用同一版本后为 revision 7。只读 API 核验 8 项通过：精确锁、编辑基线、三版摘要、全部来源及选择性更新关系均保留。 |
| 新候选设置与预览 | Design Loom 实验室品牌正确。API 页显示项目文件能力和可用 OpenCode，点击重新扫描后状态仍正确；未填写密钥。真实 `ProductButton.tsx` 导入实际主题，修改标签、切换禁用状态与重置均正确渲染，源文件未改。原 Button 的合法枚举 JSON 与无效 JSON 保留路径通过，但未声明枚举值的控件回显存在下述待修问题。 |
| 新候选文件链接与诊断 | 先打开 `verification/workspace-settings-preview.png`，再点击聊天中的绝对路径 `Page.tsx` 链接，实际切换并渲染“工作区偏好”；再次从 PNG 点击相对路径链接也正确。其余 31 条诊断可展开与收起。最新成功回复下方仍出现旧任务的失败卡，已核对属于历史 blocked 逻辑轮次。 |

连续发布核验通过只读公共 API 获取状态、版本与文件，分别复算原始字节、包摘要和来源摘要。主动修改的 `USAGE.md` 被记录为预期变化，而非忽略全部文件差异。

真实 Guided 成功案例的范围是明确的：46 条警告由 `ODDS6002` 35 条、`ODDS6005` 9 条和 `ODDS6004` 2 条组成。报告的 semantic、imports、styles、bindings 覆盖为完整，source 与 conformance 覆盖为不完整；组件复用为 2/10，绑定复用为 2/2，语义组件复用为 2/2。因此，此案例证明 Guided 流程及按保存策略接受结果可用，不证明完整源码一致性或真实项目 Strict 交付通过。

## 构建与回归证据

- 当前 `f6c5911c5` 的 `tools-pack mac build --namespace design-loom --portable --to dmg --app-version 0.1.0-beta.1 --json` 成功，最终包静态审计 **18/18** 通过，确认新概览分类明细、BYOK 状态代码、独立身份、更新/遥测隔离与预览依赖已包含。整仓 guard 和类型检查通过；最后一次仅涉及 web 的扫描失败修复后，重新通过 web 类型检查与整仓 guard。
- 当前 DMG 为 **352,913,042 字节**，SHA-256 为 `a0b355da07b7a444fe67cd23e2fd86e7c9392e8322b521f8127db0f8dcb75b48`。系统安装应用的完整树摘要为 `e7e286007f7fb58d4156235f0ef02250ba6cd543281a1eba7a4bbd7fd53190f8`，18,704 个条目与构建完全一致。原 OpenDesign 的三个基线文件哈希仍一致。
- 此前原生验收使用的 `f2f99950b` 包静态审计 14 项通过；旧 DMG 的 SHA-256 为 `d4e3abb9d46f8ce52f73eead01c8fead2d40c3ab211ffc35d0dc7f9fca8180cf`。旧记录不会自动作为新候选的原生验收结果。
- 概览相关最终 **72 项**测试通过，覆盖精确版本、账户/权限/项目切换、过期结果、分类明细、版本变化后的刷新及原编辑状态保留；相关文件工作区和预览回归 183 通过、3 项既有跳过。设置与语言最终 **174 项**测试通过，覆盖 OpenCode 可用、明确缺失、未知、加载、离线、扫描失败、失败提示保留与重试恢复；重新扫描不改变保存的 API 模式，HTTP 连接成功不被当作执行环境通过。
- 待打包的属性回显修复新增 8 条先红后绿回归；最终组件、预览 frame 与 provider 共 **33 项**通过，相关文件入口 5 项通过，19 种语言及 57 个新翻译/占位符检查通过，web 类型检查通过。未声明枚举和布尔值保留原始类型及额外属性；无效 JSON 可恢复上次有效文本并同步字段编辑器，不重新编译或重发未变化的 props。此处为源码回归结论，不代表当前安装包已经包含修复。
- 历史错误归属的修复前复现已固定：ChatPane 两个文件 46 项通过、6 个预期失败；ProjectView 重连文件 47 项通过、1 个预期失败。覆盖折叠后的修复子消息身份、无持久错误事件但有权威 blocked 报告、后来成功或运行中的独立任务、最新真实失败与无归属的非运行错误；缺少或仍在运行的修复消息仍需继续恢复。当前仅新增测试，未实施该产品修复，不能把预期失败计作通过。
- 编辑基线修复具备先红后绿的元数据与二进制继承回归；覆盖契约、存储、HTTP、CLI、版本面板。强编译器与预览兼容回归 139 项 daemon 用例通过；CSS Module 真实渲染回归 24 项通过。
- 安装版操作发现的首次启动品牌与迁移后重复入口问题已修复并纳入该构建：本地代理主入口、第三方 Cloud 身份和来源说明覆盖 55 项入口/布局、2 项重新认证、19 项语言测试；迁移入口覆盖 39 项面板测试及 112 项文件工作区/迁移测试（另有 3 项既有跳过）。新欢迎页和冷启动后的已迁移项目入口均已完成原生操作。
- 真实运行暴露的问题已形成后续修复：`377eb25be` 包含精确来源所有权适配、已证明 React 包装器的验证、BOM 处理与收起长报告；`f2f99950b` 修复 CommonMark 文件链接目的地。来源所有权新增 3 项回归先红后绿，相关验证/交付 77 项通过；包装器、编译器、验证与交付合并回归 142 项通过（与前者有重叠）。BOM 的 3 项回归先红后绿，相关两套 16 项通过；诊断卡片 8 项通过。CommonMark 新增 13 项回归通过，相关聊天 Markdown/项目链接 134 项通过；相应 daemon/web 类型检查通过。最终安装包已包含这些修复。
- 预打包依赖回归 39 项通过。独立临时目录中的真实 React/Vue 渲染不借用仓库依赖；移除 React 后明确失败。
- **签名边界**：当前候选仍为本地 ad hoc 路径。此前候选的 `codesign` 深度严格完整性验证通过，但 `spctl` 分发评估拒绝。当前环境没有 Developer ID Application 身份，已有开发/其他分发身份不替代这一要求。`56338ec48` 已加入签名门禁并通过 60 项回归：`--signed` 强制发行签名且检查最终应用的 Apple Developer ID、TeamIdentifier、hardened runtime 与完整性；`--notarize` 必须搭配签名，缺少公证配置明确失败。对现有 ad hoc 包的只读 Developer ID 验证实际拒绝。该修复防止误标，不会将本地包变成正式签名包。
- **外部依赖限制**：一次完整包装测试记录为 303 通过、8 项既有跳过、1 项失败。失败用例要求可选 Vela CLI 的实际 npm 二进制；当时 `@powerformer/vela-cli-darwin-arm64@0.0.35` 缺失且仓库返回 E404。该测试未被改为跳过；普通构建不要求此可选二进制，此前 DMG 构建已成功。API 模式需要可用 OpenCode，可来自本机安装或随附运行时；当前本机检测到外部 OpenCode 1.18.5，但此候选未包含 Vela/OpenCode companion。API 连接测试成功不证明执行依赖可用，缺少 OpenCode 时仍会阻止任务启动。本轮真实本地 Codex 成功不代替 API 生成或第三方 Cloud 验收。

详细日志与清单保存在本次工作区的 `.tmp/design-loom-acceptance/`。当前候选包括 `package-build-release-iteration.log`、`release-iteration-package-audit.json`、`release-iteration-system-install.json`、`release-iteration-installed-integrity.json`、`release-iteration-startup-smoke.json`、`release-iteration-guard-final.log` 与 `release-iteration-typecheck.log`。本轮设计、概览、设置与签名证据分别见 `overview-designed-in-app/manifest.json`、`design-overview-final/manifest.json`、`settings-runtime-final/manifest.json`、`signing-fail-closed-manifest.json`。旧候选的构建、原生冷启动及真实生成材料仍保留，包含 `package-build-delivery.log`、`final-package-audit.json`、`runtime-check-installed-cold-start-1788715592784.json`、`real-agent-complete.json` 及各项修复清单；更新前的只读快照为 `runtime-check-before-release-iteration-install-*.json`。Vela 限制另见本地 `.tmp/design-loom-pack-tests.log`、`.tmp/design-loom-packaging-manifest.json`。这些是忽略提交的验收材料，本报告保留其结论，不依赖其他机器具备相同临时目录。daemon 数据路径只遵循 [AGENTS.md 的数据目录契约](../AGENTS.md#daemon-data-directory-contract)。

## 支持边界

- 本轮安装与原生交互仅覆盖本机 macOS arm64；尚未证明 Intel Mac、Windows、Linux 或其他干净机器上的完整兼容性。
- 旧 DS 迁移转换能够证明的 token 字面量并保留源文件；复杂主题、表达式、HTML 到强组件 API 的转换不是自动推断结果。
- 强组件注册支持有界、可证明的类型与 React 包装/导出模式。复杂第三方继承、泛型或上下文组件可能需要一个调用真实实现的窄类型适配器。预览可接受临时 JSON props，不等同于强注册或 Strict 认证；缺少类型依赖或来源证据必须报错。
- 修改预览 props 不写回源文件；修改 CSS 不自动重建结构化 tokens；修改源码需显式刷新预览或重编译。其他项目仍锁定各自的确切版本，升级需审阅后应用。
- 已有确定性 benchmark/修复 fixtures 是回归证据，不是多模型实际生成成功率或广泛项目兼容率。

## 收尾待办

- [x] **真实 Codex 生成**：已记录有界修复阻止与发布锁定后成功两条实际路径，以及生成页面的原生编辑、保存与还原；Guided 成功不等于 Strict ready。
- [x] **`f2f99950b` 安装包构建**：构建成功，产物摘要、完整依赖与独立身份审计通过。
- [x] **该检查点 DMG 重装与欢迎页**：经 DMG 安装、工具启动，原生欢迎页和本地代理入口通过；Finder 已完成系统应用目录安装及完整树核对。
- [x] **该检查点项目界面复验**：从系统安装位置完成已迁移入口、普通 HTML、折叠诊断、CommonMark 相对文件链接及完整 JSON props 的原生操作。
- [x] **该检查点冷启动**：实际安装可执行文件、项目 revision、连续发布历史、编辑基线和来源字节均通过重启后的只读核验。
- [x] **原 OpenDesign 安装隔离**：冷启动后再次确认三个基线文件哈希与操作前一致；该包仅声明 `designloom://`，未安装全局 `od` 入口。
- [x] **按设计稿实施**：真实设计运行完成，已实施概览成果展示、分类明细与设置文案/依赖状态，相关测试和源码复审通过。
- [x] **新候选构建与安装**：`f6c5911c5` 构建成功，静态审计、系统目录完整安装及工具管理环境启动通过。
- [x] **`f6c5911c5` 原生复验**：从系统安装位置冷启动，完成概览、tokens/来源详情、解除与重新锁定、OpenCode 状态与重扫、实际主题组件属性调试、跨文件点击绝对/相对链接；运行数据、全部安装条目及原应用隔离核验通过。
- [ ] **原生验收新增问题收敛**：完成属性未声明值回显与历史任务错误归属修复；界面改动先在真实 Design Loom 中设计审阅，再实施、构建、安装并实际操作。已有候选的原生通过记录不自动转用于新包。
- [ ] **公开分发签名与公证**：配置可用的 Developer ID Application 与公证凭据，执行正式签名构建并验证分发接受状态。当前未具备这些条件，不标记为公开发行完成。

以上待办由本轮验收负责人依据实际结果更新；未勾选项不计为通过。
