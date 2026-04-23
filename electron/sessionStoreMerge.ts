import { sortDreamsWithTemporaryFirst } from '../src/data/streamworkOrder.js';
import type {
  DreamRecord,
  ProjectRecord,
  SessionRecord,
} from '../src/data/types.js';
import { normalizeWorkspacePath } from './workspacePaths.js';

export type SessionStoreDeletedImports = {
  claudeSessionIds: string[];
  codexThreadIds: string[];
};

export type SessionStoreAppState = {
  projects: ProjectRecord[];
  deletedImports: SessionStoreDeletedImports;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeDeletedImportIds = (value: string[] | undefined) =>
  [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))];

const mergeDeletedImports = (
  current: SessionStoreDeletedImports,
  incoming: SessionStoreDeletedImports,
): SessionStoreDeletedImports => ({
  claudeSessionIds: normalizeDeletedImportIds([
    ...current.claudeSessionIds,
    ...incoming.claudeSessionIds,
  ]),
  codexThreadIds: normalizeDeletedImportIds([
    ...current.codexThreadIds,
    ...incoming.codexThreadIds,
  ]),
});

const isTemporaryDream = (dream: DreamRecord | undefined) =>
  Boolean(dream?.isTemporary || dream?.name === 'Temporary');

const projectKey = (project: ProjectRecord) =>
  normalizeWorkspacePath(project.rootPath) || `id:${project.id}`;

const dreamKey = (dream: DreamRecord) =>
  isTemporaryDream(dream) ? '__temporary__' : `name:${dream.name.trim().toLowerCase()}`;

const choosePreferredSession = (
  current: SessionRecord | undefined,
  candidate: SessionRecord,
) => {
  if (!current) {
    return candidate;
  }

  const currentUpdatedAt = current.updatedAt ?? 0;
  const candidateUpdatedAt = candidate.updatedAt ?? 0;
  if (candidateUpdatedAt !== currentUpdatedAt) {
    return candidateUpdatedAt > currentUpdatedAt ? candidate : current;
  }

  const currentMessageCount = current.messages?.length ?? 0;
  const candidateMessageCount = candidate.messages?.length ?? 0;
  if (candidateMessageCount !== currentMessageCount) {
    return candidateMessageCount > currentMessageCount ? candidate : current;
  }

  return (candidate.preview?.length ?? 0) > (current.preview?.length ?? 0) ? candidate : current;
};

const rehomeSession = (
  session: SessionRecord,
  project: ProjectRecord,
  dream: DreamRecord,
): SessionRecord => ({
  ...clone(session),
  projectId: project.id,
  projectName: project.name,
  dreamId: dream.id,
  dreamName: dream.name,
});

const mergeDreamSessions = (
  project: ProjectRecord,
  dream: DreamRecord,
  currentSessions: SessionRecord[],
  incomingSessions: SessionRecord[],
) => {
  const merged = new Map<string, SessionRecord>();

  [...currentSessions, ...incomingSessions].forEach((session) => {
    const normalized = rehomeSession(session, project, dream);
    merged.set(
      normalized.id,
      choosePreferredSession(merged.get(normalized.id), normalized),
    );
  });

  return [...merged.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
};

const mergeDreamRecords = (
  project: ProjectRecord,
  currentDream: DreamRecord | undefined,
  incomingDream: DreamRecord | undefined,
): DreamRecord => {
  const base = clone(currentDream ?? incomingDream ?? {
    id: '',
    name: 'Recovered Streamwork',
    sessions: [],
  });

  const mergedDream: DreamRecord = {
    ...base,
    name: currentDream?.name?.trim() || incomingDream?.name?.trim() || base.name,
    isTemporary: isTemporaryDream(currentDream) || isTemporaryDream(incomingDream),
    sessions: [],
  };

  mergedDream.sessions = mergeDreamSessions(
    project,
    mergedDream,
    clone((currentDream?.sessions ?? []) as SessionRecord[]),
    clone((incomingDream?.sessions ?? []) as SessionRecord[]),
  );

  return mergedDream;
};

const findMatchingDream = (
  dreams: DreamRecord[],
  target: DreamRecord,
  consumed: Set<string>,
) =>
  dreams.find((dream) => {
    if (consumed.has(dream.id)) {
      return false;
    }

    return dream.id === target.id || dreamKey(dream) === dreamKey(target);
  });

const mergeProjectRecords = (
  currentProject: ProjectRecord | undefined,
  incomingProject: ProjectRecord | undefined,
): ProjectRecord => {
  const base = clone(currentProject ?? incomingProject ?? {
    id: '',
    name: 'Recovered Project',
    rootPath: '',
    dreams: [],
  });

  const mergedProject: ProjectRecord = {
    ...base,
    name: currentProject?.name?.trim() || incomingProject?.name?.trim() || base.name,
    rootPath: currentProject?.rootPath || incomingProject?.rootPath || base.rootPath,
    isClosed:
      currentProject && incomingProject
        ? Boolean(currentProject.isClosed) && Boolean(incomingProject.isClosed)
        : Boolean(currentProject?.isClosed ?? incomingProject?.isClosed),
    dreams: [],
  };

  const currentDreams = sortDreamsWithTemporaryFirst(clone(currentProject?.dreams ?? []));
  const incomingDreams = sortDreamsWithTemporaryFirst(clone(incomingProject?.dreams ?? []));
  const consumedIncoming = new Set<string>();

  currentDreams.forEach((dream) => {
    const match = findMatchingDream(incomingDreams, dream, consumedIncoming);
    if (match) {
      consumedIncoming.add(match.id);
    }
    mergedProject.dreams.push(mergeDreamRecords(mergedProject, dream, match));
  });

  incomingDreams.forEach((dream) => {
    if (consumedIncoming.has(dream.id)) {
      return;
    }
    mergedProject.dreams.push(mergeDreamRecords(mergedProject, undefined, dream));
  });

  mergedProject.dreams = sortDreamsWithTemporaryFirst(mergedProject.dreams);
  return mergedProject;
};

export const mergeSessionStoreStates = (
  diskState: SessionStoreAppState,
  memoryState: SessionStoreAppState,
): SessionStoreAppState => {
  const mergedProjects: ProjectRecord[] = [];
  const incomingByKey = new Map(
    clone(diskState.projects).map((project) => [projectKey(project), project] as const),
  );

  clone(memoryState.projects).forEach((project) => {
    const key = projectKey(project);
    const incoming = incomingByKey.get(key);
    if (incoming) {
      incomingByKey.delete(key);
    }
    mergedProjects.push(mergeProjectRecords(project, incoming));
  });

  incomingByKey.forEach((project) => {
    mergedProjects.push(mergeProjectRecords(undefined, project));
  });

  return {
    projects: mergedProjects,
    deletedImports: mergeDeletedImports(memoryState.deletedImports, diskState.deletedImports),
  };
};
