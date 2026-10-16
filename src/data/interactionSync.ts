import type { ClaudeStreamEvent, InteractionSnapshot, InteractionVersion } from './types.js';
import {
  enqueueSessionPermissionRequest,
  resolveAskUserQuestionState,
  setSessionRuntimeState,
  upsertSessionBackgroundTask,
  type SessionInteractionState,
} from './sessionInteraction.js';

type InteractionEvent = Extract<ClaudeStreamEvent, {
  type: 'permission-request' | 'ask-user-question' | 'plan-mode-request' | 'interaction-resolved' | 'background-task' | 'runtime-state';
}>;
type InteractionMap = Map<string, SessionInteractionState>;
type Reconciliation = { apply?: (current: InteractionMap) => InteractionMap; needsSnapshot: boolean };

export const isInteractionEvent = (event: ClaudeStreamEvent): event is InteractionEvent =>
  ['permission-request', 'ask-user-question', 'plan-mode-request', 'interaction-resolved', 'background-task', 'runtime-state'].includes(event.type);

export const applyInteractionEvent = (current: InteractionMap, event: InteractionEvent): InteractionMap => {
  if (event.type === 'interaction-resolved') {
    return new Map([...current].map(([id, state]) => [id, resolveAskUserQuestionState(state, event.requestId)]));
  }
  const next = new Map(current);
  const ids = new Set([event.sessionId, event.sourceSessionId ?? event.sessionId]);
  for (const id of ids) {
    const state = next.get(id) ?? {};
    switch (event.type) {
      case 'permission-request':
        next.set(id, enqueueSessionPermissionRequest(state, {
          path: event.targetPath ?? event.command ?? event.description ?? event.toolName,
          sensitive: event.sensitive,
          requestId: event.requestId,
          sessionId: event.sourceSessionId ?? event.sessionId,
        }));
        break;
      case 'ask-user-question':
        next.set(id, { ...state, askUserQuestion: {
          sessionId: event.sourceSessionId ?? event.sessionId,
          toolUseId: event.toolUseId, questions: event.questions,
        }, isSubmittingAskUserQuestion: false });
        break;
      case 'plan-mode-request':
        next.set(id, { ...state, planModeRequest: { sessionId: event.sourceSessionId ?? event.sessionId, request: event.request } });
        break;
      case 'background-task': next.set(id, upsertSessionBackgroundTask(state, event.task)); break;
      case 'runtime-state': next.set(id, setSessionRuntimeState(state, event.runtime)); break;
    }
  }
  return next;
};

const preserveSubmissionFlags = (current: InteractionMap, next: InteractionMap) => {
  for (const [id, value] of next) {
    const previous = current.get(id);
    if (!previous) continue;
    next.set(id, {
      ...value,
      isSubmittingAskUserQuestion: value.askUserQuestion && value.askUserQuestion.toolUseId === previous.askUserQuestion?.toolUseId
        ? previous.isSubmittingAskUserQuestion : false,
      isSubmittingPlanMode: value.planModeRequest && value.planModeRequest.request.toolUseId === previous.planModeRequest?.request.toolUseId
        ? previous.isSubmittingPlanMode : false,
      isGrantingPermission: value.permission && value.permission.requestId === previous.permission?.requestId
        ? previous.isGrantingPermission : false,
    });
  }
  return next;
};

/** Full snapshots can arrive after newer partial events. Replay only a bounded tail. */
export class InteractionReconciler {
  private epoch: string | undefined;
  private readonly retiredEpochs = new Set<string>();
  private baseSequence = -1;
  private highSequence = -1;
  private discardedThrough = -1;
  private tail: Array<{ event: InteractionEvent; bytes: number }> = [];
  private tailBytes = 0;

  constructor(private readonly limits = { events: 512, bytes: 2 * 1024 * 1024 }) {}

  get usesVersions() { return Boolean(this.epoch); }

  private selectEpoch(version: InteractionVersion, allowNewEpoch: boolean) {
    if (this.epoch === version.epoch) return 'same';
    if (this.retiredEpochs.has(version.epoch) || (this.epoch && !allowNewEpoch)) return 'ignore';
    if (this.epoch) this.retiredEpochs.add(this.epoch);
    while (this.retiredEpochs.size > 16) this.retiredEpochs.delete(this.retiredEpochs.values().next().value!);
    this.epoch = version.epoch;
    this.baseSequence = this.highSequence = this.discardedThrough = -1;
    this.tail = [];
    this.tailBytes = 0;
    return 'reset';
  }

  event(event: ClaudeStreamEvent): Reconciliation {
    if (!isInteractionEvent(event)) return { needsSnapshot: false };
    const version = event.interactionVersion;
    if (!version) return this.epoch ? { needsSnapshot: false } : { apply: (current) => applyInteractionEvent(current, event), needsSnapshot: false };
    const selection = this.selectEpoch(version, true);
    if (selection === 'ignore' || version.sequence <= this.highSequence) return { needsSnapshot: false };
    this.highSequence = version.sequence;
    const bytes = JSON.stringify(event).length * 2;
    this.tail.push({ event, bytes });
    this.tailBytes += bytes;
    while (this.tail.length > this.limits.events || this.tailBytes > this.limits.bytes) {
      const removed = this.tail.shift()!;
      this.tailBytes -= removed.bytes;
      this.discardedThrough = removed.event.interactionVersion!.sequence;
    }
    return {
      apply: (current) => applyInteractionEvent(selection === 'reset' ? new Map() : current, event),
      needsSnapshot: selection === 'reset' || this.discardedThrough > this.baseSequence,
    };
  }

  snapshot(snapshot: InteractionSnapshot, fromConnection = false): Reconciliation {
    const selection = this.selectEpoch(snapshot.version, fromConnection);
    if (selection === 'ignore' || snapshot.version.sequence < this.baseSequence) return { needsSnapshot: false };
    if (snapshot.version.sequence < this.discardedThrough) return { needsSnapshot: true };
    const sequence = snapshot.version.sequence;
    this.baseSequence = sequence;
    this.highSequence = Math.max(this.highSequence, sequence);
    this.discardedThrough = sequence;
    this.tail = this.tail.filter(({ event }) => event.interactionVersion!.sequence > sequence);
    this.tailBytes = this.tail.reduce((bytes, entry) => bytes + entry.bytes, 0);
    const replay = this.tail.map(({ event }) => event);
    return {
      apply: (current) => {
        const restored = replay.reduce(applyInteractionEvent, new Map(Object.entries(snapshot.interactions)));
        return preserveSubmissionFlags(current, restored);
      },
      needsSnapshot: false,
    };
  }
}
