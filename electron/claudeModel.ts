type ClaudeSettings = {
  model?: unknown;
  _env?: Record<string, unknown>;
};

// Compatibility for the historical EAF-only "fable" alias. New catalogs use
// exact IDs. Native opus/sonnet/haiku aliases are resolved by the installed CLI.
const DEFAULT_FABLE_MODEL = 'claude-fable-5-1';

export const isClaudeSyntheticModel = (value: string | undefined) =>
  value?.trim().toLowerCase() === '<synthetic>';

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
  if (isClaudeSyntheticModel(normalized)) {
    return undefined;
  }
  if (normalized === 'claude') {
    return 'fable';
  }
  // Preserve exact provider model IDs across persistence and resume.
  return trimmed;
};

export const resolveClaudeModelArg = (requestedModel: string | undefined, settings?: ClaudeSettings) => {
  const trimmed = requestedModel?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isClaudeSyntheticModel(trimmed)) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  const has1mTag = /\[1m\]$/i.test(trimmed);
  const modelString = has1mTag ? normalized.replace(/\[1m\]$/i, '').trim() : normalized;
  const with1m = (model: string) => `${model}${has1mTag ? '[1m]' : ''}`;

  if (modelString === 'claude' || modelString === 'fable') {
    return readEnvModel(settings, 'ANTHROPIC_DEFAULT_FABLE_MODEL') ?? DEFAULT_FABLE_MODEL;
  }
  if (modelString === 'opus') {
    return with1m(
      readEnvModel(settings, 'ANTHROPIC_DEFAULT_OPUS_MODEL') ??
        readEnvModel(settings, 'ANTHROPIC_MODEL') ??
        'opus',
    );
  }
  if (modelString === 'sonnet') {
    return readEnvModel(settings, 'ANTHROPIC_DEFAULT_SONNET_MODEL') ??
      readEnvModel(settings, 'ANTHROPIC_MODEL') ??
      with1m('sonnet');
  }
  if (modelString === 'haiku') {
    return with1m(
      readEnvModel(settings, 'ANTHROPIC_DEFAULT_HAIKU_MODEL') ??
        readEnvModel(settings, 'ANTHROPIC_MODEL') ??
        'haiku',
    );
  }

  return trimmed;
};

export const resolveClaudeSessionModelArg = (
  requestedModel: string | undefined,
  sessionModel: string | undefined,
  settings?: ClaudeSettings,
) => {
  const trimmedRequested = requestedModel?.trim();
  if (trimmedRequested) {
    return resolveClaudeModelArg(trimmedRequested, settings);
  }

  const normalizedSessionModel =
    normalizeClaudeModelSelection(sessionModel) ??
    sessionModel?.trim();
  return resolveClaudeModelArg(normalizedSessionModel, settings);
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
