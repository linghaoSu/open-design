# 使用 Design Loom

Design Loom 是独立维护的本地设计工作区，基于 OpenDesign，重点提供结构化设计系统、组件复用和真实代码预览。代码与问题反馈面向[当前 fork](https://github.com/linghaoSu/open-design)，不向上游提交合并。

当前安装版已经验证的路径、支持边界与待完成项目见[本地安装版验收报告](design-loom-acceptance.md)。

## 独立安装

当前安装包面向 macOS；本机构建使用 Apple Silicon。应用名为 **Design Loom.app**，bundle ID 为 `io.github.linghaosu.designloom`，系统链接协议为 `designloom://`。

它使用独立的应用与运行空间，不接管 OpenDesign 的系统协议或全局 `od` 命令，不自动导入旧应用数据，也不会从上游更新源安装更新。数据路径的唯一约定见 [AGENTS.md](../AGENTS.md#daemon-data-directory-contract)。已有 OpenDesign 可以继续单独使用。

构建、安装、启动都通过仓库控制平面完成：

```sh
corepack pnpm tools-pack mac build --namespace design-loom --portable --to dmg --app-version 0.1.0-beta.1 --json
corepack pnpm tools-pack mac install --namespace design-loom --app-version 0.1.0-beta.1 --json
corepack pnpm tools-pack mac start --namespace design-loom --app-version 0.1.0-beta.1 --json
```

`install` 使用工具管理的独立安装位置。也可以打开生成的 DMG，将 **Design Loom.app** 安装到自己的应用目录。使用 `tools-pack mac logs`、`stop` 时保持同一 namespace 和 `--app-version 0.1.0-beta.1`。公开分发时需另外准备签名与公证；本地构建和原生运行验收不等同于这一发行手续。

对外分发前，在构建机配置有效的 **Developer ID Application** 签名身份与公证凭据，然后使用：

```sh
corepack pnpm tools-pack mac build --namespace design-loom --portable --to dmg --app-version 0.1.0-beta.1 --signed --notarize --json
```

公证优先读取 `APPLE_NOTARY_KEYCHAIN_PROFILE`，可用 `APPLE_NOTARY_KEYCHAIN` 指定其钥匙串。兼容配置为 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 与 `APPLE_TEAM_ID`；凭据应保存在构建环境或钥匙串中，不写入仓库。`--notarize` 必须同时使用 `--signed`；请求签名时不得以临时签名代替正式分发签名。签名、公证与最终分发评估都完成后，才能把产物标记为公开发行候选。

日常使用请双击安装后的 **Design Loom.app**。工具启动使用专门的测试数据空间，双击启动使用应用自己的数据空间；二者各自持久保存项目。验收后的示例项目将保留在双击启动的应用中。

第一次启动时选择本地编码代理，例如已安装并登录的 Codex，也可以使用自己的 API 配置。API 模式通过 OpenCode 执行项目任务，需检测到可用的 OpenCode；配置 API 连接成功并不验证这一运行依赖。未检测到时，先在模型与提供商的本机 CLI 页面安装或重新扫描 OpenCode。OpenDesign Cloud 属于第三方服务，保留真实提供方名称。

<a id="data-handling"></a>

## 数据处理说明

Design Loom 的独立安装包不预设 OpenDesign 上游产品遥测配置，也不启用上游体验问卷。这不代表所有执行方式都离线：模型请求仍由你选择的本机代理、API 提供商或第三方 Cloud 处理，并受相应服务的配置和数据处理规则约束。

**设置 → 隐私**中的匿名指标、对话和工具内容是保存的共享偏好。是否具备发送条件还取决于当前运行环境是否配置了对应遥测接收服务。界面显示已配置、未配置或无法确认；开关开启和配置存在都不证明发生了上传。源码运行或自行配置的运行环境应以其实际配置为准，不能套用独立安装包的默认结论。

匿名指标涉及运行次数、用量、错误率和耗时等使用信息；内容遥测可能涉及提示词、助手回复与工具输入／输出。两个偏好分别控制这两类产品遥测，不控制完成模型请求所必需的提供商通信。更改隐私偏好不会自动更改模型提供商的设置。

既有异常诊断还有独立通道：源码运行若配置了 PostHog，异常诊断可能在上述偏好关闭时发送。独立安装包未配置该通道。环境状态描述接收服务的配置情况，不是所有发送行为的总开关或发送记录。

“删除我的数据”沿用现有操作：轮换匿名 ID 并关闭后续产品遥测偏好。它不是向每个已配置接收方发送历史删除请求；已经传出的数据如何保留或删除，需依据实际接收方的规则处理。此说明描述当前实现，不代替第三方服务的数据处理说明。

## 日常工作入口

进入项目后，文件树展示源代码、页面和资源的完整结构。打开文件即可进入代码或预览。设计系统入口位于项目文件工作区的 **Design system／设计系统**。

- **Overview／概览**：查看现有系统、导入版本或开始迁移。
- **Design components／设计组件**：选择源文件和导出、注册组件、浏览属性与生产代码绑定。
- **Preview／预览**：渲染语义页面，查看共享修改或版本升级的前后效果。
- **More／更多**：版本、项目结构、校验和工程交付。

已迁移的系统会在概览显示名称、锁定版本或编辑基线，以及设计基础、代码组件、页面和保留来源的数量。点击设计基础查看真实 tokens，点击源文件查看版本中的文件清单；完整证据可从「查看版本内容」打开。加载失败时会显示无法确认，并提供刷新入口。

## 迁移已有设计系统

将原有设计系统文件导入项目，或从 **Design systems → Your systems → Edit with agent** 进入。系统检测到有设计系统文件依据的旧 HTML 示例时会提示迁移；普通网页不会因此被标记为旧设计系统。

点击迁移入口后，按名称、文件、审阅三步操作。检查可转换的 tokens、未解析项、组件和保留文件，再发布并激活审阅过的版本。原始 HTML、字体、图片和来源文件保留；不把 HTML 示例当作已经认证的 React／Vue 组件。

需要复用 HTML 中的组件时，可让项目中的代理依据它实现有类型的代码组件，然后在 **Design components** 注册。迁移不会自行猜测复杂主题、CSS 表达式或组件 API。

## 修改并发布下一版

已锁定的版本保持不可变。进入 **More → Versions**，解除当前依赖后继续编辑；系统会持久保存精确的编辑基线。

修改组件源码后，在 **Design components → Manage component files** 重新编译同一组稳定组件身份。回到 **Versions**，选择需要更新的源文件，填写新版本号并发布。未选中的原始文件和二进制资产，以及未显式更改的 tokens、patterns、约束和兼容声明，都从编辑基线保留。连续发布会沿用上一轮已发布的工作版本，不会回退到更早的文件或元数据。

历史项目若已经解除过锁定、但没有编辑基线，需要从版本列表明确选择一个版本并恢复基线；这不会覆盖当前组件或代码绑定。损坏或缺失的基线会显示诊断，不会猜测最新版本。

tokens／patterns 的结构化修改可通过完整版本包导入或同一 API 的 CLI 请求提交；修改 CSS 源文件本身不会自动改写结构化定义。其他项目仍使用各自锁定的版本，升级需要先审阅影响再应用。

## 调试 JSX／TSX

打开组件文件并选择 **Preview**。预览会发现导出、读取能够识别的 props，并为缺失值提供临时 mock。选择导出，修改控件或完整 JSON props，观察真实组件更新。JSON 中未声明的选项会显示实际值和「未声明」提示，仍按原值传入组件。JSON 格式错误时保留草稿与最后有效预览，暂时停用属性编辑；修正 JSON 或点击「恢复上次有效 JSON」后可继续调试。Reset 恢复初始值。

如果组件依赖上下文，可在同一项目添加导入真实 Provider 的预览包装组件，再预览该导出。错误信息与原始来源保留，便于定位缺少的依赖或上下文。复杂类型未能形成控件时仍可用 JSON 提交明确的模拟数据。

修改 props 不会写回源代码、默认值或设计文档。修改源码后使用 **Reload Preview** 重新读取；重新注册组件仍需执行编译。预览分析与强组件契约是不同用途：成功渲染不意味着所有复杂类型都已获得 Strict 认证。

## 自动化和校验

源码工作区提供 `designloom` CLI 别名，现有内部包名、HTTP API 和 `od design-runtime` 保留兼容性。两套应用同时运行时，外部 CLI 调用应明确传入目标应用的 `--daemon-url`；不要依赖全局 `od` 命令选择应用。各操作由 daemon 统一执行，CLI 支持 `--json` 和 `--prompt-file <path|->`。完整命令见[结构化设计运行时指南](structured-design-runtime.md)。

Explore 保留自由生成；Guided 增加结构校验及有界修复；Strict 还需要完整语义文档、生产代码和绑定证明。使用已有设计组件生成 Guided／Strict 页面前，先在 **More → Versions** 发布并激活审阅过的版本，再保存模式与生成目标。只注册组件并不等于已经锁定可交付的设计版本。

生成结束后查看聊天中的设计验证卡片：先显示关键问题，展开可读其余诊断及对应源文件证据。代理进程结束、页面能渲染与设计校验通过分别记录。检测到不支持的语法会给出诊断，不会把未知结果当作已经通过。
