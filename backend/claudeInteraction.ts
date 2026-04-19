import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import { getRuntimePaths } from './runtimePaths.js';
import type {
  ActiveClaudeRun,
  ActiveClaudeTurn,
  ClaudeChildProcess,
  ClaudeInteractionState,
  ClaudePrintOptions,
  ClaudeRunState,
  PreparedClaudeRun,
  ResidentClaudeSession,
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
  ensureSessionRecord,
  findSession,
  getProjects,
  setSessionRuntime,
  updateAssistantMessage,
  updateSessionContextReferences,
  upsertSessionMessage,
} from '../electron/sessionStore.js';
import { getClaudeSyntheticApiError } from '../electron/claudeErrors.js';
import { applyParsedSessionMetadata } from '../electron/claudeSessionId.js';
import {
  applyAssistantTextToRunState,
  createClaudeRunState,
  getRunSessionRuntimeUpdate,
  markClaudeRunCompleted,
  markRunSessionRuntimePersisted,
  noteBackgroundTaskNotificationInRunState,
  shouldCompleteClaudeRunOnClose,
} from '../electron/claudeRunState.js';
import {
  extractBackgroundTaskNotificationContent,
  parseClaudeBackgroundTaskEvent,
} from '../electron/backgroundTaskNotification.js';
import {
  buildClaudeAskUserQuestionToolResultLine,
  buildClaudeControlRequestLine,
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
import { enqueueSessionRun } from '../electron/sessionRunQueue.js';
import {
  readSessionStopVersion,
  requestSessionStop,
  stopAssistantMessage,
  stopPendingSessionMessages,
} from '../electron/sessionStop.js';
import { buildRecordedCodeChangeDiff } from '../electron/recordedCodeChangeDiff.js';
import {
  normalizeClaudeModelSelection,
  resolveClaudeModelArg,
  shouldSwitchClaudeSessionModel,
} from '../electron/claudeModel.js';
import { getClaudeProjectDirNameCandidates } from '../electron/workspacePaths.js';
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
import type { SessionInteractionState } from '../src/data/sessionInteraction.js';
import {
  buildPlanModeResponseText,
  buildPlanModeTraceContent,
  parsePlanModeRequest,
  type PlanModeRequest,
  type PlanModeResponsePayload,
} from '../src/data/planMode.js';
import type {
  BackgroundTaskRecord,
  BtwResponse,
  ConversationMessage,
  ContextReference,
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
  return typeof parsed?.model === 'string' && parsed.model.trim()
    ? normalizeClaudeModelSelection(parsed.model.trim()) ?? parsed.model.trim()
    : undefined;
};

const resolveRequestedClaudeModel = async (
  ctx: ClaudeInteractionContext,
  requestedModel: string | undefined,
) => resolveClaudeModelArg(requestedModel, await readClaudeSettings(ctx));

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

const hasActiveBackgroundTasks = (runState: ClaudeRunState) =>
  [...runState.backgroundTasks.values()].some(
    (task) => task.status === 'pending' || task.status === 'running',
  );

type NativeClaudeBackgroundTaskCacheEntry = {
  mtimeMs: number;
  tasks: Map<string, BackgroundTaskRecord>;
};

const nativeClaudeBackgroundTaskCache = new Map<string, NativeClaudeBackgroundTaskCacheEntry>();
const terminalBackgroundTaskStatuses = new Set(['completed', 'failed', 'stopped']);

const listResidentRunStates = (resident: ResidentClaudeSession) => {
  const states: ClaudeRunState[] = [];
  const add = (runState?: ClaudeRunState) => {
    if (!runState || states.includes(runState)) {
      return;
    }
    states.push(runState);
  };

  add(resident.currentTurn?.runState);
  add(resident.activeOutputTurn?.runState);
  resident.backgroundTaskOwners.forEach((owner) => add(owner.runState));
  return states;
};

const getResidentClaudeSessionIds = (resident: ResidentClaudeSession) =>
  [
    ...new Set(
      listResidentRunStates(resident)
        .flatMap((runState) => [runState.persistedClaudeSessionId, runState.claudeSessionId])
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  ];

const nativeClaudeProjectsRoot = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.claude', 'projects');

const resolveNativeClaudeSessionLogPath = (
  projectRoot: string | undefined,
  claudeSessionId: string,
) => {
  if (!projectRoot?.trim() || !claudeSessionId.trim()) {
    return null;
  }

  const candidates = getClaudeProjectDirNameCandidates(projectRoot);
  for (const dirName of candidates) {
    const candidate = path.join(nativeClaudeProjectsRoot(), dirName, `${claudeSessionId}.jsonl`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

const readNativeClaudeTerminalBackgroundTasks = (
  projectRoot: string | undefined,
  claudeSessionId: string,
) => {
  const filePath = resolveNativeClaudeSessionLogPath(projectRoot, claudeSessionId);
  if (!filePath) {
    return new Map<string, BackgroundTaskRecord>();
  }

  try {
    const { mtimeMs } = statSync(filePath);
    const cached = nativeClaudeBackgroundTaskCache.get(filePath);
    if (cached?.mtimeMs === mtimeMs) {
      return cached.tasks;
    }

    const tasks = new Map<string, BackgroundTaskRecord>();
    const content = readFileSync(filePath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const task = parseClaudeBackgroundTaskEvent(parsed);
        if (!task || !terminalBackgroundTaskStatuses.has(task.status)) {
          return;
        }

        tasks.set(task.taskId, {
          ...(tasks.get(task.taskId) ?? {}),
          ...task,
        });
      } catch {
        // Ignore malformed native log lines while reconciling resident state.
      }
    });

    nativeClaudeBackgroundTaskCache.set(filePath, { mtimeMs, tasks });
    return tasks;
  } catch {
    return new Map<string, BackgroundTaskRecord>();
  }
};

const reconcileResidentBackgroundTasksFromNativeHistory = (resident: ResidentClaudeSession) => {
  const projectRoot = resident.projectRoot?.trim();
  if (!projectRoot) {
    return;
  }

  const runStates = listResidentRunStates(resident);
  if (runStates.length === 0) {
    return;
  }

  const terminalTasks = new Map<string, BackgroundTaskRecord>();
  getResidentClaudeSessionIds(resident).forEach((claudeSessionId) => {
    readNativeClaudeTerminalBackgroundTasks(projectRoot, claudeSessionId).forEach((task, taskId) => {
      terminalTasks.set(taskId, {
        ...(terminalTasks.get(taskId) ?? {}),
        ...task,
      });
    });
  });

  if (terminalTasks.size === 0) {
    return;
  }

  runStates.forEach((runState) => {
    runState.backgroundTasks.forEach((task, taskId) => {
      if (task.status !== 'pending' && task.status !== 'running') {
        return;
      }

      const terminalTask = terminalTasks.get(taskId);
      if (!terminalTask) {
        return;
      }

      runState.backgroundTasks.set(taskId, {
        ...task,
        ...terminalTask,
        updatedAt: Math.max(task.updatedAt ?? 0, terminalTask.updatedAt ?? 0) || undefined,
      });
    });
  });
};

const emitRuntimeState = (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  phase: import('../src/data/types.js').SessionRuntimePhase,
  processActive: boolean,
  appliedEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
) => {
  ctx.broadcastEvent({
    type: 'runtime-state',
    sessionId,
    runtime: {
      processActive,
      phase,
      appliedEffort,
      updatedAt: Date.now(),
    },
  });
};

const getResidentSession = (
  state: ClaudeInteractionState,
  sessionId: string,
) => state.residentSessions.get(sessionId);

const removeResidentSession = (
  state: ClaudeInteractionState,
  sessionId: string,
) => {
  state.residentSessions.delete(sessionId);
};

const canRestartResidentSession = (resident: ResidentClaudeSession) =>
  !resident.currentTurn &&
  ![...resident.backgroundTaskOwners.values()].some((owner) =>
    [...owner.runState.backgroundTasks.values()].some(
      (task) => task.status === 'pending' || task.status === 'running',
    ),
  );

const rejectResidentControlRequests = (
  resident: ResidentClaudeSession,
  error: unknown,
) => {
  resident.pendingControlRequests.forEach((pending) => pending.reject(error));
  resident.pendingControlRequests.clear();
};

const requestResidentModelSwitch = async (
  sessionId: string,
  resident: ResidentClaudeSession,
  nextModel: string | undefined,
) => {
  if (!nextModel) {
    return;
  }
  if (!isWritableStdin(resident.child) || !resident.child.stdin) {
    throw new Error('Claude stdin is not writable.');
  }

  const requestId = randomUUID();
  const completion = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      resident.pendingControlRequests.delete(requestId);
      reject(new Error(`Timed out waiting for Claude to switch model for session ${sessionId}.`));
    }, 8_000);

    resident.pendingControlRequests.set(requestId, {
      subtype: 'set_model',
      nextModel,
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
  });

  resident.child.stdin.write(
    `${buildClaudeControlRequestLine('set_model', { model: nextModel }, { requestId })}\n`,
  );
  await completion;
};

const registerBackgroundTaskOwner = (
  resident: ResidentClaudeSession,
  taskId: string,
  assistantMessageId: string,
  runState: ClaudeRunState,
) => {
  resident.backgroundTaskOwners.set(taskId, {
    assistantMessageId,
    runState,
  });
};

const handoffResidentTurnToBackground = (
  resident: ResidentClaudeSession,
  assistantMessageId: string,
  runState: ClaudeRunState,
) => {
  const currentTurn = resident.currentTurn;
  if (
    !currentTurn ||
    currentTurn.assistantMessageId !== assistantMessageId ||
    currentTurn.runState !== runState
  ) {
    return;
  }

  resident.activeOutputTurn = currentTurn;
  resident.currentTurn = undefined;
  currentTurn.releaseQueuedTurn();
  currentTurn.resolveCompletion();
};

const finalizeBackgroundOwnersIfSettled = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  resident: ResidentClaudeSession,
) => {
  reconcileResidentBackgroundTasksFromNativeHistory(resident);
  const seen = new Set<string>();
  for (const [taskId, owner] of resident.backgroundTaskOwners) {
    if (seen.has(owner.assistantMessageId)) {
      continue;
    }
    seen.add(owner.assistantMessageId);
    const hasActiveTasks = [...owner.runState.backgroundTasks.values()].some(
      (task) => task.status === 'pending' || task.status === 'running',
    );
    if (hasActiveTasks) {
      continue;
    }

    await completeAssistantRun(
      ctx,
      sessionId,
      owner.assistantMessageId,
      owner.runState,
      owner.runState.lastResultContent ?? owner.runState.content,
    );
    for (const [ownedTaskId, candidate] of resident.backgroundTaskOwners) {
      if (candidate.assistantMessageId === owner.assistantMessageId) {
        resident.backgroundTaskOwners.delete(ownedTaskId);
      }
    }
    // Delete the current entry as well in case it was skipped by map iteration semantics.
    resident.backgroundTaskOwners.delete(taskId);
  }
};

