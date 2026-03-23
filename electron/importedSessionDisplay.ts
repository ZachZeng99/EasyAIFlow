import type { SessionRecord } from '../src/data/types.js';

export const resolveImportedSessionDisplay = (
  existing: SessionRecord | undefined,
  parsed: {
    title: string;
    preview: string;
    timeLabel: string;
    updatedAt?: number;
  },
) => ({
  title: parsed.title,
  preview: parsed.preview,
  timeLabel: parsed.timeLabel,
  updatedAt: existing?.updatedAt ?? parsed.updatedAt,
});
