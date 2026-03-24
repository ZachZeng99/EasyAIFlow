type ClaudePrintArgOptions = {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  sessionArgs?: string[];
};

export const buildClaudePrintArgs = ({ model, effort, sessionArgs = [] }: ClaudePrintArgOptions) => {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    'default',
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

  args.push(...sessionArgs);
  return args;
};
