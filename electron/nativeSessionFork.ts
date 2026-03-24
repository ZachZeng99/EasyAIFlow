type NativeSessionFile = {
  name: string;
  lastWriteTimeMs: number;
};

export const resolveForkedNativeSessionId = (
  knownSessionIds: Set<string>,
  files: NativeSessionFile[],
) => {
  const newFiles = files
    .filter((file) => file.name.endsWith('.jsonl'))
    .map((file) => ({
      ...file,
      sessionId: file.name.slice(0, -'.jsonl'.length),
    }))
    .filter((file) => !knownSessionIds.has(file.sessionId))
    .sort((left, right) => right.lastWriteTimeMs - left.lastWriteTimeMs);

  return newFiles[0]?.sessionId;
};
