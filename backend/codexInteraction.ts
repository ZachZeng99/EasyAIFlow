import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import {
  buildAttachmentFileName,
  buildMessageTitle,
  cloneMessageContextReferences,
  nowLabel,
} from './claudeHelpers.js';
import { buildContextReferencePrompt } from './claudeInteraction.js';
import {
  appendMessagesToSession,
  ensureSessionRecord,
  findSession,
  getProjects,
  setSessionRuntime,
  updateSessionContextReferences,
  updateAssistantMessage,
  upsertSessionMessage,
} from '../electron/sessionStore.js';
import { buildRecordedCodeChangeDiff } from '../electron/recordedCodeChangeDiff.js';
import { stopPendingSessionMessages } from '../electron/sessionStop.js';
import { getProviderDisplayName, normalizeSessionProvider } from '../src/data/sessionProvider.js';
import type {
  ConversationMessage,
  ContextReference,
  MessageAttachment,
  PendingAttachment,
  SessionSummary,
  TokenUsage,
} from '../src/data/types.js';

type CodexRunOptions = {
  model?: string;
  references?: ContextReference[];
  fullAuto?: boolean;
  resumeThread?: boolean;
  disabledFeatures?: string[];
  outputSchemaPath?: string;
  parseFinalMessage?: (raw: string) => string;
  transformAgentMessage?: (message: string) => string;
  stopOnAgentMessage?: (message: string) => boolean;
};

type ActiveCodexRun = {
  sessionId: string;
  assistantMessageId: string;
  child: ReturnType<typeof spawn>;
  stopped: boolean;
  completed: boolean;
  replyCaptured?: boolean;
  traceMessages: Map<string, ConversationMessage>;
};

const activeRuns = new Map<string, ActiveCodexRun>();

const isImageAttachment = (attachment: MessageAttachment) => attachment.mimeType.startsWith('image/');

export const toCodexTokenUsage = (usage: {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}): TokenUsage => {
  const input = usage.input_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return {
    contextWindow: 0,
    used: input + cached + output,
    input,
    output,
    cached,
    windowSource: 'unknown',
  };
};

export const emitRuntimeState = (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  phase: import('../src/data/types.js').SessionRuntimePhase,
  processActive: boolean,
) => {
  ctx.broadcastEvent({
    type: 'runtime-state',
    sessionId,
    runtime: {
      phase,
      processActive,
      updatedAt: Date.now(),
    },
  });
};

export const emitTraceMessage = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  message: ConversationMessage,
) => {
  await upsertSessionMessage(sessionId, message);
  ctx.broadcastEvent({
    type: 'trace',
    sessionId,
    message,
  });
};

const saveCodexAttachments = async (
  workspace: string,
  sessionId: string,
  attachments: PendingAttachment[],
): Promise<MessageAttachment[]> => {
  if (attachments.length === 0) {
    return [];
  }

  const dir = path.join(workspace, '.easyaiflow', 'attachments', sessionId);
  await mkdir(dir, { recursive: true });

  return Promise.all(
    attachments.map(async (attachment) => {
      const filePath = path.join(dir, buildAttachmentFileName(attachment));

      if (attachment.path) {
        await copyFile(attachment.path, filePath);
      } else if (attachment.dataUrl) {
        const [, base64 = ''] = attachment.dataUrl.split(',');
        await writeFile(filePath, Buffer.from(base64, 'base64'));
      } else {
        throw new Error(`Attachment ${attachment.name || attachment.id} is missing both path and data.`);
      }

      return {
        id: attachment.id,
        name: attachment.name,
        path: filePath,
        mimeType: attachment.mimeType,
        size: attachment.size,
      };
    }),
  );
};

export const buildCodexPromptWithAttachments = (
  prompt: string,
  attachments: MessageAttachment[],
  referenceContext?: string,
  instructionPrompt?: string,
) => {
  const parts: string[] = [];

  if (instructionPrompt?.trim()) {
    parts.push(instructionPrompt.trim());
  }

  if (referenceContext?.trim()) {
    parts.push(referenceContext.trim());
  }

  parts.push(prompt);

  if (attachments.length > 0) {
    const lines = attachments.map(
      (attachment) => `- ${attachment.path} (${attachment.mimeType || 'application/octet-stream'}, ${attachment.size} bytes)`,
    );
    parts.push(
      `Attached local files:\n${lines.join('\n')}\n\nPlease inspect these local files if they are relevant to the request.`,
    );
  }

  return parts.join('\n\n');
};

