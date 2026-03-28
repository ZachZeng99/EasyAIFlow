import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type {
  ActiveClaudeRun,
  ClaudeChildProcess,
  ClaudeInteractionState,
  ClaudePrintOptions,
  ClaudeRunState,
  PreparedClaudeRun,
} from './claudeInteractionState.js';
import {
  nowLabel,
  buildMessageTitle,
  truncateText,
  summarizeToolInput,
  appendTraceContent,
  looksLikePlaceholderTrace,
  tryParsePartialJsonObject,
  mapTokenUsage,
  buildAttachmentFileName,
  isWritableStdin,
  isAutoApprovableEditRequest,
  buildPromptWithAttachments,
  cloneMessageContextReferences,
  hydratePlanModeRequest,
  buildSessionSummaryContext,
  buildSessionTranscriptContext,
  getConversationMessages,
  getGitSnapshot as getGitSnapshotHelper,
} from './claudeHelpers.js';
import {
  appendMessagesToSession,
  bootstrapHarnessFromSession,
  ensureSessionRecord,
  findSession,
  getProjects,
  setSessionRuntime,
  updateAssistantMessage,
  updateHarnessState,
  updateSessionContextReferences,
  upsertSessionMessage,
} from '../electron/sessionStore.js';
import { getClaudeSyntheticApiError } from '../electron/claudeErrors.js';
import { applyParsedSessionMetadata, extractClaudeSessionId } from '../electron/claudeSessionId.js';
import {
  applyAssistantTextToRunState,
  createClaudeRunState,
  getRunSessionRuntimeUpdate,
  markClaudeRunCompleted,
  markRunSessionRuntimePersisted,
  noteBackgroundTaskNotificationInRunState,
  shouldCompleteClaudeRunOnClose,
} from '../electron/claudeRunState.js';
import { extractBackgroundTaskNotificationContent } from '../electron/backgroundTaskNotification.js';
import {
  buildClaudeAskUserQuestionToolResultLine,
  buildClaudeControlResponseLine,
  buildClaudePlanModeToolResultLine,
  buildClaudeUserMessageLine,
  parseClaudeAskUserQuestionControlRequest,
  parseClaudePlanModeControlRequest,
  parseClaudePermissionControlRequest,
} from '../electron/claudeControlMessages.js';
import { buildClaudePrintArgs } from '../electron/claudePrintArgs.js';
import { buildClaudeSessionArgs } from '../electron/claudeSessionArgs.js';
import { buildPermissionRulesForPath } from '../electron/permissionRules.js';
import { readLatestNativeClaudeApiError } from '../electron/nativeClaudeError.js';
import { getClaudeSpawnOptions } from '../electron/claudeSpawn.js';
import { createSequentialLineProcessor } from '../electron/sequentialLineProcessor.js';
import { enqueueSessionRun, hasSessionRunQueued } from '../electron/sessionRunQueue.js';
import {
  readSessionStopVersion,
  requestSessionStop,
  stopAssistantMessage,
  stopPendingSessionMessages,
} from '../electron/sessionStop.js';
import { buildRecordedCodeChangeDiff } from '../electron/recordedCodeChangeDiff.js';
import {
  addActiveClaudeRun,
  listActiveClaudeRunsForSession,
  removeActiveClaudeRun,
} from '../electron/claudeRunRegistry.js';
import {
  extractAskUserQuestionResponsePayload,
  hasAskUserQuestionResponse,
  parseAskUserQuestions,
  type AskUserQuestion,
} from '../src/data/askUserQuestion.js';
import {
  buildPlanModeResponseText,
  buildPlanModeTraceContent,
  parsePlanModeRequest,
  type PlanModeRequest,
  type PlanModeResponsePayload,
} from '../src/data/planMode.js';
import { runHarnessOrchestration } from './harnessOrchestrator.js';
import type {
  BtwResponse,
  ConversationMessage,
  ContextReference,
  HarnessSessionState,
  PendingAttachment,
  ProjectRecord,
  SessionRecord,
  SessionSummary,
  TokenUsage,
} from '../src/data/types.js';

// ---------------------------------------------------------------------------
// 3a — Context-only functions
// ---------------------------------------------------------------------------

export const readClaudeSettings = async (ctx: ClaudeInteractionContext) => {
  try {
    const raw = await readFile(ctx.claudeSettingsPath(), 'utf8');
    return JSON.parse(raw) as { model?: unknown };
  } catch {
    return undefined;
  }
};

export const getConfiguredClaudeModel = async (ctx: ClaudeInteractionContext) => {
  const parsed = await readClaudeSettings(ctx);
  return typeof parsed?.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;
};

export const grantPathPermission = async (ctx: ClaudeInteractionContext, projectRoot: string, targetPath: string) => {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
  const homeDir = ctx.homePath();
  const rules = buildPermissionRulesForPath(targetPath, homeDir);

  let parsed: { permissions?: { allow?: string[]; additionalDirectories?: string[] } } = {};
  try {
    parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as typeof parsed;
  } catch {
    parsed = {};
  }

  const allow = new Set(parsed.permissions?.allow ?? []);
  rules.forEach((rule) => allow.add(rule));

  const next = {
    ...parsed,
    permissions: {
      ...parsed.permissions,
      allow: [...allow],
      additionalDirectories: parsed.permissions?.additionalDirectories ?? [],
    },
  };

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
};

