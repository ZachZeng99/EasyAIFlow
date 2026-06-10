import type { SessionProvider } from './types.js';
import { getDefaultModelForProvider, normalizeSessionProvider } from './sessionProvider.js';

export type ModelSelectionSource = 'implicit' | 'explicit';

export const MILLION_TOKEN_CONTEXT_WINDOW = 1000000;

const isSyntheticClaudeModel = (value: string | undefined) =>
  value?.trim().toLowerCase() === '<synthetic>';

export const normalizeModelSelectionValue = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toLowerCase();
  if (isSyntheticClaudeModel(normalized)) {
    return undefined;
  }
  if (normalized === 'claude') {
    return 'fable';
  }
  if (normalized.includes('fable')) {
    return 'fable';
  }
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

export const getKnownModelContextWindow = (value: string | undefined) => {
  const normalized = normalizeModelSelectionValue(value);
  const selected = (normalized ?? value?.trim() ?? '').toLowerCase();
  if (!selected || isSyntheticClaudeModel(selected)) {
    return undefined;
  }

  if (selected === 'fable' || selected.includes('fable') || selected.includes('[1m]')) {
    return MILLION_TOKEN_CONTEXT_WINDOW;
  }

  return undefined;
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

const normalizeProviderModelSelectionValue = (
  value: string | undefined,
  provider: SessionProvider | string | undefined,
) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (normalizeSessionProvider(provider) === 'claude') {
    if (isSyntheticClaudeModel(trimmed)) {
      return undefined;
    }
    return normalizeModelSelectionValue(trimmed) ?? trimmed;
  }

  return trimmed;
};

const getKnownProviderModelValues = (provider: SessionProvider | string | undefined) =>
  normalizeSessionProvider(provider) === 'claude'
    ? ['fable', 'opus[1m]', 'sonnet', 'haiku[1m]']
    : ['gpt-5.5', 'gpt-5.5-mini'];

export const syncModelSelectionForSession = (
  currentModel: string,
  currentSource: ModelSelectionSource,
  sessionModel: string | undefined,
  provider: SessionProvider | string | undefined,
) => {
  if (currentSource !== 'explicit') {
    return syncImplicitModelSelection(currentModel, currentSource, sessionModel);
  }

  const normalizedCurrent = normalizeProviderModelSelectionValue(currentModel, provider)?.toLowerCase();
  const normalizedSession = normalizeProviderModelSelectionValue(sessionModel, provider)?.toLowerCase();
  const knownValues = new Set(
    getKnownProviderModelValues(provider).map((value) => value.toLowerCase()),
  );

  if (
    normalizedCurrent &&
    (knownValues.has(normalizedCurrent) || normalizedCurrent === normalizedSession)
  ) {
    return {
      model: normalizeProviderModelSelectionValue(currentModel, provider) ?? currentModel,
      source: currentSource,
    };
  }

  const fallback =
    normalizeProviderModelSelectionValue(sessionModel, provider) ??
    getDefaultModelForProvider(provider);
  return {
    model: fallback,
    source: 'implicit' as const,
  };
};

export const resolveRequestedModelArg = (
  model: string,
  source: ModelSelectionSource,
) => {
  return source === 'explicit' ? model : undefined;
};

export const shouldSwitchSessionModel = (
  requestedModel: string | undefined,
  sessionModel: string | undefined,
  claudeSessionId: string | undefined,
  prompt?: string,
) => {
  const trimmedRequested = requestedModel?.trim();
  if (!trimmedRequested || !claudeSessionId) {
    return false;
  }

  if (prompt?.trim().startsWith('/')) {
    return false;
  }

  const normalizedRequested =
    (normalizeModelSelectionValue(trimmedRequested) ?? trimmedRequested).toLowerCase();
  const normalizedSession =
    (normalizeModelSelectionValue(sessionModel) ?? sessionModel?.trim() ?? '').toLowerCase();

  return normalizedRequested !== normalizedSession;
};