type CodexCommandExecutionItem = {
  id?: unknown;
  type?: unknown;
  command?: unknown;
  aggregated_output?: unknown;
  aggregatedOutput?: unknown;
  exit_code?: unknown;
  exitCode?: unknown;
  status?: unknown;
};

type CodexFunctionCallItem = {
  call_id?: unknown;
  id?: unknown;
  name?: unknown;
  tool?: unknown;
  arguments?: unknown;
  prompt?: unknown;
  result?: unknown;
  contentItems?: unknown;
  error?: unknown;
};

type CodexFunctionCallOutputItem = {
  call_id?: unknown;
  id?: unknown;
  output?: unknown;
  result?: unknown;
  contentItems?: unknown;
  error?: unknown;
};

const getString = (value: unknown) => (typeof value === 'string' ? value : '');

const normalizeCodexFunctionToolName = (value: string) =>
  value.trim().startsWith('functions.') ? value.trim().slice('functions.'.length) : value.trim();

const parseCodexFunctionArguments = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const stringifyCodexStructuredValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return stringifyCodexStructuredValue(entry);
        }

        const candidate = entry as Record<string, unknown>;
        if (typeof candidate.text === 'string') {
          return candidate.text.trim();
        }
        if (typeof candidate.message === 'string') {
          return candidate.message.trim();
        }
        return JSON.stringify(candidate);
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.text === 'string') {
      return candidate.text.trim();
    }
    if (Array.isArray(candidate.content)) {
      const nested = stringifyCodexStructuredValue(candidate.content);
      if (nested) {
        return nested;
      }
    }
    if (Array.isArray(candidate.contentItems)) {
      const nested = stringifyCodexStructuredValue(candidate.contentItems);
      if (nested) {
        return nested;
      }
    }
    if (typeof candidate.message === 'string') {
      return candidate.message.trim();
    }
    return JSON.stringify(candidate, null, 2).trim();
  }

  return '';
};

const extractCodexToolCallId = (item: CodexFunctionCallItem | CodexFunctionCallOutputItem) => {
  if (typeof item.call_id === 'string' && item.call_id.trim()) {
    return item.call_id;
  }

  if (typeof item.id === 'string' && item.id.trim()) {
    return item.id;
  }

  return undefined;
};

const extractCodexToolArgumentsText = (item: CodexFunctionCallItem | CodexFunctionCallOutputItem) => {
  const rawArguments = (item as { arguments?: unknown }).arguments;
  if (typeof rawArguments === 'string') {
    return rawArguments.trim();
  }

  if (rawArguments && typeof rawArguments === 'object') {
    return JSON.stringify(rawArguments, null, 2).trim();
  }

  if (typeof (item as { prompt?: unknown }).prompt === 'string') {
    return ((item as { prompt: string }).prompt).trim();
  }

  return '';
};

const extractCodexToolArgumentsObject = (item: CodexFunctionCallItem | CodexFunctionCallOutputItem) => {
  const rawArguments = (item as { arguments?: unknown }).arguments;
  if (rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)) {
    return rawArguments as Record<string, unknown>;
  }

  return extractCodexToolArgumentsText(item)
    ? parseCodexFunctionArguments(extractCodexToolArgumentsText(item))
    : undefined;
};

const extractCodexToolOutputText = (item: CodexFunctionCallItem | CodexFunctionCallOutputItem) => {
  const directOutput = stringifyCodexStructuredValue((item as { output?: unknown }).output);
  if (directOutput) {
    return directOutput;
  }

  const contentItems = stringifyCodexStructuredValue((item as { contentItems?: unknown }).contentItems);
  if (contentItems) {
    return contentItems;
  }

  const result = stringifyCodexStructuredValue((item as { result?: unknown }).result);
  if (result) {
    return result;
  }

  return stringifyCodexStructuredValue((item as { error?: unknown }).error);
};

const buildCodexCodeChangeSuccessLine = (toolName: string) => {
  switch (normalizeCodexFunctionToolName(toolName)) {
    case 'Edit':
    case 'MultiEdit':
      return 'The file has been updated successfully.';
    case 'Write':
      return 'The file has been written successfully.';
    case 'ApplyPatch':
    case 'apply_patch':
      return 'The file has been patched successfully.';
    default:
      return '';
  }
};

