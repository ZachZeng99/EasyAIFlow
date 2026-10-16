# 群内 agent 通信（开发版）

在「群成员」勾选**允许群成员相互委派任务并等待回复**并保存。例如对 Codex 说：“完成修改后，请 Claude 审查，再根据它的意见修正。”原有不带 @ 的默认收件人、`@成员` 和 `@all` 保持原规则。

成员获得三个当前轮次专用工具：

| 工具 | 行为 |
| --- | --- |
| `team_members` | 列出本群启用的成员 |
| `team_send` | 用稳定请求 ID 委派任务，返回持久化投递 ID；此时只表示已入队 |
| `team_wait` | 最多等待 20 秒，返回排队/执行/已回复/失败/待确认及真实回复；可继续等待 |

对方的最终回复由等待工具传回请求者，并同时显示在群聊。收件人忙时排队，不向正在生成的回复强行插入。每条用户任务最多委派 16 次、深度 4 层；禁止回投祖先和互相等待形成的环。停止群聊会取消相关执行与队列。

委派回复不会抢走下一条用户消息的默认收件人；用户继续不带 `@` 发言时，仍交给最近直接回答用户任务的成员。

CLI 通过单轮专用 MCP 配置接入，不改全局 CLI 配置。工具权限在该轮结束时撤销；Claude 协作轮次会重新连接进程并恢复原生会话，确保旧后台调用不能串到新任务。发送先记录回执、再执行；未确认结果不能自动重跑。服务重启后的人工核对/恢复入口尚未完整提供。

当前只支持同一执行设备上的群成员；跨设备放置成员、任务依赖调度、独立 worktree 和自动合并尚未交付。团队成员仍按各自 CLI 的权限操作工作区；本功能不提供文件编辑隔离。

验证：`npx tsx tests/agentMessaging.test.ts`、`npx tsx tests/groupTurnLifecycle.test.ts`；`npm run smoke:team` 使用隔离 EAF 数据目录调用真实两种 CLI，检查两个方向的实际委派记录与回复，不能只靠模型声称成功。

接入依据：[Claude MCP 文档](https://code.claude.com/docs/en/mcp)、[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[MCP stdio 协议](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)，并对照本机 Claude 恢复源码和当前 Codex 的 `thread/start`、`thread/resume` 配置类型。