export const deleteNativeClaudeSession = async (ctx: ClaudeInteractionContext, cwd: string, claudeSessionId?: string) => {
  if (!claudeSessionId) {
    return;
  }

  const normalized = cwd.replace(/\//g, '\\').replace(/\\+$/, '');
  const match = normalized.match(/^([A-Za-z]):\\?(.*)$/);
  if (!match) {
    return;
  }

  const drive = match[1];
  const rest = match[2]
    .split('\\')
    .filter(Boolean)
    .join('-');
  const dirName = rest ? `${drive}--${rest}` : `${drive}--`;
  const nativeDir = path.join(ctx.homePath(), '.claude', 'projects', dirName);

  await Promise.allSettled([
    import('node:fs/promises').then(({ rm }) => rm(path.join(nativeDir, `${claudeSessionId}.jsonl`), { force: true })),
    import('node:fs/promises').then(({ rm }) => rm(path.join(nativeDir, claudeSessionId), { force: true, recursive: true })),
  ]);
};

export const saveAttachments = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  attachments: PendingAttachment[],
): Promise<import('../src/data/types.js').MessageAttachment[]> => {
  if (attachments.length === 0) {
    return [];
  }

  const dir = path.join(ctx.attachmentRoot(), sessionId);
  const needsCopy = attachments.some((attachment) => !attachment.path);
  if (needsCopy) {
    await mkdir(dir, { recursive: true });
  }

  const saved = await Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.path) {
        return {
          id: attachment.id,
          name: attachment.name,
          path: attachment.path,
          mimeType: attachment.mimeType,
          size: attachment.size,
        };
      }

      if (!attachment.dataUrl) {
        throw new Error(`Attachment ${attachment.name || attachment.id} is missing both path and data.`);
      }

      const [, base64 = ''] = (attachment.dataUrl ?? '').split(',');
      const fileName = buildAttachmentFileName(attachment);
      const filePath = path.join(dir, fileName);
      await writeFile(filePath, Buffer.from(base64, 'base64'));

      return {
        id: attachment.id,
        name: attachment.name,
        path: filePath,
        mimeType: attachment.mimeType,
        size: attachment.size,
      };
    }),
  );

  return saved;
};

export { getGitSnapshotHelper as getGitSnapshot };

export const buildContextReferencePrompt = async (sessionId: string, overrideReferences?: ContextReference[]) => {
  const currentSession = await findSession(sessionId);
  if (!currentSession) {
    return '';
  }

  const references = (overrideReferences ?? currentSession.contextReferences ?? []).filter(Boolean);
  if (references.length === 0) {
    return '';
  }

  const projects = await getProjects();
  const storedSessions = projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions.map((session) => session as SessionRecord)),
  );
  const sessionById = new Map(storedSessions.map((session) => [session.id, session]));

  const blocks = references
    .map((reference) => {
      const resolvedSessions =
        reference.kind === 'session'
          ? reference.sessionId && reference.sessionId !== currentSession.id
            ? [sessionById.get(reference.sessionId)].filter((session): session is SessionRecord => Boolean(session))
            : []
          : storedSessions
              .filter(
                (session) =>
                  session.dreamId === reference.streamworkId &&
                  session.id !== currentSession.id,
              )
              .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

      if (resolvedSessions.length === 0) {
        return '';
      }

      const buildDetail = (session: SessionRecord) =>
        reference.mode === 'full'
          ? buildSessionTranscriptContext(session)
          : buildSessionSummaryContext(session);

      const detail = resolvedSessions.map(buildDetail).join('\n\n');

      // When the referenced session is a harness, also include its role sessions.
      const harnessRoleDetails: string[] = [];
      for (const resolved of resolvedSessions) {
        if (resolved.sessionKind !== 'harness' || !resolved.harnessState) {
          continue;
        }
        const roleIds = [
          resolved.harnessState.generatorSessionId,
          resolved.harnessState.evaluatorSessionId,
        ];
        // plannerSessionId === root session id, already included above
        for (const roleId of roleIds) {
          if (!roleId || roleId === resolved.id || roleId === currentSession.id) {
            continue;
          }
          const roleSession = sessionById.get(roleId);
          if (roleSession && getConversationMessages(roleSession).length > 0) {
            harnessRoleDetails.push(buildDetail(roleSession));
          }
        }
      }

      const title =
        reference.kind === 'session'
          ? `Referenced session (${reference.mode})`
          : `Referenced streamwork history (${reference.mode})`;

      const label =
        reference.kind === 'session'
          ? reference.label || resolvedSessions[0]?.title || 'Session'
          : reference.label || `${resolvedSessions[0]?.dreamName ?? 'Streamwork'} history`;

      const parts = [
        `## ${title}`,
        `Label: ${label}`,
        `Entries: ${resolvedSessions.length}`,
        detail,
      ];
      if (harnessRoleDetails.length > 0) {
        parts.push(`### Harness role sessions`, ...harnessRoleDetails);
      }

      return truncateText(parts.join('\n'), reference.mode === 'full' ? 36000 : 22000);
    })
    .filter(Boolean);

  if (blocks.length === 0) {
    return '';
  }

  return [
    'Referenced conversation context is provided below.',
    'Use it as supporting context when it is relevant to the current request.',
    'Do not claim events or files beyond the injected context.',
    blocks.join('\n\n'),
  ].join('\n\n');
};

// ---------------------------------------------------------------------------
// 3b — Context + State event/registration functions
// ---------------------------------------------------------------------------

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

export const registerAskUserQuestion = (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  activeRun: ActiveClaudeRun,
  toolUseId: string,
  questions: AskUserQuestion[],
) => {
  if (state.pendingAskUserQuestions.has(toolUseId)) {
    return;
  }

  state.pendingAskUserQuestions.set(toolUseId, {
    sessionId,
    activeRun,
    toolUseId,
    questions,
  });
  ctx.broadcastEvent({
    type: 'ask-user-question',
    sessionId,
    toolUseId,
    questions,
  });
};

export const registerPlanModeRequest = (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  activeRun: ActiveClaudeRun,
  request: PlanModeRequest,
) => {
  state.pendingPlanModeRequests.set(request.toolUseId, {
    sessionId,
    activeRun,
    request,
  });
  ctx.broadcastEvent({
    type: 'plan-mode-request',
    sessionId,
    request,
  });
};

