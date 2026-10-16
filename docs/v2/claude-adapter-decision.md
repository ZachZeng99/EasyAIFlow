# Claude 接入方式：首版决策

日期：2026-10-16。

首版继续直接管理原生 Claude CLI，将协议适配限制在 provider 层；领域事件、持久化和客户端与 SDK 解耦，后续可单独替换适配器。

- 本机 `2.1.284` 已通过真实回复、关闭客户端后继续执行及重复请求防重测试。
- 已验证公开 `initialize` 控制响应直接返回模型、命令和能力信息，目录发现无需模型生成，也不依赖二进制中发现的内部 `list_models`。
- 官方 Agent SDK 同样运行 Claude Code 二进制，仍需处理进程生命周期和 EAF 自己的同步；采用 SDK 还需验证认证、打包和会话迁移条件。参考[官方说明](https://code.claude.com/docs/en/agent-sdk/overview)。
- 本决策不代表全部协议已验收；审批、提问、嵌套 agent、resume/fork 和未知事件处理继续逐项验证，不能由简单回复测试替代。

提问协议已补充实测：AskUserQuestion 必须等待用户输入后，再以 `updatedInput.questions/answers` 返回控制响应。提前允许空答案或注入普通 `user/tool_result` 都不能替代该交互。已通过断开客户端后重连回答的真实测试；参考[官方用户输入说明](https://code.claude.com/docs/en/agent-sdk/user-input)。
