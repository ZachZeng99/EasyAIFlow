export type ClaudePermissionBehavior = 'allow' | 'deny';

export type ClaudePermissionControlRequest = {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  targetPath?: string;
  command?: string;
  description?: string;
  decisionReason?: string;
  sensitive: boolean;
  rawInput: Record<string, unknown>;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

const pickTargetPath = (input: Record<string, unknown>) =>
  getString(input.file_path) ??
  getString(input.path) ??
  getString(input.target_path) ??
  getString(input.new_path) ??
  getString(input.old_path);

const isSensitiveRequest = (targetPath: string | undefined, decisionReason: string | undefined) => {
  const normalizedPath = targetPath?.replace(/\//g, '\\').toLowerCase();
  const normalizedReason = decisionReason?.toLowerCase();
  return Boolean(
    normalizedPath?.includes('\\.claude\\projects\\') ||
    normalizedPath?.includes('\\.claude\\memory\\') ||
    normalizedReason?.includes('sensitive'),
  );
};

export const buildClaudeUserMessageLine = (prompt: string) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  });

export const parseClaudePermissionControlRequest = (
  parsed: Record<string, unknown>,
): ClaudePermissionControlRequest | null => {
  if (parsed.type !== 'control_request') {
    return null;
  }

  const request = asObject(parsed.request);
  const requestId = getString(parsed.request_id);
  const toolName = getString(request?.tool_name);
  const rawInput = asObject(request?.input);
  if (!request || !requestId || request.subtype !== 'can_use_tool' || !toolName || !rawInput) {
    return null;
  }

  const targetPath = pickTargetPath(rawInput);
  const command = getString(rawInput.command);
  const description = getString(rawInput.description);
  const decisionReason = getString(request.decision_reason);

  return {
    requestId,
    toolUseId: getString(request.tool_use_id),
    toolName,
    targetPath,
    command,
    description,
    decisionReason,
    sensitive: isSensitiveRequest(targetPath, decisionReason),
    rawInput,
  };
};

export const buildClaudeControlResponseLine = (
  request: ClaudePermissionControlRequest,
  behavior: ClaudePermissionBehavior,
) =>
  JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: request.requestId,
      response:
        behavior === 'allow'
          ? {
              behavior: 'allow',
              updatedInput: request.rawInput,
            }
          : {
              behavior: 'deny',
              message: 'User denied this action in EasyAIFlow.',
            },
    },
  });
