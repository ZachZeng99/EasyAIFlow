export type ModelSelectionSource = 'implicit' | 'explicit';

export const syncImplicitModelSelection = (
  currentModel: string,
  currentSource: ModelSelectionSource,
  sessionModel: string | undefined,
) => {
  if (currentSource === 'explicit') {
    return {
      model: currentModel,
      source: currentSource,
    };
  }

  const normalized = sessionModel?.trim().toLowerCase();
  if (normalized?.includes('opus')) {
    return { model: 'opus[1m]', source: 'implicit' as const };
  }
  if (normalized?.includes('sonnet')) {
    return { model: 'sonnet[1m]', source: 'implicit' as const };
  }

  return { model: currentModel, source: 'implicit' as const };
};

export const resolveRequestedModelArg = (
  model: string,
  source: ModelSelectionSource,
) => {
  return source === 'explicit' ? model : undefined;
};
