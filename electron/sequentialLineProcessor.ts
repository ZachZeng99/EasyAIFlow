export type SequentialLineProcessor = {
  pushChunk: (chunk: string) => void;
  flush: () => Promise<void>;
};

export const createSequentialLineProcessor = (
  handler: (line: string) => Promise<void> | void,
): SequentialLineProcessor => {
  let buffer = '';
  let failure: unknown;
  let pending = Promise.resolve();

  const enqueue = (line: string) => {
    if (!line.trim()) {
      return;
    }

    pending = pending.then(async () => {
      if (failure) {
        return;
      }

      try {
        await handler(line);
      } catch (error) {
        failure = error;
      }
    });
  };

  return {
    pushChunk(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      lines.forEach(enqueue);
    },

    async flush() {
      if (buffer.trim()) {
        const trailingLine = buffer;
        buffer = '';
        enqueue(trailingLine);
      }

      await pending;

      if (failure) {
        throw failure;
      }
    },
  };
};
