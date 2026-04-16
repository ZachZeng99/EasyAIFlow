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

const sharesDisplaySpeaker = (left: ConversationMessage, right: ConversationMessage) => {
  const leftSpeaker = left.speakerId?.trim() ?? '';
  const rightSpeaker = right.speakerId?.trim() ?? '';

  if (leftSpeaker || rightSpeaker) {
    return leftSpeaker === rightSpeaker;
  }

  return true;
};

const buildAssistantTraceAssignments = (messages: ConversationMessage[]) => {
  const traceItemsByAssistantId = new Map<string, ConversationMessage[]>();
  const assignedTraceIndexes = new Set<number>();

  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (current.role !== 'system') {
      continue;
    }

    for (let scan = index - 1; scan >= 0; scan -= 1) {
      const candidate = messages[scan];
      if (candidate.role === 'user') {
        break;
      }

      if (candidate.role !== 'assistant' || !sharesDisplaySpeaker(candidate, current)) {
        continue;
      }

      assignedTraceIndexes.add(index);
      const traceItems = traceItemsByAssistantId.get(candidate.id) ?? [];
      traceItems.push(current);
      traceItemsByAssistantId.set(candidate.id, traceItems);
      break;
    }
  }

  return {
    traceItemsByAssistantId,
    assignedTraceIndexes,
  };
};

export const buildDisplayItems = (messages: ConversationMessage[]): DisplayItem[] => {
  const normalized = normalizeMessages(messages);
  const { traceItemsByAssistantId, assignedTraceIndexes } = buildAssistantTraceAssignments(normalized);
  const items: DisplayItem[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];

    if (current.role === 'assistant') {
      const systemRun = traceItemsByAssistantId.get(current.id) ?? [];

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
        continue;
      }
    }

    if (current.role === 'system') {
      if (assignedTraceIndexes.has(index)) {
        continue;
      }

      const systemRun: ConversationMessage[] = [current];
      let nextIndex = index + 1;
      while (
        nextIndex < normalized.length &&
        normalized[nextIndex].role === 'system' &&
        !assignedTraceIndexes.has(nextIndex) &&
        sharesDisplaySpeaker(current, normalized[nextIndex])
      ) {
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
