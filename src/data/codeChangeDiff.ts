import type { DiffPayload } from './types.js';

export const shouldRequestCodeChangeDiff = ({
  nextOpen,
  hasRequestDiff,
  currentPayload,
  isLoading,
}: {
  nextOpen: boolean;
  hasRequestDiff: boolean;
  currentPayload: DiffPayload | null | undefined;
  isLoading: boolean;
}) => nextOpen && hasRequestDiff && !isLoading && (!currentPayload || currentPayload.kind === 'missing');

export const getDisplayedCodeChangeDiff = ({
  recordedPayload,
  loadedPayload,
}: {
  recordedPayload: DiffPayload | null | undefined;
  loadedPayload: DiffPayload | null | undefined;
}) => recordedPayload ?? loadedPayload ?? null;
