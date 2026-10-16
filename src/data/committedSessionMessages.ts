import { sanitizeConversationMessagesForDisplay } from './traceContent.js';
import type { ProjectRecord, SessionMessagesCommittedEvent, SessionRecord } from './types.js';

export const usesCommittedMessages = (session: SessionRecord) =>
  session.messageRevision !== undefined || session.requiredMessageRevision !== undefined;

export const requireMessageSnapshot = (session: SessionRecord, revision: number): SessionRecord => ({
  ...session,
  requiredMessageRevision: Math.max(session.requiredMessageRevision ?? 0, revision),
});

export const invalidateCommittedSessionMessages = (projects: ProjectRecord[]): ProjectRecord[] =>
  projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((summary) => {
        const session = summary as SessionRecord;
        return usesCommittedMessages(session)
          ? requireMessageSnapshot(session, session.messageRevision ?? 0)
          : session;
      }),
    })),
  }));

export const applyCommittedSessionMessages = (
  session: SessionRecord,
  event: SessionMessagesCommittedEvent,
): SessionRecord => {
  if (event.sessionId !== session.id || event.revision <= (session.messageRevision ?? -1)) {
    return session;
  }
  if (
    session.messagesLoaded === false ||
    session.messageRevision === undefined ||
    session.requiredMessageRevision !== undefined ||
    event.revision !== session.messageRevision + 1 ||
    event.mutation.type === 'replace-messages'
  ) {
    return requireMessageSnapshot(session, event.revision);
  }

  const messages = [...session.messages];
  const positions = new Map(messages.map((message, index) => [message.id, index]));
  const incoming = event.mutation.type === 'upsert-message'
    ? [event.mutation.message]
    : event.mutation.messages;
  // An upsert may update an older, unloaded page. Never guess its position.
  if (event.mutation.type === 'upsert-message' && !positions.has(event.mutation.message.id)) {
    return requireMessageSnapshot(session, event.revision);
  }
  for (const message of sanitizeConversationMessagesForDisplay(incoming)) {
    const index = positions.get(message.id);
    if (index === undefined) {
      positions.set(message.id, messages.length);
      messages.push(message);
    } else {
      messages[index] = message;
    }
  }
  return {
    ...session,
    messages,
    messageRevision: event.revision,
    updatedAt: event.updatedAt,
    preview: messages.at(-1)?.content || session.preview,
    timeLabel: 'Just now',
  };
};
