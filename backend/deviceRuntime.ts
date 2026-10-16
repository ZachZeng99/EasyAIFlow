import path from 'node:path';
import { stopAllCodexRuns } from './codexInteraction.js';
import { appServerManager } from './codexAppServer.js';
import { ProviderModelCatalogStore, queryRuntimeCatalog, readProviderVersion, runtimeModelScope } from './providerModelCatalog.js';
import { settleClaudeSessionsForShutdown } from '../electron/appShutdown.js';
import {
  getRuntimePaths,
} from './runtimePaths.js';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import { createClaudeInteractionState } from './claudeInteractionState.js';
import { getGitSnapshot } from './claudeHelpers.js';
import {
  getSessionInteractionSnapshots,
  grantPathPermission,
  getConfiguredClaudeModel,
} from './claudeInteraction.js';
import {
  handleRespondToPermission,
  handleRespondToAskUserQuestion,
  handleRespondToPlanMode,
  handleStopSession,
  handleDisconnectSession,
  handleSendMessage,
  handleSwitchEffort,
  handleSwitchModel,
  handleBtwMessage,
  handleBtwDiscard,
  handleBootstrapSessions,
  handleCloseProject,
  handleDeleteStreamwork,
  handleDeleteSession,
} from './claudeRpcOperations.js';
import { getCodexAppServerInteractionSnapshots } from './codexAppServerTurn.js';
import { writeTextToSystemClipboard } from './systemClipboard.js';
import {
  createProject,
  createSession,
  createSessionInStreamwork,
  createStreamwork,
  getNativeSessionHistoryRevision,
  getSessionMessagePage,
  getSessionRecordForBootstrap,
  getProjectsForBootstrap,
  setSessionRuntime,
  renameEntity,
  reorderStreamworks,
  setSessionPinned,
  updateSessionContextReferences,
  flushPendingSave,
} from '../electron/sessionStore.js';
import { getFileDiff } from '../electron/fileDiff.js';
import type {
  ClaudeStreamEvent,
  ContextReference,
  PendingAttachment,
  ProjectRecord,
  SessionRecord,
  SessionSummary,
} from '../src/data/types.js';
import type { PlanModeResponsePayload } from '../src/data/planMode.js';
import { onSessionMessagesCommitted } from './sessionMessageEvents.js';