export const respondToPlanModeRequest = (
  activeRun: ActiveClaudeRun,
  request: PlanModeRequest,
  response?: PlanModeResponsePayload,
  controlRequestId?: string,
  controlRawInput?: Record<string, unknown>,
) => {
  if (!isWritableStdin(activeRun.child)) {
    return false;
  }

  const stdin = activeRun.child.stdin;
  if (!stdin) {
    return false;
  }

  if (controlRequestId) {
    // Send the deferred control_response based on the user's decision.
    const isApproved = response?.mode && response.mode !== 'revise';
    if (isApproved) {
      stdin.write(
        `${buildClaudeControlResponseLine(
          { requestId: controlRequestId, rawInput: controlRawInput ?? {} },
          'allow',
        )}\n`,
      );
    } else {
      const denyText = response
        ? buildPlanModeResponseText(request, response)
        : 'Plan review cancelled. Stay in plan mode and revise the plan.';
      stdin.write(
        `${buildClaudeControlResponseLine(
          { requestId: controlRequestId, rawInput: controlRawInput ?? {} },
          'deny',
          denyText,
        )}\n`,
      );
    }
    return true;
  }

  // Fallback for requests without a control_request (e.g. EnterPlanMode)
  stdin.write(
    `${buildClaudePlanModeToolResultLine({
      request,
      response,
    })}\n`,
  );
  return true;
};

// ---------------------------------------------------------------------------
// Helper: clean up pending requests for a child or run
// ---------------------------------------------------------------------------

const cleanupPendingRequestsForRun = (state: ClaudeInteractionState, runId: string) => {
  for (const [requestId, pending] of state.pendingPermissionRequests) {
    if (pending.activeRun.runId === runId) {
      state.pendingPermissionRequests.delete(requestId);
    }
  }
  for (const [requestId, pending] of state.pendingPlanModeRequests) {
    if (pending.activeRun.runId === runId) {
      state.pendingPlanModeRequests.delete(requestId);
    }
  }
  for (const [toolUseId, pending] of state.pendingAskUserQuestions) {
    if (pending.activeRun.runId === runId) {
      state.pendingAskUserQuestions.delete(toolUseId);
    }
  }
};

const cleanupPendingRequestsForChild = (state: ClaudeInteractionState, child: ClaudeChildProcess) => {
  for (const [requestId, pending] of state.pendingPermissionRequests) {
    if (pending.activeRun.child === child) {
      state.pendingPermissionRequests.delete(requestId);
    }
  }
  for (const [requestId, pending] of state.pendingPlanModeRequests) {
    if (pending.activeRun.child === child) {
      state.pendingPlanModeRequests.delete(requestId);
    }
  }
  for (const [toolUseId, pending] of state.pendingAskUserQuestions) {
    if (pending.activeRun.child === child) {
      state.pendingAskUserQuestions.delete(toolUseId);
    }
  }
};

// ---------------------------------------------------------------------------
// 3c — Large orchestration functions
// ---------------------------------------------------------------------------

const finalizeToolTraces = async (ctx: ClaudeInteractionContext, sessionId: string, runState: ClaudeRunState) => {
  for (const trace of runState.toolTraces.values()) {
    if (!trace.status || trace.status === 'running' || trace.status === 'streaming') {
      trace.status = 'complete';
      await emitTraceMessage(ctx, sessionId, trace);
    }
  }
};

const syncRunSessionRuntime = async (sessionId: string, runState: ClaudeRunState) => {
  const update = getRunSessionRuntimeUpdate(runState);
  if (!update) {
    return;
  }

  await setSessionRuntime(sessionId, update);
  Object.assign(runState, markRunSessionRuntimePersisted(runState));
};

export const completeAssistantRun = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  assistantMessageId: string,
  runState: ClaudeRunState,
  fallbackContent = '',
) => {
  const content = runState.content || fallbackContent;
  Object.assign(runState, markClaudeRunCompleted(runState, content));
  await finalizeToolTraces(ctx, sessionId, runState);

  await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
    message.content = content;
    message.status = 'complete';
    message.title = buildMessageTitle(message.content, 'Claude response');
  });

  await setSessionRuntime(sessionId, {
    claudeSessionId: runState.claudeSessionId,
    model: runState.model,
    preview: content,
    timeLabel: 'Just now',
    tokenUsage: runState.tokenUsage,
  });

  ctx.broadcastEvent({
    type: 'complete',
    sessionId,
    messageId: assistantMessageId,
    content,
    claudeSessionId: runState.claudeSessionId,
    tokenUsage: runState.tokenUsage,
  });
};

export const handleToolUseBlock = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  activeRun: ActiveClaudeRun,
  runState: ClaudeRunState,
  block: { id?: string; name?: string; input?: unknown },
) => {
  const toolId = String(block.id ?? randomUUID());
  const toolName = block.name ?? 'Tool Use';
  const inputSummary = summarizeToolInput(block.input);
  const questions = toolName === 'AskUserQuestion' ? parseAskUserQuestions(block.input) : [];
  if (questions.length > 0) {
    registerAskUserQuestion(ctx, state, sessionId, activeRun, toolId, questions);
  }

  const parsedPlanModeRequest = parsePlanModeRequest({
    toolName,
    toolUseId: toolId,
    input: block.input,
  });
  const planModeRequest = parsedPlanModeRequest
    ? await hydratePlanModeRequest(parsedPlanModeRequest)
    : null;
  const traceContent = planModeRequest ? buildPlanModeTraceContent(planModeRequest) : inputSummary;
  const recordedDiff = planModeRequest ? undefined : buildRecordedCodeChangeDiff(toolName, block.input);
  const hadExistingTrace = runState.toolTraces.has(toolId);
  const existing = runState.toolTraces.get(toolId) ?? {
    id: toolId,
    role: 'system' as const,
    kind: 'tool_use' as const,
    timestamp: nowLabel(),
    title: toolName,
    content: traceContent,
    recordedDiff,
    status: 'running' as const,
  };

  existing.title = toolName;
  if (traceContent && (looksLikePlaceholderTrace(existing.content, existing.title) || planModeRequest)) {
    existing.content = traceContent;
  }
  if (!existing.recordedDiff && recordedDiff) {
    existing.recordedDiff = recordedDiff;
  }
  runState.toolTraces.set(toolId, existing);
  await emitTraceMessage(ctx, sessionId, existing);

  if (!planModeRequest) {
    return;
  }

  if (planModeRequest.toolName === 'EnterPlanMode') {
    if (!hadExistingTrace) {
      respondToPlanModeRequest(activeRun, planModeRequest);
    }
    return;
  }

  registerPlanModeRequest(ctx, state, sessionId, activeRun, planModeRequest);
};

