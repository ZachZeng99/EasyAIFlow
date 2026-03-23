import assert from 'node:assert/strict';
import { sortDreamsWithTemporaryFirst } from '../src/data/streamworkOrder.js';
import type { DreamRecord } from '../src/data/types.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeDream = (id: string, name: string, isTemporary = false): DreamRecord => ({
  id,
  name,
  isTemporary,
  sessions: [],
});

run('sortDreamsWithTemporaryFirst keeps Temporary pinned first', () => {
  const ordered = sortDreamsWithTemporaryFirst([
    makeDream('auto', 'Automation'),
    makeDream('temporary', 'Temporary', true),
    makeDream('editor', 'Editor'),
  ]);

  assert.deepEqual(
    ordered.map((dream) => dream.id),
    ['temporary', 'auto', 'editor'],
  );
});

run('sortDreamsWithTemporaryFirst preserves regular streamwork order after Temporary', () => {
  const ordered = sortDreamsWithTemporaryFirst([
    makeDream('temporary', 'Temporary', true),
    makeDream('first', 'First'),
    makeDream('second', 'Second'),
  ]);

  assert.deepEqual(
    ordered.map((dream) => dream.id),
    ['temporary', 'first', 'second'],
  );
});
