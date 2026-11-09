import type { ClaudeStreamEvent, ConversationMessage, SessionMessagePage } from '../src/data/types.js';
import { OperationError } from './operationLedger.js';
import type { RemoteExecutionPort } from './remoteExecution.js';

export type RemoteTurnOutcome =
  | { status: 'complete' | 'error'; content: string; assistantMessageId: string }
  | { status: 'stopped'; assistantMessageId?: string };

type MirroredEvent = Extract<ClaudeStreamEvent, { type: 'trace' | 'delta' | 'status' | 'complete' | 'error' }>;
const MIRRORED_TYPES = new Set(['trace', 'delta', 'status', 'complete', 'error']);
const MAX_BUFFERED_EVENTS = 4000;
const MAX_POLLED_PAGES = 8;

const isRetryableTransport = (error: unknown) => error instanceof OperationError && error.code === 'EAF_TRANSPORT_RETRYABLE';
const terminalOf = (message: ConversationMessage | undefined) =>
  message?.status === 'complete' || message?.status === 'success' ? 'complete' as const
    : message?.status === 'error' ? 'error' as const : undefined;

/**
 * Run one group-member turn in a session owned by another paired device.
 *
 * The executing device remains the only writer of the member session; this
 * coordinator only mirrors its public output into the room. Submission reuses a
 * stable operation ID, so a transport retry returns the original turn instead of
 * starting another. Live events are best-effort; polling the executor's own
 * persisted record decides completion after reconnects or lost events.
 */
export const runRemoteMemberTurn = async (options: {
  port: RemoteExecutionPort;
  deviceId: string;
  sessionId: string;
  prompt: string;
  model?: string;
  effort?: string;
  operationId: string;
  signal: AbortSignal;
  onEvent: (event: MirroredEvent) => void;
  onSubmitted?: (assistantMessageId: string) => void;
  pollIntervalMs?: number;
  submitWindowMs?: number;
}): Promise<RemoteTurnOutcome> => {
  const { port, deviceId, sessionId, signal } = options;
  const pollInterval = options.pollIntervalMs ?? 3000;
  signal.throwIfAborted();

  let assistantMessageId: string | undefined;
  let terminal: { status: 'complete' | 'error'; content: string } | undefined;
  let wake: (() => void) | undefined;
  const nudge = () => { const resolve = wake; wake = undefined; resolve?.(); };
  const buffered: MirroredEvent[] = [];
  const deliver = (event: MirroredEvent) => {
    options.onEvent(event);
    if ('messageId' in event && event.messageId === assistantMessageId) {
      if (event.type === 'complete') terminal = { status: 'complete', content: event.content };
      else if (event.type === 'error') terminal = { status: 'error', content: event.error };
      else if (event.type === 'status' && (event.status === 'complete' || event.status === 'error')) {
        // Status events can omit content; let the persisted record decide the text.
        nudge();
        return;
      }
      if (terminal) nudge();
    }
  };
  const unsubscribe = port.subscribe(deviceId, (raw) => {
    if (raw.type === 'interaction-sync' || raw.type === 'device-status') { nudge(); return; }
    if (!MIRRORED_TYPES.has(raw.type) || !('sessionId' in raw) || raw.sessionId !== sessionId) return;
    const { deviceId: _peer, interactionVersion: _version, ...event } = raw;
    if (!assistantMessageId) {
      // Events can arrive before the submit response; keep them in order.
      if (buffered.length < MAX_BUFFERED_EVENTS) buffered.push(event as MirroredEvent);
      return;
    }
    deliver(event as MirroredEvent);
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const onAbort = () => nudge();
  signal.addEventListener('abort', onAbort, { once: true });

  const readPersisted = async (): Promise<ConversationMessage | undefined> => {
    let before: string | undefined;
    for (let index = 0; index < MAX_POLLED_PAGES; index += 1) {
      const page = await port.request<SessionMessagePage>(deviceId, 'getSessionMessagePage', { sessionId, ...(before ? { before } : {}) });
      const found = page.messages.find((message) => message.id === assistantMessageId);
      if (found || !page.hasMoreBefore || !page.nextBefore) return found;
      before = page.nextBefore;
    }
    return undefined;
  };

  try {
    const submitDeadline = Date.now() + (options.submitWindowMs ?? 60000);
    let delay = 1000;
    let submitted: { queued: { assistantMessageId: string } };
    for (;;) {
      signal.throwIfAborted();
      try {
        submitted = await port.request(deviceId, 'sendMessage', {
          sessionId, prompt: options.prompt,
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
        }, options.operationId);
        break;
      } catch (error) {
        if (!isRetryableTransport(error)) throw error;
        if (Date.now() + delay > submitDeadline) {
          throw new Error('执行设备连接中断，未确认该成员任务是否已在设备上开始；未自动重发，请在执行设备上核对。');
        }
        await sleep(delay);
        delay = Math.min(5000, delay * 2);
      }
    }
    assistantMessageId = submitted.queued.assistantMessageId;
    if (!assistantMessageId) throw new Error('执行设备未返回成员回复编号。');
    options.onSubmitted?.(assistantMessageId);
    for (const event of buffered.splice(0)) deliver(event);

    while (!terminal) {
      if (signal.aborted) {
        await port.request(deviceId, 'stopSessionRun', { sessionId }, `${options.operationId}:stop`).catch(() => undefined);
        return { status: 'stopped', assistantMessageId };
      }
      try {
        const persisted = await readPersisted();
        const status = terminalOf(persisted);
        if (status && persisted) { terminal = { status, content: persisted.content }; break; }
      } catch {
        // The device may be offline; it keeps running there. Keep waiting.
      }
      if (!terminal && !signal.aborted) await sleep(pollInterval);
    }
    // Prefer the executor's persisted text when it is available.
    try {
      const persisted = await readPersisted();
      const status = terminalOf(persisted);
      if (status && persisted) terminal = { status, content: persisted.content };
    } catch { /* Keep the streamed terminal result. */ }
    return { ...terminal, assistantMessageId };
  } finally {
    signal.removeEventListener('abort', onAbort);
    unsubscribe();
  }
};
