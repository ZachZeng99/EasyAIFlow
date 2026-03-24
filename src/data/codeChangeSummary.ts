import type { ConversationMessage } from './types.js';

export type CodeChangeSummary = {
  id: string;
  toolTitle: string;
  operationLabel: string;
  filePath: string;
  summary: string;
  details: string;
};

const CHANGE_TOOL_LABELS: Record<string, string> = {
  Edit: 'Edited',
  MultiEdit: 'Edited',
  Write: 'Wrote',
  ApplyPatch: 'Patched',
  apply_patch: 'Patched',
};

const looksLikeFilePath = (value: string) => {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  return (
    /^[A-Za-z]:[\\/]/.test(normalized) ||
    normalized.startsWith('/') ||
    normalized.startsWith('./') ||
    normalized.startsWith('../')
  );
};

const extractFilePath = (content: string) => {
  const trimmed = content.trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { file_path?: unknown };
      if (typeof parsed.file_path === 'string' && looksLikeFilePath(parsed.file_path)) {
        return parsed.file_path;
      }
    } catch {
      // Fall back to line-based parsing.
    }
  }

  return (
    trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line: string) => looksLikeFilePath(line)) ?? ''
  );
};

const compactLine = (value: string) => value.replace(/\s+/g, ' ').trim();

const isBoilerplateResultLine = (line: string) =>
  /^the file(?: .+)? has been (?:updated|written|created|patched) successfully\.?$/i.test(line);

const buildSummary = (message: ConversationMessage, filePath: string) => {
  const meaningfulLines = message.content
    .split(/\r?\n/)
    .map(compactLine)
    .filter(Boolean)
    .filter((line) => line !== filePath)
    .filter((line) => !isBoilerplateResultLine(line));

  const descriptiveLine = meaningfulLines.find((line: string) => !looksLikeFilePath(line));
  if (descriptiveLine) {
    return descriptiveLine;
  }

  const firstDetail = meaningfulLines[0];
  if (firstDetail) {
    return firstDetail;
  }

  return `${CHANGE_TOOL_LABELS[message.title] ?? message.title} ${filePath.split(/[\\/]/).pop() ?? 'file'}`;
};

export const extractCodeChangeSummaries = (messages: ConversationMessage[]) =>
  messages
    .filter(
      (message) =>
        message.role === 'system' &&
        message.kind === 'tool_use' &&
        Boolean(CHANGE_TOOL_LABELS[message.title]),
    )
    .map((message) => {
      const filePath = extractFilePath(message.content);
      if (!filePath) {
        return null;
      }

      return {
        id: message.id,
        toolTitle: message.title,
        operationLabel: CHANGE_TOOL_LABELS[message.title] ?? message.title,
        filePath,
        summary: buildSummary(message, filePath),
        details: message.content.trim(),
      } satisfies CodeChangeSummary;
    })
    .filter((item): item is CodeChangeSummary => Boolean(item));
