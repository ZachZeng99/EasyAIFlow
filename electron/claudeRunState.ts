export type ClaudeRunStateCompletion = {
  content: string;
  receivedResult: boolean;
  completedContent?: string;
  needsCompletionRefresh: boolean;
  backgroundTaskNotificationPending: boolean;
};

export const createClaudeRunState = (): ClaudeRunStateCompletion => ({
  content: '',
  receivedResult: false,
  completedContent: undefined,
  needsCompletionRefresh: false,
  backgroundTaskNotificationPending: false,
});

const isBackgroundTaskNotificationContent = (content: string) => {
  const normalized = content.trim();
  return normalized.includes('<task-notification>') && normalized.includes('<task-id>');
};

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
  !state.receivedResult || state.needsCompletionRefresh;
