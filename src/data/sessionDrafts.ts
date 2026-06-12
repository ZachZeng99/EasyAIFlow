export type SessionDraftsById = Record<string, string>;

export const setSessionDraftValue = (
  drafts: SessionDraftsById,
  sessionId: string,
  value: string,
): SessionDraftsById => {
  if (value.length === 0) {
    if (!(sessionId in drafts)) {
      return drafts;
    }

    const { [sessionId]: _removed, ...rest } = drafts;
    return rest;
  }

  if (drafts[sessionId] === value) {
    return drafts;
  }

  return {
    ...drafts,
    [sessionId]: value,
  };
};

export const restoreSessionDraftIfUnchanged = (
  drafts: SessionDraftsById,
  sessionId: string,
  expectedCurrentValue: string,
  restoreValue: string,
): SessionDraftsById => {
  if ((drafts[sessionId] ?? '') !== expectedCurrentValue) {
    return drafts;
  }

  return setSessionDraftValue(drafts, sessionId, restoreValue);
};
