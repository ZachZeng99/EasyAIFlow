import type { DeviceDescriptor } from '../src/data/devices.js';
import type { ClaudeStreamEvent } from '../src/data/types.js';

/**
 * Narrow access from a coordinating device runtime to its own paired peers.
 * Requests reuse the paired-device route and its operation IDs; events are the
 * peer's own (non-transitive) stream as received by this device service.
 */
export type RemoteExecutionPort = {
  request: <T>(deviceId: string, method: string, payload?: unknown, operationId?: string) => Promise<T>;
  subscribe: (deviceId: string, listener: (event: ClaudeStreamEvent) => void) => () => void;
  describe: (deviceId: string) => DeviceDescriptor | undefined;
};

/** Fan out peer events to group turns without exposing the router itself. */
export const createRemoteEventHub = () => {
  const listeners = new Map<string, Set<(event: ClaudeStreamEvent) => void>>();
  return {
    publish: (event: ClaudeStreamEvent) => {
      if (!event.deviceId) return;
      for (const listener of listeners.get(event.deviceId) ?? []) {
        try { listener(event); } catch (error) { console.error('[REMOTE_EXECUTION] Event listener failed', error); }
      }
    },
    subscribe: (deviceId: string, listener: (event: ClaudeStreamEvent) => void) => {
      let set = listeners.get(deviceId);
      if (!set) { set = new Set(); listeners.set(deviceId, set); }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0 && listeners.get(deviceId) === set) listeners.delete(deviceId);
      };
    },
  };
};
