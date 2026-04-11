import {
  disconnectSession,
  interruptSessionTurn,
  runClaudePrint,
  switchClaudeSessionEffort,
  switchClaudeSessionModel,
} from './claudeInteraction.js';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type { ClaudeInteractionState } from './claudeInteractionState.js';
import {
  disconnectCodexRun,
  runCodexPrint,
  stopCodexRun,
  switchCodexSessionEffort,
  switchCodexSessionModel,
} from './codexInteraction.js';
import { findSession } from '../electron/sessionStore.js';
import { normalizeSessionProvider } from '../src/data/sessionProvider.js';
import type {
  ContextReference,
  ConversationMessage,
  PendingAttachment,
  ProjectRecord,
  SessionProvider,
  SessionSummary,
} from '../src/data/types.js';

export type ProviderSessionRuntimeCapabilities = {
  residentSession: boolean;
  interactiveControl: boolean;
  disconnectBehavior: 'resident' | 'stop';
};

export type ProviderSessionSendMessagePayload = {
  sessionId: string;
  prompt: string;
  attachments?: PendingAttachment[];
  session?: SessionSummary;
  references?: ContextReference[];
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
};

export type ProviderSessionSwitchModelPayload = {
  sessionId: string;
  session?: SessionSummary;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
};

export type ProviderSessionSwitchEffortPayload = {
  sessionId: string;
  session?: SessionSummary;
  effort: 'low' | 'medium' | 'high' | 'max';
};

type ProviderSessionRunResult = {
  projects: ProjectRecord[];
  queued: {
    sessionId: string;
    userMessageId: string;
    assistantMessageId: string;
  };
};

type ProviderSessionProjectsResult = {
  projects: ProjectRecord[];
};

export type ProviderSessionRuntime = {
  provider: SessionProvider;
  capabilities: ProviderSessionRuntimeCapabilities;
  sendMessage: (
    ctx: ClaudeInteractionContext,
    state: ClaudeInteractionState,
    payload: ProviderSessionSendMessagePayload,
  ) => Promise<ProviderSessionRunResult>;
  switchModel: (
    ctx: ClaudeInteractionContext,
    state: ClaudeInteractionState,
    payload: ProviderSessionSwitchModelPayload,
  ) => Promise<ProviderSessionProjectsResult>;
  switchEffort: (
    ctx: ClaudeInteractionContext,
    state: ClaudeInteractionState,
    payload: ProviderSessionSwitchEffortPayload,
  ) => Promise<ProviderSessionProjectsResult>;
  stopSession: (
    ctx: ClaudeInteractionContext,
    state: ClaudeInteractionState,
    payload: { sessionId: string },
  ) => Promise<ProviderSessionProjectsResult>;
  disconnectSession: (
    ctx: ClaudeInteractionContext,
    state: ClaudeInteractionState,
    payload: { sessionId: string },
  ) => Promise<ProviderSessionProjectsResult>;
};

const broadcastDisconnectMessages = (
  ctx: ClaudeInteractionContext,
  sessionId: string,
  changedMessages: ConversationMessage[],
) => {
  changedMessages.forEach((message) => {
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
};

export const providerSessionRuntimes: Record<SessionProvider, ProviderSessionRuntime> = {
  claude: {
    provider: 'claude',
    capabilities: {
      residentSession: true,
      interactiveControl: true,
      disconnectBehavior: 'resident',
    },
    sendMessage: (ctx, state, payload) =>
      runClaudePrint(ctx, state, payload.sessionId, payload.prompt, payload.attachments ?? [], payload.session, {
        references: payload.references,
        model: payload.model,
        effort: payload.effort,
      }),
    switchModel: (ctx, state, payload) => switchClaudeSessionModel(ctx, state, payload),
    switchEffort: (ctx, state, payload) => switchClaudeSessionEffort(ctx, state, payload),
    stopSession: async (ctx, state, payload) => {
      const result = await interruptSessionTurn(ctx, state, payload.sessionId);
      return {
        projects: result.projects,
      };
    },
    disconnectSession: async (ctx, state, payload) => {
      const result = await disconnectSession(ctx, state, payload.sessionId);
      broadcastDisconnectMessages(ctx, payload.sessionId, result.changedMessages);
      return {
        projects: result.projects,
      };
    },
  },
  codex: {
    provider: 'codex',
    capabilities: {
      residentSession: false,
      interactiveControl: false,
      disconnectBehavior: 'stop',
    },
    sendMessage: (ctx, _state, payload) =>
      runCodexPrint(ctx, payload.sessionId, payload.prompt, payload.attachments ?? [], payload.session, {
        references: payload.references,
        model: payload.model,
      }),
    switchModel: (_ctx, _state, payload) => switchCodexSessionModel(payload),
    switchEffort: (_ctx, _state, payload) => switchCodexSessionEffort(payload),
    stopSession: (ctx, _state, payload) => stopCodexRun(ctx, payload.sessionId),
    disconnectSession: (ctx, _state, payload) => disconnectCodexRun(ctx, payload.sessionId),
  },
};

export const resolveProviderSessionRuntimeProvider = async (
  sessionId: string,
  fallbackSession?: SessionSummary,
) => normalizeSessionProvider((await findSession(sessionId))?.provider ?? fallbackSession?.provider);

export const resolveProviderSessionRuntime = async (
  sessionId: string,
  fallbackSession?: SessionSummary,
) => providerSessionRuntimes[await resolveProviderSessionRuntimeProvider(sessionId, fallbackSession)];
