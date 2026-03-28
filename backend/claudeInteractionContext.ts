import type { ClaudeStreamEvent } from '../src/data/types.js';

export type ClaudeInteractionContext = {
  broadcastEvent: (event: ClaudeStreamEvent) => void;
  attachmentRoot: () => string;
  claudeSettingsPath: () => string;
  homePath: () => string;
};
