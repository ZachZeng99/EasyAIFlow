import { sanitizeConversationMessagesForDisplay } from '../src/data/traceContent.js';
import type { SessionMessagesCommittedEvent } from '../src/data/types.js';

type Listener = (event: SessionMessagesCommittedEvent) => void;
const listeners = new Set<Listener>();

export const onSessionMessagesCommitted = (listener: Listener) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const publishSessionMessagesCommitted = (event: SessionMessagesCommittedEvent) => {
  if (listeners.size === 0) return;
  const mutation = event.mutation;
  const outgoing: SessionMessagesCommittedEvent = {
    ...event,
    mutation: mutation.type === 'replace-messages'
      ? mutation
      : mutation.type === 'append-messages'
        ? { ...mutation, messages: sanitizeConversationMessagesForDisplay(mutation.messages) }
        : { ...mutation, message: sanitizeConversationMessagesForDisplay([mutation.message])[0] },
  };
  for (const listener of listeners) {
    try {
      listener(outgoing);
    } catch (error) {
      console.warn('[SESSION_EVENTS] Client delivery failed', event.sessionId, error);
    }
  }
};
