import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSequentialLineProcessor } from '../electron/sequentialLineProcessor.js';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('createSequentialLineProcessor preserves handler order across async work', async () => {
  const handled: string[] = [];
  const processor = createSequentialLineProcessor(async (line) => {
    if (line === 'first') {
      await delay(20);
    }
    handled.push(line);
  });

  processor.pushChunk('first\nsecond\n');
  await processor.flush();

  assert.deepEqual(handled, ['first', 'second']);
});

await run('createSequentialLineProcessor flushes a trailing line without a newline terminator', async () => {
  const handled: string[] = [];
  const processor = createSequentialLineProcessor(async (line) => {
    handled.push(line);
  });

  processor.pushChunk('tail');
  await processor.flush();

  assert.deepEqual(handled, ['tail']);
});

await run('createSequentialLineProcessor reports handler failures from flush', async () => {
  const handled: string[] = [];
  const processor = createSequentialLineProcessor(async (line) => {
    handled.push(line);
    if (line === 'bad') {
      throw new Error('boom');
    }
  });

  processor.pushChunk('ok\nbad\nlater\n');

  await assert.rejects(() => processor.flush(), /boom/);
  assert.deepEqual(handled, ['ok', 'bad']);
});
