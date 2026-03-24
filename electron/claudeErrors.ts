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
