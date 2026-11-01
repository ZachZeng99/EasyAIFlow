# EAF v2：Claude Code 集成需求与情报来源

> 日期：2026-10-16
> 对比基线：EAF 当前实现参照 Claude Code **v2.1.88**（`D:\AIAgent\claude-code-sourcemap`）；本机已安装 **v2.1.284**。
> 目的：为 v2 重构提供“CLI 已经能做、EAF 还没做/做错了”的需求清单，以及**如何自行持续获取一手信息**的方法。
>
> 证据等级：
> - **[CL]** 官方 CHANGELOG 明确记载
> - **[HELP]** 本机 `claude --help` 可见
> - **[BIN]** 仅在本机二进制字符串中出现，未公开文档，接入前必须先核实结构
> - **[EAF]** EAF 现状（引用代码位置）

---

## 1. 核心判断（给重构定方向）

1. **协议在高速演进**：v2.1.88 → v2.1.284 之间，二进制里 `subtype` 字面量从 38 个增长到 ~136 个。手写 NDJSON 协议 + 硬编码分支的方式（当前集中在 `backend/claudeInteraction.ts`，约 3900 行）无法持续跟进。
2. **v2 首个架构决策：是否改用官方 Agent SDK**（`@anthropic-ai/claude-agent-sdk`，2026-10 时为 0.3.x，周更）。SDK 封装的就是同一套 stream-json/control 协议并随 CLI 同步更新。
   - 选 SDK：协议维护成本转移给上游；需评估 Electron 主进程 / web server 双运行时下的打包与子进程管理。
   - 继续自管 CLI：必须做到第 3 节的“协议层”要求，否则每次 CLI 升级都会回归。
   - 无论哪种，**都应保留一个 EAF 自己的领域事件层**，UI 不直接消费 CLI 原始消息。
3. **数据模型要从“单线程消息列表”升级为“会话内 agent 树”**：子 agent 嵌套输出、后台任务、Workflow、Monitor、跨会话 SendMessage 都要求如此。
4. **能力应运行时发现，不应写死**：模型列表、斜杠命令、工具集、权限模式都能从 CLI 获取。

---

## 2. 情报来源（如何持续获取一手信息）

v2 应把“跟进 CLI 变化”做成可重复流程，而不是一次性调研。

