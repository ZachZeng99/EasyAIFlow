type SessionRunQueue = Map<string, Promise<void>>;

export const createSessionRunQueue = (): SessionRunQueue => new Map<string, Promise<void>>();

export const hasSessionRunQueued = (queue: SessionRunQueue, sessionId: string) => queue.has(sessionId);

export const enqueueSessionRun = (queue: SessionRunQueue, sessionId: string) => {
  const previous = queue.get(sessionId);
  const whenReady = (previous ?? Promise.resolve()).catch(() => undefined);
  const queued = Boolean(previous);
  let releaseTurn!: () => void;
  let released = false;
  const turnReleased = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });

  let tracked!: Promise<void>;
  tracked = whenReady.then(() => turnReleased).finally(() => {
    if (queue.get(sessionId) === tracked) {
      queue.delete(sessionId);
    }
  });

  queue.set(sessionId, tracked);

  return {
    queued,
    whenReady,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      releaseTurn();
    },
    completion: tracked,
  };
};