const residentHasActiveBackgroundTasks = (resident: ResidentClaudeSession) =>
  [...resident.backgroundTaskOwners.values()].some((owner) =>
    [...owner.runState.backgroundTasks.values()].some(
      (task) => task.status === 'pending' || task.status === 'running',
    ),
  );

const residentHasForegroundTurn = (resident: ResidentClaudeSession | undefined) =>
  Boolean(resident?.currentTurn && !hasActiveBackgroundTasks(resident.currentTurn.runState));

const collectResidentBackgroundTasks = (resident: ResidentClaudeSession): BackgroundTaskRecord[] => {
  reconcileResidentBackgroundTasksFromNativeHistory(resident);
  const tasks = new Map<string, BackgroundTaskRecord>();

  const collect = (runState?: ClaudeRunState) => {
    if (!runState) {
      return;
    }
    runState.backgroundTasks.forEach((task, taskId) => {
      tasks.set(taskId, {
        ...(tasks.get(taskId) ?? {}),
        ...task,
      });
    });
  };

  collect(resident.currentTurn?.runState);
  collect(resident.activeOutputTurn?.runState);
  resident.backgroundTaskOwners.forEach((owner) => collect(owner.runState));

  return [...tasks.values()]
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, 24);
};

const deriveResidentRuntimePhase = (
  state: ClaudeInteractionState,
  sessionId: string,
  resident: ResidentClaudeSession,
): import('../src/data/types.js').SessionRuntimePhase => {
  reconcileResidentBackgroundTasksFromNativeHistory(resident);
  const hasBlockingInteraction =
    [...state.pendingPermissionRequests.values()].some((pending) => pending.sessionId === sessionId) ||
    [...state.pendingAskUserQuestions.values()].some((pending) => pending.sessionId === sessionId) ||
    [...state.pendingPlanModeRequests.values()].some((pending) => pending.sessionId === sessionId);

  if (hasBlockingInteraction) {
    return 'awaiting_reply';
  }

  if (resident.currentTurn) {
    return hasActiveBackgroundTasks(resident.currentTurn.runState) ? 'background' : 'running';
  }

  if (resident.activeOutputTurn) {
    return hasActiveBackgroundTasks(resident.activeOutputTurn.runState) ? 'background' : 'running';
  }

  if (residentHasActiveBackgroundTasks(resident)) {
    return 'background';
  }

  return 'idle';
};

export const syncResidentRuntimeState = (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
  resident: ResidentClaudeSession,
) => {
  const processActive =
    !resident.child.killed &&
    resident.child.exitCode === null &&
    resident.child.signalCode === null;

  emitRuntimeState(
    ctx,
    sessionId,
    processActive ? deriveResidentRuntimePhase(state, sessionId, resident) : 'inactive',
    processActive,
    resident.configuredEffort,
  );
};

