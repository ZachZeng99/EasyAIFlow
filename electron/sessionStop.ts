import type { ConversationMessage } from '../src/data/types.js';
import {
  findSession,
  getProjects,
  setSessionRuntime,
  updateAssistantMessage,
  upsertSessionMessage,
} from './sessionStore.js';

export type SessionStopVersionRegistry = Map<string, number>;

export const createSessionStopVersionRegistry = (): SessionStopVersionRegistry => new Map();

export const readSessionStopVersion = (
  registry: SessionStopVersionRegistry,
  sessionId: string,
) => registry.get(sessionId) ?? 0;

export const requestSessionStop = (
  registry: SessionStopVersionRegistry,
  sessionId: string,
) => {
  const nextVersion = readSessionStopVersion(registry, sessionId) + 1;
  registry.set(sessionId, nextVersion);
  return nextVersion;
};

const isPendingStatus = (status: ConversationMessage['status']) =>
  status === 'queued' || status === 'streaming' || status === 'running';

const buildStoppedAssistantMessage = (message: ConversationMessage): ConversationMessage => ({
  ...message,
  title: 'Claude stopped',
  content: message.content.trim() ? message.content : 'Stopped.',
  status: 'complete',
});

export const stopAssistantMessage = async (sessionId: string, messageId: string) => {
  const session = await findSession(sessionId);
  const existing = session?.messages?.find((message) => message.id === messageId);
  if (!existing || existing.role !== 'assistant' || !isPendingStatus(existing.status)) {
    return null;
  }

  const stopped = buildStoppedAssistantMessage(existing);
  await updateAssistantMessage(sessionId, messageId, (message) => {
    message.title = stopped.title;
    message.content = stopped.content;
    message.status = stopped.status;
  });
  await setSessionRuntime(sessionId, {
    preview: stopped.content,
    timeLabel: 'Just now',
  });

  return stopped;
};

export const stopPendingSessionMessages = async (sessionId: string) => {
  const session = await findSession(sessionId);
  if (!session) {
    return {
      projects: await getProjects(),
      changedMessages: [] as ConversationMessage[],
    };
  }

  const changedMessages: ConversationMessage[] = [];
  let lastAssistantContent = '';

  for (const message of session.messages ?? []) {
    if (!isPendingStatus(message.status)) {
      continue;
    }

    if (message.role === 'assistant') {
      const stopped = await stopAssistantMessage(sessionId, message.id);
      if (stopped) {
        changedMessages.push(stopped);
        lastAssistantContent = stopped.content;
      }
      continue;
    }

    const nextMessage: ConversationMessage = {
      ...message,
      status: message.kind === 'tool_result' ? 'success' : 'complete',
    };
    await upsertSessionMessage(sessionId, nextMessage);
    changedMessages.push(nextMessage);
  }

  if (!lastAssistantContent && changedMessages.length > 0) {
    await setSessionRuntime(sessionId, {
      preview: 'Claude stopped',
      timeLabel: 'Just now',
    });
  }

  return {
    projects: await getProjects(),
    changedMessages,
  };
};
