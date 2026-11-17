import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getClaudeSessionRegistryPath,
  parseClaudeAgentName,
  pollClaudeAgentName,
  readClaudeAgentName,
} from '../backend/claudeAgentName.js';
import { setSessionRuntimeState } from '../src/data/sessionInteraction.js';

const run = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('registry path honours CLAUDE_CONFIG_DIR and falls back to ~/.claude', () => {
  assert.equal(
    getClaudeSessionRegistryPath(42, { CLAUDE_CONFIG_DIR: path.join('X:', 'cfg') }, 'H:'),
    path.join('X:', 'cfg', 'sessions', '42.json'),
  );
  assert.equal(getClaudeSessionRegistryPath(42, {}, 'H:'), path.join('H:', '.claude', 'sessions', '42.json'));
});

await run('parseClaudeAgentName reads the name and ignores blanks or junk', () => {
  assert.equal(parseClaudeAgentName('{"pid":1,"name":"easyaiflow-58","nameSource":"derived"}'), 'easyaiflow-58');
  assert.equal(parseClaudeAgentName('{"pid":1}'), undefined);
  assert.equal(parseClaudeAgentName('{"name":"  "}'), undefined);
  assert.equal(parseClaudeAgentName('not json'), undefined);
});

await run('readClaudeAgentName returns undefined for a missing file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eaf-agent-name-'));
  try {
    assert.equal(await readClaudeAgentName(1, path.join(dir, 'missing.json')), undefined);
    const file = path.join(dir, '7.json');
    await writeFile(file, JSON.stringify({ pid: 7, name: 'pbz-91' }));
    assert.equal(await readClaudeAgentName(7, file), 'pbz-91');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await run('pollClaudeAgentName waits until the CLI registers a name', async () => {
  let reads = 0;
  const name = await pollClaudeAgentName(9, {
    isAlive: () => true,
    intervalMs: 1,
    read: async () => (++reads >= 3 ? 'dlss-9b' : undefined),
  });
  assert.equal(name, 'dlss-9b');
  assert.equal(reads, 3);
});

await run('pollClaudeAgentName stops when the process dies or the deadline passes', async () => {
  let alive = true;
  const stopped = await pollClaudeAgentName(9, {
    isAlive: () => alive,
    intervalMs: 1,
    read: async () => {
      alive = false;
      return undefined;
    },
  });
  assert.equal(stopped, undefined);
  const timedOut = await pollClaudeAgentName(9, {
    isAlive: () => true,
    intervalMs: 1,
    timeoutMs: 5,
    read: async () => undefined,
  });
  assert.equal(timedOut, undefined);
});

await run('runtime reducer keeps the agent name across updates and drops it when the process ends', () => {
  let state = setSessionRuntimeState({}, { processActive: true, phase: 'idle', agentName: 'easyaiflow-58' });
  state = setSessionRuntimeState(state, { processActive: true, phase: 'running' });
  assert.equal(state.runtime?.agentName, 'easyaiflow-58');
  state = setSessionRuntimeState(state, { processActive: false, phase: 'inactive' });
  assert.equal(state.runtime?.agentName, undefined);
});
