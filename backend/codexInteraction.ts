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
} from '../electron/sessionStore.js';
import { stopPendingSessionMessages } from '../electron/sessionStop.js';
import { getProviderDisplayName, normalizeSessionProvider } from '../src/data/sessionProvider.js';
import type {
  ContextReference,
  MessageAttachment,
  PendingAttachment,
  SessionSummary,
  TokenUsage,
} from '../src/data/types.js';

type CodexRunOptions = {
  model?: string;
  references?: ContextReference[];
};

type ActiveCodexRun = {
  sessionId: string;
  assistantMessageId: string;
  child: ReturnType<typeof spawn>;
  stopped: boolean;
  completed: boolean;
};

const activeRuns = new Map<string, ActiveCodexRun>();

const isImageAttachment = (attachment: MessageAttachment) => attachment.mimeType.startsWith('image/');

const toCodexTokenUsage = (usage: {
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

const emitRuntimeState = (
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

const prepareCodexRun = async (
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
) => {
  const imagePaths = attachments.filter(isImageAttachment).map((attachment) => attachment.path);
  const args: string[] = ['exec'];

  if (session.codexThreadId?.trim()) {
    args.push('resume', '--json', '--full-auto');
    if (model?.trim()) {
      args.push('-m', model.trim());
    }
    imagePaths.forEach((imagePath) => {
      args.push('-i', imagePath);
    });
    args.push(session.codexThreadId.trim(), prompt);
    return args;
  }

  args.push('--json', '--full-auto');
  if (model?.trim()) {
    args.push('-m', model.trim());
  }
  imagePaths.forEach((imagePath) => {
    args.push('-i', imagePath);
  });
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
  const codexArgs = buildCodexArgs(
    prepared.session,
    prepared.resolvedPrompt,
    prepared.attachments,
    requestedModel,
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
      await setSessionRuntime(sessionId, {
        codexThreadId: threadId,
      });
      return;
    }

    if (type === 'item.completed') {
      const item = parsed.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        finalContent = finalContent ? `${finalContent}\n\n${item.text}` : item.text;
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

    if (!failureMessage && code && code !== 0) {
      failureMessage = stderrBuffer.trim() || `Codex exited with code ${code}.`;
    }

    if (failureMessage) {
      await updateAssistantMessage(sessionId, prepared.assistantMessageId, (message) => {
        message.title = 'Codex error';
        message.content = failureMessage;
        message.status = 'error';
      });
      await setSessionRuntime(sessionId, {
        codexThreadId: threadId,
        model: requestedModel,
        preview: failureMessage,
        timeLabel: 'Just now',
      });
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

    const content = finalContent.trim() || 'No response.';
    activeRun.completed = true;
    await updateAssistantMessage(sessionId, prepared.assistantMessageId, (message) => {
      message.title = buildMessageTitle(content, 'Codex response');
      message.content = content;
      message.status = 'complete';
    });
    await setSessionRuntime(sessionId, {
      codexThreadId: threadId,
      model: requestedModel,
      tokenUsage,
      preview: content,
      timeLabel: 'Just now',
    });
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
  effort: 'low' | 'medium' | 'high' | 'max';
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
};