export const getSessionInteractionSnapshots = (
  state: ClaudeInteractionState,
): Record<string, SessionInteractionState> => {
  const snapshots: Record<string, SessionInteractionState> = {};
  const ensureSnapshot = (sessionId: string) => {
    snapshots[sessionId] ??= {};
    return snapshots[sessionId];
  };

  state.residentSessions.forEach((resident, sessionId) => {
    const snapshot = ensureSnapshot(sessionId);
    const backgroundTasks = collectResidentBackgroundTasks(resident);
    if (backgroundTasks.length > 0) {
      snapshot.backgroundTasks = backgroundTasks;
    }

    const processActive =
      !resident.child.killed &&
      resident.child.exitCode === null &&
      resident.child.signalCode === null;

    snapshot.runtime = {
      processActive,
      phase: processActive ? deriveResidentRuntimePhase(state, sessionId, resident) : 'inactive',
      appliedEffort: resident.configuredEffort,
      updatedAt: Date.now(),
    };
  });

  state.pendingPermissionRequests.forEach((pending, requestId) => {
    const snapshot = ensureSnapshot(pending.sessionId);
    const request = {
      path:
        pending.request.targetPath ??
        pending.request.command ??
        pending.request.description ??
        pending.request.toolName,
      sensitive: pending.request.sensitive,
      requestId,
      sessionId: pending.sessionId,
    };
    if (!snapshot.permission) {
      snapshot.permission = request;
      return;
    }
    snapshot.pendingPermissions = [...(snapshot.pendingPermissions ?? []), request];
  });

  state.pendingAskUserQuestions.forEach((pending) => {
    const snapshot = ensureSnapshot(pending.sessionId);
    snapshot.askUserQuestion = {
      sessionId: pending.sessionId,
      toolUseId: pending.toolUseId,
      questions: pending.questions,
    };
  });

  state.pendingPlanModeRequests.forEach((pending) => {
    const snapshot = ensureSnapshot(pending.sessionId);
    snapshot.planModeRequest = {
      sessionId: pending.sessionId,
      request: pending.request,
    };
  });

  Object.values(snapshots).forEach((snapshot) => {
    if (
      !snapshot.runtime &&
      (snapshot.permission || snapshot.askUserQuestion || snapshot.planModeRequest)
    ) {
      snapshot.runtime = {
        processActive: true,
        phase: 'awaiting_reply',
        updatedAt: Date.now(),
      };
    }
  });

  return snapshots;
};

const createAutonomousAssistantTurn = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
): Promise<ActiveClaudeTurn | undefined> => {
  const session = await findSession(sessionId);
  if (!session) {
    return undefined;
  }

  const assistantMessage: ConversationMessage = {
    id: randomUUID(),
    role: 'assistant',
    timestamp: nowLabel(),
    title: 'Claude background response',
    content: '',
    status: 'background',
  };

  await upsertSessionMessage(sessionId, assistantMessage);
  ctx.broadcastEvent({
    type: 'trace',
    sessionId,
    message: assistantMessage,
  });

  return {
    userMessageId: `background-user-${assistantMessage.id}`,
    assistantMessageId: assistantMessage.id,
    stopVersion: readSessionStopVersion(new Map(), sessionId),
    session,
    runState: {
      ...createClaudeRunState(),
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      persistedClaudeSessionId: session.claudeSessionId,
      persistedModel: session.model,
      tokenUsage: session.tokenUsage,
      lastResultContent: undefined,
      backgroundTasks: new Map(),
      toolTraces: new Map<string, ConversationMessage>(),
      toolUseBlockIds: new Map<number, string>(),
      toolUseJsonBuffers: new Map<string, string>(),
    },
    releaseQueuedTurn: () => undefined,
    resolveCompletion: () => undefined,
    rejectCompletion: () => undefined,
  };
};

const createOwnerBackedOutputTurn = (
  session: SessionSummary,
  assistantMessageId: string,
  runState: ClaudeRunState,
): ActiveClaudeTurn => ({
  userMessageId: `background-owner-${assistantMessageId}`,
  assistantMessageId,
  stopVersion: 0,
  session,
  runState,
  releaseQueuedTurn: () => undefined,
  resolveCompletion: () => undefined,
  rejectCompletion: () => undefined,
});

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const getNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const normalizeBackgroundTaskStatusFromToolResult = (value: unknown) => {
  switch (value) {
    case 'completed':
      return 'completed' as const;
    case 'failed':
      return 'failed' as const;
    case 'killed':
    case 'stopped':
    case 'cancelled':
      return 'stopped' as const;
    default:
      return undefined;
  }
};

const extractToolResultText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }

      if (!block || typeof block !== 'object') {
        return '';
      }

      const typedBlock = block as { type?: string; text?: unknown; content?: unknown };
      if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
        return typedBlock.text;
      }

      return extractToolResultText(typedBlock.content);
    })
    .filter(Boolean)
    .join('\n');
};

const extractBackgroundTaskOwnerIdFromPayload = (payload: unknown) => {
  const structured = asObject(payload);
  return (
    getNonEmptyString(structured?.backgroundTaskId) ??
    getNonEmptyString(structured?.agentId)
  );
};

export const extractBackgroundTaskResolutionFromToolUseResult = (payload: {
  toolUseResult?: unknown;
  resultText: string;
}) => {
  const structured = asObject(payload.toolUseResult);
  const taskId = extractBackgroundTaskOwnerIdFromPayload(structured);
  const status = normalizeBackgroundTaskStatusFromToolResult(structured?.status);
  if (!taskId || !status) {
    return null;
  }

  return {
    taskId,
    status,
    result: payload.resultText.trim() || undefined,
  };
};

export const parseBackgroundLaunchFromToolResult = (payload: {
  content: unknown;
  toolUseResult?: unknown;
  toolUseId: string;
}) => {
  const normalized = extractToolResultText(payload.content).trim();
  const structured = asObject(payload.toolUseResult);
  const structuredTaskId =
    getNonEmptyString(structured?.backgroundTaskId) ??
    getNonEmptyString(structured?.agentId);
  const structuredOutputFile = getNonEmptyString(structured?.outputFile);
  const structuredStatus = getNonEmptyString(structured?.status);
  const structuredDescription = getNonEmptyString(structured?.description);
  const settledStructuredStatuses = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled']);

  if (structuredTaskId && getNonEmptyString(structured?.backgroundTaskId)) {
    if (structuredStatus && settledStructuredStatuses.has(structuredStatus)) {
      return null;
    }
    return {
      taskId: structuredTaskId,
      status: 'running' as const,
      description: structuredDescription ?? 'Background command task',
      toolUseId: payload.toolUseId,
      taskType: 'command',
      outputFile:
        structuredOutputFile ??
        normalized.match(/Output is being written to:\s*([^\r\n]+)/i)?.[1]?.trim(),
      summary: normalized.split(/\r?\n/)[0]?.trim() || 'Background command launched.',
      updatedAt: Date.now(),
    };
  }

  if (structured?.isAsync === true && structuredStatus === 'async_launched') {
    return {
      taskId: structuredTaskId ?? `tool-${payload.toolUseId}`,
      status: 'running' as const,
      description: structuredDescription ?? 'Background agent task',
      toolUseId: payload.toolUseId,
      taskType: 'agent',
      outputFile:
        structuredOutputFile ??
        normalized.match(/output_file:\s*([^\r\n]+)/i)?.[1]?.trim(),
      summary: normalized.split(/\r?\n/)[0]?.trim() || 'Background agent launched.',
      updatedAt: Date.now(),
    };
  }

  const commandBackgroundMatch = normalized.match(
    /^Command running in background with ID:\s*([^\s.]+)/i,
  );
  if (commandBackgroundMatch) {
    return {
      taskId: commandBackgroundMatch[1] ?? `tool-${payload.toolUseId}`,
      status: 'running' as const,
      description: 'Background command task',
      toolUseId: payload.toolUseId,
      taskType: 'command',
      outputFile:
        normalized.match(/Output is being written to:\s*([^\r\n]+)/i)?.[1]?.trim(),
      summary: normalized.split(/\r?\n/)[0]?.trim() || 'Background command launched.',
      updatedAt: Date.now(),
    };
  }

  if (/^Async agent launched successfully\./i.test(normalized)) {
    return {
      taskId:
        normalized.match(/agentId:\s*([^\s.]+)/i)?.[1] ??
        `tool-${payload.toolUseId}`,
      status: 'running' as const,
      description: structuredDescription ?? 'Background agent task',
      toolUseId: payload.toolUseId,
      taskType: 'agent',
      outputFile:
        structuredOutputFile ??
        normalized.match(/output_file:\s*([^\r\n]+)/i)?.[1]?.trim(),
      summary: normalized.split(/\r?\n/)[0]?.trim() || 'Background agent launched.',
      updatedAt: Date.now(),
    };
  }

  return null;
};

