import path from 'node:path';
import type { DiffPayload } from '../src/data/types.js';

const PREVIEW_CHAR_LIMIT = 12000;

const normalizeText = (value: string) => value.replace(/\r\n?/g, '\n');

const getString = (value: unknown) => (typeof value === 'string' ? value : '');

const splitDiffLines = (value: string) => normalizeText(value).split('\n');

const toDisplayPath = (filePath: string) => path.normalize(filePath).replace(/\\/g, '/');

const sliceContent = (value: string) => value.slice(0, PREVIEW_CHAR_LIMIT);

const buildSyntheticDiff = (filePath: string, before: string, after: string) => {
  const displayPath = toDisplayPath(filePath);

  return [
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    '@@',
    ...splitDiffLines(before).map((line) => `-${line}`),
    ...splitDiffLines(after).map((line) => `+${line}`),
  ].join('\n');
};

const buildMultiEditDiff = (filePath: string, edits: Array<{ old_string?: unknown; new_string?: unknown }>) => {
  const displayPath = toDisplayPath(filePath);
  const hunks = edits.flatMap((edit) => {
    const before = getString(edit.old_string);
    const after = getString(edit.new_string);
    if (!before && !after) {
      return [];
    }

    return [
      '@@',
      ...splitDiffLines(before).map((line) => `-${line}`),
      ...splitDiffLines(after).map((line) => `+${line}`),
    ];
  });

  if (hunks.length === 0) {
    return undefined;
  }

  return [
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    ...hunks,
  ].join('\n');
};

export const buildRecordedCodeChangeDiff = (toolName: string, input: unknown): DiffPayload | undefined => {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const filePath = getString(record.file_path).trim();
  if (!filePath) {
    return undefined;
  }

  if (toolName === 'Edit') {
    const before = getString(record.old_string);
    const after = getString(record.new_string);
    if (!before && !after) {
      return undefined;
    }

    return {
      filePath,
      kind: 'git',
      content: sliceContent(buildSyntheticDiff(filePath, before, after)),
    };
  }

  if (toolName === 'MultiEdit' && Array.isArray(record.edits)) {
    const content = buildMultiEditDiff(
      filePath,
      record.edits as Array<{ old_string?: unknown; new_string?: unknown }>,
    );
    if (!content) {
      return undefined;
    }

    return {
      filePath,
      kind: 'git',
      content: sliceContent(content),
    };
  }

  if (toolName === 'ApplyPatch' || toolName === 'apply_patch') {
    const patch = getString(record.patch) || getString(record.content);
    if (!patch.trim()) {
      return undefined;
    }

    return {
      filePath,
      kind: 'git',
      content: sliceContent(normalizeText(patch)),
    };
  }

  if (toolName === 'Write') {
    const content = getString(record.content);
    if (!content) {
      return undefined;
    }

    return {
      filePath,
      kind: 'preview',
      content: sliceContent(normalizeText(content)),
    };
  }

  return undefined;
};