export const createDeviceRuntime = (broadcast: (event: ClaudeStreamEvent) => void) => {
  const models = new ProviderModelCatalogStore(path.join(getRuntimePaths().userDataPath, 'model-catalogs'), {
    load: queryRuntimeCatalog,
    scope: (provider, cwd) => runtimeModelScope(provider, cwd, getRuntimePaths().homePath),
    version: readProviderVersion,
  });
  const initializeSessionModel = async <T extends { session: SessionRecord }>(result: T): Promise<T> => {
    const session = result.session;
    if (!session.provider || session.sessionKind === 'group' || session.claudeSessionId || session.codexThreadId || session.messages.length > 0) return result;
    const catalog = await models.get(session.provider, session.workspace);
    const recommended = catalog.models.find((model) => model.isDefault);
    if (!recommended) return result;
    await setSessionRuntime(session.id, { model: recommended.id });
    return { ...result, session: { ...session, model: recommended.id } };
  };
  const ctx: ClaudeInteractionContext = {
    broadcastEvent: broadcast,
    attachmentRoot: () => path.join(getRuntimePaths().userDataPath, 'attachments'),
    claudeSettingsPath: () => path.join(getRuntimePaths().homePath, '.claude', 'settings.json'),
    homePath: () => getRuntimePaths().homePath,
  };
  const state = createClaudeInteractionState();
  const unsubscribe = onSessionMessagesCommitted(broadcast);
  const interactionEvents = () => {
    const events: ClaudeStreamEvent[] = [];
    const interactions = {
      ...getSessionInteractionSnapshots(state),
      ...getCodexAppServerInteractionSnapshots(),
    };

    Object.entries(interactions).forEach(([sessionId, interaction]) => {
      interaction.runtime &&
        events.push({
          type: 'runtime-state',
          sessionId,
          runtime: interaction.runtime,
        });

      interaction.backgroundTasks?.forEach((task) => {
        events.push({
          type: 'background-task',
          sessionId,
          task,
        });
      });

      const pendingPermissions = [
        ...(interaction.permission ? [interaction.permission] : []),
        ...(interaction.pendingPermissions ?? []),
      ];
      pendingPermissions.forEach((request) => {
        if (!request.requestId) {
          return;
        }
        events.push({
          type: 'permission-request',
          sessionId,
          requestId: request.requestId,
          toolName: 'Permission Request',
          targetPath: request.path,
          sensitive: request.sensitive,
        });
      });

      interaction.askUserQuestion &&
        events.push({
          type: 'ask-user-question',
          sessionId,
          toolUseId: interaction.askUserQuestion.toolUseId,
          questions: interaction.askUserQuestion.questions,
        });

      interaction.planModeRequest &&
        events.push({
          type: 'plan-mode-request',
          sessionId,
          request: interaction.planModeRequest.request,
        });
    });
    return events;
  };

  const deriveProjectNameFromPath = (rootPath: string) => {
    const parts = rootPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? 'Project';
  };

  const summarizeProjectsForWebBootstrap = (projects: ProjectRecord[]) => {
    let includedInitialVisibleSession = false;

    return projects.map((project) => ({
      ...project,
      dreams: project.dreams.map((dream) => ({
        ...dream,
        sessions: dream.sessions.map((session) => {
          const current = session as SessionRecord;
          const isVisible = !current.hidden;
          const shouldIncludeMessages =
            isVisible &&
            current.messagesLoaded !== false &&
            !includedInitialVisibleSession;

          if (shouldIncludeMessages) {
            includedInitialVisibleSession = true;
          }

          return {
            ...current,
            messages: shouldIncludeMessages ? (current.messages ?? []) : [],
            messagesLoaded: shouldIncludeMessages,
          };
        }),
      })),
    }));
  };

  const summarizeProjectsInResult = <T extends { projects: ProjectRecord[] }>(result: T): T => ({
    ...result,
    projects: summarizeProjectsForWebBootstrap(result.projects),
  });

  const rpcHandlers = {
    getProviderModels: (payload: { provider: 'claude' | 'codex'; cwd: string; force?: boolean }) => {
      if (!['claude', 'codex'].includes(payload.provider) || typeof payload.cwd !== 'string') throw new Error('Invalid provider or workspace.');
      return models.get(payload.provider, payload.cwd, payload.force);
    },
    'clipboard:write-text': async (payload: { value: string }) => {
      await writeTextToSystemClipboard(payload.value);
      return null;
    },
    getAppMeta: async () => ({
      name: 'EasyAIFlow',
      version: '0.1.0',
      platform: process.platform,
      defaultModel: await getConfiguredClaudeModel(ctx),
    }),
    getProjects: async () => {
      const bootstrap = await handleBootstrapSessions(state, { bootstrapProjects: true });
      return {
        ...bootstrap,
        projects: summarizeProjectsForWebBootstrap(bootstrap.projects),
      };
    },
    getSessionRecord: async (payload: { sessionId: string }) => {
      const session = await getSessionRecordForBootstrap(payload.sessionId, {
        finalizeTrailingUserTurn: !state.residentSessions.has(payload.sessionId),
        finalizeTrailingToolTurn: !state.residentSessions.has(payload.sessionId),
      });
      if (!session) {
        throw new Error('Session not found.');
      }

      return {
        ...session,
        messagesLoaded: true,
      };
    },
    getSessionHistoryRevision: async (payload: { sessionId: string }) =>
      getNativeSessionHistoryRevision(payload.sessionId),
    getSessionMessagePage: async (payload: { sessionId: string; before?: string }) =>
      getSessionMessagePage(payload.sessionId, payload.before),
    getGitSnapshot: async (payload: { cwd: string }) => getGitSnapshot(payload.cwd),
    getSlashCommands: async (payload: { cwd: string; model?: string }) => {
      let catalog = await models.get('claude', payload.cwd);
      if (catalog.commands === undefined && !catalog.stale) catalog = await models.get('claude', payload.cwd, true);
      return { commands: catalog.commands ?? [] };
    },
    sendBtwMessage: async (payload: {
      sessionId?: string;
      cwd: string;
      prompt: string;
      model?: string;
      effort?: string;
      baseClaudeSessionId?: string;
    }) => handleBtwMessage(ctx, state, payload),
    discardBtwSession: async (payload: { cwd: string; claudeSessionId?: string }) => {
      await handleBtwDiscard(ctx, state, payload);
      return null;
    },
    getFileDiff: async (payload: { cwd: string; filePath: string }) => getFileDiff(payload.cwd, payload.filePath),
    grantPathPermission: async (payload: { projectRoot: string; targetPath: string }) => {
      await grantPathPermission(ctx, payload.projectRoot, payload.targetPath);
      return null;
    },
    respondToPermissionRequest: async (payload: { requestId: string; behavior: 'allow' | 'deny' }) =>
      handleRespondToPermission(ctx, state, payload),
    respondToPlanModeRequest: async (payload: {
      requestId: string;
      behavior: 'allow' | 'deny';
      choice?: 'clear-auto' | 'auto' | 'manual' | 'revise';
      notes?: string;
    }) => {
      const pending = state.pendingPlanModeRequests.get(payload.requestId);
      if (!pending) {
        return { mode: 'missing' as const };
      }

      const toolUseId = pending.request.toolUseId;
      const mode: PlanModeResponsePayload['mode'] = payload.behavior === 'allow'
        ? (payload.choice === 'manual' ? 'approve_manual' : 'approve_accept_edits')
        : 'revise';
      return handleRespondToPlanMode(ctx, state, {
        toolUseId,
        mode,
        notes: payload.notes,
      });
    },
    respondToAskUserQuestion: async (payload: {
      toolUseId: string;
      answers: Record<string, string>;
      annotations?: Record<string, { notes?: string }>;
    }) => handleRespondToAskUserQuestion(ctx, state, payload),
    respondToPlanMode: async (payload: {
      toolUseId: string;
      mode: PlanModeResponsePayload['mode'];
      selectedPromptIndex?: number;
      notes?: string;
    }) => handleRespondToPlanMode(ctx, state, payload),
    createProject: async (payload: { name?: string; rootPath: string }) => {
      const before = new Set((await getProjectsForBootstrap()).map((project) => project.id));
      const result = await createProject(payload.name?.trim() || deriveProjectNameFromPath(payload.rootPath), payload.rootPath);
      return summarizeProjectsInResult(before.has(result.project.id) ? result : await initializeSessionModel(result));
    },
    closeProject: async (payload: { projectId: string }) =>
      summarizeProjectsInResult(await handleCloseProject(ctx, state, payload)),
    createStreamwork: async (payload: { projectId: string; name: string }) =>
      summarizeProjectsInResult(await initializeSessionModel(await createStreamwork(payload.projectId, payload.name))),
    deleteStreamwork: async (payload: { streamworkId: string }) =>
      summarizeProjectsInResult(await handleDeleteStreamwork(ctx, state, payload)),
    reorderStreamworks: async (payload: { projectId: string; sourceId: string; targetId: string }) =>
      summarizeProjectsInResult(
        await reorderStreamworks(payload.projectId, payload.sourceId, payload.targetId),
      ),
    createSession: async (payload?: {
      sourceSessionId?: string;
      includeStreamworkSummary?: boolean;
      provider?: import('../src/data/types.js').SessionProvider;
      sessionKind?: import('../src/data/types.js').SessionKind;
    }) =>
      summarizeProjectsInResult(
        await initializeSessionModel(await createSession(
          payload?.sourceSessionId,
          Boolean(payload?.includeStreamworkSummary),
          payload?.provider,
          payload?.sessionKind,
        )),
      ),
    createSessionInStreamwork: async (payload: {
      streamworkId: string;
      name?: string;
      includeStreamworkSummary?: boolean;
      provider?: import('../src/data/types.js').SessionProvider;
      sessionKind?: import('../src/data/types.js').SessionKind;
    }) =>
      summarizeProjectsInResult(
        await initializeSessionModel(await createSessionInStreamwork(
          payload.streamworkId,
          payload.name,
          Boolean(payload.includeStreamworkSummary),
          payload.provider,
          payload.sessionKind,
        )),
      ),
    deleteSession: async (payload: { sessionId: string }) =>
      summarizeProjectsInResult(await handleDeleteSession(ctx, state, payload)),
    setSessionPinned: async (payload: { sessionId: string; pinned: boolean }) =>
      summarizeProjectsInResult(await setSessionPinned(payload.sessionId, payload.pinned)),
    updateSessionContextReferences: async (payload: { sessionId: string; references: ContextReference[] }) =>
      summarizeProjectsInResult(await updateSessionContextReferences(payload.sessionId, payload.references)),
    renameEntity: async (payload: { kind: 'project' | 'streamwork' | 'session'; id: string; name: string }) =>
      summarizeProjectsInResult(await renameEntity(payload.kind, payload.id, payload.name)),
    sendMessage: async (payload: {
      sessionId: string;
      prompt: string;
      attachments?: PendingAttachment[];
      session?: SessionSummary;
      references?: ContextReference[];
      model?: string;
      effort?: string;
    }) => handleSendMessage(ctx, state, payload),
    switchModel: async (payload: {
      sessionId: string;
      session?: SessionSummary;
      model: string;
      effort?: string;
    }) => handleSwitchModel(ctx, state, payload),
    switchEffort: async (payload: {
      sessionId: string;
      session?: SessionSummary;
      effort: string;
    }) => handleSwitchEffort(ctx, state, payload),
    stopSessionRun: async (payload: { sessionId: string }) =>
      handleStopSession(ctx, state, payload),
    disconnectSession: async (payload: { sessionId: string }) =>
      handleDisconnectSession(ctx, state, payload),
  } as const;


  return {
    handlers: rpcHandlers,
    interactionEvents,
    hasActiveWork: () => state.sessionRunQueue.size > 0 || interactionEvents().some((event) => event.type === 'runtime-state' && ['running', 'background', 'awaiting_reply'].includes(event.runtime.phase)),
    close: async () => {
      unsubscribe();
      await settleClaudeSessionsForShutdown(ctx, state);
      stopAllCodexRuns();
      await appServerManager.closeAll();
      const children = new Set([...state.activeRuns.values(), ...state.residentSessions.values()].map((run) => run.child));
      await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (!child.killed) child.kill();
      })));
      await flushPendingSave();
    },
  };
};
export type DeviceRuntime = ReturnType<typeof createDeviceRuntime>;