export const buildCodexCommandTraceMessage = (payload: {
  item: CodexCommandExecutionItem;
  status: 'running' | 'success' | 'error';
  previous?: ConversationMessage;
  timestamp?: string;
}) => {
  if (
    payload.item.type !== 'command_execution' &&
    payload.item.type !== 'commandExecution'
  ) {
    return null;
  }

  if (typeof payload.item.command !== 'string') {
    return null;
  }

  const command = payload.item.command.trim();
  if (!command) {
    return null;
  }

  const output =
    typeof payload.item.aggregated_output === 'string'
      ? payload.item.aggregated_output.trim()
      : typeof payload.item.aggregatedOutput === 'string'
        ? payload.item.aggregatedOutput.trim()
        : '';
  const exitCode =
    typeof payload.item.exit_code === 'number' && Number.isFinite(payload.item.exit_code)
      ? payload.item.exit_code
      : typeof payload.item.exitCode === 'number' && Number.isFinite(payload.item.exitCode)
        ? payload.item.exitCode
        : null;
  const contentParts = [command];
  if (output) {
    contentParts.push(output);
  }
  if (payload.status === 'error' && exitCode !== null) {
    contentParts.push(`Exit code: ${exitCode}`);
  }

  return {
    id: payload.previous?.id ?? randomUUID(),
    role: 'system' as const,
    kind: 'tool_use' as const,
    timestamp: payload.previous?.timestamp ?? payload.timestamp ?? nowLabel(),
    title: 'Command',
    content: contentParts.join('\n\n'),
    status: payload.status,
  };
};

export const buildCodexFunctionCallTraceMessage = (payload: {
  item: CodexFunctionCallItem | CodexFunctionCallOutputItem;
  status: 'running' | 'success' | 'error';
  previous?: ConversationMessage;
  timestamp?: string;
  title?: string;
  extraLines?: string[];
}) => {
  const callId = extractCodexToolCallId(payload.item);
  if (!callId) {
    return null;
  }

  const rawName =
    payload.title ??
    (typeof (payload.item as { name?: unknown }).name === 'string'
      ? (payload.item as { name: string }).name
      : typeof (payload.item as { tool?: unknown }).tool === 'string'
        ? (payload.item as { tool: string }).tool
      : 'Tool');
  const name = normalizeCodexFunctionToolName(rawName);
  const argumentsText = extractCodexToolArgumentsText(payload.item);
  const outputText = extractCodexToolOutputText(payload.item);
  const parsedArguments = extractCodexToolArgumentsObject(payload.item);
  const recordedDiff =
    payload.previous?.recordedDiff ??
    (parsedArguments ? buildRecordedCodeChangeDiff(name, parsedArguments) : undefined);
  const filePath = recordedDiff?.filePath || getString(parsedArguments?.file_path).trim();
  const contentParts = (payload.previous?.content?.trim() ?? '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!payload.previous && argumentsText) {
    contentParts.push(filePath || argumentsText);
  }
  if (recordedDiff && payload.status === 'success') {
    const successLine = buildCodexCodeChangeSuccessLine(name);
    if (successLine && !contentParts.includes(successLine)) {
      contentParts.push(successLine);
    }
  } else if (outputText) {
    contentParts.push(outputText);
  }
  for (const line of payload.extraLines ?? []) {
    const trimmed = line.trim();
    if (trimmed && !contentParts.includes(trimmed)) {
      contentParts.push(trimmed);
    }
  }

  return {
    id: payload.previous?.id ?? callId,
    role: 'system' as const,
    kind: 'tool_use' as const,
    timestamp: payload.previous?.timestamp ?? payload.timestamp ?? nowLabel(),
    title: payload.previous?.title ?? name,
    content: contentParts.join('\n\n'),
    recordedDiff,
    status: payload.status,
  };
};