export const handleClaudeLine = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  assistantMessageId: string,
  line: string,
  runState: ClaudeRunState,
  activeRun: ActiveClaudeRun,
  releaseQueuedTurn: () => void,
) => {
  if (!line.trim()) {
    return;
  }
  if (activeRun.child.killed) {
    return;
  }

  const parsed = JSON.parse(line) as Record<string, unknown>;
  Object.assign(runState, applyParsedSessionMetadata(runState, parsed));
  await syncRunSessionRuntime(sessionId, runState);
  const backgroundTaskNotification = extractBackgroundTaskNotificationContent(parsed);
  if (backgroundTaskNotification) {
    Object.assign(runState, noteBackgroundTaskNotificationInRunState(runState, backgroundTaskNotification));
    if (parsed.type === 'queue-operation') {
      return;
    }
  }
  const askUserQuestionRequest = parseClaudeAskUserQuestionControlRequest(parsed);
  if (askUserQuestionRequest) {
    const stdin = activeRun.child.stdin;
    if (isWritableStdin(activeRun.child) && stdin) {
      stdin.write(`${buildClaudeControlResponseLine(askUserQuestionRequest, 'allow')}\n`);
    }
    return;
  }

  const planModeControlRequest = parseClaudePlanModeControlRequest(parsed);
  if (planModeControlRequest) {
    if (planModeControlRequest.toolName === 'ExitPlanMode') {
      // Defer the control_response for ExitPlanMode until the user decides.
      // Sending 'allow' immediately would let Claude CLI auto-approve the plan
      // before the user has a chance to review it.
      // Store in a session-level map so it survives handleToolUseBlock re-registrations.
      state.deferredExitPlanControlRequests.set(sessionId, {
        requestId: planModeControlRequest.requestId,
        rawInput: planModeControlRequest.rawInput,
      });
      return;
    }

    // EnterPlanMode: allow immediately (no user decision needed)
    const stdin = activeRun.child.stdin;
    if (isWritableStdin(activeRun.child) && stdin) {
      stdin.write(`${buildClaudeControlResponseLine(planModeControlRequest, 'allow')}\n`);
    }
    return;
  }

  const permissionControlRequest = parseClaudePermissionControlRequest(parsed);
  if (permissionControlRequest) {
    const approvalPreference = state.sessionPlanApprovalPreferences.get(sessionId);
    if (approvalPreference && approvalPreference !== 'manual' && isAutoApprovableEditRequest(permissionControlRequest)) {
      if (permissionControlRequest.targetPath) {
        await grantPathPermission(ctx, activeRun.projectRoot, permissionControlRequest.targetPath);
      }
      const stdin = activeRun.child.stdin;
      if (isWritableStdin(activeRun.child) && stdin) {
        stdin.write(`${buildClaudeControlResponseLine(permissionControlRequest, 'allow')}\n`);
        return;
      }
    }

    state.pendingPermissionRequests.set(permissionControlRequest.requestId, {
      sessionId,
      activeRun,
      request: permissionControlRequest,
    });
    ctx.broadcastEvent({
      type: 'permission-request',
      sessionId,
      requestId: permissionControlRequest.requestId,
      toolName: permissionControlRequest.toolName,
      targetPath: permissionControlRequest.targetPath,
      command: permissionControlRequest.command,
      description: permissionControlRequest.description,
      decisionReason: permissionControlRequest.decisionReason,
      sensitive: permissionControlRequest.sensitive,
    });
    return;
  }
  const syntheticApiError = getClaudeSyntheticApiError(parsed);
  if (syntheticApiError) {
    runState.terminalError = syntheticApiError;
    await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
      message.content = syntheticApiError;
      message.status = 'error';
      message.title = 'Claude error';
    });

    ctx.broadcastEvent({
      type: 'error',
      sessionId,
      messageId: assistantMessageId,
      error: syntheticApiError,
    });
    return;
  }

  if (parsed.type === 'stream_event') {
    const event = parsed.event as {
      type?: string;
      index?: number;
      delta?: { type?: string; text?: string; partial_json?: string };
      content_block?: { type?: string; name?: string; input?: unknown; id?: string };
    };
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      runState.content += event.delta.text;
      await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
        message.content = runState.content;
        message.status = 'streaming';
        message.title = buildMessageTitle(runState.content, 'Claude response');
      });

      ctx.broadcastEvent({
        type: 'delta',
        sessionId,
        messageId: assistantMessageId,
        delta: event.delta.text,
      });
    }

    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      if (typeof event.index === 'number' && event.content_block.id) {
        runState.toolUseBlockIds.set(event.index, event.content_block.id);
      }
      await handleToolUseBlock(ctx, state, sessionId, activeRun, runState, {
        id: (event.content_block as { id?: string }).id,
        name: event.content_block.name,
        input: event.content_block.input,
      });
    }

    if (
      event?.type === 'content_block_delta' &&
      event.delta?.type === 'input_json_delta' &&
      typeof event.delta.partial_json === 'string' &&
      typeof event.index === 'number'
    ) {
      const toolUseId = runState.toolUseBlockIds.get(event.index);
      if (toolUseId) {
        const nextJson = `${runState.toolUseJsonBuffers.get(toolUseId) ?? ''}${event.delta.partial_json}`;
        runState.toolUseJsonBuffers.set(toolUseId, nextJson);
        const parsedInput = tryParsePartialJsonObject(nextJson);
        if (parsedInput && typeof parsedInput === 'object') {
          const current = runState.toolTraces.get(toolUseId);
          await handleToolUseBlock(ctx, state, sessionId, activeRun, runState, {
            id: toolUseId,
            name: current?.title,
            input: parsedInput,
          });
        }
      }
    }

    if (event?.type === 'content_block_stop' && typeof event.index === 'number') {
      const toolUseId = runState.toolUseBlockIds.get(event.index);
      if (toolUseId) {
        runState.toolUseBlockIds.delete(event.index);
      }
    }
  }

  if (parsed.type === 'assistant') {
    const message = parsed.message as {
      model?: string;
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    if (typeof message?.model === 'string' && message.model.trim()) {
      runState.model = message.model.trim();
    }
    if (message?.usage) {
      runState.lastAssistantUsage = {
        input_tokens: message.usage.input_tokens ?? 0,
        cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
      };
    }
    const finalText = message?.content
      ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('') ?? runState.content;
    Object.assign(runState, applyAssistantTextToRunState(runState, finalText));

    for (const block of message?.content ?? []) {
      if (block.type === 'tool_use') {
        await handleToolUseBlock(ctx, state, sessionId, activeRun, runState, {
          id: (block as { id?: string }).id,
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  if (parsed.type === 'progress') {
    const toolUseId = String(parsed.toolUseID ?? '');
    if (toolUseId && runState.toolTraces.has(toolUseId)) {
      const current = runState.toolTraces.get(toolUseId)!;
      current.content = appendTraceContent(
        current.content,
        String((parsed.data as { statusMessage?: string; command?: string })?.statusMessage ?? (parsed.data as { command?: string })?.command ?? 'Progress update'),
      );
      current.status = 'running';
      await emitTraceMessage(ctx, sessionId, current);
    }
  }

  if (parsed.type === 'user' && parsed.isMeta !== true) {
    const content = (parsed.message as { content?: unknown })?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'tool_result' &&
          typeof (block as { tool_use_id?: string }).tool_use_id === 'string'
        ) {
          const toolUseId = (block as { tool_use_id: string }).tool_use_id;
          const pendingAskUserQuestion = state.pendingAskUserQuestions.get(toolUseId);
          const askUserQuestionResponse = extractAskUserQuestionResponsePayload(
            (parsed as { toolUseResult?: unknown }).toolUseResult,
          );
          if (pendingAskUserQuestion && !hasAskUserQuestionResponse(askUserQuestionResponse)) {
            requestSessionStop(state.sessionStopVersions, sessionId);
            if (!pendingAskUserQuestion.activeRun.child.killed) {
              pendingAskUserQuestion.activeRun.child.kill();
            }
            continue;
          }

          state.pendingAskUserQuestions.delete(toolUseId);
          const current = runState.toolTraces.get(toolUseId);
          if (current) {
            const resultText = String((block as { content?: string }).content ?? 'Tool result returned.');
            current.content = appendTraceContent(current.content, resultText);
            current.status = (block as { is_error?: boolean }).is_error ? 'error' : 'success';
            await emitTraceMessage(ctx, sessionId, current);
          }
          const pendingPlanModeRequest = state.pendingPlanModeRequests.get(toolUseId);
          if (pendingPlanModeRequest) {
            state.pendingPlanModeRequests.delete(toolUseId);
            const planCurrent = runState.toolTraces.get(toolUseId);
            if (planCurrent) {
              const resultText = String((block as { content?: string }).content ?? 'Plan mode result returned.');
              planCurrent.content = appendTraceContent(planCurrent.content, resultText);
              planCurrent.status = (block as { is_error?: boolean }).is_error ? 'error' : 'success';
              await emitTraceMessage(ctx, sessionId, planCurrent);
            }
          }
        }
      }
    }
  }

  if (parsed.type === 'result') {
    runState.receivedResult = true;
    runState.tokenUsage = mapTokenUsage(parsed, runState.lastAssistantUsage);
    try {
      await completeAssistantRun(ctx, sessionId, assistantMessageId, runState, String(parsed.result ?? ''));
    } finally {
      releaseQueuedTurn();
      activeRun.child.stdin?.end();
    }
  }
};

export const prepareClaudeRun = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: ClaudePrintOptions,
  assistantStatus: 'queued' | 'streaming' = 'streaming',
): Promise<PreparedClaudeRun> => {
  let session = (await findSession(sessionId)) ?? (fallbackSession ? await ensureSessionRecord(fallbackSession) : null);
  if (!session) {
    throw new Error('Session not found');
  }

  if (options?.references) {
    await updateSessionContextReferences(sessionId, options.references);
    session = await findSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
  }

  const attachments = await saveAttachments(ctx, sessionId, pendingAttachments);
  const referenceContext = await buildContextReferencePrompt(sessionId, options?.references);
  const resolvedPrompt = buildPromptWithAttachments(
    prompt,
    attachments,
    referenceContext,
    session.instructionPrompt,
  );

  const userMessage: ConversationMessage = {
    id: randomUUID(),
    role: 'user',
    timestamp: nowLabel(),
    title: buildMessageTitle(prompt, 'User prompt'),
    content: prompt,
    status: 'complete',
    contextReferences: cloneMessageContextReferences(options?.references),
    attachments,
  };

  const assistantMessage: ConversationMessage = {
    id: randomUUID(),
    role: 'assistant',
    timestamp: nowLabel(),
    title: assistantStatus === 'queued' ? 'Claude queued' : 'Claude response',
    content: assistantStatus === 'queued' ? 'Queued. Claude will start this message after the current run completes.' : '',
    status: assistantStatus,
  };

  const projects = await appendMessagesToSession(
    sessionId,
    [userMessage, assistantMessage],
    prompt,
    'Just now',
  );
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
    sessionId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    session,
    resolvedPrompt,
    options,
    projects,
    assistantWasQueued: assistantStatus === 'queued',
    stopVersion: readSessionStopVersion(state.sessionStopVersions, sessionId),
  };
};

