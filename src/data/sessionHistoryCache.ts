import type { ProjectRecord, SessionMessagePage, SessionRecord } from './types.js';
import { sanitizeConversationMessagesForDisplay } from './traceContent.js';

export const touchSessionHistory = (recency: string[], sessionId: string) => [
  sessionId,
  ...recency.filter((id) => id !== sessionId),
];

export const mergeOlderSessionMessagePage = (
  session: SessionRecord,
  page: SessionMessagePage,
): SessionRecord => {
  if (page.sessionId !== session.id) {
    return session;
  }
  const messages = new Map(
    sanitizeConversationMessagesForDisplay(page.messages).map(
      (message) => [message.id, message] as const,
    ),
  );
  for (const message of session.messages ?? []) {
    messages.set(message.id, message);
  }
  return {
    ...session,
    messages: [...messages.values()],
    messagesLoaded: true,
    historyPage: {
      nextBefore: page.nextBefore,
      hasMoreBefore: page.hasMoreBefore,
      sessionRevision: Math.max(
        session.historyPage?.sessionRevision ?? 0,
        page.sessionRevision,
      ),
    },
  };
};

const hasInFlightMessages = (session: SessionRecord) =>
  (session.messages ?? []).some((message) =>
    message.status === 'queued' ||
    message.status === 'streaming' ||
    message.status === 'running' ||
    message.status === 'background'
  );

const isInFlightMessage = (message: SessionRecord['messages'][number]) =>
  message.status === 'queued' ||
  message.status === 'streaming' ||
  message.status === 'running' ||
  message.status === 'background';

export const isStaleSessionHistoryCursorError = (error: unknown) =>
  error instanceof Error && (
    error.name === 'SessionStoreV2StaleCursorError' ||
    error.message.includes('Stale history cursor')
  );

export const replaceSessionHistoryAfterStaleCursor = (
  session: SessionRecord,
  reloaded: SessionRecord,
): SessionRecord => {
  if (session.id !== reloaded.id) {
    return session;
  }
  const messages = new Map(
    (reloaded.messages ?? []).map((message) => [message.id, message] as const),
  );
  for (const message of session.messages ?? []) {
    if (isInFlightMessage(message)) {
      messages.set(message.id, message);
    }
  }
  return {
    ...reloaded,
    messages: [...messages.values()],
    messagesLoaded: true,
  };
};

export const evictSessionHistories = (
  projects: ProjectRecord[],
  options: {
    selectedSessionId?: string;
    pinnedSessionIds: ReadonlySet<string>;
    recency: string[];
    retainRecentInactive?: number;
  },
) => {
  const keep = new Set(options.pinnedSessionIds);
  if (options.selectedSessionId) {
    keep.add(options.selectedSessionId);
  }
  const recentLimit = options.retainRecentInactive ?? 2;
  let retainedRecent = 0;
  for (const sessionId of options.recency) {
    if (keep.has(sessionId)) {
      continue;
    }
    if (retainedRecent >= recentLimit) {
      break;
    }
    keep.add(sessionId);
    retainedRecent += 1;
  }

  let changed = false;
  const next = projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((summary) => {
        const session = summary as SessionRecord;
        if (
          keep.has(session.id) ||
          hasInFlightMessages(session) ||
          (session.messagesLoaded === false && (session.messages?.length ?? 0) === 0)
        ) {
          return summary;
        }
        changed = true;
        const { historyPage: _historyPage, ...withoutPage } = session;
        return {
          ...withoutPage,
          messages: [],
          messagesLoaded: false,
        };
      }),
    })),
  }));
  return changed ? next : projects;
};
