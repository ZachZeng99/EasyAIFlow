import { extractCodeChangeSummaries, type CodeChangeSummary } from './codeChangeSummary.js';
import type { ConversationMessage } from './types.js';

export type MessageDisplayItem = {
  type: 'message';
  message: ConversationMessage;
  relatedTraceItems?: ConversationMessage[];
  codeChanges?: CodeChangeSummary[];
};

export type TraceGroupDisplayItem = {
  type: 'trace-group';
  id: string;
  items: ConversationMessage[];
};

export type DisplayItem = MessageDisplayItem | TraceGroupDisplayItem;

export const shouldShowTitle = (message: ConversationMessage) => {
  if (message.kind && message.kind !== 'message') {
    return true;
  }

  const normalizedTitle = message.title.trim();
  const normalizedContent = message.content.trim();
  if (!normalizedTitle || !normalizedContent) {
    return Boolean(normalizedTitle);
  }

  return normalizedTitle !== normalizedContent && !normalizedContent.startsWith(normalizedTitle);
};

const normalizeMessages = (messages: ConversationMessage[]) => {
  const result: ConversationMessage[] = [];
  let activeTrace: ConversationMessage | null = null;

  const flushTrace = () => {
    if (activeTrace) {
      result.push(activeTrace);
      activeTrace = null;
    }
  };

  for (const message of messages) {
    if (message.role !== 'system') {
      flushTrace();
      result.push(message);
      continue;
    }

    if (message.kind === 'thinking') {
      const text = message.content.trim();
      if (!text || text === 'Thinking step captured.' || text === 'Thinking was redacted by provider.') {
        continue;
      }
    }

    if (message.kind === 'tool_use') {
      flushTrace();
      activeTrace = {
        ...message,
        content: message.content.trim(),
        status:
          message.status === 'error'
            ? 'error'
            : message.status === 'success'
              ? 'success'
              : message.status === 'complete'
                ? 'complete'
                : 'running',
      };
      continue;
    }

    if ((message.kind === 'progress' || message.kind === 'tool_result') && activeTrace) {
      const extra = message.content.trim();
      activeTrace = {
        ...activeTrace,
        content: extra ? `${activeTrace.content}\n${extra}` : activeTrace.content,
        status:
          message.status === 'error'
            ? 'error'
            : message.kind === 'tool_result'
              ? 'success'
              : activeTrace.status,
      };
      continue;
    }

    flushTrace();
    result.push(message);
  }

  flushTrace();
  return result;
};

export const buildDisplayItems = (messages: ConversationMessage[]): DisplayItem[] => {
  const normalized = normalizeMessages(messages);
  const items: DisplayItem[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];

    if (current.role === 'assistant') {
      const systemRun: ConversationMessage[] = [];
      let nextIndex = index + 1;
      while (nextIndex < normalized.length && normalized[nextIndex].role === 'system') {
        systemRun.push(normalized[nextIndex]);
        nextIndex += 1;
      }

      if (systemRun.length > 0) {
        items.push({
          type: 'trace-group',
          id: `trace-group-${current.id}`,
          items: systemRun,
        });
        items.push({
          type: 'message',
          message: current,
          relatedTraceItems: systemRun,
          codeChanges: extractCodeChangeSummaries(systemRun),
        });
        index = nextIndex - 1;
        continue;
      }
    }

    if (current.role === 'system') {
      const systemRun: ConversationMessage[] = [current];
      let nextIndex = index + 1;
      while (nextIndex < normalized.length && normalized[nextIndex].role === 'system') {
        systemRun.push(normalized[nextIndex]);
        nextIndex += 1;
      }

      items.push({
        type: 'trace-group',
        id: `trace-group-${current.id}`,
        items: systemRun,
      });
      index = nextIndex - 1;
      continue;
    }

    items.push({ type: 'message', message: current });
  }

  return items;
};
