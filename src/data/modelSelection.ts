export type ModelSelectionSource = 'implicit' | 'explicit';

export const normalizeModelSelectionValue = (value: string | undefined) => {
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

export const syncImplicitModelSelection = (
  currentModel: string,
  currentSource: ModelSelectionSource,
  sessionModel: string | undefined,
) => {
  if (currentSource === 'explicit') {
    return {
      model: normalizeModelSelectionValue(currentModel) ?? currentModel,
      source: currentSource,
    };
  }

  return {
    model:
      normalizeModelSelectionValue(sessionModel) ??
      normalizeModelSelectionValue(currentModel) ??
      currentModel,
    source: 'implicit' as const,
  };
};

export const resolveRequestedModelArg = (
  model: string,
  source: ModelSelectionSource,
) => {
  return source === 'explicit' ? model : undefined;
};
