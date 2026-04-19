import type { ConversationMessage, SessionRecord } from '../src/data/types.js';
import { isIgnorableBackgroundTaskFollowupText } from './claudeRunState.js';

export type ParsedNativeSession = {
  nativeSessionId: string;
  title: string;
  preview: string;
  timeLabel: string;
  updatedAt?: number;
  model: string;
  messages: ConversationMessage[];
};

const hasEmptyCompletedAssistantPlaceholder = (messages: ConversationMessage[] | undefined) =>
  (messages ?? []).some(
    (message) =>
      message.role === 'assistant' &&
      message.status === 'complete' &&
      message.title === 'Claude response' &&
      !message.content.trim(),
  );

const getLastAssistantContent = (messages: ConversationMessage[] | undefined) =>
  [...(messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.content.trim() &&
        !isIgnorableBackgroundTaskFollowupText(message.content),
    )
    ?.content.trim();

const getConversationRecoverySignature = (messages: ConversationMessage[] | undefined) =>
  (messages ?? [])
    .filter((message) => {
      if (message.role === 'user') {
        return Boolean(message.content.trim());
      }

      return (
        message.role === 'assistant' &&
        Boolean(message.content.trim()) &&
        !isIgnorableBackgroundTaskFollowupText(message.content)
      );
    })
    .map((message) => `${message.role}:${message.content.trim()}`)
    .join('\n---\n');

export const shouldRecoverSessionFromNative = (
  existing: SessionRecord,
  parsed: ParsedNativeSession,
) => {
  if (!existing.claudeSessionId || existing.claudeSessionId !== parsed.nativeSessionId) {
    return false;
  }

  if (parsed.messages.length === 0) {
    return false;
  }

  const existingMessages = existing.messages ?? [];
  if (existingMessages.length === 0) {
    return true;
  }

  if (hasEmptyCompletedAssistantPlaceholder(existingMessages)) {
    return true;
  }

  if (parsed.messages.length > existingMessages.length) {
    return true;
  }

  const parsedSignature = getConversationRecoverySignature(parsed.messages);
  const existingSignature = getConversationRecoverySignature(existingMessages);
  if (parsedSignature && parsedSignature !== existingSignature) {
    return true;
  }

  const parsedAssistant = getLastAssistantContent(parsed.messages);
  const existingAssistant = getLastAssistantContent(existingMessages);
  return Boolean(parsedAssistant && parsedAssistant !== existingAssistant);
};

export const mergeNativeSessionIntoExisting = (
  existing: SessionRecord,
  parsed: ParsedNativeSession,
): SessionRecord => {
  const display = {
    title: parsed.title,
    preview: parsed.preview,
    timeLabel: parsed.timeLabel,
    updatedAt: existing.updatedAt ?? parsed.updatedAt,
  };

  return {
    ...existing,
    claudeSessionId: parsed.nativeSessionId,
    title: display.title,
    preview: display.preview,
    timeLabel: display.timeLabel,
    updatedAt: display.updatedAt,
    model: parsed.model,
    messages: parsed.messages,
  };
};
