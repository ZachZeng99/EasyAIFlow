import { getProviderDisplayName, normalizeSessionProvider } from '../src/data/sessionProvider.js';
import type { ConversationMessage, SessionProvider } from '../src/data/types.js';

const recoverMessage = (
  message: ConversationMessage,
  provider: SessionProvider | undefined,
): ConversationMessage => {
  const providerName = getProviderDisplayName(provider);

  if (
    message.status !== 'running' &&
    message.status !== 'streaming' &&
    message.status !== 'queued' &&
    message.status !== 'background'
  ) {
    return message;
  }

  if (message.role === 'assistant') {
    if (message.status === 'queued') {
      return {
        ...message,
        status: 'error',
        title: `${providerName} queue interrupted`,
        content: `Queued ${providerName} run did not resume after restart.`,
      };
    }

    const content = message.content.trim();
    if (content) {
      return {
        ...message,
        status: 'complete',
      };
    }

    return {
      ...message,
      status: 'error',
      title: `${providerName} error`,
      content: `Previous ${providerName} run did not finish.`,
    };
  }

  if (message.kind === 'tool_use') {
    return {
      ...message,
      status: 'complete',
    };
  }

  if (message.kind === 'tool_result') {
    return {
      ...message,
      status: 'success',
    };
  }

  if (message.kind === 'progress' || message.kind === 'thinking') {
    return {
      ...message,
      status: 'complete',
    };
  }

  return {
    ...message,
    status: 'complete',
  };
};

export const recoverStaleSessionMessages = (messages: ConversationMessage[] | undefined) =>
  (messages ?? []).map((message) => recoverMessage(message, 'claude'));

export const recoverStaleSessionMessagesForProvider = (
  messages: ConversationMessage[] | undefined,
  provider: SessionProvider | undefined,
) => (messages ?? []).map((message) => recoverMessage(message, normalizeSessionProvider(provider)));

export const recoverStaleGroupRoomMessages = (messages: ConversationMessage[] | undefined) =>
  (messages ?? []).map((message) => recoverMessage(message, normalizeSessionProvider(message.provider)));
