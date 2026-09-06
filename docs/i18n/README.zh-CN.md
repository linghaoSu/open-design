# Design Loom

基于可复用组件、设计系统版本和真实代码预览的本地设计工作区。

Design Loom 是 [OpenDesign](https://github.com/nexu-io/open-design) 的独立衍生项目，开发与交付只面向[当前 fork](https://github.com/linghaoSu/open-design)。应用名、安装包标识、协议、运行命名空间及更新策略独立，可与已安装的 OpenDesign 并行运行。

## 主要能力

- 文件树查看项目全景，预览并编辑产物。
- JSX／TSX 组件自动识别 props，生成临时 mock，并交互调试。
- React／TypeScript、Vue 组件注册及明确的生产代码绑定。
- 语义页面、共享组件实例、修改影响分析和并排预览。
- 旧设计系统迁移、原文件和资产保留、精确版本锁定与升级审阅。
- 从明确的版本基线继续编辑设计系统。
- Guided／Strict 生成校验，以及与 UI 共用 API 的 CLI 操作。

详细支持范围与用法见[设计系统指南](../structured-design-runtime.md)。旧 HTML 作为设计参考保留，检测到后提示迁移；不会把 HTML 示例当作已经认证的代码组件。

## 启动与安装

开发环境使用 Node 24 和 Corepack 指定的 pnpm。启动前必须设置隔离的 `OD_DATA_DIR`，遵循 [daemon 数据目录约定](../../AGENTS.md#daemon-data-directory-contract)；仅指定 namespace 不会隔离开发数据。

```sh
corepack pnpm install --frozen-lockfile
: "${OD_DATA_DIR:?请先设置隔离的 daemon 数据目录}"
corepack pnpm tools-dev start desktop --namespace design-loom-dev
```

构建并运行独立 macOS 安装包：

```sh
corepack pnpm tools-pack mac build --namespace design-loom --portable --to dmg --app-version 0.1.0-beta.1 --json
corepack pnpm tools-pack mac install --namespace design-loom --app-version 0.1.0-beta.1 --json
corepack pnpm tools-pack mac start --namespace design-loom --app-version 0.1.0-beta.1 --json
```

产物为 **Design Loom.app**。它使用自己的安装与运行空间，不覆盖现有 OpenDesign，不接管其系统协议或全局 `od` 命令，不自动导入其数据，也不消费上游更新源。现有内部包名、API 和 `od design-runtime` 保持兼容。具体说明见[独立项目使用指南](../design-loom.md)。

本地构建产物与签名、公证后的公开发行包是不同的交付阶段。

## 开发与来源

检查使用 `corepack pnpm guard` 和 `corepack pnpm typecheck`，测试按 package 执行。参见 [AGENTS.md](../../AGENTS.md) 及[交付记录](../../specs/current/structured-design-runtime.md)。

感谢 Nexu Labs 与 OpenDesign 贡献者。保留原有来源与许可声明，沿用 [Apache 2.0](../../LICENSE) 许可证。OpenDesign Cloud 等第三方服务保留其真实提供方名称。
