type JsonRecord = Record<string, unknown>;

type PromptTaskState = {
  createdTaskIds: Set<string>;
  taskStatuses: Map<string, string>;
  backgroundTaskIds: Set<string>;
};

const asRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const asNonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const getPromptTaskState = (
  prompts: Map<string, PromptTaskState>,
  promptId: string,
) => {
  const existing = prompts.get(promptId);
  if (existing) {
    return existing;
  }

  const created: PromptTaskState = {
    createdTaskIds: new Set(),
    taskStatuses: new Map(),
    backgroundTaskIds: new Set(),
  };
  prompts.set(promptId, created);
  return created;
};

export const createClaudeTaskListCompletionTracker = (
  requestedBackgroundTaskIds?: Iterable<string>,
) => {
  const requestedTaskIds = new Set(
    [...(requestedBackgroundTaskIds ?? [])]
      .map((taskId) => taskId.trim())
      .filter(Boolean),
  );
  const prompts = new Map<string, PromptTaskState>();

  return {
    consume(value: unknown) {
      const record = asRecord(value);
      const promptId = asNonEmptyString(record?.promptId);
      const toolUseResult = asRecord(record?.toolUseResult);
      if (!promptId || !toolUseResult) {
        return;
      }

      const prompt = getPromptTaskState(prompts, promptId);
      const createdTaskId = asNonEmptyString(asRecord(toolUseResult.task)?.id);
      if (createdTaskId) {
        prompt.createdTaskIds.add(createdTaskId);
        if (!prompt.taskStatuses.has(createdTaskId)) {
          prompt.taskStatuses.set(createdTaskId, 'pending');
        }
      }

      if (toolUseResult.success !== false) {
        const updatedTaskId = asNonEmptyString(toolUseResult.taskId);
        const updatedStatus = asNonEmptyString(asRecord(toolUseResult.statusChange)?.to);
        if (updatedTaskId && updatedStatus) {
          prompt.taskStatuses.set(updatedTaskId, updatedStatus);
        }
      }

      const backgroundTaskId = asNonEmptyString(toolUseResult.backgroundTaskId);
      if (
        backgroundTaskId &&
        (requestedTaskIds.size === 0 || requestedTaskIds.has(backgroundTaskId))
      ) {
        prompt.backgroundTaskIds.add(backgroundTaskId);
      }
    },

    getDetachedBackgroundTaskIds() {
      const detachedTaskIds = new Set<string>();
      prompts.forEach((prompt) => {
        if (
          prompt.backgroundTaskIds.size === 0 ||
          prompt.createdTaskIds.size === 0 ||
          ![...prompt.createdTaskIds].every(
            (taskId) => prompt.taskStatuses.get(taskId) === 'completed',
          )
        ) {
          return;
        }

        prompt.backgroundTaskIds.forEach((taskId) => detachedTaskIds.add(taskId));
      });
      return detachedTaskIds;
    },
  };
};