const resolveAssistantVisibleContent = (
  runState: ClaudeRunState,
  preferredFallback = '',
) => {
  // Prefer accumulated streaming content when it is longer than the result
  // event's content, because multi-turn responses (with tool use) may only
  // include the last text block in the result event.
  const result = runState.lastResultContent?.trim() ? runState.lastResultContent : undefined;
  const streamed = runState.content?.trim() ? runState.content : undefined;

  if (result && streamed) {
    return streamed.length >= result.length ? streamed : result;
  }

  const candidates = [
    streamed,
    result,
    runState.lastToolResultContent,
    preferredFallback,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  return '';
};

export const getAssistantMessageSnapshot = (runState: ClaudeRunState) => {
  const content = runState.content.trim();
  if (!content) {
    return null;
  }

  const status = hasActiveBackgroundTasks(runState) ? ('background' as const) : ('streaming' as const);
  return {
    content: runState.content,
    status,
    title: buildMessageTitle(runState.content, 'Claude response'),
  };
};

export const getResidentIdleTurnOutcome = (runState: ClaudeRunState) => {
  if (hasActiveBackgroundTasks(runState)) {
    return null;
  }

  const content = resolveAssistantVisibleContent(runState);
  if (runState.receivedResult || content.trim()) {
    return {
      kind: 'complete' as const,
      content,
    };
  }

  return {
    kind: 'error' as const,
    content: 'Claude finished without returning a visible response.',
  };
};

export const isClaudeAssistantEndTurnEvent = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const record = payload as {
    type?: unknown;
    stop_reason?: unknown;
    message?: { stop_reason?: unknown };
  };

  return (
    record.type === 'assistant' &&
    (record.stop_reason === 'end_turn' || record.message?.stop_reason === 'end_turn')
  );
};

export const shouldFinalizeResidentAssistantEndTurn = (
  payload: unknown,
  runState: ClaudeRunState,
) =>
  isClaudeAssistantEndTurnEvent(payload) &&
  Boolean(runState.content.trim() || runState.completedContent?.trim() || runState.lastResultContent?.trim());

export const shouldForkResidentClaudeSession = (input: {
  session: Pick<SessionSummary, 'claudeSessionId' | 'sessionKind'>;
  persistedModel?: string;
  resolvedModel?: string;
  hasResident: boolean;
  effortChanged: boolean;
}) => {
  const settingsChanged =
    Boolean(input.persistedModel && input.resolvedModel && input.persistedModel !== input.resolvedModel) ||
    (input.hasResident && input.effortChanged);

  if (!input.session.claudeSessionId || !settingsChanged) {
    return false;
  }

  return input.session.sessionKind !== 'group_member';
};

const mergeBackgroundTaskRecord = (
  previous: BackgroundTaskRecord | undefined,
  next: BackgroundTaskRecord,
): BackgroundTaskRecord => ({
  ...(previous ?? {}),
  ...next,
});

