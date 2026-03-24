import assert from 'node:assert/strict';
import { createSessionRunQueue, enqueueSessionRun, hasSessionRunQueued } from '../electron/sessionRunQueue.ts';

const run = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('enqueueSessionRun serializes runs for the same session', async () => {
  const queue = createSessionRunQueue();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  assert.equal(hasSessionRunQueued(queue, 'session-1'), false);

  const first = enqueueSessionRun(queue, 'session-1', async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });

  assert.equal(first.queued, false);
  assert.equal(hasSessionRunQueued(queue, 'session-1'), true);

  const second = enqueueSessionRun(queue, 'session-1', async () => {
    order.push('second:start');
    order.push('second:end');
  });

  assert.equal(second.queued, true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);

  releaseFirst();
  await Promise.all([first.completion, second.completion]);

  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  assert.equal(hasSessionRunQueued(queue, 'session-1'), false);
});

await run('enqueueSessionRun keeps different sessions independent', async () => {
  const queue = createSessionRunQueue();
  const order: string[] = [];

  const first = enqueueSessionRun(queue, 'session-1', async () => {
    order.push('session-1');
  });
  const second = enqueueSessionRun(queue, 'session-2', async () => {
    order.push('session-2');
  });

  assert.equal(first.queued, false);
  assert.equal(second.queued, false);

  await Promise.all([first.completion, second.completion]);
  assert.deepEqual(new Set(order), new Set(['session-1', 'session-2']));
});
