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
