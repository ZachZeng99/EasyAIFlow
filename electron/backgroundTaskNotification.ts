export const isBackgroundTaskNotificationContent = (content: string) => {
  const normalized = content.trim();
  return normalized.includes('<task-notification>') && normalized.includes('<task-id>');
};

const extractTextBlocks = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((block) => {
    if (typeof block === 'string') {
      return [block];
    }

    if (!block || typeof block !== 'object') {
      return [];
    }

    const typedBlock = block as { type?: string; text?: unknown };
    return typedBlock.type === 'text' && typeof typedBlock.text === 'string' ? [typedBlock.text] : [];
  });
};

export const extractBackgroundTaskNotificationContent = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as {
    type?: string;
    isMeta?: boolean;
    content?: unknown;
    message?: { content?: unknown };
  };

  const candidates =
    record.type === 'queue-operation'
      ? extractTextBlocks(record.content)
      : record.type === 'user' && record.isMeta !== true
        ? extractTextBlocks(record.message?.content)
        : [];

  return candidates.find((candidate) => isBackgroundTaskNotificationContent(candidate)) ?? null;
};
