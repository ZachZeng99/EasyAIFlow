import { getProviderDisplayName } from './sessionProvider.js';
import type {
  ContextReference,
  ConversationMessage,
  MessageAttachment,
  PendingAttachment,
  ProjectRecord,
  SessionRecord,
} from './types.js';

const cloneReferences = (references: ContextReference[]) => references.map((reference) => ({ ...reference }));

const toMessageAttachments = (attachments: PendingAttachment[]): MessageAttachment[] =>
  attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    path: attachment.path ?? attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  }));

const updateSessionInProjects = (
  projects: ProjectRecord[],
  sessionId: string,
  updater: (session: SessionRecord) => SessionRecord,
) =>
  projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) =>
        session.id === sessionId ? updater(session as SessionRecord) : session,
      ),
    })),
  }));

export const buildOptimisticSendState = ({
  projects,
  sessionId,
  prompt,
  attachments,
  references,
  queued,
  provider,
  now = new Date(),
}: {
  projects: ProjectRecord[];
  sessionId: string;
  prompt: string;
  attachments: PendingAttachment[];
  references: ContextReference[];
  queued: boolean;
  provider?: SessionRecord['provider'];
  now?: Date;
}) => {
  const timestamp = now.toLocaleString('zh-CN');
  const updatedAt = now.getTime();
  const userMessageId = `local-user-${updatedAt}`;
  const assistantMessageId = `local-assistant-${updatedAt}`;
  const providerName = getProviderDisplayName(provider);

  const nextProjects = updateSessionInProjects(projects, sessionId, (session) => ({
    ...session,
    preview: prompt,
    timeLabel: 'Just now',
    updatedAt,
    messages: [
      ...(session.messages ?? []),
      {
        id: userMessageId,
        role: 'user',
        timestamp,
        title: 'User prompt',
        content: prompt,
        status: 'complete',
        contextReferences: cloneReferences(references),
        attachments: toMessageAttachments(attachments),
      },
      {
        id: assistantMessageId,
        role: 'assistant',
        timestamp,
        title: queued ? `${providerName} queued` : `${providerName} response`,
        content: queued
          ? `Queued. ${providerName} will start this message after the current run completes.`
          : '',
        status: queued ? 'queued' : 'streaming',
      },
    ],
  }));

  return {
    projects: nextProjects,
    userMessageId,
    assistantMessageId,
  };
};

export const reconcileOptimisticSendMessages = ({
  projects,
  sessionId,
  optimisticUserMessageId,
  optimisticAssistantMessageId,
  queuedUserMessageId,
  queuedAssistantMessageId,
}: {
  projects: ProjectRecord[];
  sessionId: string;
  optimisticUserMessageId: string;
  optimisticAssistantMessageId: string;
  queuedUserMessageId: string;
  queuedAssistantMessageId: string;
}) =>
  updateSessionInProjects(projects, sessionId, (session) => {
    const messages = [...(session.messages ?? [])];
    const byId = new Map(messages.map((message) => [message.id, message] as const));

    const remapMessage = (
      optimisticMessageId: string,
      queuedMessageId: string,
    ) => {
      if (!queuedMessageId) {
        return;
      }

      const optimisticMessage = byId.get(optimisticMessageId);
      if (!optimisticMessage) {
        return;
      }

      if (!byId.has(queuedMessageId)) {
        byId.set(queuedMessageId, {
          ...optimisticMessage,
          id: queuedMessageId,
        });
      }

      byId.delete(optimisticMessageId);
    };

    remapMessage(optimisticUserMessageId, queuedUserMessageId);
    remapMessage(optimisticAssistantMessageId, queuedAssistantMessageId);

    const nextMessages: ConversationMessage[] = [];
    const seen = new Set<string>();

    const pushIfPresent = (messageId: string) => {
      if (!messageId || seen.has(messageId)) {
        return;
      }

      const message = byId.get(messageId);
      if (!message) {
        return;
      }

      seen.add(messageId);
      nextMessages.push(message);
    };

    messages.forEach((message) => {
      if (message.id === optimisticUserMessageId) {
        pushIfPresent(queuedUserMessageId);
        return;
      }

      if (message.id === optimisticAssistantMessageId) {
        pushIfPresent(queuedAssistantMessageId);
        return;
      }

      pushIfPresent(message.id);
    });

    pushIfPresent(queuedUserMessageId);
    pushIfPresent(queuedAssistantMessageId);

    return {
      ...session,
      messages: nextMessages,
    };
  });

const isLocalOptimisticMessage = (message: ConversationMessage, role: ConversationMessage['role']) =>
  message.role === role && message.id.startsWith(`local-${role}-`);

const hasMatchingAttachments = (
  left: ConversationMessage['attachments'],
  right: ConversationMessage['attachments'],
) => {
  const leftIds = (left ?? []).map((attachment) => attachment.id);
  const rightIds = (right ?? []).map((attachment) => attachment.id);

  if (leftIds.length !== rightIds.length) {
    return false;
  }

  return leftIds.every((id, index) => id === rightIds[index]);
};

const findOptimisticReplacementIndex = (
  messages: ConversationMessage[],
  incomingMessage: ConversationMessage,
) => {
  if (incomingMessage.role === 'user') {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        isLocalOptimisticMessage(message, 'user') &&
        message.content.trim() === incomingMessage.content.trim() &&
        hasMatchingAttachments(message.attachments, incomingMessage.attachments)
      ) {
        return index;
      }
    }
  }

  if (incomingMessage.role === 'assistant') {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        isLocalOptimisticMessage(message, 'assistant') &&
        (message.status === 'queued' || message.status === 'streaming' || message.status === 'running')
      ) {
        return index;
      }
    }
  }

  return -1;
};

export const reconcileLiveTraceMessage = (
  messages: ConversationMessage[],
  incomingMessage: ConversationMessage,
) => {
  const nextMessages = [...messages];
  const existingIndex = nextMessages.findIndex((message) => message.id === incomingMessage.id);
  if (existingIndex >= 0) {
    nextMessages[existingIndex] = incomingMessage;
    return nextMessages;
  }

  const optimisticIndex = findOptimisticReplacementIndex(nextMessages, incomingMessage);
  if (optimisticIndex >= 0) {
    nextMessages[optimisticIndex] = incomingMessage;
    return nextMessages;
  }

  nextMessages.push(incomingMessage);
  return nextMessages;
};
