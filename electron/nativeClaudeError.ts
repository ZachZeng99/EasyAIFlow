import { readFile } from 'node:fs/promises';
import path from 'node:path';

const toNativeClaudeProjectDir = (cwd: string) => {
  const normalized = cwd.replace(/\//g, '\\').replace(/\\+$/, '');
  const match = normalized.match(/^([A-Za-z]):\\?(.*)$/);
  if (!match) {
    return null;
  }

  const drive = match[1];
  const rest = match[2]
    .split('\\')
    .filter(Boolean)
    .join('-');
  return rest ? `${drive}--${rest}` : `${drive}--`;
};

export const extractLatestSyntheticApiError = (raw: string, sessionId?: string) => {
  const lines = raw.split(/\r?\n/).filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
      if (sessionId && parsed.sessionId !== sessionId) {
        continue;
      }
      if (parsed.type !== 'assistant' || parsed.isApiErrorMessage !== true) {
        continue;
      }

      const message = parsed.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const text = message?.content
        ?.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join('\n')
        .trim();

      if (text) {
        return text;
      }
    } catch {
      continue;
    }
  }

  return undefined;
};

export const readLatestNativeClaudeApiError = async (cwd: string, sessionId?: string) => {
  const dirName = toNativeClaudeProjectDir(cwd);
  if (!dirName || !sessionId) {
    return undefined;
  }

  const filePath = path.join(process.env.USERPROFILE ?? '', '.claude', 'projects', dirName, `${sessionId}.jsonl`);
  try {
    const raw = await readFile(filePath, 'utf8');
    return extractLatestSyntheticApiError(raw, sessionId);
  } catch {
    return undefined;
  }
};
