import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSerialAsyncQueue } from '../electron/serialAsyncQueue.js';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('createSerialAsyncQueue does not run a task synchronously on push', async () => {
  let ran = false;
  const queue = createSerialAsyncQueue();
  queue.push(() => {
    ran = true;
  });
  // Deferred to a microtask — must not have executed within push().
  assert.equal(ran, false);
  assert.equal(queue.depth, 1);
  await queue.drain();
  assert.equal(ran, true);
  assert.equal(queue.depth, 0);
});

await run('createSerialAsyncQueue preserves order across async work', async () => {
  const order: number[] = [];
  const queue = createSerialAsyncQueue();
  queue.push(async () => {
    await delay(15);
    order.push(1);
  });
  queue.push(async () => {
    order.push(2);
  });
  await queue.drain();
  assert.deepEqual(order, [1, 2]);
});

await run('createSerialAsyncQueue routes task errors to onError and keeps going', async () => {
  const errors: string[] = [];
  const done: string[] = [];
  const queue = createSerialAsyncQueue((error) => {
    errors.push(error instanceof Error ? error.message : String(error));
  });
  queue.push(() => {
    throw new Error('boom');
  });
  queue.push(() => {
    done.push('after');
  });
  await queue.drain();
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(done, ['after']);
});

await run('createSerialAsyncQueue drain settles even when work is enqueued mid-drain', async () => {
  const order: string[] = [];
  const queue = createSerialAsyncQueue();
  queue.push(async () => {
    order.push('a');
    queue.push(async () => {
      order.push('b');
    });
  });
  await queue.drain();
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(queue.depth, 0);
});
