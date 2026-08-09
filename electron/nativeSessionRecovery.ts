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

type NativeClaudeHistoryEntry = Record<string, unknown>;

type NativeClaudeTranscriptNode = {
  entry: NativeClaudeHistoryEntry;
  index: number;
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'attachment' | 'system';
  timestampMs: number;
  isSidechain: boolean;
};

const nativeClaudeTranscriptTypes = new Set<NativeClaudeTranscriptNode['type']>([
  'user',
  'assistant',
  'attachment',
  'system',
]);

const asNativeRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;

const asNativeString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const getNativeTimestampMs = (value: unknown, fallback: number) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const getNativeAssistantMessageId = (node: NativeClaudeTranscriptNode) =>
  asNativeString(asNativeRecord(node.entry.message)?.id);

const isNativeToolResultNode = (node: NativeClaudeTranscriptNode) => {
  if (node.type !== 'user' || !node.parentUuid) {
    return false;
  }
  const content = asNativeRecord(node.entry.message)?.content;
  return Array.isArray(content) && content.some(
    (block) => asNativeRecord(block)?.type === 'tool_result',
  );
};

/**
 * Claude JSONL is an append-only tree, not a linear conversation. Rewinds and
 * parallel tool results create sibling branches. Mirror Claude Code's resume
 * semantics: choose the newest non-sidechain conversation leaf, walk its
 * parent chain, and recover legitimate parallel tool siblings. Returning the
 * selected records in physical order keeps append-time ordering for metadata
 * and auxiliary records while removing abandoned conversation branches.
 */
export const selectActiveNativeClaudeHistoryEntries = (
  entries: NativeClaudeHistoryEntry[],
) => {
  const progressParents = new Map<string, string | null>();
  const nodesByUuid = new Map<string, NativeClaudeTranscriptNode>();
  const orderedNodes: NativeClaudeTranscriptNode[] = [];

  const resolveProgressParent = (parentUuid: string | null) => {
    const seen = new Set<string>();
    let current = parentUuid;
    while (current && progressParents.has(current) && !seen.has(current)) {
      seen.add(current);
      current = progressParents.get(current) ?? null;
    }
    return current;
  };

  entries.forEach((entry, index) => {
    const type = asNativeString(entry.type);
    const uuid = asNativeString(entry.uuid);
    const rawParentUuid = asNativeString(entry.parentUuid) ?? null;

    if (type === 'progress' && uuid) {
      progressParents.set(uuid, resolveProgressParent(rawParentUuid));
      return;
    }
    if (!uuid || !type || !nativeClaudeTranscriptTypes.has(type as NativeClaudeTranscriptNode['type'])) {
      return;
    }

    const node: NativeClaudeTranscriptNode = {
      entry,
      index,
      uuid,
      parentUuid: resolveProgressParent(rawParentUuid),
      type: type as NativeClaudeTranscriptNode['type'],
      timestampMs: getNativeTimestampMs(entry.timestamp, index),
      isSidechain: entry.isSidechain === true,
    };
    nodesByUuid.set(uuid, node);
    orderedNodes.push(node);
  });

  // Synthetic fixtures and older exports may omit UUID linkage entirely.
  // Preserve their original behavior rather than guessing a chain.
  if (orderedNodes.length === 0) {
    return entries;
  }

  const parentUuids = new Set(
    orderedNodes
      .map((node) => node.parentUuid)
      .filter((uuid): uuid is string => Boolean(uuid)),
  );
  const terminalNodes = orderedNodes.filter((node) => !parentUuids.has(node.uuid));
  const hasConversationChild = new Set(
    orderedNodes
      .filter((node) => node.type === 'user' || node.type === 'assistant')
      .map((node) => node.parentUuid)
      .filter((uuid): uuid is string => Boolean(uuid)),
  );
  const leafCandidates = new Map<string, NativeClaudeTranscriptNode>();

  for (const terminal of terminalNodes) {
    const seen = new Set<string>();
    let current: NativeClaudeTranscriptNode | undefined = terminal;
    while (current && !seen.has(current.uuid)) {
      seen.add(current.uuid);
      if (current.type === 'user' || current.type === 'assistant') {
        if (!hasConversationChild.has(current.uuid)) {
          leafCandidates.set(current.uuid, current);
        }
        break;
      }
      current = current.parentUuid ? nodesByUuid.get(current.parentUuid) : undefined;
    }
  }

  let leaf: NativeClaudeTranscriptNode | undefined;
  for (const candidate of leafCandidates.values()) {
    if (candidate.isSidechain) {
      continue;
    }
    if (
      !leaf ||
      candidate.timestampMs > leaf.timestampMs ||
      (candidate.timestampMs === leaf.timestampMs && candidate.index > leaf.index)
    ) {
      leaf = candidate;
    }
  }
  if (!leaf) {
    return entries;
  }

  const chain: NativeClaudeTranscriptNode[] = [];
  const selectedUuids = new Set<string>();
  let current: NativeClaudeTranscriptNode | undefined = leaf;
  while (current && !selectedUuids.has(current.uuid)) {
    selectedUuids.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? nodesByUuid.get(current.parentUuid) : undefined;
  }
  chain.reverse();

  // Claude streams parallel content blocks as assistant siblings sharing one
  // message.id, with tool_result records parented to their specific sibling.
  // Recover those records without admitting unrelated conversation branches.
  const assistantGroups = new Map<string, NativeClaudeTranscriptNode[]>();
  const toolResultsByAssistant = new Map<string, NativeClaudeTranscriptNode[]>();
  for (const node of orderedNodes) {
    const assistantMessageId = node.type === 'assistant'
      ? getNativeAssistantMessageId(node)
      : undefined;
    if (assistantMessageId) {
      const group = assistantGroups.get(assistantMessageId) ?? [];
      group.push(node);
      assistantGroups.set(assistantMessageId, group);
    } else if (isNativeToolResultNode(node) && node.parentUuid) {
      const group = toolResultsByAssistant.get(node.parentUuid) ?? [];
      group.push(node);
      toolResultsByAssistant.set(node.parentUuid, group);
    }
  }

  const processedAssistantGroups = new Set<string>();
  for (const node of chain) {
    if (node.type !== 'assistant') {
      continue;
    }
    const assistantMessageId = getNativeAssistantMessageId(node);
    if (!assistantMessageId || processedAssistantGroups.has(assistantMessageId)) {
      continue;
    }
    processedAssistantGroups.add(assistantMessageId);
    const group = assistantGroups.get(assistantMessageId) ?? [node];
    for (const sibling of group) {
      selectedUuids.add(sibling.uuid);
      for (const toolResult of toolResultsByAssistant.get(sibling.uuid) ?? []) {
        selectedUuids.add(toolResult.uuid);
      }
    }
  }

  return entries.filter((entry) => {
    const uuid = asNativeString(entry.uuid);
    const type = asNativeString(entry.type);
    if (type === 'progress' && uuid) {
      return false;
    }
    if (!uuid || !type || !nativeClaudeTranscriptTypes.has(type as NativeClaudeTranscriptNode['type'])) {
      return true;
    }
    return selectedUuids.has(uuid);
  });
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
