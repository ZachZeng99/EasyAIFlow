type ClaudeSettings = {
  model?: unknown;
  _env?: Record<string, unknown>;
};

const DEFAULT_OPUS_MODEL = 'claude-opus-4-6';
const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5';

const readEnvModel = (settings: ClaudeSettings | undefined, key: string) => {
  const value = settings?._env?.[key] ?? process.env[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

export const normalizeClaudeModelSelection = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('opus')) {
    return 'opus[1m]';
  }
  if (normalized.includes('sonnet')) {
    return 'sonnet';
  }
  if (normalized.includes('haiku')) {
    return 'haiku[1m]';
  }

  return trimmed;
};

export const resolveClaudeModelArg = (requestedModel: string | undefined, settings?: ClaudeSettings) => {
  const trimmed = requestedModel?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  const has1mTag = /\[1m\]$/i.test(trimmed);
  const modelString = has1mTag ? normalized.replace(/\[1m\]$/i, '').trim() : normalized;
  const with1m = (model: string) => `${model}${has1mTag ? '[1m]' : ''}`;

  if (modelString === 'opus') {
    return with1m(
      readEnvModel(settings, 'ANTHROPIC_DEFAULT_OPUS_MODEL') ??
        readEnvModel(settings, 'ANTHROPIC_MODEL') ??
        DEFAULT_OPUS_MODEL,
    );
  }
  if (modelString === 'sonnet') {
    return readEnvModel(settings, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ??
      readEnvModel(settings, 'ANTHROPIC_MODEL') ??
      DEFAULT_SONNET_MODEL;
  }
  if (modelString === 'haiku') {
    return with1m(
      readEnvModel(settings, 'ANTHROPIC_DEFAULT_HAIKU_MODEL') ??
        readEnvModel(settings, 'ANTHROPIC_MODEL') ??
        DEFAULT_HAIKU_MODEL,
    );
  }

  return trimmed;
};

export const shouldSwitchClaudeSessionModel = (payload: {
  prompt?: string;
  claudeSessionId?: string;
  currentResolvedModel?: string;
  requestedResolvedModel?: string;
}) => {
  const prompt = payload.prompt?.trim();
  if (prompt?.startsWith('/')) {
    return false;
  }

  if (!payload.claudeSessionId || !payload.requestedResolvedModel) {
    return false;
  }

  if (!payload.currentResolvedModel) {
    return true;
  }

  return payload.currentResolvedModel.trim() !== payload.requestedResolvedModel.trim();
};