| 来源 | 获取方式 | 用途 |
|---|---|---|
| 官方 CHANGELOG | `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` | 版本级功能/破坏性变更，最权威 |
| 官方文档 | `https://code.claude.com/docs`（headless / Agent SDK / hooks / settings / permissions 章节） | 公开协议与参数语义 |
| Agent SDK 类型定义 | `npm pack @anthropic-ai/claude-agent-sdk` 后读 `.d.ts`（`SDKMessage`、`SDKControlRequest` 等联合类型） | **公开协议的事实标准**，比 CHANGELOG 更精确；可直接作为 v2 协议类型来源 |
| 本机 CLI 帮助 | `claude --help`、`claude <sub> --help`（mcp / plugin / agents / attach …） | 当前可用 flag 与子命令 |
| 本机二进制 | `grep -aoE 'subtype:"[a-z_]+"' ~/.local/bin/claude \| sort -u` | 全部消息/控制请求子类型清单（含未公开） |
| 二进制上下文 | `grep -aoE '.{0,200}subtype:"list_models".{0,300}' ~/.local/bin/claude` | 查看某个子类型的请求/响应字段（压缩代码，需人工辨读） |
| 恢复源码 | `D:\AIAgent\claude-code-sourcemap\restored-src\src\`（v2.1.88） | 旧协议细节：`entrypoints/sdk/controlSchemas.ts`、`coreSchemas.ts`、`cli/structuredIO.ts`、`cli/print.ts` |
| 真实抓包 | 跑一次 `claude -p --output-format stream-json --input-format stream-json --verbose ...`，把 stdout 原样落盘 | 最终依据；建议沉淀为 v2 的协议回放测试夹具 |
| 本地 transcript | `~/.claude/projects/<project>/*.jsonl` | 会话持久化格式（导入/恢复/分叉依赖它） |

**建议 v2 内置的流程**：
- 维护一份 `protocol-snapshot`（CLI 版本号 + subtype 清单 + `--help` 输出），CI 或手动脚本对比本机 CLI，出现新增/删除时生成差异报告。
- 运行时遇到**未知** `type`/`subtype` 时记录（开发模式可在 UI 显示），而不是静默丢弃——这是最便宜的“新功能雷达”。
- 项目约定仍然有效：涉及 Claude 的改动先对照上述来源核实，再实现。

---

## 3. 需求清单

### P0 — 兼容性（现在已经/即将出错）

| # | 需求 | 依据 | EAF 现状 |
|---|---|---|---|
| P0-1 | 权限模式支持 `manual`（`default` 已改名），完整模式集：`acceptEdits / auto / bypassPermissions / manual / dontAsk / plan` | [CL] 2.1.200，[HELP] | [EAF] 已实现（2026-11-01）：会话级权限模式，默认仍为 `bypassPermissions`；`manual` 按 `default` 处理 |
| P0-2 | 任务面板不能依赖 TodoWrite / TaskCreate：新模型（Opus 4.8、Sonnet 5、Fable 5 及以后）默认不提供，除非 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`。需决定：设该环境变量，或改用 `task_*` / `background_tasks_changed` 事件驱动 | [CL] 2.1.233、2.1.268 | [EAF] `electron/claudeTaskListState.ts` 依赖 `toolUseResult.task` |
| P0-3 | 已移除工具：TaskOutput（2.1.277，改为 Read 读输出文件）、TeamCreate/TeamDelete（2.1.178，改为 Agent 工具的 `name` 参数）；Task 工具的 `mode` 参数废弃（2.1.212） | [CL] | 需排查渲染逻辑 |
| P0-4 | AskUserQuestion 默认不再自动继续，EAF 的等待/超时逻辑需对齐 | [CL] 2.1.200 | 需验证 |
| P0-5 | 协议层对未知消息**可观测**（记录 + 开发模式显示），已知但未处理的至少不报错 | — | [EAF] `compact_boundary`、`rate_limit`、`status`、hook 事件等被忽略 |
| P0-6 | SIGTERM 行为变化：print 模式不再写中断回合/伪造拒绝，退出码 143。停止/恢复逻辑需对齐 | [CL] 2.1.236 | 需验证 `electron/sessionStop.ts` |
| P0-7 | system prompt 快照：同一会话 resume 时重放首次记录的 system prompt（`--system-prompt-snapshot on\|off`）。若 v2 在 resume 之间改 `--append-system-prompt`，需显式处理 | [CL] 2.1.267 | 需评估 |

### P1 — 体验补齐（CLI 已支持，EAF 缺失）

| # | 需求 | 依据 | 备注 |
|---|---|---|---|
| P1-1 | **实时 thinking 展示** | stream `thinking_delta`；[BIN] `thinking`、`thinking_tokens` | [EAF] 流式 thinking 被丢弃，仅导入时可见 |
| P1-2 | **子 agent 嵌套视图**：启用 `--forward-subagent-text`，按 `parent_tool_use_id` 建树 | [CL] 2.1.211，2.1.219 起支持多层 | 依赖第 1 节的 agent 树模型 |
| P1-3 | **权限模式切换 UI**：通过 `set_permission_mode` 控制请求实时切换；展示 `permission_denied`（含子 agent id）和 auto 模式拒绝原因 | 旧协议已有；[BIN] `permission_denied`；[CL] 2.1.193、2.1.284 “allow once” | [EAF] 部分：模式切换与 `status` 回传已实现；`permission_denied` 展示未做 |
| P1-4 | **模型选择改为运行时获取**：`list_models` 控制请求；处理 `model_fallback` / `model_refusal_fallback`；支持 `--fallback-model` 多模型 | [BIN]；[CL] 2.1.166 | [EAF] `electron/claudeModel.ts` 硬编码别名 |
| P1-5 | **费用与用量**：读 `result.total_cost_usd`；`get_session_cost` / `get_usage` / `get_context_usage` | 旧协议有 `get_context_usage`；其余 [BIN] | [EAF] 有上下文条，无费用 |
| P1-6 | **斜杠命令运行时同步**：用 `system/init.slash_commands` + `commands_changed`，取消“Reply with only OK”探测进程 | [BIN] | [EAF] `backend/claudeInteraction.ts:3800` 起的探测 |
| P1-7 | **effort 用正规通道**：新增 `xhigh`、Ultracode 独立开关、按会话保存的 effort；[BIN] `per_turn_effort_changed` | [CL] 2.1.111、2.1.257、2.1.280、2.1.284 | [EAF] 目前发 `/effort X` 提示词，且改 effort 会 fork 会话 |
| P1-8 | **后台任务面板**：消费 `background_tasks_changed`（全量替换语义）、`task_updated`、`task_summary` | [BIN] | 替代零散的 task_started/progress/notification 拼装 |
| P1-9 | **图片附件以内容块发送**（stream-json user message 的 image block），而非在提示词中写路径 | 协议能力 | [EAF] 目前只写路径 |
| P1-10 | **启动诊断**：展示 `system/init` 中的 `plugin_errors`、`mcp_server_errors` | [CL] 2.1.111、2.1.219、2.1.283 | |
| P1-11 | **回合元信息**：`turn_duration`、`api_error`/重试、`rate_limit`、`compact_boundary`（压缩标记） | [BIN] / 旧协议 | |

### P2 — 新能力（v2 差异化机会）

| # | 需求 | 依据 |
|---|---|---|
| P2-1 | **Rewind / 检查点**：`rewind_files` 控制请求 + 消息级回退 UI | 旧协议已有；[CL] 2.1.191 |
| P2-2 | **MCP 管理面板**：`mcp_status` / `mcp_toggle` / `mcp_reconnect` / `mcp_set_servers`；`claude mcp login/logout` | 旧协议已有；[CL] 2.1.186 |
| P2-3 | **新工具专门渲染**：Monitor（2.1.98）、Workflow（2.1.154）、Artifact、SendMessage/ListAgents（2.1.224）、EnterWorktree（2.1.105 加 `path`）、Bash 附带文件 diff（2.1.269） | [CL] |
| P2-4 | **下一步建议**：`--prompt-suggestions` → `prompt_suggestion` 消息，做成输入框旁可点击的建议 | [HELP] |
| P2-5 | **会话中途调整**：`register_repo_root`（加工作目录）、`set_cwd`、`rename_session`、`update_settings`、`/config key=value`、`/goal`、`/output-style` | [CL] 2.1.219、2.1.181、2.1.139、2.1.269；部分 [BIN] |
| P2-6 | **@ 文件补全**：`file_suggestions` 控制请求 | [BIN] |
| P2-7 | **后台会话接入**：`--bg`、`claude attach/logs/stop/respawn/rm`、`claude agents --json`，可列出并接管非 EAF 启动的会话 | [CL] 2.1.144、2.1.145、2.1.251 |
| P2-8 | **Hooks 可视化**：`--include-hook-events`，hook 进度/结果；新事件 `PermissionDenied`、`MessageDisplay`、`Pre/PostModelSwitch`、`DirectoryAdded`；PreToolUse 的 `defer` 决策 | [HELP]；[CL] 2.1.89、2.1.152、2.1.219、2.1.251 |
| P2-9 | **无人值守模式**：`--permission-prompts none`（会询问的操作一律自动拒绝）、`--max-budget-usd`、`--json-schema` 结构化输出 | [CL] 2.1.259；[HELP] |
| P2-10 | **Skills / 插件**：`reload_skills`、`/reload-plugins`、`--plugin-dir`（可指向插件目录）、`claude plugin --json` | [CL] 2.1.152、2.1.260、2.1.265、2.1.268 |
| P2-11 | **定时任务与记忆**：`scheduled_task_fire`、`memory_saved`、`memory_recall` 的展示 | [BIN] |

---

## 4. 架构启发（供 v2 设计参考）

- **协议层**：`CLI 原始消息 → 带类型解析（按 type/subtype 分发表）→ EAF 领域事件 → 状态归约 → UI`。分发表要可扩展，单个新 subtype 应只需加一个 handler，不改主循环。
- **控制请求客户端**：统一的 `sendControlRequest(subtype, payload, {timeout, signal})`，按 `request_id` 匹配响应，支持 `control_request_progress`。当前 `set_model`、`interrupt`、`end_session` 各自实现的方式应收敛到这里。
- **会话状态**：会话 → agent 树（主 agent / 子 agent / 后台任务 / 队友）→ 每个节点有自己的消息流与状态；权限模式、模型、effort、cwd 都是会话的一级可变状态，而不是启动参数的副本。
- **能力注册表**：启动时从 `system/init` 和控制请求拉取模型、命令、工具、MCP 服务器、插件，变化事件增量更新；UI 只读注册表。
- **双运行时不变**：Electron IPC 与 web RPC/SSE 共享同一协议层与领域事件，`src/bridge.ts` 的抽象保留。
- **测试**：用真实抓包的 NDJSON 作为回放夹具（每个 CLI 大版本一份），协议层可以脱离 CLI 进程测试；对未知 subtype 的容错要有测试。
- **多 provider**：EAF 已有 Codex provider 和群聊；协议层抽象时把 provider 差异限制在“原始消息 → 领域事件”这一层。

---

## 5. 待核实 / 开放问题

1. 所有 **[BIN]** 控制请求（`list_models`、`get_session_cost`、`get_usage`、`file_suggestions`、`update_settings`、`rename_session`、`set_cwd`、`background_tasks` 等）的请求/响应字段尚未核实；其中部分在二进制中标注为 `@internal`，可能变动。优先以 Agent SDK 的 `.d.ts` 为准，SDK 未暴露的视为不稳定。
2. Agent SDK 与 EAF 的 Codex provider、群聊、BTW 旁聊（`--fork-session` + `--no-session-persistence`）如何共存。
3. 2.1.90 起 `-p`/SDK 会话不出现在终端 `--resume` 选择列表；v2 是否需要与终端会话互通（导入/接管）。
4. TodoWrite 默认关闭后，是启用 `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` 保留旧体验，还是转向新的任务事件模型。