export const markPreparedClaudeRunStarted = async (ctx: ClaudeInteractionContext, prepared: PreparedClaudeRun) => {
  if (!prepared.assistantWasQueued) {
    return;
  }

  await updateAssistantMessage(prepared.sessionId, prepared.assistantMessageId, (message) => {
    message.content = '';
    message.status = 'streaming';
    message.title = 'Claude response';
  });

  ctx.broadcastEvent({
    type: 'status',
    sessionId: prepared.sessionId,
    messageId: prepared.assistantMessageId,
    status: 'streaming',
    content: '',
    title: 'Claude response',
  });
};

export const executePreparedClaudeRun = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  prepared: PreparedClaudeRun,
  releaseQueuedTurn: () => void,
) =>
  new Promise<void>((resolve) => {
    const { sessionId, assistantMessageId, session, resolvedPrompt, options } = prepared;
    const args = buildClaudePrintArgs({
      model: options?.model,
      effort: options?.effort,
      sessionArgs: buildClaudeSessionArgs(session.claudeSessionId, session.title),
    });

    const child = spawn('claude', args, getClaudeSpawnOptions(session.workspace));
    const activeRun = addActiveClaudeRun(state.activeRuns, {
      runId: randomUUID(),
      sessionId,
      child,
      projectRoot: session.workspace,
    });

    let stderrBuffer = '';
    let finalizing = false;
    const beginFinalize = () => {
      if (finalizing) {
        return false;
      }
      finalizing = true;
      cleanupPendingRequestsForRun(state, activeRun.runId);
      removeActiveClaudeRun(state.activeRuns, activeRun.runId);
      releaseQueuedTurn();
      return true;
    };
    const runState: ClaudeRunState = {
      ...createClaudeRunState(),
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      persistedClaudeSessionId: session.claudeSessionId,
      persistedModel: session.model,
      tokenUsage: session.tokenUsage,
      toolTraces: new Map<string, ConversationMessage>(),
      toolUseBlockIds: new Map<number, string>(),
      toolUseJsonBuffers: new Map<string, string>(),
    };

    const stdoutProcessor = createSequentialLineProcessor((line) =>
      handleClaudeLine(ctx, state, sessionId, assistantMessageId, line, runState, activeRun, releaseQueuedTurn),
    );

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutProcessor.pushChunk(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.stdin.write(`${buildClaudeUserMessageLine(resolvedPrompt)}\n`);

    child.on('close', (code) => {
      if (!beginFinalize()) {
        return;
      }

      void (async () => {
        try {
          await stdoutProcessor.flush();

          if (readSessionStopVersion(state.sessionStopVersions, sessionId) !== prepared.stopVersion) {
            const stopped = await stopAssistantMessage(sessionId, assistantMessageId);
            if (stopped) {
              ctx.broadcastEvent({
                type: 'status',
                sessionId,
                messageId: assistantMessageId,
                status: stopped.status,
                title: stopped.title,
                content: stopped.content,
              });
            }
            return;
          }

          if (code === 0) {
            if (runState.terminalError) {
              await setSessionRuntime(sessionId, {
                claudeSessionId: runState.claudeSessionId,
                model: runState.model,
                preview: runState.terminalError,
                timeLabel: 'Just now',
              });
              return;
            }
            if (shouldCompleteClaudeRunOnClose(runState)) {
              await completeAssistantRun(ctx, sessionId, assistantMessageId, runState);
            }
            return;
          }

          const nativeApiError = await readLatestNativeClaudeApiError(
            session.workspace,
            runState.claudeSessionId ?? session.claudeSessionId,
          );
          const errorMessage =
            stderrBuffer.trim() ||
            runState.terminalError ||
            nativeApiError ||
            `Claude exited with code ${code ?? 'unknown'}.`;
          await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
            message.content = errorMessage;
            message.status = 'error';
            message.title = 'Claude error';
          });
          await setSessionRuntime(sessionId, {
            claudeSessionId: runState.claudeSessionId,
            model: runState.model,
            preview: errorMessage,
            timeLabel: 'Just now',
          });

          ctx.broadcastEvent({
            type: 'error',
            sessionId,
            messageId: assistantMessageId,
            error: errorMessage,
          });
        } finally {
          await finalizeToolTraces(ctx, sessionId, runState);
          resolve();
        }
      })();
    });

    child.on('error', (error) => {
      if (!beginFinalize()) {
        return;
      }

      void (async () => {
        try {
          if (readSessionStopVersion(state.sessionStopVersions, sessionId) !== prepared.stopVersion) {
            const stopped = await stopAssistantMessage(sessionId, assistantMessageId);
            if (stopped) {
              ctx.broadcastEvent({
                type: 'status',
                sessionId,
                messageId: assistantMessageId,
                status: stopped.status,
                title: stopped.title,
                content: stopped.content,
              });
            }
            return;
          }

          await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
            message.content = error.message;
            message.status = 'error';
            message.title = 'Claude error';
          });
          await setSessionRuntime(sessionId, {
            claudeSessionId: runState.claudeSessionId,
            model: runState.model,
            preview: error.message,
            timeLabel: 'Just now',
          });

          ctx.broadcastEvent({
            type: 'error',
            sessionId,
            messageId: assistantMessageId,
            error: error.message,
          });
        } finally {
          await finalizeToolTraces(ctx, sessionId, runState);
          resolve();
        }
      })();
    });
  });

