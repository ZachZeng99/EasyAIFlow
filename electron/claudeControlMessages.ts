import {
  buildAskUserQuestionResultText,
  parseAskUserQuestions,
  type AskUserQuestion,
  type AskUserQuestionResponsePayload,
} from '../src/data/askUserQuestion.js';
import {
  buildPlanModeEnteredText,
  buildPlanModeResponseText,
  isPlanModeToolName,
  type PlanModeRequest,
  type PlanModeResponsePayload,
  type PlanModeToolName,
} from '../src/data/planMode.js';

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

export type ClaudePlanModeControlRequest = {
  requestId: string;
  toolUseId?: string;
  toolName: PlanModeToolName;
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
  if (toolName === 'AskUserQuestion' || isPlanModeToolName(toolName)) {
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

export const parseClaudePlanModeControlRequest = (
  parsed: Record<string, unknown>,
): ClaudePlanModeControlRequest | null => {
  if (parsed.type !== 'control_request') {
    return null;
  }

  const request = asObject(parsed.request);
  const requestId = getString(parsed.request_id);
  const toolName = request?.tool_name;
  if (!request || !requestId || request.subtype !== 'can_use_tool' || !isPlanModeToolName(toolName)) {
    return null;
  }

  return {
    requestId,
    toolUseId: getString(request.tool_use_id),
    toolName,
    rawInput: asObject(request.input) ?? {},
  };
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
  denyMessage?: string,
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
              message: denyMessage ?? 'User denied this action in EasyAIFlow.',
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

export const buildClaudePlanModeToolResultLine = (payload: {
  request: PlanModeRequest;
  response?: PlanModeResponsePayload;
}) => {
  const resultText =
    payload.request.toolName === 'EnterPlanMode'
      ? buildPlanModeEnteredText()
      : payload.response
        ? buildPlanModeResponseText(payload.request, payload.response)
        : 'Plan mode update acknowledged.';

  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: resultText,
          tool_use_id: payload.request.toolUseId,
        },
      ],
    },
    toolUseResult: {
      planMode: {
        request: payload.request,
        response: payload.response,
      },
    },
  });
};
