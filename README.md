# EasyAIFlow

> 面向本地 AI 编码工作流的桌面/Web 客户端 — 以 Claude CLI 为核心，支持会话通信、普通任务与 Harness 多智能体编排。
>
> A desktop/web client for local AI coding workflows — built around Claude CLI, with session communication, standard tasks, and Harness multi-agent orchestration.

![EasyAIFlow Screenshot](./screenshot.png)

![Harness Multi-Agent Orchestration / Harness 多智能体编排界面](./screenshot-harness.png)

---

## 目录 / Table of Contents

- [功能亮点 / Features](#功能亮点--features)
- [会话通信 / Session Communication](#会话通信--session-communication)
- [Harness 多智能体编排 / Harness Multi-Agent Orchestration](#harness-多智能体编排--harness-multi-agent-orchestration)
- [交互式对话系统 / Interactive Dialog System](#交互式对话系统--interactive-dialog-system)
- [双运行时架构 / Dual Runtime Architecture](#双运行时架构--dual-runtime-architecture)
- [技术栈 / Tech Stack](#技术栈--tech-stack)
- [快速开始 / Getting Started](#快速开始--getting-started)
- [命令参考 / Commands](#命令参考--commands)
- [项目结构 / Project Structure](#项目结构--project-structure)
- [License](#license)

---

## 功能亮点 / Features

### 中文

- **三层会话结构**：Project → Streamwork → Session，灵活组织多项目、多任务线的对话
- **实时流式通信**：基于 NDJSON 逐行解析 Claude 输出，支持流式渲染、工具调用追踪、Token 用量统计
- **普通任务 & Harness 任务一键切换**：同一个 Session 既可直接与 Claude 对话，也可升级为 Harness 多智能体流水线
- **交互式控制**：权限请求、Plan Mode 审批、Ask User Question 三种暂停机制，让用户全程掌控 AI 行为
- **上下文引用**：通过 `[[session:id]]` / `[[streamwork:id]]` 跨会话注入历史上下文
- **Git 快照 & 代码变更追踪**：每个 Session 记录分支状态、文件变更、diff 预览
- **BTW 面板**：临时快速提问，不打断主对话流
- **桌面 + Web 双运行时**：同一套业务逻辑，既能打包为 Windows 桌面应用，也能作为 Web 服务部署

### English

- **Three-tier session hierarchy**: Project → Streamwork → Session for organizing multi-project, multi-task conversations
- **Real-time streaming**: NDJSON line-by-line parsing of Claude output with progressive rendering, tool-call tracing, and token usage metrics
- **Standard & Harness tasks in one place**: Any session can serve as a direct Claude conversation or be upgraded to a Harness multi-agent pipeline
- **Interactive control**: Permission requests, Plan Mode approval, and Ask User Question — three pause mechanisms that keep the user in control
- **Context references**: Inject cross-session history via `[[session:id]]` / `[[streamwork:id]]` syntax
- **Git snapshot & code change tracking**: Per-session branch state, file change lists, and diff preview
- **BTW panel**: Quick side-queries without interrupting the main conversation
- **Desktop + Web dual runtime**: Same business logic, packaged as a Windows desktop app or deployed as a web service

---

## 会话通信 / Session Communication

### 中文

EasyAIFlow 的核心是**会话驱动**的 Claude CLI 集成。每个 Session 拥有独立的 Claude 子进程生命周期：

```
用户消息 → Bridge 层 → 后端 spawn Claude 子进程
                         ↓
                  stdout NDJSON 逐行解析
                         ↓
            ┌─── delta (流式文本) ──→ 逐字渲染
            ├─── status / trace ──→ 工具调用面板
            ├─── permission-request ──→ 权限对话框
            ├─── plan-mode-request ──→ Plan 审批卡片
            ├─── ask-user-question ──→ 用户问答卡片
            └─── complete / error ──→ 消息完成或错误
                         ↓
              用户响应 → 写入 Claude stdin → 继续执行
```

**会话状态**：`idle` → `responding` → `awaiting_reply` → `idle`，前端实时反映每个 Session 的活动状态。

**数据持久化**：所有会话数据（元数据 + 完整消息历史）保存在本地 JSON 文件中（默认 `~/.EasyAIFlow/`），支持跨重启恢复。

**上下文引用**：在 Composer 中输入 `[[session:xxx]]` 或 `[[streamwork:xxx]]`，可将其他会话或 Streamwork 的历史摘要/全文注入当前对话上下文，实现跨 Session 的知识传递。

### English

At its core, EasyAIFlow is a **session-driven** Claude CLI integration. Each Session manages an independent Claude child process lifecycle:

```
User message → Bridge layer → Backend spawns Claude child process
                                ↓
                      stdout NDJSON line-by-line parsing
                                ↓
               ┌─── delta (streaming text) ──→ progressive render
               ├─── status / trace ──→ tool-call panel
               ├─── permission-request ──→ permission dialog
               ├─── plan-mode-request ──→ plan approval card
               ├─── ask-user-question ──→ user question card
               └─── complete / error ──→ message done or error
                                ↓
                 User response → write to Claude stdin → resume
```

**Session states**: `idle` → `responding` → `awaiting_reply` → `idle`, reflected in real-time in the UI.

**Persistence**: All session data (metadata + full message history) is saved to a local JSON file (default `~/.EasyAIFlow/`), surviving app restarts.

**Context references**: Type `[[session:xxx]]` or `[[streamwork:xxx]]` in the Composer to inject another session's or streamwork's history (summary or full) into the current conversation context — enabling cross-session knowledge transfer.

---

## Harness 多智能体编排 / Harness Multi-Agent Orchestration

### 中文

Harness 是 EasyAIFlow 的多智能体编排系统。用户的任务可以从普通 Session 一键升级为 Harness 流水线，由三个专业角色协同完成：

| 角色 | 职责 |
|------|------|
| **Planner（规划者）** | 将用户需求展开为产品规格与迭代计划 |
| **Generator（生成者）** | 根据迭代合约实现代码，生成交付物 |
| **Evaluator（评审者）** | 审核合约、验证实现，给出 QA 评分 |

**Sprint 工作流**：

```
规划阶段
  └─ Planner 生成 product-spec.md + handoff.md

Sprint 循环 (1..maxSprints):
  ├─ 合约阶段：Generator 提出合约 → Evaluator 审批/修订
  ├─ 实现阶段：Generator 编码实现 → Evaluator 质量验收
  └─ 决策：APPROVED → 下一 Sprint | REVISE → 重试 | DONE → 提前完成

完成：汇总所有产出物
```

**产出物目录**（自动生成）：

```
{artifactDir}/
├── manifest.json           # 流水线状态 + 时间线
├── product-spec.md         # 产品需求规格
├── sprint-contract.md      # 当前 Sprint 合约
├── evaluation-report.md    # QA 评审报告
└── handoff.md              # 进展、风险、下一步
```

**配置项**：支持 `maxSprints`、`maxContractRounds`、`maxImplementationRounds`、`effort`（low/medium/high/max）等参数。

### English

Harness is the multi-agent orchestration system in EasyAIFlow. Any standard session can be upgraded to a Harness pipeline with one click, coordinating three specialized roles:

| Role | Responsibility |
|------|---------------|
| **Planner** | Expands user requirements into a product spec and sprint plan |
| **Generator** | Implements code per sprint contract, produces deliverables |
| **Evaluator** | Reviews contracts, validates implementations, provides QA scores |

**Sprint workflow**:

```
Planning Phase
  └─ Planner generates product-spec.md + handoff.md

Sprint Loop (1..maxSprints):
  ├─ Contract phase: Generator proposes → Evaluator approves/revises
  ├─ Implementation phase: Generator codes → Evaluator validates (QA)
  └─ Decision: APPROVED → next sprint | REVISE → retry | DONE → finish early

Completion: all artifacts collected
```

**Artifact directory** (auto-generated):

```
{artifactDir}/
├── manifest.json           # Pipeline state + timeline
├── product-spec.md         # Product requirements
├── sprint-contract.md      # Current sprint contract
├── evaluation-report.md    # QA evaluation report
└── handoff.md              # Progress, risks, next steps
```

**Configuration**: `maxSprints`, `maxContractRounds`, `maxImplementationRounds`, `effort` (low/medium/high/max), and more.

---

## 交互式对话系统 / Interactive Dialog System

### 中文

Claude 在执行过程中可能暂停并请求用户输入，EasyAIFlow 支持三种交互机制：

| 类型 | 触发场景 | 用户操作 |
|------|---------|---------|
| **Permission Request** | Claude 需要访问文件/执行命令 | 允许 / 拒绝（支持路径级别持久授权） |
| **Plan Mode** | Claude 进入计划模式等待审批 | 批准 / 修订 / 手动执行（支持多种审批策略） |
| **Ask User Question** | Claude 向用户提出多选/单选问题 | 选择答案 + 可选备注 |

在 Harness 模式下，这些对话框以**内联卡片**形式嵌入各角色的消息流中，而非弹出式对话框，实现多角色并行交互。

### English

Claude may pause execution to request user input. EasyAIFlow supports three interactive mechanisms:

| Type | Trigger | User Action |
|------|---------|-------------|
| **Permission Request** | Claude needs file/command access | Allow / Deny (with path-level persistent authorization) |
| **Plan Mode** | Claude enters planning and awaits approval | Approve / Revise / Manual execute (multiple approval strategies) |
| **Ask User Question** | Claude asks single/multi-choice questions | Select answer(s) + optional notes |

In Harness mode, these dialogs render as **inline cards** within each role's message stream (not modal popups), enabling parallel interaction across multiple roles.

---

## 双运行时架构 / Dual Runtime Architecture

### 中文

```
┌─────────────────────────────────────────────────────────┐
│                    React 前端 (src/)                      │
│          bridge.ts — 自动检测并适配运行时                    │
└────────────┬───────────────────────┬────────────────────┘
             │                       │
    ┌────────▼────────┐    ┌────────▼─────────┐
    │   Electron IPC   │    │   HTTP JSON-RPC   │
    │  (桌面模式)       │    │   + SSE 事件流     │
    │  preload.cts     │    │   (Web 模式)       │
    │  main.ts         │    │   server.ts        │
    └────────┬────────┘    └────────┬─────────┘
             │                       │
    ┌────────▼───────────────────────▼────────┐
    │         backend/ — 共享业务逻辑            │
    │   Claude CLI 交互 · Harness 编排 · 持久化  │
    └─────────────────────────────────────────┘
```

### English

```
┌──────────────────────────────────────────────────────────┐
│                   React Frontend (src/)                    │
│           bridge.ts — auto-detects runtime adapter         │
└────────────┬────────────────────────┬────────────────────┘
             │                        │
    ┌────────▼─────────┐    ┌────────▼──────────┐
    │   Electron IPC    │    │   HTTP JSON-RPC    │
    │  (Desktop mode)   │    │   + SSE events      │
    │  preload.cts      │    │   (Web mode)        │
    │  main.ts          │    │   server.ts         │
    └────────┬─────────┘    └────────┬──────────┘
             │                        │
    ┌────────▼────────────────────────▼─────────┐
    │          backend/ — shared business logic   │
    │   Claude CLI · Harness orchestration · I/O  │
    └────────────────────────────────────────────┘
```

---

## 技术栈 / Tech Stack

| 层级 / Layer | 技术 / Technology |
|---|---|
| 前端 / Frontend | React 19, React Markdown, Remark GFM, Vite 7 |
| 桌面 / Desktop | Electron 37, Electron Builder (NSIS) |
| 后端 / Backend | Node.js 20+, TypeScript 5.9 (strict), tsx |
| 通信 / Communication | NDJSON streaming, IPC (desktop), JSON-RPC + SSE (web) |
| 持久化 / Persistence | Local JSON file store |

---

## 快速开始 / Getting Started

### 前置要求 / Prerequisites

- Node.js 20+
- npm 10+
- 本地已安装可用的 [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) / A working local `claude` CLI installation
- Windows（桌面模式）/ Any OS（Web 模式）

### 安装 / Install

```bash
git clone https://github.com/anthropics/EasyAIFlow.git   # or your fork
cd EasyAIFlow
npm install
```

### 启动开发 / Start Development

```bash
# 桌面模式（Electron + Vite）/ Desktop mode
npm run dev

# Web 模式（HTTP 服务 + Vite）/ Web mode
npm run dev:web
```

---

## 命令参考 / Commands

| 命令 / Command | 说明 / Description |
|---|---|
| `npm run dev` | 启动桌面开发（Vite + Electron）/ Start desktop dev (Vite + Electron) |
| `npm run dev:web` | 启动 Web 开发（Vite + HTTP 服务）/ Start web dev (Vite + HTTP server) |
| `npm run dev:web:client` | 仅启动 Vite 前端（端口 4173）/ Vite frontend only (port 4173) |
| `npm run dev:server` | 仅启动 Web 后端 / Web server only |
| `npm run check` | TypeScript 类型检查（tsc -b）/ Type check all configs |
| `npm run build` | 完整构建：类型检查 + Vite + Electron / Full build |
| `npm run build:web` | Web 构建：类型检查 + Vite + 服务端 / Web-only build |
| `npm run package:win` | 构建 + 打包 Windows NSIS 安装程序 / Build + Windows installer |
| `npm run start:web` | 运行已构建的 Web 服务 / Run built web server |

---

## 项目结构 / Project Structure

```
EasyAIFlow/
├── src/                          # React 前端 / Frontend
│   ├── App.tsx                   # 主组件与状态管理 / Main component & state
│   ├── bridge.ts                 # 双运行时抽象层 / Dual runtime abstraction
│   ├── components/               # UI 组件 / UI components
│   │   ├── ChatThread.tsx        #   聊天消息流 / Chat message stream
│   │   ├── ChatComposer.tsx      #   消息输入 / Message input
│   │   ├── ChatHistory.tsx       #   左侧导航 / Left panel navigation
│   │   ├── ContextPanel.tsx      #   右侧上下文 / Right context panel
│   │   ├── HarnessDashboard.tsx  #   Harness 编排面板 / Harness orchestration
│   │   ├── BtwPanel.tsx          #   BTW 快问面板 / Quick query panel
│   │   ├── PlanModeDialog.tsx    #   Plan 审批 / Plan approval
│   │   ├── AskUserQuestionDialog.tsx  #   用户问答 / User Q&A
│   │   └── PermissionDialog.tsx  #   权限请求 / Permission request
│   └── data/                     # 共享类型与逻辑 / Shared types & logic
│       ├── types.ts              #   所有 TypeScript 类型定义 / All type defs
│       ├── planMode.ts           #   Plan 模式处理 / Plan mode handling
│       ├── askUserQuestion.ts    #   用户问答处理 / Question handling
│       └── permissionRequest.ts  #   权限请求处理 / Permission handling
├── electron/                     # Electron 主进程 / Main process
│   ├── main.ts                   #   入口 & IPC 注册 / Entry & IPC handlers
│   ├── claudeSpawn.ts            #   Claude 进程管理 / Process spawning
│   ├── claudeControlMessages.ts  #   控制消息解析 / Control message parsing
│   └── sessionStore.ts           #   会话持久化 / Session persistence
├── backend/                      # 共享后端逻辑 / Shared backend
│   ├── harnessOrchestrator.ts    #   Harness 编排器 / Orchestrator
│   ├── claudeInteraction.ts      #   Claude CLI 交互 / CLI interaction
│   └── claudeRpcOperations.ts    #   RPC 操作实现 / RPC operations
├── server/
│   └── server.ts                 # Web HTTP 服务 / Web HTTP server
├── tests/                        # 测试文件（tsx 直接运行）/ Tests (run with tsx)
├── CLAUDE.md                     # Claude Code 开发指南 / Dev instructions
└── package.json
```

---

## 数据模型 / Data Model

```
ProjectRecord[]                     # 项目 / Projects
  └─ DreamRecord[]                  # Streamwork（任务线）/ Task streams
     └─ SessionSummary[]            # 会话 / Sessions
        │   kind: standard          #   普通对话 / Standard conversation
        │   kind: harness           #   Harness 根会话 / Harness root
        │   kind: harness_role      #   Harness 角色子会话 / Harness role sub-session
        └─ ConversationMessage[]    # 消息记录 / Messages
```

---

## License

MIT — see [LICENSE](./LICENSE).
