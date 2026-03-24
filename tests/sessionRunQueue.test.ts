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

await run('enqueueSessionRun releases the next turn before prior background cleanup finishes', async () => {
  const queue = createSessionRunQueue();
  const order: string[] = [];
  let finishFirstCleanup!: () => void;
  const firstCleanup = new Promise<void>((resolve) => {
    finishFirstCleanup = resolve;
  });

  assert.equal(hasSessionRunQueued(queue, 'session-1'), false);

  const first = enqueueSessionRun(queue, 'session-1');
  const firstExecution = first.whenReady.then(async () => {
    order.push('first:start');
    await firstCleanup;
    order.push('first:cleanup');
  });

  assert.equal(first.queued, false);
  assert.equal(hasSessionRunQueued(queue, 'session-1'), true);

  const second = enqueueSessionRun(queue, 'session-1');
  const secondExecution = second.whenReady.then(() => {
    order.push('second:start');
    second.release();
  });

  assert.equal(second.queued, true);
  await first.whenReady;
  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);

  first.release();
  await second.whenReady;
  await Promise.resolve();
  assert.deepEqual(order, ['first:start', 'second:start']);

  finishFirstCleanup();
  await Promise.all([firstExecution, secondExecution, first.completion, second.completion]);

  assert.deepEqual(order, ['first:start', 'second:start', 'first:cleanup']);
  assert.equal(hasSessionRunQueued(queue, 'session-1'), false);
});

await run('enqueueSessionRun keeps different sessions independent', async () => {
  const queue = createSessionRunQueue();
  const order: string[] = [];

  const first = enqueueSessionRun(queue, 'session-1');
  const firstExecution = first.whenReady.then(() => {
    order.push('session-1');
    first.release();
  });
  const second = enqueueSessionRun(queue, 'session-2');
  const secondExecution = second.whenReady.then(() => {
    order.push('session-2');
    second.release();
  });

  assert.equal(first.queued, false);
  assert.equal(second.queued, false);

  await Promise.all([
    first.whenReady,
    second.whenReady,
    firstExecution,
    secondExecution,
    first.completion,
    second.completion,
  ]);
  assert.deepEqual(new Set(order), new Set(['session-1', 'session-2']));
});
