import type { SessionRecord } from '../src/data/types.js';
import type { SessionProvider } from '../src/data/types.js';
import { normalizeSessionProvider } from '../src/data/sessionProvider.js';
import { sameWorkspacePath } from './workspacePaths.js';

export const findImportedSessionTarget = (
  projectSessions: SessionRecord[],
  importedSessionId: string,
  title: string,
  workspace: string,
  sessionIdKey: 'claudeSessionId' | 'codexThreadId' = 'claudeSessionId',
  importedProvider?: SessionProvider,
) => {
  const direct = projectSessions.find((session) => session[sessionIdKey] === importedSessionId);
  if (direct) {
    return direct;
  }

  const provider = normalizeSessionProvider(importedProvider);
  const sameTitle = projectSessions.filter(
    (session) =>
      session.title === title &&
      session.dreamName !== 'Temporary' &&
      sameWorkspacePath(session.workspace, workspace) &&
      normalizeSessionProvider(session.provider) === provider,
  );

  return sameTitle.length === 1 ? sameTitle[0] : undefined;
};
