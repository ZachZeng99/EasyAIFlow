import assert from 'node:assert/strict';
import { InteractionReconciler } from '../src/data/interactionSync.ts';
import type { ClaudeStreamEvent, InteractionSnapshot } from '../src/data/types.ts';
import type { SessionInteractionState } from '../src/data/sessionInteraction.ts';

const version = (sequence: number, epoch = 'worker-a') => ({ epoch, sequence });
const snapshot = (sequence: number, interactions: Record<string, SessionInteractionState> = {}, epoch = 'worker-a'): InteractionSnapshot => ({ version: version(sequence, epoch), interactions });
const question: SessionInteractionState = { askUserQuestion: { sessionId: 'session', toolUseId: 'question', questions: [] }, runtime: { processActive: true, phase: 'awaiting_reply' } };
const runtime = (sequence: number, phase: 'running' | 'idle', epoch = 'worker-a'): ClaudeStreamEvent => ({ type: 'runtime-state', sessionId: 'session', runtime: { processActive: true, phase }, interactionVersion: version(sequence, epoch) });
const resolved = (sequence: number): ClaudeStreamEvent => ({ type: 'interaction-resolved', sessionId: 'session', requestId: 'question', interaction: 'ask', interactionVersion: version(sequence) });
const run = (name: string, fn: () => void) => { fn(); console.log(`PASS ${name}`); };
const harness = (limits?: { events: number; bytes: number }) => {
  const sync = new InteractionReconciler(limits);
  let state = new Map<string, SessionInteractionState>();
  const apply = (result: ReturnType<InteractionReconciler['snapshot']>) => {
    if (result.apply) state = result.apply(state);
    return result;
  };
  return { sync, apply, get state() { return state; }, event: (event: ClaudeStreamEvent) => apply(sync.event(event)), snapshot: (value: InteractionSnapshot, connection?: boolean) => apply(sync.snapshot(value, connection)) };
};

run('a delayed snapshot cannot reopen a question already answered on another client', () => {
  const h = harness();
  h.snapshot(snapshot(1, { session: question }));
  h.event(resolved(3));
  h.snapshot(snapshot(2, { session: question }));
  assert.equal(h.state.get('session')?.askUserQuestion, undefined);
  assert.equal(h.state.get('session')?.runtime?.phase, 'running');
});

run('an initial snapshot restores older fields while retaining newer partial events', () => {
  const h = harness();
  h.event(runtime(4, 'idle'));
  h.snapshot(snapshot(2, { session: question }));
  assert.equal(h.state.get('session')?.askUserQuestion?.toolUseId, 'question');
  assert.equal(h.state.get('session')?.runtime?.phase, 'idle');
});

run('duplicate and reversed live events cannot regress runtime state', () => {
  const h = harness();
  h.snapshot(snapshot(1));
  h.event(runtime(3, 'idle'));
  h.event(runtime(2, 'running'));
  h.event(runtime(3, 'running'));
  assert.equal(h.state.get('session')?.runtime?.phase, 'idle');
});

run('a service restart clears old dialogs and rejects delayed responses from the old epoch', () => {
  const h = harness();
  h.snapshot(snapshot(8, { session: question }));
  h.event(runtime(1, 'idle', 'worker-b'));
  h.snapshot(snapshot(9, { session: question }));
  h.event(resolved(10));
  assert.equal(h.state.get('session')?.askUserQuestion, undefined);
  assert.equal(h.state.get('session')?.runtime?.phase, 'idle');
  h.snapshot(snapshot(2, {}, 'worker-b'), true);
  assert.equal(h.state.size, 0);
});

run('unordered RPC snapshots cannot replace an established service epoch', () => {
  const h = harness();
  h.event(runtime(5, 'idle', 'worker-b'));
  h.snapshot(snapshot(100, { session: question }, 'worker-a'));
  assert.equal(h.state.get('session')?.askUserQuestion, undefined);
  assert.equal(h.state.get('session')?.runtime?.phase, 'idle');
});

run('older snapshots cannot reintroduce sessions removed by a newer complete snapshot', () => {
  const h = harness();
  h.snapshot(snapshot(5));
  h.snapshot(snapshot(3, { session: question }));
  assert.equal(h.state.size, 0);
});

run('bounded buffer overflow requests a fresh snapshot instead of applying incomplete recovery', () => {
  const h = harness({ events: 2, bytes: 100000 });
  h.snapshot(snapshot(0));
  h.event(runtime(1, 'running'));
  h.event(resolved(2));
  assert.equal(h.event(runtime(3, 'idle')).needsSnapshot, true);
  assert.equal(h.snapshot(snapshot(0, { session: question })).needsSnapshot, true);
  assert.equal(h.state.get('session')?.runtime?.phase, 'idle');
  assert.equal(h.snapshot(snapshot(4, {})).needsSnapshot, false);
  assert.equal(h.state.size, 0);
});

run('byte limits also bound a single oversized interaction event', () => {
  const h = harness({ events: 10, bytes: 1 });
  assert.equal(h.event(runtime(2, 'idle')).needsSnapshot, true);
  assert.equal(h.snapshot(snapshot(1)).needsSnapshot, true);
  assert.equal(h.snapshot(snapshot(3)).needsSnapshot, false);
});

run('multiple permissions are queued without duplicating the same request', () => {
  const h = harness();
  h.snapshot(snapshot(0));
  const permission = (sequence: number, requestId: string): ClaudeStreamEvent => ({ type: 'permission-request', sessionId: 'room', sourceSessionId: 'member', requestId, toolName: 'Write', targetPath: 'example.txt', sensitive: false, interactionVersion: version(sequence) });
  h.event(permission(1, 'first'));
  h.event(permission(2, 'second'));
  h.event(permission(3, 'second'));
  assert.equal(h.state.get('room')?.permission?.requestId, 'first');
  assert.deepEqual(h.state.get('member')?.pendingPermissions?.map((entry) => entry.requestId), ['second']);
});

run('reconciliation updaters are pure under React double invocation', () => {
  const sync = new InteractionReconciler();
  const initial = new Map<string, SessionInteractionState>([['session', { ...question, isSubmittingAskUserQuestion: true }]]);
  const update = sync.snapshot(snapshot(1, { session: question })).apply!;
  assert.deepEqual(update(initial), update(initial));
  assert.equal(initial.get('session')?.isSubmittingAskUserQuestion, true);
  assert.equal(update(initial).get('session')?.isSubmittingAskUserQuestion, true);
});