export const prepareCodexRun = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[],
  fallbackSession?: SessionSummary,
  options?: CodexRunOptions,
) => {
  let session = (await findSession(sessionId)) ?? (fallbackSession ? await ensureSessionRecord(fallbackSession) : null);
  if (!session) {
    throw new Error('Session not found.');
  }

  if (normalizeSessionProvider(session.provider) !== 'codex') {
    throw new Error('This session is not configured for Codex.');
  }

  if (options?.references) {
    await updateSessionContextReferences(sessionId, options.references);
    session = await findSession(sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
  }

  const attachments = await saveCodexAttachments(session.workspace, sessionId, pendingAttachments);
  const referenceContext = await buildContextReferencePrompt(sessionId, options?.references);
  const resolvedPrompt = buildCodexPromptWithAttachments(
    prompt,
    attachments,
    referenceContext,
    session.instructionPrompt,
  );
  const providerName = getProviderDisplayName(session.provider);

  const userMessage = {
    id: randomUUID(),
    role: 'user' as const,
    timestamp: nowLabel(),
    title: buildMessageTitle(prompt, 'User prompt'),
    content: prompt,
    status: 'complete' as const,
    contextReferences: cloneMessageContextReferences(options?.references),
    attachments,
  };

  const assistantMessage = {
    id: randomUUID(),
    role: 'assistant' as const,
    timestamp: nowLabel(),
    title: `${providerName} response`,
    content: '',
    status: 'streaming' as const,
  };

  const projects = await appendMessagesToSession(sessionId, [userMessage, assistantMessage], prompt, 'Just now');
  ctx.broadcastEvent({
    type: 'trace',
    sessionId,
    message: userMessage,
  });
  ctx.broadcastEvent({
    type: 'trace',
    sessionId,
    message: assistantMessage,
  });

  return {
    session,
    projects,
    resolvedPrompt,
    attachments,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
  };
};

export const buildCodexArgs = (
  session: SessionSummary,
  prompt: string,
  attachments: MessageAttachment[],
  model?: string,
  fullAuto = true,
  resumeThread = true,
  disabledFeatures: string[] = [],
  outputSchemaPath?: string,
) => {
  const imagePaths = attachments.filter(isImageAttachment).map((attachment) => attachment.path);
  const args: string[] = [];

  disabledFeatures
    .map((feature) => feature.trim())
    .filter(Boolean)
    .forEach((feature) => {
      args.push('--disable', feature);
    });

  args.push('exec');

  if (resumeThread && session.codexThreadId?.trim()) {
    args.push('resume', '--json');
    if (fullAuto) {
      args.push('--full-auto');
    }
    if (model?.trim()) {
      args.push('-m', model.trim());
    }
    imagePaths.forEach((imagePath) => {
      args.push('-i', imagePath);
    });
    args.push(session.codexThreadId.trim(), prompt);
    return args;
  }

  args.push('--json');
  if (fullAuto) {
    args.push('--full-auto');
  }
  if (model?.trim()) {
    args.push('-m', model.trim());
  }
  imagePaths.forEach((imagePath) => {
    args.push('-i', imagePath);
  });
  if (outputSchemaPath?.trim()) {
    args.push('--output-schema', outputSchemaPath.trim());
  }
  args.push(prompt);
  return args;
};

export const buildCodexSpawnSpec = (
  args: string[],
  platform = process.platform,
  comspec = process.env.ComSpec,
) =>
  platform === 'win32'
    ? {
        command: comspec?.trim() || 'cmd.exe',
        args: ['/d', '/s', '/c', 'codex', ...args],
        shell: false,
      }
    : {
        command: 'codex',
        args,
        shell: false,
      };

export const runCodexPrint = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: CodexRunOptions,
) => {
  if (activeRuns.has(sessionId)) {
    throw new Error('Codex is already running for this session.');
  }

  const prepared = await prepareCodexRun(ctx, sessionId, prompt, pendingAttachments, fallbackSession, options);
  const requestedModel = options?.model?.trim() || prepared.session.model;
  const resumeThread = options?.resumeThread ?? true;
  const codexArgs = buildCodexArgs(
    prepared.session,
    prepared.resolvedPrompt,
    prepared.attachments,
    requestedModel,
    options?.fullAuto ?? true,
    resumeThread,
    options?.disabledFeatures ?? [],
    options?.outputSchemaPath,
  );
  const codexSpawn = buildCodexSpawnSpec(codexArgs);
  const child = spawn(codexSpawn.command, codexSpawn.args, {
    cwd: prepared.session.workspace,
    shell: codexSpawn.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const activeRun: ActiveCodexRun = {
    sessionId,
    assistantMessageId: prepared.assistantMessageId,
    child,
    stopped: false,
    completed: false,
    replyCaptured: false,
    traceMessages: new Map(),
  };
  activeRuns.set(sessionId, activeRun);
  emitRuntimeState(ctx, sessionId, 'running', true);

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let threadId = prepared.session.codexThreadId;
  let finalContent = '';
  let tokenUsage: TokenUsage | undefined;
  let failureMessage = '';

  const handleJsonLine = async (line: string) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof parsed.type === 'string' ? parsed.type : '';
    if (type === 'thread.started' && typeof parsed.thread_id === 'string' && parsed.thread_id.trim()) {
      threadId = parsed.thread_id.trim();
      if (resumeThread) {
        await setSessionRuntime(sessionId, {
          codexThreadId: threadId,
        });
      }
      return;
    }

    if (type === 'response_item') {
      const payload = parsed.payload as { type?: unknown; name?: unknown; call_id?: unknown; arguments?: unknown; output?: unknown } | undefined;
      if (payload?.type === 'function_call' && typeof payload.call_id === 'string') {
        const previous = activeRun.traceMessages.get(payload.call_id);
        const traceMessage = buildCodexFunctionCallTraceMessage({
          item: payload,
          status: 'running',
          previous,
          title: typeof payload.name === 'string' ? payload.name : 'Tool',
        });
        if (traceMessage) {
          activeRun.traceMessages.set(payload.call_id, traceMessage);
          await emitTraceMessage(ctx, sessionId, traceMessage);
        }
        return;
      }

      if (payload?.type === 'function_call_output' && typeof payload.call_id === 'string') {
        const previous = activeRun.traceMessages.get(payload.call_id);
        const traceMessage = buildCodexFunctionCallTraceMessage({
          item: payload,
          status: 'success',
          previous,
        });
        if (traceMessage) {
          activeRun.traceMessages.set(payload.call_id, traceMessage);
          await emitTraceMessage(ctx, sessionId, traceMessage);
        }
        return;
      }
    }

    if (type === 'item.started' || type === 'item.completed') {
      const item = parsed.item as CodexCommandExecutionItem | undefined;
      const itemId = typeof item?.id === 'string' ? item.id : undefined;
      if (item?.type === 'command_execution' && itemId) {
        const previous = activeRun.traceMessages.get(itemId);
        const traceMessage = buildCodexCommandTraceMessage({
          item,
          status:
            type === 'item.started'
              ? 'running'
              : typeof item.exit_code === 'number' && item.exit_code !== 0
                ? 'error'
                : 'success',
          previous,
        });
        if (traceMessage) {
          activeRun.traceMessages.set(itemId, traceMessage);
          await emitTraceMessage(ctx, sessionId, traceMessage);
        }
      }
    }

    if (type === 'item.completed') {
      const item = parsed.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        const visibleText = options?.transformAgentMessage
          ? options.transformAgentMessage(item.text)
          : item.text;
        finalContent = visibleText ? (finalContent ? `${finalContent}\n\n${visibleText}` : visibleText) : finalContent;
        if (
          visibleText &&
          options?.stopOnAgentMessage?.(visibleText) &&
          !activeRun.replyCaptured &&
          !child.killed
        ) {
          activeRun.replyCaptured = true;
          child.kill();
        }
      }
      return;
    }

    if (type === 'turn.completed') {
      const usage = parsed.usage as {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
      } | undefined;
      if (usage) {
        tokenUsage = toCodexTokenUsage(usage);
      }
      return;
    }

    if (type === 'error' || type === 'turn.failed') {
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        failureMessage = parsed.message.trim();
      } else if (parsed.error && typeof parsed.error === 'object') {
        failureMessage = JSON.stringify(parsed.error, null, 2);
      } else {
        failureMessage = line.trim();
      }
    }
  };

  child.stdout.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    lines.forEach((line) => {
      if (!line.trim()) {
        return;
      }
      void handleJsonLine(line);
    });
  });

  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  void child.on('close', async (code) => {
    activeRuns.delete(sessionId);

    const trailing = stdoutBuffer.trim();
    if (trailing) {
      await handleJsonLine(trailing);
    }

    if (activeRun.stopped) {
      emitRuntimeState(ctx, sessionId, 'inactive', false);
      return;
    }

    if (!activeRun.replyCaptured && !failureMessage && code && code !== 0) {
      failureMessage = stderrBuffer.trim() || `Codex exited with code ${code}.`;
    }

    if (failureMessage) {
      await updateAssistantMessage(sessionId, prepared.assistantMessageId, (message) => {
        message.title = 'Codex error';
        message.content = failureMessage;
        message.status = 'error';
      });
      const runtimeUpdate: Parameters<typeof setSessionRuntime>[1] = {
        model: requestedModel,
        preview: failureMessage,
        timeLabel: 'Just now',
      };
      if (resumeThread && threadId) {
        runtimeUpdate.codexThreadId = threadId;
      }
      await setSessionRuntime(sessionId, runtimeUpdate);
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: prepared.assistantMessageId,
        status: 'error',
        title: 'Codex error',
        content: failureMessage,
      });
      emitRuntimeState(ctx, sessionId, 'inactive', false);
      return;
    }

    const rawContent = finalContent.trim() || 'No response.';
    const content = options?.parseFinalMessage
      ? options.parseFinalMessage(rawContent)
      : rawContent;
    activeRun.completed = true;
    await updateAssistantMessage(sessionId, prepared.assistantMessageId, (message) => {
      message.title = buildMessageTitle(content, 'Codex response');
      message.content = content;
      message.status = 'complete';
    });
    const runtimeUpdate: Parameters<typeof setSessionRuntime>[1] = {
      model: requestedModel,
      tokenUsage,
      preview: content,
      timeLabel: 'Just now',
    };
    if (resumeThread && threadId) {
      runtimeUpdate.codexThreadId = threadId;
    }
    await setSessionRuntime(sessionId, runtimeUpdate);
    ctx.broadcastEvent({
      type: 'complete',
      sessionId,
      messageId: prepared.assistantMessageId,
      content,
      tokenUsage,
    });
    emitRuntimeState(ctx, sessionId, 'inactive', false);
  });

  return {
    projects: prepared.projects,
    queued: {
      sessionId,
      userMessageId: prepared.userMessageId,
      assistantMessageId: prepared.assistantMessageId,
    },
  };
};

