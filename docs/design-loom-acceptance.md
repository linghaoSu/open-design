# Design Loom 本地安装版验收

本报告记录 **2026-09-07** 的 macOS Apple Silicon 本地验收，应用版本为 **0.1.0-beta.1**。操作方法见[使用 Design Loom](design-loom.md)。最终安装包来自源码检查点 `f2f99950b`，已成功构建、安装并完成新欢迎页操作。

当前结论：安装版的迁移、连续编辑发布、组件预览和真实 Codex 生成已完成下列实际操作验收；最终应用已复制到 `/Applications/Design Loom.app`。系统锁屏阻止了从该位置启动，保留项目的最终冷启动复验仍待解锁后完成。此包是**未签名、未公证的本地 beta**，不代表已完成公开稳定发行或跨机器兼容认证。

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

连续发布核验通过只读公共 API 获取状态、版本与文件，分别复算原始字节、包摘要和来源摘要。主动修改的 `USAGE.md` 被记录为预期变化，而非忽略全部文件差异。

## 构建与回归证据

- 最终 `f2f99950b` 的 `tools-pack mac build --namespace design-loom --portable --to dmg --app-version 0.1.0-beta.1 --json` 成功；日志明确记录跳过 macOS 代码签名。最终包静态审计 14 项通过，整仓 guard、类型检查及后续改动所属包的类型检查已有通过记录。
- 最终 DMG 为 352,898,749 字节，SHA-256 为 `d4e3abb9d46f8ce52f73eead01c8fead2d40c3ab211ffc35d0dc7f9fca8180cf`。安装应用的完整树摘要为 `6cdcd9864119664ee05d85aeb0c37560e19a7ae8bbac668778d8c5e1252de126`，与构建副本一致。
- 编辑基线修复具备先红后绿的元数据与二进制继承回归；覆盖契约、存储、HTTP、CLI、版本面板。强编译器与预览兼容回归 139 项 daemon 用例通过；CSS Module 真实渲染回归 24 项通过。
- 安装版操作发现的首次启动品牌与迁移后重复入口问题已修复并纳入最终构建：本地代理主入口、第三方 Cloud 身份和来源说明覆盖 55 项入口/布局、2 项重新认证、19 项语言测试；迁移入口覆盖 39 项面板测试及 112 项文件工作区/迁移测试（另有 3 项既有跳过）。新欢迎页已完成原生操作，已迁移项目的最终入口复验待冷启动完成。
- 真实运行暴露的问题已形成后续修复：`377eb25be` 包含精确来源所有权适配、已证明 React 包装器的验证、BOM 处理与收起长报告；`f2f99950b` 修复 CommonMark 文件链接目的地。来源所有权新增 3 项回归先红后绿，相关验证/交付 77 项通过；包装器、编译器、验证与交付合并回归 142 项通过（与前者有重叠）。BOM 的 3 项回归先红后绿，相关两套 16 项通过；诊断卡片 8 项通过。CommonMark 新增 13 项回归通过，相关聊天 Markdown/项目链接 134 项通过；相应 daemon/web 类型检查通过。最终安装包已包含这些修复。
- 预打包依赖回归 39 项通过。独立临时目录中的真实 React/Vue 渲染不借用仓库依赖；移除 React 后明确失败。
- **外部依赖限制**：一次完整包装测试记录为 303 通过、8 项既有跳过、1 项失败。失败用例要求可选 Vela CLI 的实际 npm 二进制；当时 `@powerformer/vela-cli-darwin-arm64@0.0.35` 缺失且仓库返回 E404。该测试未被改为跳过；普通构建不要求此可选二进制，此前 DMG 构建已成功。此结果不证明第三方 Cloud 登录已在该环境验收。

详细日志与清单保存在本次工作区的 `.tmp/design-loom-acceptance/`，包括最终构建的 `package-build-delivery.log`、`final-package-audit.json`、`installed-app-integrity.json`、`original-after-install.json`，以及 `delivery-final-guard.log`、`final-typecheck.log` 和 `runtime-check-*.json`。真实运行终态保存在 `real-agent-complete.json`；后续修复分别见 `validation-handoff-proof-final/manifest.json`、`verified-react-wrappers-final/manifest.json`、`generation-bom-fix-manifest.json` 和 `markdown-destination-final/manifest.json`。Vela 限制另见本地 `.tmp/design-loom-pack-tests.log`、`.tmp/design-loom-packaging-manifest.json`。这些是忽略提交的验收材料，本报告保留其结论，不依赖其他机器具备相同临时目录。daemon 数据路径只遵循 [AGENTS.md 的数据目录契约](../AGENTS.md#daemon-data-directory-contract)。

## 支持边界

- 本轮安装与原生交互仅覆盖本机 macOS arm64；尚未证明 Intel Mac、Windows、Linux 或其他干净机器上的完整兼容性。
- 旧 DS 迁移转换能够证明的 token 字面量并保留源文件；复杂主题、表达式、HTML 到强组件 API 的转换不是自动推断结果。
- 强组件注册支持有界、可证明的类型与 React 包装/导出模式。复杂第三方继承、泛型或上下文组件可能需要一个调用真实实现的窄类型适配器。预览可接受临时 JSON props，不等同于强注册或 Strict 认证；缺少类型依赖或来源证据必须报错。
- 修改预览 props 不写回源文件；修改 CSS 不自动重建结构化 tokens；修改源码需显式刷新预览或重编译。其他项目仍锁定各自的确切版本，升级需审阅后应用。
- 已有确定性 benchmark/修复 fixtures 是回归证据，不是多模型实际生成成功率或广泛项目兼容率。

## 收尾待办

- [x] **真实 Codex 生成**：已记录有界修复阻止与发布锁定后成功两条实际路径，以及生成页面的原生编辑、保存与还原；Guided 成功不等于 Strict ready。
- [x] **最新安装包构建**：`f2f99950b` 构建成功，产物摘要、完整依赖与独立身份审计通过。
- [x] **最终 DMG 重装与欢迎页**：最终包经 DMG 安装、工具启动，原生欢迎页和本地代理入口通过；Finder 已完成系统应用目录安装及完整树核对。
- [ ] **最终项目界面复验**：已迁移项目入口、折叠诊断与 CommonMark 文件链接，待解锁后从系统安装位置操作。
- [ ] **关闭后的冷启动**：从安装的应用重新打开，核对项目、连续发布历史、编辑基线和来源字节，并补充重启后的只读快照。
- [x] **原 OpenDesign 安装隔离**：系统目录安装后，三个基线文件哈希仍与操作前一致；最终包仅声明 `designloom://`，未安装全局 `od` 入口。最终冷启动后会再次复核。

以上待办由本轮验收负责人依据实际结果更新；未勾选项不计为通过。
