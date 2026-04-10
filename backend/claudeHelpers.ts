import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  ConversationMessage,
  ContextReference,
  MessageAttachment,
  PendingAttachment,
  SessionRecord,
  TokenUsage,
} from '../src/data/types.js';
import type { PlanModeRequest } from '../src/data/planMode.js';

const execFileAsync = promisify(execFile);

export const nowLabel = () =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date());

export const buildMessageTitle = (content: string, fallback: string) => {
  const firstLine = content.split(/\r?\n/)[0]?.trim();
  if (!firstLine) {
    return fallback;
  }

  return firstLine.slice(0, 42);
};

export const truncateText = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}\n...[truncated]`;
};

export const compactText = (value: string, maxLength = 220) =>
  truncateText(
    value
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    maxLength,
  );

export const compactMultilineText = (value: string, maxLength = 600) =>
  truncateText(
    value
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line, index, lines) => line || (index > 0 && index < lines.length - 1))
      .join('\n')
      .trim(),
    maxLength,
  );

export const summarizeToolInput = (input: unknown) => {
  if (typeof input === 'string') {
    return input.trim();
  }

  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.command === 'string') {
      return record.command;
    }
    if (typeof record.pattern === 'string') {
      return `pattern: ${record.pattern}`;
    }
    if (typeof record.file_path === 'string') {
      return record.file_path;
    }

    const serialized = JSON.stringify(input, null, 2);
    return serialized === '{}' || serialized === '[]' ? '' : serialized;
  }

  return typeof input === 'undefined' || input === null ? '' : String(input);
};

export const appendTraceContent = (current: string, next: string) => {
  const normalizedCurrent = current.trim();
  const normalizedNext = next.trim();
  if (!normalizedNext) {
    return normalizedCurrent;
  }
  if (!normalizedCurrent) {
    return normalizedNext;
  }
  return `${normalizedCurrent}\n${normalizedNext}`;
};

export const looksLikePlaceholderTrace = (content: string, title: string) => {
  const normalizedContent = content.trim();
  const normalizedTitle = title.trim();
  return !normalizedContent || normalizedContent === normalizedTitle || normalizedContent === `${normalizedTitle}\n${normalizedTitle}`;
};

export const tryParsePartialJsonObject = (value: string) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

export const readNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export const mapTokenUsage = (
  payload: Record<string, unknown>,
  lastAssistantUsage?: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  },
): TokenUsage | undefined => {
  const resultUsage = payload.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  const modelUsage = payload.modelUsage as Record<string, { contextWindow?: number }> | undefined;
  const modelMeta = modelUsage ? Object.values(modelUsage)[0] : undefined;
  const resultPayload =
    payload.result && typeof payload.result === 'object' ? (payload.result as Record<string, unknown>) : undefined;
  const contextWindowData =
    (payload.context_window as Record<string, unknown> | undefined) ??
    (resultPayload?.context_window as Record<string, unknown> | undefined);

  // Per-call usage from the last assistant event gives accurate context utilization.
  // The result event's usage is cumulative across all API calls in the run, which
  // inflates cache_read values in multi-turn agent runs.
  const perCall = lastAssistantUsage;
  const input = perCall?.input_tokens ?? readNumber(contextWindowData?.total_input_tokens) ?? resultUsage?.input_tokens ?? 0;
  const output = resultUsage?.output_tokens ?? readNumber(contextWindowData?.total_output_tokens) ?? 0;
  const cached =
    (perCall?.cache_read_input_tokens ?? resultUsage?.cache_read_input_tokens ?? 0) +
    (perCall?.cache_creation_input_tokens ?? resultUsage?.cache_creation_input_tokens ?? 0);
  const used = input + output + cached;

  const modelContextWindow = readNumber(modelMeta?.contextWindow);
  const explicitContextWindow =
    readNumber(contextWindowData?.max_tokens) ??
    readNumber(contextWindowData?.max_input_tokens) ??
    readNumber(contextWindowData?.window_size) ??
    readNumber(contextWindowData?.context_window) ??
    readNumber(contextWindowData?.total_tokens);
  const rawUsedPercentage = readNumber(contextWindowData?.used_percentage);
  const usedPercentage =
    rawUsedPercentage !== undefined
      ? Math.max(0, Math.min(100, rawUsedPercentage <= 1 ? rawUsedPercentage * 100 : rawUsedPercentage))
      : undefined;

  const hasContextMetadata =
    contextWindowData !== undefined ||
    modelContextWindow !== undefined ||
    explicitContextWindow !== undefined ||
    usedPercentage !== undefined;

  if (!hasContextMetadata) {
    return undefined;
  }

  let contextWindow = explicitContextWindow ?? modelContextWindow ?? 0;
  let windowSource: TokenUsage['windowSource'] = contextWindow > 0 ? 'runtime' : 'unknown';

  if (contextWindow === 0 && usedPercentage && used > 0) {
    contextWindow = Math.round(used / (usedPercentage / 100));
    windowSource = contextWindow > 0 ? 'derived' : 'unknown';
  }
  return {
    contextWindow,
    used,
    input,
    output,
    cached,
    usedPercentage,
    windowSource,
  };
};

export const extensionFromMime = (mimeType: string) => {
  if (mimeType === 'image/png') {
    return '.png';
  }
  if (mimeType === 'image/jpeg') {
    return '.jpg';
  }
  if (mimeType === 'image/webp') {
    return '.webp';
  }
  if (mimeType === 'image/gif') {
    return '.gif';
  }
  return '.bin';
};

export const sanitizeAttachmentName = (value: string) => {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim();
  return sanitized || 'attachment';
};

import path from 'node:path';

export const buildAttachmentFileName = (attachment: PendingAttachment) => {
  const preferredName = sanitizeAttachmentName(path.basename(attachment.name || 'attachment'));
  const hasExtension = path.extname(preferredName).length > 0;
  const safeName = hasExtension ? preferredName : `${preferredName}${extensionFromMime(attachment.mimeType)}`;
  return `${Date.now()}-${attachment.id}-${safeName}`;
};

export const parseGitBranchLine = (line: string) => {
  const normalized = line.replace(/^##\s*/, '').trim();
  const branchPart = normalized.split(' [')[0] ?? normalized;
  const [branch, tracking] = branchPart.split('...');
  const aheadMatch = normalized.match(/ahead (\d+)/);
  const behindMatch = normalized.match(/behind (\d+)/);

  return {
    branch: branch?.trim() || 'unknown',
    tracking: tracking?.trim(),
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
};

export const parseGitStatusCode = (rawCode: string) => {
  const code = rawCode.trim();
  if (code === '??') {
    return '??';
  }
  if (code.includes('A')) {
    return 'A';
  }
  if (code.includes('D')) {
    return 'D';
  }
  if (code.includes('R')) {
    return 'R';
  }
  return 'M';
};

export const isWritableStdin = (child: { killed: boolean; stdin: { destroyed: boolean; writableEnded: boolean } | null }) => {
  const stdin = child.stdin;
  return Boolean(stdin && !child.killed && !stdin.destroyed && !stdin.writableEnded);
};

export const isAutoApprovableEditRequest = (request: { toolName: string; command?: string }) => {
  const toolName = request.toolName.trim().toLowerCase();
  if (toolName === 'write' || toolName === 'edit' || toolName === 'multiedit') {
    return true;
  }

  if (toolName !== 'bash') {
    return false;
  }

  const command = request.command?.trim() ?? '';
  return /^(mkdir|md|touch|cp|copy|mv|move|ren|rename|rm|del|erase|new-item|copy-item|move-item|remove-item)\b/i.test(
    command,
  );
};

export const getConversationMessages = (session: SessionRecord) =>
  (session.messages ?? []).filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') && Boolean(message.content.trim()),
  );

export const buildSessionSummaryContext = (session: SessionRecord) => {
  const messages = getConversationMessages(session);
  const firstUser = messages.find((message) => message.role === 'user');
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const userCount = messages.filter((message) => message.role === 'user').length;
  const assistantCount = messages.filter((message) => message.role === 'assistant').length;
  const recentExcerpts = messages
    .slice(-4)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${compactText(message.content, 140)}`);

  return [
    `Session: ${session.title}`,
    `Session ID: ${session.id}`,
    `Project: ${session.projectName}`,
    `Streamwork: ${session.dreamName}`,
    session.harness ? `Harness role: ${session.harness.role}` : '',
    `Updated: ${session.timeLabel}`,
    `Model: ${session.model}`,
    `Messages: ${userCount} user / ${assistantCount} assistant`,
    latestAssistant ? `Final assistant conclusion:\n${compactMultilineText(latestAssistant.content, 900)}` : '',
    latestUser ? `Latest user intent: ${compactText(latestUser.content, 260)}` : '',
    firstUser ? `Initial ask: ${compactText(firstUser.content)}` : '',
    recentExcerpts.length > 0 ? `Recent excerpts:\n${recentExcerpts.map((item) => `- ${item}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

export const buildSessionTranscriptContext = (session: SessionRecord) => {
  const transcript = getConversationMessages(session)
    .map(
      (message) =>
        `[${message.role.toUpperCase()} | ${message.timestamp}${message.title ? ` | ${message.title}` : ''}]\n${message.content.trim()}`,
    )
    .join('\n\n');

  return truncateText(
    [
      `Session: ${session.title}`,
      `Session ID: ${session.id}`,
      `Project: ${session.projectName}`,
      `Streamwork: ${session.dreamName}`,
      'Transcript:',
      transcript || 'No user or assistant messages were recorded.',
    ].join('\n'),
    16000,
  );
};

export const buildPromptWithAttachments = (
  prompt: string,
  attachments: MessageAttachment[],
  referenceContext?: string,
  instructionPrompt?: string,
) => {
  const trimmedPrompt = prompt.trim();
  // Claude slash commands must be sent as the raw prompt token. If we prepend
  // host notes or injected context, Claude treats them as normal text instead
  // of dispatching the slash command.
  if (/^\/\S+/.test(trimmedPrompt)) {
    return trimmedPrompt;
  }

  const parts: string[] = [];

  if (instructionPrompt?.trim()) {
    parts.push(instructionPrompt.trim());
  }

  if (referenceContext?.trim()) {
    parts.push(referenceContext.trim());
  }

  parts.push(prompt);

  if (attachments.length > 0) {
    const lines = attachments.map(
      (attachment) => `- ${attachment.path} (${attachment.mimeType || 'application/octet-stream'}, ${attachment.size} bytes)`,
    );
    parts.push(
      `Attached local files:\n${lines.join('\n')}\n\nPlease inspect these local files if they are relevant to the request.`,
    );
  }

  return parts.join('\n\n');
};

export const cloneMessageContextReferences = (references: ContextReference[] | undefined) =>
  (references ?? []).map((reference) => ({
    ...reference,
  }));

export const hydratePlanModeRequest = async (request: PlanModeRequest): Promise<PlanModeRequest> => {
  if (request.plan || !request.planFilePath) {
    return request;
  }

  try {
    const plan = (await readFile(request.planFilePath, 'utf8')).trim();
    return plan ? { ...request, plan } : request;
  } catch {
    return request;
  }
};

export const getGitSnapshot = async (cwd: string) => {
  try {
    const [{ stdout: statusStdout }, { stdout: rootStdout }] = await Promise.all([
      execFileAsync('git', ['status', '--short', '--branch', '--untracked-files=all'], { cwd }),
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd }),
    ]);

    const lines = statusStdout.split(/\r?\n/).filter(Boolean);
    const branchMeta = parseGitBranchLine(lines[0] ?? '## unknown');
    const files = lines.slice(1).map((line) => {
      const statusCode = line.slice(0, 2);
      const filePath = line.slice(3).trim();

      return {
        path: filePath,
        status: parseGitStatusCode(statusCode),
        additions: 0,
        deletions: 0,
      };
    });

    return {
      ...branchMeta,
      dirty: files.length > 0,
      changedFiles: files,
      rootPath: rootStdout.trim(),
      source: 'git' as const,
    };
  } catch {
    return null;
  }
};
