import assert from 'node:assert/strict';
import { collectPinnedSessions, sortSessionsWithPinnedFirst } from '../src/data/sessionOrder.ts';
import type { ProjectRecord } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('sortSessionsWithPinnedFirst keeps pinned sessions first and each group recent-first', () => {
  const sessions = [
    { id: 'recent', updatedAt: 40 },
    { id: 'older-pinned', pinned: true, updatedAt: 10 },
    { id: 'older', updatedAt: 20 },
    { id: 'recent-pinned', pinned: true, updatedAt: 30 },
  ];

  const ordered = sortSessionsWithPinnedFirst(sessions);

  assert.deepEqual(
    ordered.map((session) => session.id),
    ['recent-pinned', 'older-pinned', 'recent', 'older'],
  );
  assert.deepEqual(
    sessions.map((session) => session.id),
    ['recent', 'older-pinned', 'older', 'recent-pinned'],
  );
});

run('sortSessionsWithPinnedFirst treats missing timestamps as oldest', () => {
  const ordered = sortSessionsWithPinnedFirst([
    { id: 'missing-pinned', pinned: true },
    { id: 'dated-pinned', pinned: true, updatedAt: 1 },
    { id: 'missing' },
    { id: 'dated', updatedAt: 1 },
  ]);

  assert.deepEqual(
    ordered.map((session) => session.id),
    ['dated-pinned', 'missing-pinned', 'dated', 'missing'],
  );
});

run('collectPinnedSessions collects visible pins globally and sorts them recent-first', () => {
  const projects = [
    {
      id: 'project-a',
      name: 'Project A',
      rootPath: 'X:\\a',
      dreams: [
        {
          id: 'dream-a',
          name: 'Streamwork A',
          sessions: [
            { id: 'older-pin', pinned: true, updatedAt: 10 },
            { id: 'hidden-pin', pinned: true, hidden: true, updatedAt: 50 },
          ],
        },
      ],
    },
    {
      id: 'project-b',
      name: 'Project B',
      rootPath: 'X:\\b',
      dreams: [
        {
          id: 'dream-b',
          name: 'Streamwork B',
          sessions: [
            { id: 'recent-pin', pinned: true, updatedAt: 30 },
            { id: 'recent-unpinned', pinned: false, updatedAt: 40 },
          ],
        },
      ],
    },
  ] as unknown as ProjectRecord[];

  const pinned = collectPinnedSessions(projects);

  assert.deepEqual(
    pinned.map((session) => session.id),
    ['recent-pin', 'older-pin'],
  );
});
