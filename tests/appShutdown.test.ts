import assert from 'node:assert/strict';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.ts';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.ts';
import {
  collectClaudeShutdownSessionIds,
  createBeforeQuitHandler,
  settleClaudeSessionsForShutdown,
} from '../electron/appShutdown.ts';

const run = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const ctx: ClaudeInteractionContext = {
  broadcastEvent: () => undefined,
  attachmentRoot: () => '',
  claudeSettingsPath: () => '',
  homePath: () => '',
};

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

await run('collectClaudeShutdownSessionIds de-duplicates resident and active sessions', () => {
  const state = createClaudeInteractionState();
  state.residentSessions.set('session-1', { sessionId: 'session-1' } as never);
  state.activeRuns.set('run-1', {
    runId: 'run-1',
    sessionId: 'session-1',
    child: {} as never,
    projectRoot: 'X:\\Project',
  });
  state.activeRuns.set('run-2', {
    runId: 'run-2',
    sessionId: 'session-2',
    child: {} as never,
    projectRoot: 'X:\\Project',
  });

  assert.deepEqual(collectClaudeShutdownSessionIds(state), ['session-1', 'session-2']);
});

await run('settleClaudeSessionsForShutdown interrupts live turns, then settles pending messages, then flushes', async () => {
  const state = createClaudeInteractionState();
  state.residentSessions.set(
    'session-1',
    {
      sessionId: 'session-1',
      currentTurn: { assistantMessageId: 'assistant-1' },
    } as never,
  );
  state.activeRuns.set('run-1', {
    runId: 'run-1',
    sessionId: 'session-1',
    child: {} as never,
    projectRoot: 'X:\\Project',
  });
  state.activeRuns.set('run-2', {
    runId: 'run-2',
    sessionId: 'session-2',
    child: {} as never,
    projectRoot: 'X:\\Project',
  });

  const calls: string[] = [];
  await settleClaudeSessionsForShutdown(ctx, state, {
    interruptSessionTurnImpl: async (_ctx, _state, sessionId) => {
      calls.push(`interrupt:${sessionId}`);
    },
    stopPendingSessionMessagesImpl: async (sessionId) => {
      calls.push(`stop:${sessionId}`);
      return {
        projects: [],
        changedMessages: [],
      };
    },
    flushPendingSaveImpl: async () => {
      calls.push('flush');
    },
  });

  assert.deepEqual(calls, [
    'interrupt:session-1',
    'stop:session-1',
    'stop:session-2',
    'flush',
  ]);
});

await run('createBeforeQuitHandler waits for async cleanup before quitting and only starts cleanup once', async () => {
  let resolveCleanup: (() => void) | null = null;
  const calls: string[] = [];
  let prevented = 0;

  const handler = createBeforeQuitHandler({
    prepareClaudeShutdown: () =>
      new Promise<void>((resolve) => {
        calls.push('prepare');
        resolveCleanup = () => {
          calls.push('prepared');
          resolve();
        };
      }),
    stopAllCodexRuns: () => {
      calls.push('stop-codex');
    },
    killClaudeRuns: () => {
      calls.push('kill-claude');
    },
    quit: () => {
      calls.push('quit');
    },
  });

  handler({
    preventDefault: () => {
      prevented += 1;
    },
  });
  handler({
    preventDefault: () => {
      prevented += 1;
    },
  });

  assert.equal(prevented, 2);
  assert.deepEqual(calls, ['prepare']);

  resolveCleanup?.();
  await flushMicrotasks();

  assert.deepEqual(calls, ['prepare', 'prepared', 'stop-codex', 'kill-claude', 'quit']);

  handler({
    preventDefault: () => {
      prevented += 1;
    },
  });

  assert.equal(prevented, 2);
});
