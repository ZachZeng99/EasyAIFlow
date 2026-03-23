export const deriveImportedSessionSummary = (input: {
  customTitle?: string;
  firstUserText?: string;
  lastAssistantText?: string;
  lastErrorText?: string;
  interrupted?: boolean;
  nativeSessionId: string;
}) => {
  const customTitle = input.customTitle?.trim() ?? '';
  const firstUserText = input.firstUserText?.trim() ?? '';
  const lastAssistantText = input.lastAssistantText?.trim() ?? '';
  const lastErrorText = input.lastErrorText?.trim() ?? '';
  const interrupted = Boolean(input.interrupted);

  if (customTitle) {
    return {
      title: customTitle.trim(),
      preview: (lastAssistantText || firstUserText || lastErrorText || 'Imported Claude history.').trim(),
    };
  }

  if (!lastAssistantText && lastErrorText) {
    return {
      title: lastErrorText.slice(0, 42).trim(),
      preview: (firstUserText || lastErrorText).trim(),
    };
  }

  if (!lastAssistantText && interrupted) {
    return {
      title: 'Interrupted request',
      preview: (firstUserText || 'Request interrupted by user.').trim(),
    };
  }

  return {
    title: (firstUserText ? firstUserText.slice(0, 42) : `Imported ${input.nativeSessionId.slice(0, 8)}`).trim(),
    preview: (lastAssistantText || firstUserText || 'Imported Claude history.').trim(),
  };
};
