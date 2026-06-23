import v8 from 'node:v8';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { ClaudeInteractionState } from './claudeInteractionState.js';

export type MemoryDiagnosticsOptions = {
  state: ClaudeInteractionState;
  /** Current number of connected SSE clients. */
  sseClientCount: () => number;
  /** How often to log, in ms. */
  intervalMs?: number;
  /** Write a single heap snapshot once heapUsed first exceeds this many bytes. */
  snapshotThresholdBytes?: number;
  /** File the [mem] lines are mirrored to so they survive an OOM crash. */
  logFilePath?: string;
};

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * Periodically logs heap usage alongside the sizes of the in-memory structures
 * most likely to leak, so a climbing process reveals *which* structure is
 * responsible without having to parse a multi-GB heap snapshot. As a backstop
 * it also writes one heap snapshot when usage first crosses a threshold, giving
 * a retainer graph captured before the OOM rather than a bare crash.
 */
export const startMemoryDiagnostics = ({
  state,
  sseClientCount,
  intervalMs = 30_000,
  snapshotThresholdBytes = 2.5 * 1024 * 1024 * 1024,
  logFilePath = path.join(process.cwd(), 'mem-diag.log'),
}: MemoryDiagnosticsOptions) => {
  let snapshotWritten = false;

  // Append (don't truncate): a crash followed by a restart must NOT wipe the
  // crashed run's history — that history is exactly what diagnoses the leak.
  // A `# mem-diag started` separator delimits each run within the file.
  try {
    appendFileSync(logFilePath, `\n# mem-diag started, pid=${process.pid}, uptime0=${Math.round(process.uptime())}s\n`);
  } catch {
    // Non-fatal: fall back to console-only logging.
  }

  const emit = (line: string) => {
    console.log(line);
    try {
      appendFileSync(logFilePath, `${line}\n`);
    } catch {
      // Ignore log-file write failures; console output still works.
    }
  };

  const timer = setInterval(() => {
    const mem = process.memoryUsage();

    const residents: string[] = [];
    for (const [sessionId, resident] of state.residentSessions) {
      const runState = resident.currentTurn?.runState ?? resident.activeOutputTurn?.runState;
      residents.push(
        [
          sessionId.slice(0, 6),
          `q=${resident.stdoutProcessor.queueDepth}`,
          `qturns=${resident.queuedTurns.size}`,
          `bgOwners=${resident.backgroundTaskOwners.size}`,
          `orphan=${resident.orphanBackgroundTasks.size}`,
          `ctrl=${resident.pendingControlRequests.size}`,
          `errKB=${Math.round(resident.stderrBuffer.length / 1024)}`,
          `traces=${runState?.toolTraces.size ?? 0}`,
          `jsonBuf=${runState?.toolUseJsonBuffers.size ?? 0}`,
          `bgTasks=${runState?.backgroundTasks.size ?? 0}`,
        ].join(' '),
      );
    }

    let interceptorTotal = 0;
    for (const set of state.sessionBroadcastInterceptors.values()) {
      interceptorTotal += set.size;
    }

    emit(
      `[mem] t=${Math.round(process.uptime())}s heapUsed=${mb(mem.heapUsed)}MB heapTotal=${mb(mem.heapTotal)}MB ` +
        `rss=${mb(mem.rss)}MB ext=${mb(mem.external)}MB arrayBuffers=${mb(mem.arrayBuffers)}MB ` +
        `sse=${sseClientCount()} residents=${state.residentSessions.size} ` +
        `perm=${state.pendingPermissionRequests.size} ask=${state.pendingAskUserQuestions.size} ` +
        `plan=${state.pendingPlanModeRequests.size} deferPlan=${state.deferredExitPlanControlRequests.size} ` +
        `slashCache=${state.slashCommandCache.size} interceptors=${interceptorTotal}` +
        (residents.length ? `\n[mem]   ${residents.join('\n[mem]   ')}` : ''),
    );

    if (!snapshotWritten && mem.heapUsed > snapshotThresholdBytes) {
      snapshotWritten = true;
      try {
        const file = v8.writeHeapSnapshot(path.join(process.cwd(), `easyaiflow-${process.pid}.heapsnapshot`));
        emit(`[mem] heapUsed crossed threshold — wrote heap snapshot: ${file}`);
      } catch (error) {
        console.error('[mem] failed to write heap snapshot', error);
      }
    }
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
};
