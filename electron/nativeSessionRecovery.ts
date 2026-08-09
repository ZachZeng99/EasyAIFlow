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

const nativeRecoveryPromptPrefix = 'EasyAIFlow is starting a fresh native Claude conversation instead of resuming ';
const currentUserMessageMarker = '\n\nCurrent user message:\n\n';

const cloneMessage = (message: ConversationMessage): ConversationMessage => ({ ...message });

const firstMeaningfulLine = (content: string) =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';

const normalizeMessageKey = (message: ConversationMessage) =>
  [
    message.role,
    message.kind ?? 'message',
    message.content.trim(),
  ].join('\u0000');

const countMatchingPrefix = (left: string[], right: string[], leftStart = 0) => {
  let matched = 0;
  while (
    leftStart + matched < left.length &&
    matched < right.length &&
    left[leftStart + matched] === right[matched]
  ) {
    matched += 1;
  }
  return matched;
};

const appendMissingMessageSuffix = (
  existingMessages: ConversationMessage[],
  incomingMessages: ConversationMessage[],
) => {
  if (incomingMessages.length === 0) {
    return existingMessages.map(cloneMessage);
  }

  const existingKeys = existingMessages.map(normalizeMessageKey);
  const incomingKeys = incomingMessages.map(normalizeMessageKey);
  let bestPrefixLength = 0;

  for (let existingIndex = 0; existingIndex < existingKeys.length; existingIndex += 1) {
    const matched = countMatchingPrefix(existingKeys, incomingKeys, existingIndex);
    bestPrefixLength = Math.max(bestPrefixLength, matched);
  }

  return [
    ...existingMessages.map(cloneMessage),
    ...incomingMessages.slice(bestPrefixLength).map(cloneMessage),
  ];
};

const isRepeatedRecoveryImport = (
  existingMessages: ConversationMessage[],
  incomingMessages: ConversationMessage[],
) => {
  if (incomingMessages.length < 10 || existingMessages.length < incomingMessages.length * 2) {
    return false;
  }

  const sampleSize = Math.min(20, incomingMessages.length);
  const existingKeys = existingMessages.map(normalizeMessageKey);
  const incomingKeys = incomingMessages.map(normalizeMessageKey);
  return countMatchingPrefix(existingKeys, incomingKeys.slice(0, sampleSize)) === sampleSize;
};

const normalizeRecoveredNativeMessages = (messages: ConversationMessage[]) => {
  const [first, ...rest] = messages;
  if (
    !first ||
    first.role !== 'user' ||
    !first.content.startsWith(nativeRecoveryPromptPrefix)
  ) {
    return messages.map(cloneMessage);
  }

  const markerIndex = first.content.indexOf(currentUserMessageMarker);
  if (markerIndex === -1) {
    return messages.map(cloneMessage);
  }

  const currentUserMessage = first.content.slice(markerIndex + currentUserMessageMarker.length).trim();
  if (!currentUserMessage) {
    return rest.map(cloneMessage);
  }

  return [
    {
      ...first,
      content: currentUserMessage,
      title: firstMeaningfulLine(currentUserMessage).slice(0, 42) || 'User prompt',
    },
    ...rest.map(cloneMessage),
  ];
};

const hasRawNativeRecoveryPrompt = (messages: ConversationMessage[]) =>
  messages.some(
    (message) =>
      message.role === 'user' &&
      message.content.startsWith(nativeRecoveryPromptPrefix),
  );

export const mergeNativeConversationMessages = (
  existingMessages: ConversationMessage[] | undefined,
  parsedMessages: ConversationMessage[],
) => {
  const normalizedParsedMessages = normalizeRecoveredNativeMessages(parsedMessages);
  const currentMessages = existingMessages ?? [];
  if (
    parsedMessages[0]?.role === 'user' &&
    parsedMessages[0]?.content.startsWith(nativeRecoveryPromptPrefix)
  ) {
    if (hasRawNativeRecoveryPrompt(currentMessages)) {
      return normalizedParsedMessages;
    }
    if (isRepeatedRecoveryImport(currentMessages, normalizedParsedMessages)) {
      return normalizedParsedMessages;
    }

    return appendMissingMessageSuffix(currentMessages.map(cloneMessage), normalizedParsedMessages);
  }

  return normalizedParsedMessages;
};

const isPendingAssistantMessage = (message: ConversationMessage | undefined) =>
  message?.role === 'assistant' &&
  message.kind !== 'tool_use' &&
  message.kind !== 'tool_result' &&
  (message.status === 'queued' ||
    message.status === 'streaming' ||
    message.status === 'running' ||
    message.status === 'background');

const normalizePromptContent = (content: string) => content.replace(/\r\n/g, '\n').trim();

const nativePromptContainsLocalPrompt = (
  localMessage: ConversationMessage,
  nativeMessage: ConversationMessage,
) => {
  const localContent = normalizePromptContent(localMessage.content);
  const nativeContent = normalizePromptContent(nativeMessage.content);
  if (!localContent || !nativeContent) {
    return false;
  }
  if (localContent === nativeContent) {
    return true;
  }

  // EasyAIFlow may prepend instructions/reference context and append attachment
  // notes before writing the user line to Claude. The original visible prompt
  // remains a double-newline-delimited block inside that resolved prompt.
  return (
    nativeContent.startsWith(`${localContent}\n\n`) ||
    nativeContent.endsWith(`\n\n${localContent}`) ||
    nativeContent.includes(`\n\n${localContent}\n\n`)
  );
};

/**
 * Native history is authoritative for turns already written to Claude, but it
 * cannot contain prompts that EasyAIFlow has queued behind the current turn.
 * Preserve those local pending pairs while the native snapshot catches up.
 */
export const mergeNativeHydrationMessages = (
  existingMessages: ConversationMessage[] | undefined,
  parsedMessages: ConversationMessage[],
) => {
  const currentMessages = existingMessages ?? [];
  const parsedUserMessages = parsedMessages.filter(
    (message) => message.role === 'user' && message.kind !== 'tool_result',
  );
  const pendingLocalMessages: ConversationMessage[] = [];
  let parsedUserCursor = 0;

  for (let index = 0; index < currentMessages.length; index += 1) {
    const message = currentMessages[index];
    if (message?.role !== 'user' || message.kind === 'tool_result') {
      continue;
    }

    let matchingParsedIndex = -1;
    for (let candidate = parsedUserCursor; candidate < parsedUserMessages.length; candidate += 1) {
      if (nativePromptContainsLocalPrompt(message, parsedUserMessages[candidate]!)) {
        matchingParsedIndex = candidate;
        break;
      }
    }

    if (matchingParsedIndex >= 0) {
      parsedUserCursor = matchingParsedIndex + 1;
      continue;
    }

    const assistant = currentMessages[index + 1];
    if (isPendingAssistantMessage(assistant)) {
      pendingLocalMessages.push(cloneMessage(message), cloneMessage(assistant!));
      index += 1;
    }
  }

  return pendingLocalMessages.length > 0
    ? [...parsedMessages, ...pendingLocalMessages]
    : parsedMessages;
};

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
    messages: mergeNativeConversationMessages(existing.messages, parsed.messages),
  };
};
