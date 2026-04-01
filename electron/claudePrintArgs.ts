type ClaudePrintArgOptions = {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  sessionArgs?: string[];
  tools?: string;
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan' | 'auto';
  noSessionPersistence?: boolean;
};

export const buildClaudePrintArgs = ({
  model,
  effort,
  sessionArgs = [],
  tools,
  permissionMode = 'default',
  noSessionPersistence = false,
}: ClaudePrintArgOptions) => {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
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
