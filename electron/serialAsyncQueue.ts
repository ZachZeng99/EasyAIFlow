export type SerialAsyncQueue = {
  /** Enqueue a task to run after all previously-enqueued tasks complete. */
  push: (task: () => Promise<void> | void) => void;
  /** Resolves once the queue is fully drained and idle. */
  drain: () => Promise<void>;
  /** Number of tasks still waiting to run. */
  readonly depth: number;
};

/**
 * Runs async tasks strictly one-at-a-time, in enqueue order, using an explicit
 * queue + single drain loop.
 *
 * This deliberately avoids the `tail = tail.then(task)` idiom: that builds an
 * ever-growing graph of unsettled promises whenever tasks are enqueued faster
 * than they complete (each link retains its task closure and the previous
 * promise), which the GC cannot reclaim until the whole chain settles. On a
 * long-lived, high-frequency producer that never happens, so the heap grows
 * without bound. A plain array releases each task as soon as it has run, so
 * retained memory is just the current backlog.
 */
export const createSerialAsyncQueue = (
  onError?: (error: unknown) => void,
): SerialAsyncQueue => {
  const queue: Array<() => Promise<void> | void> = [];
  let draining = false;
  let drainPromise: Promise<void> = Promise.resolve();

  const run = async () => {
    try {
      while (queue.length > 0) {
        const task = queue.shift()!;
        try {
          await task();
        } catch (error) {
          if (onError) {
            onError(error);
          } else {
            throw error;
          }
        }
      }
    } finally {
      draining = false;
    }
  };

  const kick = () => {
    if (draining || queue.length === 0) {
      return;
    }
    // Reserve the drain slot synchronously, but defer the first task to a
    // microtask so enqueuing never runs a task within the caller's stack frame
    // (matching the `tail = tail.then(task)` timing this replaces).
    draining = true;
    drainPromise = Promise.resolve().then(run);
  };

  return {
    push(task) {
      queue.push(task);
      kick();
    },
    async drain() {
      while (draining || queue.length > 0) {
        await drainPromise;
        kick();
      }
    },
    get depth() {
      return queue.length;
    },
  };
};
