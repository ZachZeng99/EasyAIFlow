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

const unwrapBackgroundFollowupParagraph = (content: string) => {
  const normalized = content.trim();
  if (
    (normalized.startsWith('(') && normalized.endsWith(')')) ||
    (normalized.startsWith('（') && normalized.endsWith('）'))
  ) {
    return normalized.slice(1, -1).trim();
  }

  return normalized;
};

const isBackgroundTaskFollowupLeadParagraph = (content: string) => {
  const normalized = unwrapBackgroundFollowupParagraph(content);
  if (!normalized) {
    return false;
  }

  return (
    /^Background task (?:completed|cleaned up)\b/i.test(normalized) ||
    /^Last background task\b/i.test(normalized) ||
    /^后台任务\b/.test(normalized)
  );
};

export const isIgnorableBackgroundTaskFollowupText = (content: string) => {
  const normalized = content.trim();
  if (!normalized) {
    return false;
  }

  return (
    /^No response requested\.?$/i.test(normalized) ||
    /^\(?Background task (?:completed|cleaned up)\b[\s\S]*?(?:no action needed|nothing new)[\s\S]*\)?$/i.test(normalized) ||
    /^\(?Background task (?:completed|cleaned up)\b[\s\S]*?(?:already got (?:all the )?data we needed|already got what we needed|already had (?:all the )?data we needed)[\s\S]*\)?$/i.test(normalized) ||
    /^后台任务清理完了.*$/i.test(normalized) ||
    (/^Last background task\b/i.test(normalized) &&
      (
        /already incorporated/i.test(normalized) ||
        /nothing new/i.test(normalized) ||
        /already got (?:all the )?data we needed/i.test(normalized) ||
        /already got what we needed/i.test(normalized)
      ))
  );
};

export const stripLeadingBackgroundTaskFollowupText = (content: string) => {
  const normalized = content.trim();
  if (!normalized) {
    return null;
  }

  const paragraphs = normalized
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  if (paragraphs.length < 2) {
    return null;
  }

  const [firstParagraph, ...rest] = paragraphs;
  if (!isBackgroundTaskFollowupLeadParagraph(firstParagraph)) {
    return null;
  }

  const remainder = rest.join('\n\n').trim();
  return remainder || null;
};

export const applyAssistantTextToRunState = <T extends ClaudeRunStateCompletion>(
  state: T,
  incomingText: string,
): T => {
  let nextText = incomingText;
  if (state.backgroundTaskNotificationPending) {
    nextText = stripLeadingBackgroundTaskFollowupText(incomingText) ?? incomingText;
  }

  if (!nextText.trim()) {
    return state;
  }

  if (state.backgroundTaskNotificationPending) {
    const hasMeaningfulExistingContent =
      Boolean(state.completedContent?.trim()) ||
      Boolean(state.content.trim()) ||
      ('lastToolResultContent' in state &&
        typeof (state as T & { lastToolResultContent?: unknown }).lastToolResultContent === 'string' &&
        (state as T & { lastToolResultContent?: string }).lastToolResultContent?.trim());
    if (
      hasMeaningfulExistingContent &&
      isIgnorableBackgroundTaskFollowupText(nextText)
    ) {
      return {
        ...state,
        backgroundTaskNotificationPending: false,
      };
    }
  }

  return {
    ...state,
    content: nextText,
    needsCompletionRefresh: state.receivedResult && state.completedContent !== nextText,
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
