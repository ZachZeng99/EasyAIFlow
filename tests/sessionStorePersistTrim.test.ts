import assert from 'node:assert/strict';

// Must be set before importing the module — the cap is read once at load time.
process.env.EASYAIFLOW_MAX_PERSISTED_MESSAGES = '3';

const { buildPersistableState } = await import('../electron/sessionStore.js');

const run = async (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeSession = (id: string, messageCount: number) => ({
  id,
  title: id,
  messages: Array.from({ length: messageCount }, (_, i) => ({
    id: `${id}-m${i}`,
    role: 'assistant',
    content: `msg ${i}`,
    timestamp: 'now',
  })),
});

const makeState = (sessions: ReturnType<typeof makeSession>[]) =>
  ({
    projects: [{ id: 'p1', name: 'p', dreams: [{ id: 'd1', name: 'd', sessions }] }],
    deletedImports: { claudeSessionIds: [], codexThreadIds: [] },
  }) as never;

await run('caps over-limit sessions to the last N messages, preserving order', () => {
  const state = makeState([makeSession('big', 10)]);
  const persisted = buildPersistableState(state) as never as {
    projects: { dreams: { sessions: { messages: { id: string }[] }[] }[] }[];
  };
  const messages = persisted.projects[0].dreams[0].sessions[0].messages;
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m.id), ['big-m7', 'big-m8', 'big-m9']);
});

await run('leaves under-limit sessions untouched (same reference, no copy)', () => {
  const small = makeSession('small', 2);
  const state = makeState([small]);
  const persisted = buildPersistableState(state) as never as {
    projects: { dreams: { sessions: unknown[] }[] }[];
  };
  assert.equal(persisted.projects[0].dreams[0].sessions[0], small);
});

await run('returns the original state object when nothing needs trimming', () => {
  const state = makeState([makeSession('a', 1), makeSession('b', 3)]);
  assert.equal(buildPersistableState(state), state);
});

await run('does not mutate the input state', () => {
  const state = makeState([makeSession('big', 10)]);
  buildPersistableState(state);
  const original = state as never as {
    projects: { dreams: { sessions: { messages: unknown[] }[] }[] }[];
  };
  assert.equal(original.projects[0].dreams[0].sessions[0].messages.length, 10);
});
