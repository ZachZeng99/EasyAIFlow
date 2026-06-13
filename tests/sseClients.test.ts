import assert from 'node:assert/strict';
import { createSseClientRegistry } from '../server/sseClients.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

type FakeSseClientOptions = {
  writableLength?: number;
  writeResult?: boolean;
  throwOnWrite?: boolean;
};

class FakeSseClient {
  writes: string[] = [];
  writableLength: number;
  writableEnded = false;
  destroyed = false;

  private readonly writeResult: boolean;
  private readonly throwOnWrite: boolean;

  constructor(options: FakeSseClientOptions = {}) {
    this.writableLength = options.writableLength ?? 0;
    this.writeResult = options.writeResult ?? true;
    this.throwOnWrite = options.throwOnWrite ?? false;
  }

  write(payload: string) {
    if (this.throwOnWrite) {
      throw new Error('socket closed');
    }
    this.writes.push(payload);
    this.writableLength += Buffer.byteLength(payload);
    return this.writeResult;
  }

  end() {
    this.writableEnded = true;
  }
}

run('SSE registry drops clients that already exceed the buffered byte limit', () => {
  const registry = createSseClientRegistry({ maxBufferedBytes: 10 });
  const client = new FakeSseClient({ writableLength: 11 });

  registry.add(client);
  const written = registry.writeComment(client, 'heartbeat');

  assert.equal(written, false);
  assert.equal(registry.size, 0);
  assert.equal(client.writableEnded, true);
  assert.deepEqual(client.writes, []);
});

run('SSE registry drops clients when a write pushes the buffer beyond the byte limit', () => {
  const registry = createSseClientRegistry({ maxBufferedBytes: 10 });
  const client = new FakeSseClient({ writeResult: false });

  registry.add(client);
  const written = registry.writeEvent(client, {
    type: 'interaction-sync',
  });

  assert.equal(written, false);
  assert.equal(registry.size, 0);
  assert.equal(client.writableEnded, true);
  assert.equal(client.writes.length, 1);
});

run('SSE registry removes clients that throw while writing', () => {
  const registry = createSseClientRegistry({ maxBufferedBytes: 10 });
  const client = new FakeSseClient({ throwOnWrite: true });

  registry.add(client);
  const written = registry.writeComment(client, 'heartbeat');

  assert.equal(written, false);
  assert.equal(registry.size, 0);
  assert.equal(client.writableEnded, true);
});