export const runClaudePrint = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: ClaudePrintOptions,
) => {
  const queued = hasSessionRunQueued(state.sessionRunQueue, sessionId);
  const scheduledRun = enqueueSessionRun(state.sessionRunQueue, sessionId);
  const preparedRun = prepareClaudeRun(
    ctx,
    state,
    sessionId,
    prompt,
    pendingAttachments,
    fallbackSession,
    options,
    queued ? 'queued' : 'streaming',
  );
  void (async () => {
    try {
      const prepared = await preparedRun;
      await scheduledRun.whenReady;
      if (readSessionStopVersion(state.sessionStopVersions, sessionId) !== prepared.stopVersion) {
        const stopped = await stopAssistantMessage(prepared.sessionId, prepared.assistantMessageId);
        if (stopped) {
          ctx.broadcastEvent({
            type: 'status',
            sessionId: prepared.sessionId,
            messageId: prepared.assistantMessageId,
            status: stopped.status,
            title: stopped.title,
            content: stopped.content,
          });
        }
        scheduledRun.release();
        return;
      }
      await markPreparedClaudeRunStarted(ctx, prepared);
      await executePreparedClaudeRun(ctx, state, prepared, scheduledRun.release);
    } catch {
      scheduledRun.release();
    }
  })();
  void scheduledRun.completion.catch(() => undefined);
  const prepared = await preparedRun;

  return {
    projects: prepared.projects,
    queued: {
      sessionId,
      userMessageId: prepared.userMessageId,
      assistantMessageId: prepared.assistantMessageId,
    },
  };
};

export const emitHarnessState = async (ctx: ClaudeInteractionContext, sessionId: string, harnessState: HarnessSessionState) => {
  await updateHarnessState(sessionId, () => harnessState);
  ctx.broadcastEvent({
    type: 'harness-state',
    sessionId,
    state: harnessState,
  });
};

