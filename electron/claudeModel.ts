type ClaudeSettings = {
  model?: unknown;
  _env?: Record<string, unknown>;
};

const readEnvModel = (settings: ClaudeSettings | undefined, key: string) => {
  const value = settings?._env?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

export const resolveClaudeModelArg = (requestedModel: string | undefined, settings?: ClaudeSettings) => {
  const trimmed = requestedModel?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'opus[1m]') {
    return readEnvModel(settings, 'ANTHROPIC_DEFAULT_OPUS_MODEL') ?? readEnvModel(settings, 'ANTHROPIC_MODEL') ?? trimmed;
  }
  if (normalized === 'sonnet[1m]') {
    return readEnvModel(settings, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ?? readEnvModel(settings, 'ANTHROPIC_MODEL') ?? trimmed;
  }
  if (normalized === 'haiku[1m]') {
    return readEnvModel(settings, 'ANTHROPIC_DEFAULT_HAIKU_MODEL') ?? readEnvModel(settings, 'ANTHROPIC_MODEL') ?? trimmed;
  }

  return trimmed;
};
