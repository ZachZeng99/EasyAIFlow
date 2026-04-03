import { isBackgroundTaskNotificationContent } from './backgroundTaskNotification.js';

export type ClaudeRunStateCompletion = {
  content: string;
  receivedResult: boolean;
  completedContent?: string;
  needsCompletionRefresh: boolean;
  backgroundTaskNotificationPending: boolean;
};

export type ClaudeRunSessionRuntimeState = {
  claudeSessionId?: string;
  model?: string;
  persistedClaudeSessionId?: string;
  persistedModel?: string;
};

export const createClaudeRunState = (): ClaudeRunStateCompletion => ({
  content: '',
  receivedResult: false,
  completedContent: undefined,
  needsCompletionRefresh: false,
  backgroundTaskNotificationPending: false,
});

export const getRunSessionRuntimeUpdate = (state: ClaudeRunSessionRuntimeState) => {
  const update: {
    claudeSessionId?: string;
    model?: string;
  } = {};

  if (state.claudeSessionId && state.claudeSessionId !== state.persistedClaudeSessionId) {
    update.claudeSessionId = state.claudeSessionId;
  }

  if (state.model && state.model !== state.persistedModel) {
    update.model = state.model;
  }

  return Object.keys(update).length > 0 ? update : null;
};

export const markRunSessionRuntimePersisted = <T extends ClaudeRunSessionRuntimeState>(state: T): T => ({
  ...state,
  persistedClaudeSessionId: state.claudeSessionId ?? state.persistedClaudeSessionId,
  persistedModel: state.model ?? state.persistedModel,
});

export const noteBackgroundTaskNotificationInRunState = <T extends ClaudeRunStateCompletion>(
  state: T,
  content: string,
): T => ({
  ...state,
  backgroundTaskNotificationPending: isBackgroundTaskNotificationContent(content),
});

export const applyAssistantTextToRunState = <T extends ClaudeRunStateCompletion>(
  state: T,
  incomingText: string,
): T => {
  if (!incomingText.trim()) {
    return state;
  }

  if (state.backgroundTaskNotificationPending) {
    return {
      ...state,
      backgroundTaskNotificationPending: false,
    };
  }

  return {
    ...state,
    content: incomingText,
    needsCompletionRefresh: state.receivedResult && state.completedContent !== incomingText,
    backgroundTaskNotificationPending: false,
  };
};

export const markClaudeRunCompleted = <T extends ClaudeRunStateCompletion>(
  state: T,
  completedContent: string,
): T => ({
  ...state,
  content: completedContent,
  receivedResult: true,
  completedContent,
  needsCompletionRefresh: false,
  backgroundTaskNotificationPending: false,
});

export const shouldCompleteClaudeRunOnClose = (state: ClaudeRunStateCompletion) =>
  state.completedContent === undefined || state.needsCompletionRefresh;
