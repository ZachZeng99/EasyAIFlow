export const getClaudeSyntheticApiError = (parsed: Record<string, unknown>) => {
  if (parsed.type !== 'assistant' || parsed.isApiErrorMessage !== true) {
    return undefined;
  }

  const message = parsed.message as
    | {
        model?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      }
    | undefined;

  const text = message?.content
    ?.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || 'Claude API error';
};

const readClaudeResultErrorDetail = (value: unknown) => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as { message?: unknown; error?: unknown };
  return (
    (typeof record.message === 'string' && record.message.trim()) ||
    (typeof record.error === 'string' && record.error.trim()) ||
    undefined
  );
};

export const getClaudeResultError = (parsed: Record<string, unknown>) => {
  if (parsed.type !== 'result' || parsed.is_error !== true) {
    return undefined;
  }

  const errors = Array.isArray(parsed.errors)
    ? parsed.errors.map(readClaudeResultErrorDetail).filter((value): value is string => Boolean(value))
    : [];
  if (errors.length > 0) {
    return errors.join('\n');
  }

  const result = readClaudeResultErrorDetail(parsed.result);
  if (result) {
    return result;
  }

  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype.trim() : '';
  return subtype
    ? `Claude returned an error result (${subtype}).`
    : 'Claude returned an error result.';
};
