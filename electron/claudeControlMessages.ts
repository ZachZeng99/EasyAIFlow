import {
  buildAskUserQuestionResultText,
  parseAskUserQuestions,
  type AskUserQuestion,
  type AskUserQuestionResponsePayload,
} from '../src/data/askUserQuestion.js';
import type { PlanModeAllowedPrompt } from '../src/data/types.js';

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

export type ClaudeAskUserQuestionControlRequest = {
  requestId: string;
  toolUseId: string;
  toolName: 'AskUserQuestion';
  questions: AskUserQuestion[];
  rawInput: Record<string, unknown>;
};

const planModeControlToolPattern = /^(Enter|Exit)PlanMode$/i;
export type ClaudePlanModeControlRequest = {
  requestId: string;
  toolUseId?: string;
  toolName: 'EnterPlanMode' | 'ExitPlanMode';
  plan: string;
  planFilePath?: string;
  allowedPrompts: PlanModeAllowedPrompt[];
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
  if (toolName === 'AskUserQuestion' || planModeControlToolPattern.test(toolName)) {
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

export const isPlanModeClaudeControlRequest = (
  request: Pick<ClaudePermissionControlRequest, 'toolName'>,
) => planModeControlToolPattern.test(request.toolName);

export const parseClaudePlanModeControlRequest = (
  parsed: Record<string, unknown>,
): ClaudePlanModeControlRequest | null => {
  if (parsed.type !== 'control_request') {
    return null;
  }

  const request = asObject(parsed.request);
  const requestId = getString(parsed.request_id);
  const toolName = getString(request?.tool_name);
  const rawInput = asObject(request?.input);
  if (
    !request ||
    !requestId ||
    request.subtype !== 'can_use_tool' ||
    !toolName ||
    !planModeControlToolPattern.test(toolName) ||
    !rawInput
  ) {
    return null;
  }

  const rawAllowedPrompts = Array.isArray(rawInput.allowedPrompts) ? rawInput.allowedPrompts : [];
  const allowedPrompts = rawAllowedPrompts
    .map((item) => {
      const record = asObject(item);
      const tool = getString(record?.tool);
      const prompt = getString(record?.prompt);
      return tool && prompt ? { tool, prompt } : null;
    })
    .filter((item): item is PlanModeAllowedPrompt => Boolean(item));
  const plan = getString(rawInput.plan) ?? '';
  const planFilePath = getString(rawInput.planFilePath);

  return {
    requestId,
    toolUseId: getString(request.tool_use_id),
    toolName: toolName as 'EnterPlanMode' | 'ExitPlanMode',
    plan,
    planFilePath,
    allowedPrompts,
    rawInput,
  };
};

export const parseClaudePlanModeToolInput = (
  toolName: string | undefined,
  input: unknown,
) => {
  if (!toolName || !planModeControlToolPattern.test(toolName)) {
    return null;
  }

  const rawInput = asObject(input);
  if (!rawInput) {
    return null;
  }

  const rawAllowedPrompts = Array.isArray(rawInput.allowedPrompts) ? rawInput.allowedPrompts : [];
  const allowedPrompts = rawAllowedPrompts
    .map((item) => {
      const record = asObject(item);
      const tool = getString(record?.tool);
      const prompt = getString(record?.prompt);
      return tool && prompt ? { tool, prompt } : null;
    })
    .filter((item): item is PlanModeAllowedPrompt => Boolean(item));

  return {
    toolName: toolName as 'EnterPlanMode' | 'ExitPlanMode',
    plan: getString(rawInput.plan) ?? '',
    planFilePath: getString(rawInput.planFilePath),
    allowedPrompts,
    rawInput,
  };
};

export const buildClaudePlanModeToolResultLine = (payload: {
  toolUseId: string;
  approved: boolean;
  plan: string;
  planFilePath?: string;
  notes?: string;
}) => {
  if (!payload.approved) {
    const feedback = payload.notes?.trim() || 'Please revise the plan and try again.';
    const content =
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n" +
      feedback;

    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content,
            is_error: true,
            tool_use_id: payload.toolUseId,
          },
        ],
      },
      toolUseResult: `Error: ${content}`,
    });
  }

  const content = [
    'User has approved your plan. You can now start coding. Start with updating your todo list if applicable',
    payload.planFilePath ? `\n\nYour plan has been saved to: ${payload.planFilePath}` : '',
    payload.planFilePath ? '\nYou can refer back to it if needed during implementation.' : '',
    payload.plan ? `\n\n## Approved Plan:\n${payload.plan}` : '',
  ].join('');

  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content,
          tool_use_id: payload.toolUseId,
        },
      ],
    },
    toolUseResult: {
      plan: payload.plan,
      isAgent: false,
      filePath: payload.planFilePath,
    },
  });
};

export const parseClaudeAskUserQuestionControlRequest = (
  parsed: Record<string, unknown>,
): ClaudeAskUserQuestionControlRequest | null => {
  if (parsed.type !== 'control_request') {
    return null;
  }

  const request = asObject(parsed.request);
  const requestId = getString(parsed.request_id);
  const toolName = getString(request?.tool_name);
  const rawInput = asObject(request?.input);
  const toolUseId = getString(request?.tool_use_id);
  if (
    !request ||
    !requestId ||
    request.subtype !== 'can_use_tool' ||
    toolName !== 'AskUserQuestion' ||
    !rawInput ||
    !toolUseId
  ) {
    return null;
  }

  const questions = parseAskUserQuestions(rawInput);
  if (questions.length === 0) {
    return null;
  }

  return {
    requestId,
    toolUseId,
    toolName: 'AskUserQuestion',
    questions,
    rawInput,
  };
};

export const buildClaudeControlResponseLine = (
  request: Pick<ClaudePermissionControlRequest, 'requestId' | 'rawInput'>,
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

export const buildClaudeAskUserQuestionToolResultLine = (payload: {
  toolUseId: string;
  questions: AskUserQuestion[];
  response: AskUserQuestionResponsePayload;
}) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: buildAskUserQuestionResultText(payload.questions, payload.response),
          tool_use_id: payload.toolUseId,
        },
      ],
    },
    toolUseResult: {
      questions: payload.questions,
      answers: payload.response.answers,
      annotations: payload.response.annotations,
    },
  });
