export const isBackgroundTaskNotificationContent = (content: string) => {
  const normalized = content.trim();
  return normalized.includes('<task-notification>') && normalized.includes('<task-id>');
};
