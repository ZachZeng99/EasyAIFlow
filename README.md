# EasyAIFlow

EasyAIFlow 是一个面向本地 AI 编码工作流的桌面客户端，当前阶段专注于 Claude 集成，后续会逐步扩展到更多模型与提供方。项目采用 Electron + React 单体架构，目标是提供一个可直接打包为 Windows `exe` 的聊天式工作台。

## 当前能力

- Claude CLI / Claude Code 桌面桥接
- 左侧 `Project / Streamwork / Session` 三层会话结构
- 中间聊天主区，支持流式回复展示
- 右侧上下文与 Git 快照面板
- 本地项目打开、会话管理、历史记录持久化
- 会话引用、上下文注入、附件输入
- Windows 桌面打包

## 技术栈

- Electron
- React 19
- TypeScript
- Vite

## 当前限制

- 目前只支持 Claude 相关工作流
- 多模型接入尚未开放
- 依赖本地已安装并可用的 `claude` 命令

## 开发环境

建议环境：

- Node.js 20+
- npm 10+
- Windows
- 本地可执行的 Claude CLI / Claude Code

安装依赖：

```bash
npm install
```

启动开发：

```bash
npm run dev
```

类型检查：

```bash
npm run check
```

构建桌面应用：

```bash
npm run build
```

打包 Windows 安装程序：

```bash
npm run package:win
```

## 后续方向

- 扩展更多模型和服务提供方
- 完善会话管理与上下文编排
- 增强本地工程分析与 Git 集成
- 持续优化桌面端交互体验

## License

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