export const completeAssistantRun = async (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  assistantMessageId: string,
  runState: ClaudeRunState,
  fallbackContent = '',
) => {
  const content = resolveAssistantVisibleContent(runState, fallbackContent);
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
  options?: {
    persistentSession?: boolean;
    onBackgroundTaskOwner?: (taskId: string, assistantMessageId: string, runState: ClaudeRunState) => void;
    onBackgroundActivated?: (assistantMessageId: string, runState: ClaudeRunState) => void;
    appliedEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  },
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
  }
  const backgroundTask = parseClaudeBackgroundTaskEvent(parsed);
  if (backgroundTask) {
    const mergedBackgroundTask = mergeBackgroundTaskRecord(
      runState.backgroundTasks.get(backgroundTask.taskId),
      backgroundTask,
    );
    runState.backgroundTasks.set(mergedBackgroundTask.taskId, mergedBackgroundTask);
    if (mergedBackgroundTask.result?.trim()) {
      runState.lastToolResultContent = mergedBackgroundTask.result;
    }
    options?.onBackgroundTaskOwner?.(mergedBackgroundTask.taskId, assistantMessageId, runState);
    if (mergedBackgroundTask.status === 'pending' || mergedBackgroundTask.status === 'running') {
      emitRuntimeState(ctx, sessionId, 'background', true, options?.appliedEffort);
      options?.onBackgroundActivated?.(assistantMessageId, runState);
      await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
        if (
          message.role === 'assistant' &&
          (message.status === 'queued' ||
            message.status === 'streaming' ||
            message.status === 'running')
        ) {
          message.status = 'background';
        }
      });
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: assistantMessageId,
        status: 'background',
      });
    }
    ctx.broadcastEvent({
      type: 'background-task',
      sessionId,
      task: mergedBackgroundTask,
    });
    if (parsed.type === 'system' || parsed.type === 'queue-operation') {
      return;
    }
  }
  if (parsed.type === 'system') {
    const systemState = typeof parsed.state === 'string' ? parsed.state : undefined;
    if (parsed.subtype === 'session_state_changed' && systemState === 'idle') {
      emitRuntimeState(ctx, sessionId, 'idle', true, options?.appliedEffort);
      if (!options?.persistentSession && isWritableStdin(activeRun.child) && activeRun.child.stdin) {
        activeRun.child.stdin.end();
      }
      return;
    }
  }
  const askUserQuestionRequest = parseClaudeAskUserQuestionControlRequest(parsed);
  if (askUserQuestionRequest) {
    emitRuntimeState(ctx, sessionId, 'awaiting_reply', true, options?.appliedEffort);
    const stdin = activeRun.child.stdin;
    if (isWritableStdin(activeRun.child) && stdin) {
      stdin.write(`${buildClaudeControlResponseLine(askUserQuestionRequest, 'allow')}\n`);
    }
    return;
  }

  const planModeControlRequest = parseClaudePlanModeControlRequest(parsed);
  if (planModeControlRequest) {
    if (planModeControlRequest.toolName === 'ExitPlanMode') {
      emitRuntimeState(ctx, sessionId, 'awaiting_reply', true, options?.appliedEffort);
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
    emitRuntimeState(ctx, sessionId, 'awaiting_reply', true, options?.appliedEffort);
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
      emitRuntimeState(ctx, sessionId, 'running', true, options?.appliedEffort);
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
    const turnText = message?.content
      ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    // Prefer accumulated content (includes all prior turns) to avoid losing
    // earlier text when the assistant event carries only the current turn.
    const finalText = runState.content || turnText || '';
    Object.assign(runState, applyAssistantTextToRunState(runState, finalText));
    const assistantSnapshot = getAssistantMessageSnapshot(runState);
    if (assistantSnapshot) {
      await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
        message.content = assistantSnapshot.content;
        message.status = assistantSnapshot.status;
        message.title = assistantSnapshot.title;
      });
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: assistantMessageId,
        status: assistantSnapshot.status,
        title: assistantSnapshot.title,
        content: assistantSnapshot.content,
      });
    }
    emitRuntimeState(
      ctx,
      sessionId,
      assistantSnapshot?.status === 'background' ? 'background' : 'running',
      true,
      options?.appliedEffort,
    );

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
            const rawToolResult = (parsed as { toolUseResult?: unknown }).toolUseResult;
            const resultContent = (block as { content?: unknown }).content;
            const resultText = extractToolResultText(resultContent) || 'Tool result returned.';
            if (resultText.trim()) {
              runState.lastToolResultContent = resultText;
            }
            const backgroundResolution = extractBackgroundTaskResolutionFromToolUseResult({
              toolUseResult: rawToolResult,
              resultText,
            });
            if (backgroundResolution) {
              const previousTask = runState.backgroundTasks.get(backgroundResolution.taskId);
              const nextTask = mergeBackgroundTaskRecord(previousTask, {
                ...(previousTask ?? {
                  taskId: backgroundResolution.taskId,
                  description: current.title === 'Agent' ? 'Background agent task' : 'Background task',
                  toolUseId,
                }),
                taskId: backgroundResolution.taskId,
                status: backgroundResolution.status,
                result: backgroundResolution.result,
                updatedAt: Date.now(),
              });
              runState.backgroundTasks.set(backgroundResolution.taskId, nextTask);
              ctx.broadcastEvent({
                type: 'background-task',
                sessionId,
                task: nextTask,
              });
            }
            current.content = appendTraceContent(current.content, resultText);
            current.status = (block as { is_error?: boolean }).is_error ? 'error' : 'success';
            await emitTraceMessage(ctx, sessionId, current);
            const backgroundLaunch = parseBackgroundLaunchFromToolResult({
              content: resultContent,
              toolUseResult: rawToolResult,
              toolUseId,
            });
            if (backgroundLaunch) {
              runState.backgroundTasks.set(backgroundLaunch.taskId, backgroundLaunch);
              options?.onBackgroundTaskOwner?.(backgroundLaunch.taskId, assistantMessageId, runState);
              options?.onBackgroundActivated?.(assistantMessageId, runState);
              await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
                if (
                  message.role === 'assistant' &&
                  (message.status === 'queued' ||
                    message.status === 'streaming' ||
                    message.status === 'running')
                ) {
                  message.status = 'background';
                }
              });
              ctx.broadcastEvent({
                type: 'status',
                sessionId,
                messageId: assistantMessageId,
                status: 'background',
              });
              ctx.broadcastEvent({
                type: 'background-task',
                sessionId,
                task: backgroundLaunch,
              });
            }
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
    runState.lastResultContent = String(parsed.result ?? '');
    runState.tokenUsage = mapTokenUsage(parsed, runState.lastAssistantUsage);
    const visibleContent = resolveAssistantVisibleContent(runState);
    if (!hasActiveBackgroundTasks(runState)) {
      await completeAssistantRun(
        ctx,
        sessionId,
        assistantMessageId,
        runState,
        visibleContent,
      );
      if (options?.persistentSession) {
        emitRuntimeState(ctx, sessionId, 'idle', true, options?.appliedEffort);
      }
      if (!options?.persistentSession && isWritableStdin(activeRun.child) && activeRun.child.stdin) {
        activeRun.child.stdin.end();
      }
      return;
    }

    if (visibleContent) {
      runState.content = visibleContent;
      const title = buildMessageTitle(visibleContent, 'Claude response');
      await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
        message.content = visibleContent;
        message.status = 'background';
        message.title = title;
      });
      await setSessionRuntime(sessionId, {
        claudeSessionId: runState.claudeSessionId,
        model: runState.model,
        preview: visibleContent,
        timeLabel: 'Just now',
        tokenUsage: runState.tokenUsage,
      });
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: assistantMessageId,
        status: 'background',
        title,
        content: visibleContent,
      });
    }
    return;
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

const createActiveTurn = (
  prepared: PreparedClaudeRun,
  releaseQueuedTurn: () => void,
  resolveCompletion: () => void,
  rejectCompletion: (error: unknown) => void,
): ActiveClaudeTurn => ({
  userMessageId: prepared.userMessageId,
  assistantMessageId: prepared.assistantMessageId,
  stopVersion: prepared.stopVersion,
  session: prepared.session,
  runState: {
    ...createClaudeRunState(),
    claudeSessionId: prepared.session.claudeSessionId,
    model: prepared.session.model,
    persistedClaudeSessionId: prepared.session.claudeSessionId,
    persistedModel: prepared.session.model,
    tokenUsage: prepared.session.tokenUsage,
    lastResultContent: undefined,
    backgroundTasks: new Map(),
    toolTraces: new Map<string, ConversationMessage>(),
    toolUseBlockIds: new Map<number, string>(),
    toolUseJsonBuffers: new Map<string, string>(),
  },
  releaseQueuedTurn,
  resolveCompletion,
  rejectCompletion,
});

const finalizeResidentSessionClose = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  resident: ResidentClaudeSession,
  code: number | null,
  error?: Error,
) => {
  cleanupPendingRequestsForRun(state, resident.runId);
  removeActiveClaudeRun(state.activeRuns, resident.runId);
  const currentResident = getResidentSession(state, resident.sessionId);
  const isCurrentResident = currentResident?.runId === resident.runId;
  if (isCurrentResident) {
    removeResidentSession(state, resident.sessionId);
    emitRuntimeState(ctx, resident.sessionId, 'inactive', false, resident.configuredEffort);
  }
  await resident.stdoutProcessor.flush();

  const turn = resident.currentTurn;
  resident.currentTurn = undefined;

  if (turn) {
    turn.releaseQueuedTurn();
    if (readSessionStopVersion(state.sessionStopVersions, resident.sessionId) !== turn.stopVersion) {
      const stopped = await stopAssistantMessage(resident.sessionId, turn.assistantMessageId);
      if (stopped) {
        ctx.broadcastEvent({
          type: 'status',
          sessionId: resident.sessionId,
          messageId: turn.assistantMessageId,
          status: stopped.status,
          title: stopped.title,
          content: stopped.content,
        });
      }
      turn.resolveCompletion();
    } else if (error) {
      await updateAssistantMessage(resident.sessionId, turn.assistantMessageId, (message) => {
        message.content = error.message;
        message.status = 'error';
        message.title = 'Claude error';
      });
      await setSessionRuntime(resident.sessionId, {
        claudeSessionId: turn.runState.claudeSessionId,
        model: turn.runState.model,
        preview: error.message,
        timeLabel: 'Just now',
      });
      ctx.broadcastEvent({
        type: 'error',
        sessionId: resident.sessionId,
        messageId: turn.assistantMessageId,
        error: error.message,
      });
      turn.resolveCompletion();
    } else if ((code ?? 0) === 0) {
      if (turn.runState.terminalError) {
        await setSessionRuntime(resident.sessionId, {
          claudeSessionId: turn.runState.claudeSessionId,
          model: turn.runState.model,
          preview: turn.runState.terminalError,
          timeLabel: 'Just now',
        });
      } else if (shouldCompleteClaudeRunOnClose(turn.runState)) {
        await completeAssistantRun(
          ctx,
          resident.sessionId,
          turn.assistantMessageId,
          turn.runState,
          turn.runState.lastResultContent ?? '',
        );
      }
      turn.resolveCompletion();
    } else {
      const nativeApiError = await readLatestNativeClaudeApiError(
        turn.session.workspace,
        turn.runState.claudeSessionId ?? turn.session.claudeSessionId,
      );
      const errorMessage =
        resident.stderrBuffer.trim() ||
        turn.runState.terminalError ||
        nativeApiError ||
        `Claude exited with code ${code ?? 'unknown'}.`;
      await updateAssistantMessage(resident.sessionId, turn.assistantMessageId, (message) => {
        message.content = errorMessage;
        message.status = 'error';
        message.title = 'Claude error';
      });
      await setSessionRuntime(resident.sessionId, {
        claudeSessionId: turn.runState.claudeSessionId,
        model: turn.runState.model,
        preview: errorMessage,
        timeLabel: 'Just now',
      });
      ctx.broadcastEvent({
        type: 'error',
        sessionId: resident.sessionId,
        messageId: turn.assistantMessageId,
        error: errorMessage,
      });
      turn.resolveCompletion();
    }
    await finalizeToolTraces(ctx, resident.sessionId, turn.runState);
  }

  await finalizeBackgroundOwnersIfSettled(ctx, resident.sessionId, resident);
};

