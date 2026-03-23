export const shouldIgnoreImportedProgress = (input: {
  dataType?: string;
  hookEvent?: string;
  command?: string;
}) => {
  if (input.dataType !== 'hook_progress') {
    return false;
  }

  if (input.hookEvent === 'SessionStart') {
    return true;
  }

  return false;
};