export const switchCodexSessionModel = async (payload: {
  sessionId: string;
  session?: SessionSummary;
  model: string;
}) => {
  const session = (await findSession(payload.sessionId)) ?? (payload.session ? await ensureSessionRecord(payload.session) : null);
  if (!session) {
    throw new Error('Session not found.');
  }

  await setSessionRuntime(payload.sessionId, {
    model: payload.model,
  });

  return {
    projects: await getProjects(),
  };
};

export const switchCodexSessionEffort = async (_payload: {
  sessionId: string;
  session?: SessionSummary;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}) => ({
  projects: await getProjects(),
});

const stopCodexRunInternal = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
) => {
  const activeRun = activeRuns.get(sessionId);
  if (!activeRun) {
    return {
      projects: await getProjects(),
    };
  }

  activeRun.stopped = true;
  if (!activeRun.child.killed) {
    activeRun.child.kill();
  }

  const result = await stopPendingSessionMessages(sessionId);
  result.changedMessages.forEach((message) => {
    if (message.role === 'assistant') {
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: message.id,
        status: message.status,
        title: message.title,
        content: message.content,
      });
      return;
    }

    ctx.broadcastEvent({
      type: 'trace',
      sessionId,
      message,
    });
  });
  emitRuntimeState(ctx, sessionId, 'inactive', false);
  activeRuns.delete(sessionId);
  return {
    projects: result.projects,
  };
};

export const stopCodexRun = async (ctx: ClaudeInteractionContext, sessionId: string) =>
  stopCodexRunInternal(ctx, sessionId);

export const disconnectCodexRun = async (ctx: ClaudeInteractionContext, sessionId: string) =>
  stopCodexRunInternal(ctx, sessionId);

export const stopAllCodexRuns = () => {
  activeRuns.forEach((run) => {
    run.stopped = true;
    if (!run.child.killed) {
      run.child.kill();
    }
  });
  activeRuns.clear();
  void import('./codexAppServer.js').then((m) => m.appServerManager.closeAll());
};
