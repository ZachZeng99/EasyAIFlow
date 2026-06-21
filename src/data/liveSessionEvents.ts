import { reconcileLiveTraceMessage } from './optimisticSend.js';
import { hydrateSessionRecordInProjects } from './projectSnapshots.js';
import { getProviderDisplayName } from './sessionProvider.js';
import type {
  ClaudeStreamEvent,
  ConversationMessage,
  ProjectRecord,
  SessionRecord,
} from './types.js';

const nowLabel = () => new Date().toLocaleString('zh-CN');

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

const createFallbackAssistantMessage = (
  event: Extract<ClaudeStreamEvent, { type: 'status' | 'delta' | 'complete' | 'error' }>,
  providerName: string,
): ConversationMessage => {
  if (event.type === 'status') {
    return {
      id: event.messageId,
      role: 'assistant',
      timestamp: nowLabel(),
      title: event.title ?? `${providerName} response`,
      content: event.content ?? '',
      status: event.status,
    };
  }

  if (event.type === 'delta') {
    return {
      id: event.messageId,
      role: 'assistant',
      timestamp: nowLabel(),
      title: `${providerName} response`,
      content: '',
      status: 'streaming',
    };
  }

  if (event.type === 'complete') {
    return {
      id: event.messageId,
      role: 'assistant',
      timestamp: nowLabel(),
      title: `${providerName} response`,
      content: event.content,
      status: 'complete',
    };
  }

  return {
    id: event.messageId,
    role: 'assistant',
    timestamp: nowLabel(),
    title: `${providerName} error`,
    content: event.error,
    status: 'error',
  };
};

export const applyClaudeEventToProjects = (projects: ProjectRecord[], event: ClaudeStreamEvent) =>
  event.type === 'interaction-sync'
    ? projects
    : event.type === 'session-sync'
      ? hydrateSessionRecordInProjects(projects, event.session)
      : updateSessionInProjects(projects, event.sessionId, (session) => {
          const updatedAt = Date.now();
          const providerName = session.sessionKind === 'group'
            ? 'Group room'
            : getProviderDisplayName(session.provider);

          if (
            event.type === 'permission-request' ||
            event.type === 'ask-user-question' ||
            event.type === 'plan-mode-request' ||
            event.type === 'background-task' ||
            event.type === 'runtime-state'
          ) {
            return session;
          }

          if (event.type === 'trace') {
            const messages = reconcileLiveTraceMessage(session.messages ?? [], event.message);

            return {
              ...session,
              messages,
              updatedAt,
            };
          }

          const messages = [...(session.messages ?? [])];
          let targetIndex = messages.findIndex((message) => message.id === event.messageId);
          if (targetIndex === -1) {
            messages.push(createFallbackAssistantMessage(event, providerName));
            targetIndex = messages.length - 1;
          }

          const target = { ...messages[targetIndex] };

          if (event.type === 'status') {
            if (typeof event.content === 'string') {
              target.content = event.content;
            }
            if (typeof event.title === 'string') {
              target.title = event.title;
            }
            if (event.status) {
              target.status = event.status;
            }
            messages[targetIndex] = target;
            return {
              ...session,
              messages,
              preview: target.content || session.preview,
              timeLabel: 'Just now',
              updatedAt,
            };
          }

          if (event.type === 'delta') {
            target.content += event.delta;
            target.status = 'streaming';
            messages[targetIndex] = target;
            return {
              ...session,
              messages,
              preview: target.content || session.preview,
              timeLabel: 'Just now',
              updatedAt,
            };
          }

          if (event.type === 'complete') {
            target.content = event.content;
            target.status = 'complete';
            messages[targetIndex] = target;
            return {
              ...session,
              messages,
              preview: event.content || session.preview,
              timeLabel: 'Just now',
              updatedAt,
              claudeSessionId: event.claudeSessionId ?? session.claudeSessionId,
              tokenUsage: event.tokenUsage ?? session.tokenUsage,
            };
          }

          if (session.sessionKind === 'group' && target.speakerLabel) {
            target.title = `${target.speakerLabel} error`;
          }
          target.content = event.error;
          target.status = 'error';
          messages[targetIndex] = target;
          return {
            ...session,
            messages,
            preview:
              session.sessionKind === 'group' && target.speakerLabel
                ? `${target.speakerLabel} error`
                : `${providerName} error`,
            timeLabel: 'Just now',
            updatedAt,
          };
        });