const ensureResidentClaudeSession = async (
  callerCtx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  session: SessionSummary,
  options?: ClaudePrintOptions,
) => {
  // Wrap broadcastEvent so that registered interceptors (used by group chat to
  // mirror backing-session events to the room) are invoked for every event the
  // resident stdout processor produces — even for events that fire long after
  // the original caller's mirroredCtx has gone out of scope.
  const ctx: ClaudeInteractionContext = {
    ...callerCtx,
    broadcastEvent: (event) => {
      const interceptors = state.sessionBroadcastInterceptors.get(session.id);
      if (interceptors) {
        for (const fn of interceptors) {
          try {
            fn(event);
          } catch {
            // Best-effort: interceptor errors must not break the resident processor.
          }
        }
      }
      callerCtx.broadcastEvent(event);
    },
  };
  const resolvedModel = await resolveRequestedClaudeModel(ctx, options?.model);
  const persistedModel = await resolveRequestedClaudeModel(ctx, session.model);
  const existing = getResidentSession(state, session.id);
  const effortChanged = existing?.configuredEffort !== options?.effort;
  const modelChanged = existing?.configuredModel !== resolvedModel;
  if (existing && !existing.child.killed) {
    if (!modelChanged && !effortChanged) {
      return existing;
    }

    if (modelChanged && !effortChanged) {
      try {
        await requestResidentModelSwitch(session.id, existing, resolvedModel);
        existing.configuredModel = resolvedModel;
        await setSessionRuntime(session.id, {
          model: resolvedModel,
        });
        return existing;
      } catch (error) {
        if (!canRestartResidentSession(existing)) {
          throw error;
        }
      }
    } else if (!canRestartResidentSession(existing)) {
      throw new Error('Claude is busy and cannot apply the requested session settings yet.');
    }

    if (!existing.child.killed) {
      existing.child.kill();
    }
    removeResidentSession(state, session.id);
    removeActiveClaudeRun(state.activeRuns, existing.runId);
  }

  const forkSession = shouldForkResidentClaudeSession({
    session,
    persistedModel,
    resolvedModel,
    hasResident: Boolean(existing),
    effortChanged,
  });
  const args = buildClaudePrintArgs({
    model: resolvedModel,
    effort: options?.effort,
    sessionArgs: buildClaudeSessionArgs(session.claudeSessionId, session.title, forkSession),
  });

  const child = spawn('claude', args, getClaudeSpawnOptions(session.workspace));
  const activeRun = addActiveClaudeRun(state.activeRuns, {
    runId: randomUUID(),
    sessionId: session.id,
    child,
    projectRoot: session.workspace,
  });
  let resolveResidentReady: () => void = () => undefined;
  const residentReady = new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    resolveResidentReady = settle;
    setTimeout(settle, 8_000);
  });

  const resident: ResidentClaudeSession = {
    ...activeRun,
    configuredModel: resolvedModel,
    configuredEffort: options?.effort,
    stderrBuffer: '',
    queuedTurns: new Map(),
    backgroundTaskOwners: new Map(),
    pendingControlRequests: new Map(),
    stdoutProcessor: createSequentialLineProcessor(async (line) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      if (parsed.type === 'system' && parsed.subtype === 'init') {
        resolveResidentReady();
      }

      const currentResident = getResidentSession(state, session.id);
      if (!currentResident) {
        return;
      }

      if (parsed.type === 'system' && parsed.subtype === 'init') {
        if (typeof parsed.model === 'string' && parsed.model.trim()) {
          currentResident.configuredModel = parsed.model.trim();
        }
        resolveResidentReady();
      }

      if (parsed.type === 'control_response') {
        const response = parsed.response as
          | { request_id?: unknown; subtype?: unknown; error?: unknown }
          | undefined;
        const requestId =
          typeof response?.request_id === 'string' ? response.request_id : undefined;
        const pending = requestId
          ? currentResident.pendingControlRequests.get(requestId)
          : undefined;
        if (pending && requestId) {
          currentResident.pendingControlRequests.delete(requestId);
          if (response?.subtype === 'error') {
            pending.reject(
              new Error(
                typeof response.error === 'string'
                  ? response.error
                  : `Claude rejected control request ${requestId}.`,
              ),
            );
          } else {
            pending.resolve();
          }
        }
      }

      const parsedBackgroundTask = parseClaudeBackgroundTaskEvent(parsed);
      const ownerTaskId =
        (typeof parsed.task_id === 'string' ? parsed.task_id : undefined) ??
        extractBackgroundTaskOwnerIdFromPayload(
          (parsed as { toolUseResult?: unknown }).toolUseResult,
        ) ??
        parsedBackgroundTask?.taskId;
      const owner = ownerTaskId
        ? currentResident.backgroundTaskOwners.get(ownerTaskId)
        : undefined;

      if (
        parsed.type === 'user' &&
        parsed.isMeta !== true &&
        typeof parsed.uuid === 'string' &&
        !parsed.parent_tool_use_id
      ) {
        const matchedTurn = currentResident.queuedTurns.get(parsed.uuid);
        if (matchedTurn) {
          currentResident.queuedTurns.delete(parsed.uuid);
          currentResident.activeOutputTurn = matchedTurn;
          emitRuntimeState(ctx, session.id, 'running', true, currentResident.configuredEffort);
        }
      }

      let turn = currentResident.currentTurn ?? currentResident.activeOutputTurn;
      if (!turn && owner) {
        turn = createOwnerBackedOutputTurn(session, owner.assistantMessageId, owner.runState);
        currentResident.activeOutputTurn = turn;
      }
      if (
        !turn &&
        !owner &&
        parsed.type === 'system' &&
        parsed.subtype === 'task_notification'
      ) {
        turn = await createAutonomousAssistantTurn(ctx, session.id);
        if (turn) {
          currentResident.activeOutputTurn = turn;
        }
      }
      const assistantMessageId = owner?.assistantMessageId ?? turn?.assistantMessageId;
      const runState = owner?.runState ?? turn?.runState;
      const releaseTurn = turn?.releaseQueuedTurn ?? (() => undefined);

      if (!assistantMessageId || !runState) {
        if (
          parsed.type === 'system' &&
          (parsed.subtype === 'task_notification' ||
            (parsed.subtype === 'session_state_changed' && parsed.state === 'idle'))
        ) {
          await finalizeBackgroundOwnersIfSettled(ctx, session.id, currentResident);
          syncResidentRuntimeState(ctx, state, session.id, currentResident);
        }
        return;
      }

      await handleClaudeLine(
        ctx,
        state,
        session.id,
        assistantMessageId,
        line,
        runState,
        currentResident,
        releaseTurn,
        {
          persistentSession: true,
          onBackgroundTaskOwner: (taskId, ownerAssistantMessageId, ownerRunState) =>
            registerBackgroundTaskOwner(currentResident, taskId, ownerAssistantMessageId, ownerRunState),
          onBackgroundActivated: (backgroundAssistantMessageId, backgroundRunState) => {
            // Background-capable tools (for example async Agent/Bash launches)
            // should immediately yield the foreground turn so the next user
            // message can start without being queued behind background work.
            emitRuntimeState(ctx, session.id, 'background', true, currentResident.configuredEffort);
            handoffResidentTurnToBackground(
              currentResident,
              backgroundAssistantMessageId,
              backgroundRunState,
            );
          },
          appliedEffort: currentResident.configuredEffort,
        },
      );

      if (turn && parsed.type === 'result') {
        for (const [taskId, task] of turn.runState.backgroundTasks) {
          if (task.status === 'pending' || task.status === 'running') {
            registerBackgroundTaskOwner(currentResident, taskId, turn.assistantMessageId, turn.runState);
          }
        }
        if (!hasActiveBackgroundTasks(turn.runState)) {
          for (const [ownedTaskId, candidate] of currentResident.backgroundTaskOwners) {
            if (
              candidate.assistantMessageId === turn.assistantMessageId &&
              candidate.runState === turn.runState
            ) {
              currentResident.backgroundTaskOwners.delete(ownedTaskId);
            }
          }
        }
        if (currentResident.currentTurn === turn) {
          currentResident.currentTurn = undefined;
          turn.releaseQueuedTurn();
          turn.resolveCompletion();
        }
        if (currentResident.activeOutputTurn === turn) {
          currentResident.activeOutputTurn = undefined;
        }
      }

      const shouldFinalizeResidentTurn =
        (parsed.type === 'system' &&
          (parsed.subtype === 'task_notification' ||
            (parsed.subtype === 'session_state_changed' && parsed.state === 'idle'))) ||
        shouldFinalizeResidentAssistantEndTurn(parsed, runState);
      if (shouldFinalizeResidentTurn) {
        const matchedTurn =
          currentResident.currentTurn?.assistantMessageId === assistantMessageId &&
          currentResident.currentTurn.runState === runState
            ? currentResident.currentTurn
            : currentResident.activeOutputTurn?.assistantMessageId === assistantMessageId &&
                currentResident.activeOutputTurn.runState === runState
              ? currentResident.activeOutputTurn
              : undefined;
        const idleTurnOutcome =
          matchedTurn
            ? getResidentIdleTurnOutcome(matchedTurn.runState)
            : null;
        if (matchedTurn && idleTurnOutcome) {
          if (idleTurnOutcome.kind === 'complete') {
            await completeAssistantRun(
              ctx,
              session.id,
              matchedTurn.assistantMessageId,
              matchedTurn.runState,
              idleTurnOutcome.content,
            );
          } else {
            await finalizeToolTraces(ctx, session.id, matchedTurn.runState);
            await updateAssistantMessage(session.id, matchedTurn.assistantMessageId, (message) => {
              message.content = idleTurnOutcome.content;
              message.status = 'error';
              message.title = 'Claude error';
            });
            await setSessionRuntime(session.id, {
              claudeSessionId: matchedTurn.runState.claudeSessionId,
              model: matchedTurn.runState.model,
              preview: idleTurnOutcome.content,
              timeLabel: 'Just now',
              tokenUsage: matchedTurn.runState.tokenUsage,
            });
            ctx.broadcastEvent({
              type: 'error',
              sessionId: session.id,
              messageId: matchedTurn.assistantMessageId,
              error: idleTurnOutcome.content,
            });
          }

          if (currentResident.currentTurn === matchedTurn) {
            currentResident.currentTurn = undefined;
          }
          if (currentResident.activeOutputTurn === matchedTurn) {
            currentResident.activeOutputTurn = undefined;
          }
          matchedTurn.releaseQueuedTurn();
          matchedTurn.resolveCompletion();
        }
        if (
          !(
            parsed.subtype === 'task_notification' &&
            owner &&
            currentResident.activeOutputTurn?.assistantMessageId === owner.assistantMessageId &&
            currentResident.activeOutputTurn.runState === owner.runState
          )
        ) {
          await finalizeBackgroundOwnersIfSettled(ctx, session.id, currentResident);
        }
        syncResidentRuntimeState(ctx, state, session.id, currentResident);
      }
    }),
  };

  state.residentSessions.set(session.id, resident);
  emitRuntimeState(ctx, session.id, 'idle', true, resident.configuredEffort);

  child.stdout.on('data', (chunk: Buffer | string) => {
    resident.stdoutProcessor.pushChunk(chunk.toString());
  });

  child.stderr.on('data', (chunk: Buffer | string) => {
    resident.stderrBuffer += chunk.toString();
  });

  child.on('close', (code) => {
    resolveResidentReady();
    rejectResidentControlRequests(
      resident,
      new Error(`Claude exited before control requests completed (code ${code ?? 'unknown'}).`),
    );
    void finalizeResidentSessionClose(ctx, state, resident, code);
  });

  child.on('error', (error) => {
    resolveResidentReady();
    rejectResidentControlRequests(resident, error);
    void finalizeResidentSessionClose(ctx, state, resident, null, error);
  });
  await residentReady;
  return resident;
};

