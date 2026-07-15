type ClaudePrintArgOptions = {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  sessionArgs?: string[];
  tools?: string;
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan' | 'auto';
  noSessionPersistence?: boolean;
};

export const DEFAULT_CLAUDE_EFFORT: NonNullable<ClaudePrintArgOptions['effort']> = 'max';

export const buildClaudePrintArgs = ({
  model,
  effort = DEFAULT_CLAUDE_EFFORT,
  sessionArgs = [],
  tools,
  permissionMode = 'bypassPermissions',
  noSessionPersistence = false,
}: ClaudePrintArgOptions) => {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    // Stream partial assistant/tool chunks as they are generated so the UI can
    // render live intermediate output (text deltas + tool input/result detail)
    // instead of only updating at message boundaries. Removing this flag (commit
    // 2db7036) silently disabled all `stream_event`/`delta` output, leaving the
    // delta-handling path dead and making live updates appear "stuck". The
    // thinking-block resume issue that motivated its removal is handled
    // separately by detachThinkingBlockMutationClaudeConversation(); this flag
    // only affects stdout streaming, not the native transcript used for resume.
    '--include-partial-messages',
    '--permission-mode',
    permissionMode,
    '--permission-prompt-tool',
    'stdio',
    '--verbose',
  ];

  if (model) {
    args.push('--model', model);
  }

  if (effort) {
    args.push('--effort', effort);
  }

  if (tools !== undefined) {
    args.push('--tools', tools);
  }

  if (noSessionPersistence) {
    args.push('--no-session-persistence');
  }

  args.push(...sessionArgs);
  return args;
};
