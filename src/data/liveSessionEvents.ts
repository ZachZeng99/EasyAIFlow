import { reconcileLiveTraceMessage } from './optimisticSend.js';
import { hydrateSessionRecordInProjects } from './projectSnapshots.js';
import { getProviderDisplayName } from './sessionProvider.js';
import { sanitizeConversationMessageTraceContent } from './traceContent.js';
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
) => {
  for (let projectIndex = 0; projectIndex < projects.length; projectIndex += 1) {
    const project = projects[projectIndex];
    for (let dreamIndex = 0; dreamIndex < project.dreams.length; dreamIndex += 1) {
      const dream = project.dreams[dreamIndex];
      const sessionIndex = dream.sessions.findIndex((session) => session.id === sessionId);
      if (sessionIndex === -1) {
        continue;
      }

      const currentSession = dream.sessions[sessionIndex] as SessionRecord;
      const nextSession = updater(currentSession);
      if (nextSession === currentSession) {
        return projects;
      }

      const sessions = [...dream.sessions];
      sessions[sessionIndex] = nextSession;
      const dreams = [...project.dreams];
      dreams[dreamIndex] = { ...dream, sessions };
      const nextProjects = [...projects];
      nextProjects[projectIndex] = { ...project, dreams };
      return nextProjects;
    }
  }

  return projects;
};

type ClaudeDeltaEvent = Extract<ClaudeStreamEvent, { type: 'delta' }>;

export const coalesceClaudeDeltaEvents = (events: ClaudeDeltaEvent[]): ClaudeDeltaEvent[] => {
  type DeltaBatch = {
    event: ClaudeDeltaEvent;
    chunks: string[];
    lastIndex: number;
  };

  const batches: DeltaBatch[] = [];
  const activeBatchBySession = new Map<string, DeltaBatch>();

  events.forEach((event, index) => {
    const existing = activeBatchBySession.get(event.sessionId);
    if (existing?.event.messageId === event.messageId) {
      existing.chunks.push(event.delta);
      existing.lastIndex = index;
      return;
    }

    const batch = { event, chunks: [event.delta], lastIndex: index };
    batches.push(batch);
    activeBatchBySession.set(event.sessionId, batch);
  });

  return batches
    .sort((left, right) => left.lastIndex - right.lastIndex)
    .map(({ event, chunks }) =>
      chunks.length === 1 ? event : { ...event, delta: chunks.join('') },
    );
};

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
            const messages = reconcileLiveTraceMessage(
              session.messages ?? [],
              sanitizeConversationMessageTraceContent(event.message),
            );

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