export const switchClaudeSessionModel = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: {
    sessionId: string;
    session?: SessionSummary;
    model: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  },
) => {
  const requestedModel = payload.model.trim();
  if (!requestedModel) {
    return {
      projects: await getProjects(),
    };
  }

  const session =
    (await findSession(payload.sessionId)) ??
    (payload.session ? await ensureSessionRecord(payload.session) : null);
  if (!session) {
    throw new Error('Session not found');
  }

  const currentResolvedModel = await resolveRequestedClaudeModel(ctx, session.model);
  const requestedResolvedModel = await resolveRequestedClaudeModel(ctx, requestedModel);
  if (
    !shouldSwitchClaudeSessionModel({
      claudeSessionId: session.claudeSessionId,
      currentResolvedModel,
      requestedResolvedModel,
    })
  ) {
    return {
      projects: await getProjects(),
    };
  }

  await runClaudePrintAndWait(
    ctx,
    state,
    payload.sessionId,
    `/model ${requestedModel}`,
    [],
    session,
    {
      effort: payload.effort,
    },
  );

  return {
    projects: await getProjects(),
  };
};

export const switchClaudeSessionEffort = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  payload: {
    sessionId: string;
    session?: SessionSummary;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  },
) => {
  const session =
    (await findSession(payload.sessionId)) ??
    (payload.session ? await ensureSessionRecord(payload.session) : null);
  if (!session) {
    throw new Error('Session not found');
  }

  const resident = getResidentSession(state, payload.sessionId);
  if (!resident && !session.claudeSessionId) {
    return {
      projects: await getProjects(),
    };
  }

  if (resident?.configuredEffort === payload.effort) {
    return {
      projects: await getProjects(),
    };
  }

  await runClaudePrintAndWait(
    ctx,
    state,
    payload.sessionId,
    `/effort ${payload.effort}`,
    [],
    session,
    {
      effort: resident?.configuredEffort,
    },
  );

  const currentResident = getResidentSession(state, payload.sessionId);
  if (currentResident) {
    currentResident.configuredEffort = payload.effort;
  }

  return {
    projects: await getProjects(),
  };
};

