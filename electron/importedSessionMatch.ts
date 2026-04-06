import type { SessionRecord } from '../src/data/types.js';
import { sameWorkspacePath } from './workspacePaths.js';

export const findImportedSessionTarget = (
  projectSessions: SessionRecord[],
  importedSessionId: string,
  title: string,
  workspace: string,
  sessionIdKey: 'claudeSessionId' | 'codexThreadId' = 'claudeSessionId',
) => {
  const direct = projectSessions.find((session) => session[sessionIdKey] === importedSessionId);
  if (direct) {
    return direct;
  }

  const sameTitle = projectSessions.filter(
    (session) =>
      session.title === title &&
      session.dreamName !== 'Temporary' &&
      sameWorkspacePath(session.workspace, workspace),
  );

  return sameTitle.length === 1 ? sameTitle[0] : undefined;
};
