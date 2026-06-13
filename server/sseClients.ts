import type { ClaudeStreamEvent } from '../src/data/types.js';

export type SseWritableClient = {
  destroyed?: boolean;
  writableEnded?: boolean;
  writableLength?: number;
  write: (payload: string) => boolean;
  end: () => void;
};

export type SseClientRegistryOptions = {
  maxBufferedBytes?: number;
};

const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

const hasExceededBufferLimit = (client: SseWritableClient, maxBufferedBytes: number) =>
  (client.writableLength ?? 0) > maxBufferedBytes;

export const createSseClientRegistry = ({
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
}: SseClientRegistryOptions = {}) => {
  const clients = new Set<SseWritableClient>();

  const closeClient = (client: SseWritableClient) => {
    clients.delete(client);
    if (!client.destroyed && !client.writableEnded) {
      try {
        client.end();
      } catch {
        // The socket is already unusable; removing it from the registry is enough.
      }
    }
  };

  const writePayload = (client: SseWritableClient, payload: string) => {
    if (client.destroyed || client.writableEnded || hasExceededBufferLimit(client, maxBufferedBytes)) {
      closeClient(client);
      return false;
    }

    try {
      const accepted = client.write(payload);
      if (!accepted && hasExceededBufferLimit(client, maxBufferedBytes)) {
        closeClient(client);
        return false;
      }
      return true;
    } catch {
      closeClient(client);
      return false;
    }
  };

  const writeComment = (client: SseWritableClient, comment: string) =>
    writePayload(client, `: ${comment.replace(/\r?\n/g, ' ')}\n\n`);

  const writeEvent = (client: SseWritableClient, event: ClaudeStreamEvent) =>
    writePayload(client, `data: ${JSON.stringify(event)}\n\n`);

  const broadcastEvent = (event: ClaudeStreamEvent) => {
    [...clients].forEach((client) => {
      writeEvent(client, event);
    });
  };

  return {
    add: (client: SseWritableClient) => {
      clients.add(client);
    },
    has: (client: SseWritableClient) => clients.has(client),
    remove: (client: SseWritableClient) => {
      clients.delete(client);
    },
    writeComment,
    writeEvent,
    broadcastEvent,
    get size() {
      return clients.size;
    },
  };
};