export const getAssistantMessageContent = async (sessionId: string, messageId: string) => {
  const session = await findSession(sessionId);
  return session?.messages.find((message) => message.id === messageId)?.content ?? '';
};

export const runClaudePrintAndWait = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: ClaudePrintOptions,
) => {
  const queued = hasSessionRunQueued(state.sessionRunQueue, sessionId);
  const scheduledRun = enqueueSessionRun(state.sessionRunQueue, sessionId);
  try {
    const prepared = await prepareClaudeRun(
      ctx,
      state,
      sessionId,
      prompt,
      pendingAttachments,
      fallbackSession,
      options,
      queued ? 'queued' : 'streaming',
    );
    await scheduledRun.whenReady;
    if (readSessionStopVersion(state.sessionStopVersions, sessionId) !== prepared.stopVersion) {
      const stopped = await stopAssistantMessage(prepared.sessionId, prepared.assistantMessageId);
      if (stopped) {
        ctx.broadcastEvent({
          type: 'status',
          sessionId: prepared.sessionId,
          messageId: prepared.assistantMessageId,
          status: stopped.status,
          title: stopped.title,
          content: stopped.content,
        });
      }
      scheduledRun.release();
      return {
        projects: await getProjects(),
        content: await getAssistantMessageContent(sessionId, prepared.assistantMessageId),
      };
    }

    await markPreparedClaudeRunStarted(ctx, prepared);
    await executePreparedClaudeRun(ctx, state, prepared, scheduledRun.release);

    return {
      projects: await getProjects(),
      content: await getAssistantMessageContent(sessionId, prepared.assistantMessageId),
    };
  } catch (error) {
    scheduledRun.release();
    throw error;
  }
};

export const runHarnessForSession = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  options?: {
    maxSprints?: number;
    maxContractRounds?: number;
    maxImplementationRounds?: number;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  },
) => {
  try {
    const result = await runHarnessOrchestration({
      entrySessionId: sessionId,
      options,
      bootstrapHarness: bootstrapHarnessFromSession,
      findSession,
      onProgress: async (harnessState) => {
        await emitHarnessState(ctx, sessionId, harnessState);
      },
      runRoleTurn: async ({ sessionId: roleSessionId, prompt, model, effort }) => {
        const session = await findSession(roleSessionId);
        if (!session) {
          throw new Error('Harness session not found.');
        }

        const turn = await runClaudePrintAndWait(ctx, state, roleSessionId, prompt, [], session, {
          references: session.contextReferences ?? [],
          model,
          effort,
        });

        return {
          content: turn.content,
        };
      },
    });

    return {
      ...result,
      projects: await getProjects(),
    };
  } catch (error) {
    // Reset harness state to failed so the UI is not stuck at 'running'.
    const errorMessage = error instanceof Error ? error.message : 'Harness orchestration failed.';
    await emitHarnessState(ctx, sessionId, {
      plannerSessionId: '',
      generatorSessionId: '',
      evaluatorSessionId: '',
      artifactDir: '',
      status: 'failed',
      currentStage: 'error',
      currentSprint: 0,
      currentRound: 0,
      completedSprints: 0,
      maxSprints: 0,
      completedTurns: 0,
      totalTurns: 0,
      lastDecision: 'ERROR',
      summary: errorMessage,
      updatedAt: Date.now(),
    });
    throw error;
  }
};

