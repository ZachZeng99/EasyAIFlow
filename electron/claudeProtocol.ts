/** CLI transport fields changed casing while native transcript fields stayed compatible. */
export const normalizeClaudeProtocolMessage = (message: Record<string, unknown>) =>
  message.toolUseResult === undefined && message.tool_use_result !== undefined
    ? { ...message, toolUseResult: message.tool_use_result }
    : message;
