import type { SessionProvider } from './types.js';

export const normalizeSessionProvider = (value: SessionProvider | string | undefined): SessionProvider =>
  value === 'codex' ? 'codex' : 'claude';

export const getProviderDisplayName = (value: SessionProvider | string | undefined) =>
  normalizeSessionProvider(value) === 'codex' ? 'Codex' : 'Claude';

export const getProviderBadgeLabel = (value: SessionProvider | string | undefined) =>
  normalizeSessionProvider(value).toUpperCase();

export const getDefaultModelForProvider = (value: SessionProvider | string | undefined) =>
  normalizeSessionProvider(value) === 'codex' ? 'gpt-5.5' : 'opus[1m]';

export const getDefaultPreviewForProvider = (value: SessionProvider | string | undefined) =>
  normalizeSessionProvider(value) === 'codex'
    ? 'Start a new Codex conversation.'
    : 'Start a new Claude conversation.';

export const providerSupportsBtw = (value: SessionProvider | string | undefined) =>
  normalizeSessionProvider(value) === 'claude';
