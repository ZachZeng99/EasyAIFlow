import type { ConversationMessage } from '../src/data/types.js';

const recoverMessage = (message: ConversationMessage): ConversationMessage => {
  if (message.status !== 'running' && message.status !== 'streaming' && message.status !== 'queued') {
    return message;
  }

  if (message.role === 'assistant') {
    if (message.status === 'queued') {
      return {
        ...message,
        status: 'error',
        title: 'Claude queue interrupted',
        content: 'Queued Claude run did not resume after restart.',
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
      title: 'Claude error',
      content: 'Previous Claude run did not finish.',
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
  (messages ?? []).map(recoverMessage);
