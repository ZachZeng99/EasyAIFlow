type SessionRunQueue = Map<string, Promise<void>>;

export const createSessionRunQueue = (): SessionRunQueue => new Map<string, Promise<void>>();

export const hasSessionRunQueued = (queue: SessionRunQueue, sessionId: string) => queue.has(sessionId);

export const enqueueSessionRun = (
  queue: SessionRunQueue,
  sessionId: string,
  task: () => Promise<void>,
) => {
  const previous = queue.get(sessionId);
  const queued = Boolean(previous);
  const completion = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(task);

  let tracked!: Promise<void>;
  tracked = completion.finally(() => {
    if (queue.get(sessionId) === tracked) {
      queue.delete(sessionId);
    }
  });

  queue.set(sessionId, tracked);

  return {
    queued,
    completion: tracked,
  };
};
