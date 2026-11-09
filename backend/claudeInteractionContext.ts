import type { ClaudeStreamEvent } from '../src/data/types.js';
import type { RemoteExecutionPort } from './remoteExecution.js';

export type ClaudeInteractionContext = {
  broadcastEvent: (event: ClaudeStreamEvent) => void;
  attachmentRoot: () => string;
  claudeSettingsPath: () => string;
  homePath: () => string;
  /** Present only inside a device service that owns paired peers. */
  remote?: RemoteExecutionPort;
};