export const runBtwPrompt = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  prompt: string,
  cwd: string,
  options?: {
    sessionId?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    claudeSessionId?: string;
    baseClaudeSessionId?: string;
  },
): Promise<BtwResponse> =>
  new Promise((resolve, reject) => {
    void (async () => {
      let inheritedContext = false;
      const sessionArgs: string[] = [];

      if (options?.claudeSessionId) {
        sessionArgs.push('--resume', options.claudeSessionId);
        inheritedContext = true;
      } else if (options?.baseClaudeSessionId) {
        sessionArgs.push('--resume', options.baseClaudeSessionId, '--fork-session');
        inheritedContext = true;
      } else {
        sessionArgs.push('-n', 'BTW');
      }

      const args = buildClaudePrintArgs({
        model: options?.model,
        effort: options?.effort,
        sessionArgs,
      });
      const child = spawn('claude', args, getClaudeSpawnOptions(cwd));

      let stderrBuffer = '';
      let content = '';
      let claudeSessionId = options?.claudeSessionId;
      let model = options?.model;
      let tokenUsage: TokenUsage | undefined;
      let btwLastAssistantUsage: import('./claudeInteractionState.js').PerCallUsage | undefined;

      const processLine = (line: string) => {
        if (!line.trim()) {
          return;
        }

        const parsed = JSON.parse(line) as Record<string, unknown>;
        const askUserQuestionRequest = parseClaudeAskUserQuestionControlRequest(parsed);
        if (askUserQuestionRequest) {
          const stdin = child.stdin;
          if (isWritableStdin(child) && stdin) {
            stdin.write(`${buildClaudeControlResponseLine(askUserQuestionRequest, 'allow')}\n`);
          }
          return;
        }

        const planModeControlRequest = parseClaudePlanModeControlRequest(parsed);
        if (planModeControlRequest) {
          const stdin = child.stdin;
          if (isWritableStdin(child) && stdin) {
            stdin.write(`${buildClaudeControlResponseLine(planModeControlRequest, 'allow')}\n`);
          }
          return;
        }

        const permissionControlRequest = parseClaudePermissionControlRequest(parsed);
        if (permissionControlRequest) {
          if (options?.sessionId) {
            const approvalPreference = state.sessionPlanApprovalPreferences.get(options.sessionId);
            if (approvalPreference && approvalPreference !== 'manual' && !permissionControlRequest.sensitive) {
              const stdin = child.stdin;
              if (isWritableStdin(child) && stdin) {
                stdin.write(`${buildClaudeControlResponseLine(permissionControlRequest, 'allow')}\n`);
              }
              return;
            }
          }

          state.pendingPermissionRequests.set(permissionControlRequest.requestId, {
            sessionId: options?.sessionId ?? '',
            activeRun: {
              runId: randomUUID(),
              sessionId: options?.sessionId ?? '',
              child,
              projectRoot: cwd,
            },
            request: permissionControlRequest,
          });

          if (options?.sessionId) {
            ctx.broadcastEvent({
              type: 'permission-request',
              sessionId: options.sessionId,
              requestId: permissionControlRequest.requestId,
              toolName: permissionControlRequest.toolName,
              targetPath: permissionControlRequest.targetPath,
              command: permissionControlRequest.command,
              description: permissionControlRequest.description,
              decisionReason: permissionControlRequest.decisionReason,
              sensitive: permissionControlRequest.sensitive,
            });
          }
          return;
        }
        const resolvedClaudeSessionId = extractClaudeSessionId(parsed);
        if (resolvedClaudeSessionId) {
          claudeSessionId = resolvedClaudeSessionId;
        }

        if (parsed.type === 'assistant') {
          const message = parsed.message as {
            model?: string;
            content?: Array<{ type?: string; text?: string; name?: string; id?: string; input?: unknown }>;
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          if (typeof message?.model === 'string' && message.model.trim()) {
            model = message.model.trim();
          }
          if (message?.usage) {
            btwLastAssistantUsage = {
              input_tokens: message.usage.input_tokens ?? 0,
              cache_read_input_tokens: message.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: message.usage.cache_creation_input_tokens ?? 0,
            };
          }
          const text = message?.content
            ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
          if (text) {
            content = text;
          }

          for (const block of message?.content ?? []) {
            if (block.type !== 'tool_use') {
              continue;
            }

            if (block.name === 'AskUserQuestion' && options?.sessionId) {
              const questions = parseAskUserQuestions(block.input);
              if (questions.length === 0) {
                continue;
              }

              registerAskUserQuestion(
                ctx,
                state,
                options.sessionId,
                {
                  runId: randomUUID(),
                  sessionId: options.sessionId,
                  child,
                  projectRoot: cwd,
                },
                String(block.id ?? randomUUID()),
                questions,
              );
              continue;
            }

            const planModeRequest = parsePlanModeRequest({
              toolName: block.name,
              toolUseId: String(block.id ?? ''),
              input: block.input,
            });
            if (planModeRequest) {
              respondToPlanModeRequest(
                {
                  runId: randomUUID(),
                  sessionId: options?.sessionId ?? '',
                  child,
                  projectRoot: cwd,
                },
                planModeRequest,
                planModeRequest.toolName === 'ExitPlanMode'
                  ? {
                      mode: 'revise',
                      notes: 'Interactive plan review is unavailable in BTW mode. Summarize the plan in plain text instead of exiting directly into execution.',
                    }
                  : undefined,
              );
            }
          }
        }

        if (parsed.type === 'result') {
          tokenUsage = mapTokenUsage(parsed, btwLastAssistantUsage);
          if (!content) {
            content = String(parsed.result ?? '');
          }
        }
      };

      const stdoutProcessor = createSequentialLineProcessor(async (line) => {
        processLine(line);
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutProcessor.pushChunk(chunk.toString());
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuffer += chunk.toString();
      });

      child.stdin.write(`${buildClaudeUserMessageLine(prompt)}\n`);

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        void (async () => {
          cleanupPendingRequestsForChild(state, child);
          try {
            await stdoutProcessor.flush();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }

          if (code !== 0) {
            reject(new Error(stderrBuffer.trim() || `Claude exited with code ${code ?? 'unknown'}.`));
            return;
          }

          resolve({
            claudeSessionId,
            model,
            content,
            tokenUsage,
            inheritedContext,
          });
        })();
      });
    })().catch(reject);
  });

export const stopSessions = (state: ClaudeInteractionState, sessionIds: string[]) => {
  sessionIds.forEach((sessionId) => {
    state.sessionPlanApprovalPreferences.delete(sessionId);
    state.deferredExitPlanControlRequests.delete(sessionId);
    requestSessionStop(state.sessionStopVersions, sessionId);
    const runs = listActiveClaudeRunsForSession(state.activeRuns, sessionId);
    runs.forEach((run) => {
      if (!run.child.killed) {
        run.child.kill();
      }
      removeActiveClaudeRun(state.activeRuns, run.runId);
    });
    for (const [requestId, pending] of state.pendingPermissionRequests) {
      if (pending.sessionId === sessionId) {
        state.pendingPermissionRequests.delete(requestId);
      }
    }
    for (const [requestId, pending] of state.pendingPlanModeRequests) {
      if (pending.sessionId === sessionId) {
        state.pendingPlanModeRequests.delete(requestId);
      }
    }
    for (const [toolUseId, pending] of state.pendingAskUserQuestions) {
      if (pending.sessionId === sessionId) {
        state.pendingAskUserQuestions.delete(toolUseId);
      }
    }
  });
};

export const getSlashCommands = async (state: ClaudeInteractionState, cwd: string, model?: string) => {
  const cacheKey = `${cwd}::${model ?? ''}`;
  const cached = state.slashCommandCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.commands;
  }

  return new Promise<string[]>((resolve) => {
    const args = [
      '-p',
      'Reply with only OK',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
    ];

    if (model) {
      args.push('--model', model);
    }

    const child = spawn('claude', args, getClaudeSpawnOptions(cwd));

    let stdoutBuffer = '';
    let settled = false;

    const finish = (commands: string[]) => {
      if (settled) {
        return;
      }
      settled = true;
      const normalized = [...new Set(commands.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
      state.slashCommandCache.set(cacheKey, {
        commands: normalized,
        expiresAt: Date.now() + 60_000,
      });
      if (!child.killed) {
        child.kill();
      }
      resolve(normalized);
    };

    const timeout = setTimeout(() => finish([]), 8_000);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === 'system' && parsed.subtype === 'init' && Array.isArray(parsed.slash_commands)) {
            clearTimeout(timeout);
            finish(
              parsed.slash_commands.filter((item): item is string => typeof item === 'string'),
            );
            return;
          }
        } catch {
          continue;
        }
      }
    });

    child.on('error', () => {
      clearTimeout(timeout);
      finish([]);
    });

    child.on('close', () => {
      clearTimeout(timeout);
      finish([]);
    });
  });
};
