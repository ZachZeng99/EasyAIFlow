export type SequentialLineProcessor = {
  pushChunk: (chunk: string) => void;
  flush: () => Promise<void>;
  /** Number of parsed lines waiting to be handled. Lets callers apply
   *  backpressure (e.g. pause the source stream) when the consumer lags. */
  readonly queueDepth: number;
};

export type SequentialLineProcessorOptions = {
  /** Invoked whenever the backlog fully drains (queue reaches empty after
   *  having had work). Callers use this to resume a paused source stream. */
  onDrained?: () => void;
};

export const createSequentialLineProcessor = (
  handler: (line: string) => Promise<void> | void,
  options: SequentialLineProcessorOptions = {},
): SequentialLineProcessor => {
  let buffer = '';
  let failure: unknown;
  // An explicit queue + single drain loop, instead of chaining
  // `pending = pending.then(...)`. The chaining approach builds an
  // ever-growing graph of unsettled promises whenever the producer outruns the
  // async handler — each link retains its line string, closure, and the
  // previous promise — which GC cannot reclaim until the whole chain settles.
  // Under a sustained-fast stdout stream that never happens, so the graph grows
  // until the heap is exhausted. A plain array releases each line as soon as it
  // is handled, so retained memory is just the current backlog.
  const queue: string[] = [];
  let draining = false;
  let drainPromise: Promise<void> = Promise.resolve();

  const drain = async () => {
    draining = true;
    try {
      while (queue.length > 0) {
        if (failure) {
          queue.length = 0;
          break;
        }
        const line = queue.shift()!;
        try {
          await handler(line);
        } catch (error) {
          failure = error;
          queue.length = 0;
          break;
        }
      }
    } finally {
      draining = false;
    }
    options.onDrained?.();
  };

  const kick = () => {
    if (!draining && queue.length > 0) {
      drainPromise = drain();
    }
  };

  return {
    pushChunk(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) {
          queue.push(line);
        }
      }
      kick();
    },

    async flush() {
      if (buffer.trim()) {
        queue.push(buffer);
      }
      buffer = '';
      kick();

      // A drain started before flush may settle while fresh work remains
      // queued; loop until the queue is genuinely empty and idle.
      while (draining || queue.length > 0) {
        await drainPromise;
        kick();
      }

      if (failure) {
        throw failure;
      }
    },

    get queueDepth() {
      return queue.length;
    },
  };
};
