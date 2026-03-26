import type { ContextReference, MessageAttachment, PendingAttachment, ProjectRecord, SessionRecord } from './types.js';

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
  now = new Date(),
}: {
  projects: ProjectRecord[];
  sessionId: string;
  prompt: string;
  attachments: PendingAttachment[];
  references: ContextReference[];
  queued: boolean;
  now?: Date;
}) => {
  const timestamp = now.toLocaleString('zh-CN');
  const updatedAt = now.getTime();
  const userMessageId = `local-user-${updatedAt}`;
  const assistantMessageId = `local-assistant-${updatedAt}`;

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
        title: queued ? 'Claude queued' : 'Claude response',
        content: queued
          ? 'Queued. Claude will start this message after the current run completes.'
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
