import type {
  BackgroundTaskRecord,
  BackgroundTaskStatus,
  BackgroundTaskUsage,
} from '../src/data/types.js';

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

const getString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const getNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const normalizeBackgroundTaskStatus = (
  value: unknown,
): BackgroundTaskStatus | undefined => {
  switch (value) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
    case 'stopped':
      return value;
    case 'killed':
      return 'stopped';
    default:
      return undefined;
  }
};

const parseBackgroundTaskUsage = (
  value: unknown,
): BackgroundTaskUsage | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const usage = value as {
    total_tokens?: unknown;
    tool_uses?: unknown;
    duration_ms?: unknown;
  };

  const totalTokens = getNumber(usage.total_tokens);
  const toolUses = getNumber(usage.tool_uses);
  const durationMs = getNumber(usage.duration_ms);
  if (
    totalTokens === undefined ||
    toolUses === undefined ||
    durationMs === undefined
  ) {
    return undefined;
  }

  return {
    totalTokens,
    toolUses,
    durationMs,
  };
};

const readXmlTag = (content: string, tag: string) => {
  const match = content.match(
    new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  return match?.[1]?.trim();
};

export const parseBackgroundTaskNotificationContent = (
  content: string,
): BackgroundTaskRecord | null => {
  if (!isBackgroundTaskNotificationContent(content)) {
    return null;
  }

  const taskId = readXmlTag(content, 'task-id');
  if (!taskId) {
    return null;
  }

  const usageXml = readXmlTag(content, 'usage');
  const usage =
    usageXml
      ? parseBackgroundTaskUsage({
          total_tokens: Number(readXmlTag(usageXml, 'total_tokens')),
          tool_uses: Number(readXmlTag(usageXml, 'tool_uses')),
          duration_ms: Number(readXmlTag(usageXml, 'duration_ms')),
        })
      : undefined;
  const summary = readXmlTag(content, 'summary');

  return {
    taskId,
    status: normalizeBackgroundTaskStatus(readXmlTag(content, 'status')) ?? 'running',
    description: summary ?? `Background task ${taskId}`,
    toolUseId: readXmlTag(content, 'tool-use-id'),
    taskType: readXmlTag(content, 'task-type'),
    outputFile: readXmlTag(content, 'output-file'),
    summary,
    usage,
    updatedAt: Date.now(),
  };
};

export const parseClaudeBackgroundTaskEvent = (
  payload: unknown,
): BackgroundTaskRecord | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as {
    type?: string;
    subtype?: string;
    task_id?: unknown;
    tool_use_id?: unknown;
    description?: unknown;
    task_type?: unknown;
    workflow_name?: unknown;
    prompt?: unknown;
    output_file?: unknown;
    summary?: unknown;
    last_tool_name?: unknown;
    status?: unknown;
    usage?: unknown;
  };

  if (record.type === 'system') {
    const taskId = getString(record.task_id);
    if (!taskId) {
      return null;
    }

    if (record.subtype === 'task_started') {
      return {
        taskId,
        status: 'running',
        description: getString(record.description) ?? `Background task ${taskId}`,
        toolUseId: getString(record.tool_use_id),
        taskType: getString(record.task_type),
        workflowName: getString(record.workflow_name),
        prompt: getString(record.prompt),
        updatedAt: Date.now(),
      };
    }

    if (record.subtype === 'task_progress') {
      return {
        taskId,
        status: 'running',
        description: getString(record.description) ?? `Background task ${taskId}`,
        toolUseId: getString(record.tool_use_id),
        usage: parseBackgroundTaskUsage(record.usage),
        lastToolName: getString(record.last_tool_name),
        summary: getString(record.summary),
        updatedAt: Date.now(),
      };
    }

    if (record.subtype === 'task_notification') {
      const summary = getString(record.summary);
      return {
        taskId,
        status: normalizeBackgroundTaskStatus(record.status) ?? 'completed',
        description: summary ?? getString(record.description) ?? `Background task ${taskId}`,
        toolUseId: getString(record.tool_use_id),
        outputFile: getString(record.output_file),
        summary,
        usage: parseBackgroundTaskUsage(record.usage),
        updatedAt: Date.now(),
      };
    }
  }

  const embeddedNotification = extractBackgroundTaskNotificationContent(payload);
  return embeddedNotification
    ? parseBackgroundTaskNotificationContent(embeddedNotification)
    : null;
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
