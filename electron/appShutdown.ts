import { interruptSessionTurn } from '../backend/claudeInteraction.js';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.js';
import type { ClaudeInteractionState } from '../backend/claudeInteractionState.js';
import { flushPendingSave } from './sessionStore.js';
import { stopPendingSessionMessages } from './sessionStop.js';

type BeforeQuitEventLike = {
  preventDefault: () => void;
};

type ShutdownDependencies = {
  interruptSessionTurnImpl?: typeof interruptSessionTurn;
  stopPendingSessionMessagesImpl?: typeof stopPendingSessionMessages;
  flushPendingSaveImpl?: typeof flushPendingSave;
};

type BeforeQuitHandlerDependencies = {
  prepareClaudeShutdown: () => Promise<void>;
  stopAllCodexRuns: () => void;
  killClaudeRuns: () => void;
  quit: () => void;
};

export const collectClaudeShutdownSessionIds = (state: ClaudeInteractionState) => {
  const sessionIds = new Set<string>();
  state.residentSessions.forEach((_resident, sessionId) => {
    sessionIds.add(sessionId);
  });
  state.activeRuns.forEach((run) => {
    sessionIds.add(run.sessionId);
  });
  return [...sessionIds];
};

export const settleClaudeSessionsForShutdown = async (
  ctx: ClaudeInteractionContext,
  state: ClaudeInteractionState,
  deps: ShutdownDependencies = {},
) => {
  const interruptSessionTurnImpl = deps.interruptSessionTurnImpl ?? interruptSessionTurn;
  const stopPendingSessionMessagesImpl =
    deps.stopPendingSessionMessagesImpl ?? stopPendingSessionMessages;
  const flushPendingSaveImpl = deps.flushPendingSaveImpl ?? flushPendingSave;

  for (const sessionId of collectClaudeShutdownSessionIds(state)) {
    const resident = state.residentSessions.get(sessionId);
    if (resident?.currentTurn) {
      await interruptSessionTurnImpl(ctx, state, sessionId);
    }
    await stopPendingSessionMessagesImpl(sessionId);
  }

  await flushPendingSaveImpl();
};

export const createBeforeQuitHandler = (deps: BeforeQuitHandlerDependencies) => {
  let cleanupPromise: Promise<void> | null = null;
  let quitRequested = false;

  return (event: BeforeQuitEventLike) => {
    if (quitRequested) {
      return;
    }

    event.preventDefault();
    if (cleanupPromise) {
      return;
    }

    cleanupPromise = (async () => {
      try {
        await deps.prepareClaudeShutdown();
      } finally {
        try {
          deps.stopAllCodexRuns();
          deps.killClaudeRuns();
        } finally {
          cleanupPromise = null;
          quitRequested = true;
          deps.quit();
        }
      }
    })();
  };
};
