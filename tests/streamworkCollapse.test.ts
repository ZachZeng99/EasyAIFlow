import assert from 'node:assert/strict';
import { buildInitialCollapsedStreamworks } from '../src/data/streamworkCollapse.ts';

const run = async (name: string, test: () => void | Promise<void>) => {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('collapses streamworks without an online session', () => {
  const collapsed = buildInitialCollapsedStreamworks(
    [
      {
        dreams: [
          { id: 'offline', sessions: [{ id: 'offline-session' }] },
          { id: 'empty', sessions: [] },
        ],
      },
    ],
    {
      'offline-session': { online: false },
    },
  );

  assert.deepEqual(collapsed, {
    offline: true,
    empty: true,
  });
});

await run('expands only streamworks containing an online session', () => {
  const collapsed = buildInitialCollapsedStreamworks(
    [
      {
        dreams: [
          {
            id: 'mixed',
            sessions: [{ id: 'offline-session' }, { id: 'online-session' }],
          },
          { id: 'busy-but-offline', sessions: [{ id: 'busy-session' }] },
        ],
      },
    ],
    {
      'offline-session': { online: false },
      'online-session': { online: true },
      'busy-session': { online: false },
    },
  );

  assert.deepEqual(collapsed, {
    mixed: false,
    'busy-but-offline': true,
  });
});
