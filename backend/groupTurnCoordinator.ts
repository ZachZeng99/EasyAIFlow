import { createSessionRunQueue, enqueueSessionRun } from '../electron/sessionRunQueue.js';

/** Dispatch order is separate from execution: idle members can run while another is busy. */
export class GroupTurnCoordinator {
  private readonly dispatchQueue = createSessionRunQueue();
  private readonly memberQueue = createSessionRunQueue();
  private readonly turns = new Map<string, Set<AbortController>>();
  private readonly completions = new WeakMap<AbortController, Promise<void>>();

  async dispatch<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const slot = enqueueSessionRun(this.dispatchQueue, roomId);
    await slot.whenReady;
    try { return await operation(); }
    finally { slot.release(); }
  }

  begin(roomId: string): { signal: AbortSignal; finish: () => void } {
    const controller = new AbortController();
    const roomTurns = this.turns.get(roomId) ?? new Set<AbortController>();
    roomTurns.add(controller);
    this.turns.set(roomId, roomTurns);
    let resolve!: () => void;
    this.completions.set(controller, new Promise<void>((done) => { resolve = done; }));
    return {
      signal: controller.signal,
      finish: () => {
        roomTurns.delete(controller);
        if (!roomTurns.size && this.turns.get(roomId) === roomTurns) this.turns.delete(roomId);
        resolve();
      },
    };
  }

  async runMember(memberId: string, signal: AbortSignal, operation: () => Promise<void>) {
    const slot = enqueueSessionRun(this.memberQueue, memberId);
    await slot.whenReady;
    try {
      if (!signal.aborted) await operation();
    } finally { slot.release(); }
  }

  cancel(roomId: string) {
    const turns = [...(this.turns.get(roomId) ?? [])];
    turns.forEach((controller) => controller.abort());
    return Promise.all(turns.map((controller) => this.completions.get(controller)));
  }

  hasWork(roomId?: string) {
    return roomId ? Boolean(this.turns.get(roomId)?.size) : this.turns.size > 0;
  }

  pendingCounts(): Array<[string, number]> {
    return [...this.turns].map(([roomId, turns]) => [roomId, turns.size]);
  }
}