export const executePreparedClaudeRun = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  prepared: PreparedClaudeRun,
  releaseQueuedTurn: () => void,
) =>
  new Promise<void>((resolve, reject) => {
    const { session, resolvedPrompt } = prepared;
    void (async () => {
      const resident = await ensureResidentClaudeSession(ctx, state, session, prepared.options);
      const turn = createActiveTurn(prepared, releaseQueuedTurn, resolve, reject);
      resident.currentTurn = turn;
      emitRuntimeState(ctx, prepared.sessionId, 'running', true, resident.configuredEffort);
      if (!isWritableStdin(resident.child) || !resident.child.stdin) {
        turn.releaseQueuedTurn();
        resident.currentTurn = undefined;
        throw new Error('Claude stdin is not writable.');
      }
      resident.child.stdin.write(
        `${buildClaudeUserMessageLine(resolvedPrompt, { uuid: prepared.userMessageId })}\n`,
      );
    })().catch((error) => {
      releaseQueuedTurn();
      reject(error);
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
  const queued = residentHasForegroundTurn(getResidentSession(state, sessionId));
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
  const queued = residentHasForegroundTurn(getResidentSession(state, sessionId));
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

export const runBtwPrompt = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  prompt: string,
  cwd: string,
  options?: {
    sessionId?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    baseClaudeSessionId?: string;
  },
): Promise<BtwResponse> =>
  new Promise((resolve, reject) => {
    void (async () => {
      const stripPendingAssistantFromSession = (session: SessionRecord): SessionRecord => {
        const messages = [...(session.messages ?? [])];
        const lastMessage = messages.at(-1);
        if (
          lastMessage?.role === 'assistant' &&
          (lastMessage.status === 'queued' || lastMessage.status === 'streaming' || lastMessage.status === 'running')
        ) {
          return {
            ...session,
            messages: messages.slice(0, -1),
          };
        }

        return session;
      };

      const buildBtwFallbackContext = async (sessionId: string | undefined) => {
        if (!sessionId) {
          return '';
        }

        const session = await findSession(sessionId);
        if (!session) {
          return '';
        }

        const normalizedSession = stripPendingAssistantFromSession(session);
        const primaryContext =
          getConversationMessages(normalizedSession).length > 0
            ? buildSessionTranscriptContext(normalizedSession)
            : buildSessionSummaryContext(normalizedSession);
        const referenceContext = await buildContextReferencePrompt(sessionId);

        return [
          'Current main session context is provided below.',
          'Use it only as supporting context for this BTW side question.',
          'Do not claim any file inspection, command execution, or other actions unless they are explicitly present in the provided context.',
          '',
          primaryContext,
          referenceContext,
        ]
          .filter(Boolean)
          .join('\n\n');
      };

      const buildBtwPrompt = (question: string, sessionContext?: string) =>
        [
          sessionContext,
          question.trim(),
        ]
          .filter(Boolean)
          .join('\n\n');

      let inheritedContext = false;
      let fallbackContext = '';
      const sessionArgs: string[] = [];

      if (options?.baseClaudeSessionId) {
        sessionArgs.push('--resume', options.baseClaudeSessionId, '--fork-session');
        inheritedContext = true;
      } else {
        sessionArgs.push('-n', 'BTW');
        fallbackContext = await buildBtwFallbackContext(options?.sessionId);
        inheritedContext = Boolean(fallbackContext);
      }

      const args = buildClaudePrintArgs({
        model: await resolveRequestedClaudeModel(ctx, options?.model),
        effort: options?.effort,
        sessionArgs,
        tools: '',
        permissionMode: 'dontAsk',
        noSessionPersistence: true,
      });
      const child = spawn('claude', args, getClaudeSpawnOptions(cwd));

      let stderrBuffer = '';
      let content = '';
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

      child.stdin.write(`${buildClaudeUserMessageLine(buildBtwPrompt(prompt, fallbackContext))}\n`);

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
    const resident = getResidentSession(state, sessionId);
    if (resident) {
      if (resident.currentTurn) {
        resident.currentTurn.releaseQueuedTurn();
        resident.currentTurn.resolveCompletion();
        resident.currentTurn = undefined;
      }
      if (!resident.child.killed) {
        resident.child.kill();
      }
      removeResidentSession(state, sessionId);
    }
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

export const interruptSessionTurn = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
) => {
  const resident = getResidentSession(state, sessionId);
  if (!resident || !resident.currentTurn) {
    stopSessions(state, [sessionId]);
    return stopPendingSessionMessages(sessionId);
  }

  const turn = resident.currentTurn;
  resident.currentTurn = undefined;
  requestSessionStop(state.sessionStopVersions, sessionId);

  if (isWritableStdin(resident.child) && resident.child.stdin) {
    resident.child.stdin.write(`${buildClaudeControlRequestLine('interrupt')}\n`);
  }

  const hasBackgroundTasks = hasActiveBackgroundTasks(turn.runState);
  if (!hasBackgroundTasks) {
    const stopped = await stopAssistantMessage(sessionId, turn.assistantMessageId);
    if (stopped) {
      ctx.broadcastEvent({
        type: 'status',
        sessionId,
        messageId: turn.assistantMessageId,
        status: stopped.status,
        title: stopped.title,
        content: stopped.content,
      });
    }
  }

  turn.releaseQueuedTurn();
  turn.resolveCompletion();

  emitRuntimeState(
    ctx,
    sessionId,
    hasBackgroundTasks || residentHasActiveBackgroundTasks(resident) ? 'background' : 'idle',
    true,
  );

  return {
    projects: await getProjects(),
  };
};

export const disconnectSession = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  sessionId: string,
) => {
  const resident = getResidentSession(state, sessionId);
  if (resident && isWritableStdin(resident.child) && resident.child.stdin) {
    resident.child.stdin.write(`${buildClaudeControlRequestLine('end_session', { reason: 'host_disconnect' })}\n`);
  }
  stopSessions(state, [sessionId]);
  const result = await stopPendingSessionMessages(sessionId);
  emitRuntimeState(ctx, sessionId, 'inactive', false);
  return result;
};

export const getSlashCommands = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  cwd: string,
  model?: string,
) => {
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

    void (async () => {
      const resolvedModel = await resolveRequestedClaudeModel(ctx, model);
      if (resolvedModel) {
        args.push('--model', resolvedModel);
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
    })().catch(() => resolve([]));
  });
};
