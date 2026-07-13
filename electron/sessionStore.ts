import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { getRuntimePaths } from '../backend/runtimePaths.js';
import { allSessions, projectTree } from '../src/data/mockSessions.js';
import { findImportedSessionTarget } from './importedSessionMatch.js';
import { cleanupProjectSessions } from './projectSessionCleanup.js';
import { pruneTemporaryImportedDuplicates } from './importedSessionCleanup.js';
import { resolveImportedSessionDisplay } from './importedSessionDisplay.js';
import { shouldIgnoreImportedProgress } from './importedProgressFilter.js';
import { deriveImportedSessionSummary } from './importedSessionSummary.js';
import {
  formatImportedAskUserQuestionAnswer,
  formatImportedAskUserQuestionPrompt,
} from './importedAskUserQuestion.js';
import {
  extractBackgroundTaskNotificationContent,
  isBackgroundTaskNotificationContent,
  parseBackgroundTaskNotificationContent,
} from './backgroundTaskNotification.js';
import {
  isIgnorableBackgroundTaskFollowupText,
  stripLeadingBackgroundTaskFollowupText as stripLeadingBackgroundTaskFollowupFromAssistantText,
} from './claudeRunState.js';
import { isClaudeSyntheticModel, normalizeClaudeModelSelection } from './claudeModel.js';
import { mergeNativeImportedSessions } from './nativeSessionMerge.js';
import {
  mergeNativeConversationMessages,
  mergeNativeSessionIntoExisting,
  shouldRecoverSessionFromNative,
} from './nativeSessionRecovery.js';
import { hydrateProjectForOpen } from './projectOpen.js';
import { buildRecordedCodeChangeDiff } from './recordedCodeChangeDiff.js';
import {
  getDefaultModelForProvider,
  getDefaultPreviewForProvider,
  normalizeSessionProvider,
} from '../src/data/sessionProvider.js';
import { sortDreamsWithTemporaryFirst } from '../src/data/streamworkOrder.js';
import {
  isWorkspaceWithinProjectTree,
  normalizeWorkspacePath,
  sameWorkspacePath,
  getClaudeProjectDirNameCandidates,
  toClaudeProjectDirName,
} from './workspacePaths.js';
import { filterVisibleProjects } from './projectVisibility.js';
import { mergeSessionStoreStates } from './sessionStoreMerge.js';
import { normalizeProjectsForCache, normalizeProjectsFromPersistence } from './sessionStoreNormalization.js';
import {
  recoverStaleGroupRoomMessages,
  recoverStaleSessionMessagesForProvider,
} from './sessionRecovery.js';
import {
  getSessionStoreV2Paths,
  migrateSessionStoreV2,
  openSessionStoreV2,
  type SessionStoreV2,
  SessionStoreV2LockError,
  type SessionStoreV2SessionMutation,
} from './sessionStoreV2.js';
import type {
  BranchSnapshot,
  CloseProjectResult,
  ConversationMessage,
  ContextReference,
  DeleteEntityResult,
  DreamRecord,
  GroupParticipant,
  GroupParticipantId,
  GroupSessionMetadata,
  ProjectCreateResult,
  ProjectRecord,
  SessionProvider,
  SessionContextUpdateResult,
  SessionKind,
  SessionMessagePage,
  SessionCreateResult,
  SessionRecord,
  SessionSummary,
  StreamworkCreateResult,
  TokenUsage,
  RenameEntityResult,
} from '../src/data/types.js';

type AppState = {
  projects: ProjectRecord[];
  deletedImports: {
    claudeSessionIds: string[];
    codexThreadIds: string[];
  };
};

type NativeCleanupResult = {
  warnings: string[];
};

type ParsedCodexImportedSession = NonNullable<Awaited<ReturnType<typeof parseCodexSessionFile>>>;
type ParsedNativeClaudeSession = Awaited<ReturnType<typeof parseNativeClaudeSessionFile>>;

type NativeImportCache = {
  parsedCodexSessions?: ParsedCodexImportedSession[];
  parsedClaudeSessionsByFile?: Map<string, ParsedNativeClaudeSession | null>;
};

type NativeSessionCatalogEntry = {
  nativeSessionId: string;
  workspace: string;
  model: string;
  title: string;
  preview: string;
  timeLabel: string;
  updatedAt?: number;
  tokenUsage?: TokenUsage;
  filePath: string;
  provider: SessionProvider;
  sourceRevision: string;
};

type NativeSessionSource = Pick<NativeSessionCatalogEntry, 'filePath' | 'provider' | 'sourceRevision'>;

type NativeCatalogFileCacheEntry = {
  mtimeMs: number;
  size: number;
  auxiliaryRevision: string;
  entry: NativeSessionCatalogEntry | null;
};

let cachedState: AppState | null = null;
let cachedStateMtimeMs: number | null = null;
let loadingStatePromise: Promise<AppState> | null = null;
let v2Store: SessionStoreV2 | null = null;
const nativeSessionSources = new Map<string, NativeSessionSource>();
const nativeSessionHydrationPromises = new Map<string, Promise<void>>();
const nativeSessionsNeedingHydration = new Set<string>();
const repairedGroupRoomSessionIds = new Set<string>();
const nativeCatalogFileCache = new Map<string, NativeCatalogFileCacheEntry>();
let nativeCatalogLastRefreshAt = 0;
const storePath = () => path.join(getRuntimePaths().userDataPath, 'easyaiflow-sessions.json');
const nativeClaudeProjectsRoot = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.claude', 'projects');
const nativeClaudeHistoryPath = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.claude', 'history.jsonl');

const normalizeSessionModel = (model: string, provider: SessionProvider) => {
  if (provider !== 'claude') {
    return model.trim();
  }

  if (isClaudeSyntheticModel(model)) {
    return getDefaultModelForProvider(provider);
  }

  return normalizeClaudeModelSelection(model) ?? model.trim();
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const isMissingFsEntryError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === 'ENOENT';

type NativeClaudeHistoryEntry = {
  display: string;
  pastedContents: Record<string, never>;
  timestamp: number;
  project: string;
  sessionId: string;
};

const firstNativeClaudeHistoryDisplayLine = (value: string | undefined) =>
  (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';

const buildNativeClaudeHistoryEntry = (session: SessionSummary): NativeClaudeHistoryEntry | null => {
  const sessionId = session.claudeSessionId?.trim();
  const project = session.workspace.trim();
  if (!sessionId || !project) {
    return null;
  }

  return {
    display:
      firstNativeClaudeHistoryDisplayLine(session.title) ||
      firstNativeClaudeHistoryDisplayLine(session.preview) ||
      `Claude session ${sessionId.slice(0, 8)}`,
    pastedContents: {},
    timestamp: Number.isFinite(session.updatedAt) ? (session.updatedAt as number) : Date.now(),
    project,
    sessionId,
  };
};

const buildNativeClaudeHistoryEntryFromTitle = (
  project: string,
  sessionId: string,
  title: string,
): NativeClaudeHistoryEntry | null => {
  const display = firstNativeClaudeHistoryDisplayLine(title);
  const trimmedProject = project.trim();
  const trimmedSessionId = sessionId.trim();
  if (!display || !trimmedProject || !trimmedSessionId) {
    return null;
  }

  return {
    display,
    pastedContents: {},
    timestamp: Date.now(),
    project: trimmedProject,
    sessionId: trimmedSessionId,
  };
};

const upsertNativeClaudeHistoryEntry = async (entry: NativeClaudeHistoryEntry) => {
  const historyPath = nativeClaudeHistoryPath();
  let raw = '';
  try {
    raw = await readFile(historyPath, 'utf8');
  } catch (error) {
    if (!isMissingFsEntryError(error)) {
      throw error;
    }
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  const nextLine = JSON.stringify(entry);
  let existingIndex = -1;
  lines.forEach((line, index) => {
    try {
      const parsed = JSON.parse(line) as { sessionId?: unknown };
      if (parsed.sessionId === entry.sessionId) {
        existingIndex = index;
      }
    } catch {
      // Preserve malformed history lines; they are not ours to normalize.
    }
  });

  if (existingIndex >= 0) {
    if (lines[existingIndex] === nextLine) {
      return;
    }
    lines[existingIndex] = nextLine;
  } else {
    lines.push(nextLine);
  }

  await mkdir(path.dirname(historyPath), { recursive: true });
  await writeFile(historyPath, `${lines.join('\n')}\n`, 'utf8');
};

const safelyUpsertNativeClaudeHistoryEntry = async (entry: NativeClaudeHistoryEntry | null) => {
  if (!entry) {
    return;
  }

  try {
    await upsertNativeClaudeHistoryEntry(entry);
  } catch (error) {
    console.warn(
      `[SESSION_STORE] Failed to update native Claude history "${nativeClaudeHistoryPath()}": ${describeError(error)}`,
    );
  }
};

const logNativeCleanupWarnings = (warnings: string[]) => {
  warnings.forEach((warning) => console.warn(`[SESSION_STORE] ${warning}`));
};

const summarizeDeleteWarning = (warnings: string[]) =>
  warnings.length > 0
    ? 'Deleted, but native session cleanup partially failed. Check the app logs for details.'
    : undefined;

const normalizeDeletedImportIds = (value: unknown) =>
  [...new Set((Array.isArray(value) ? value : []).filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];

const createEmptyDeletedImports = () => ({
  claudeSessionIds: [] as string[],
  codexThreadIds: [] as string[],
});

const normalizeDeletedImports = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return createEmptyDeletedImports();
  }

  const typed = value as {
    claudeSessionIds?: unknown;
    codexThreadIds?: unknown;
  };

  return {
    claudeSessionIds: normalizeDeletedImportIds(typed.claudeSessionIds),
    codexThreadIds: normalizeDeletedImportIds(typed.codexThreadIds),
  };
};

const rememberDeletedImports = (
  state: AppState,
  nativeTargets: { claudeSessions: Array<{ workspace: string; sessionId: string }>; codexThreadIds: string[] },
) => {
  const claude = new Set(state.deletedImports.claudeSessionIds);
  nativeTargets.claudeSessions.forEach((session) => claude.add(session.sessionId));
  const codex = new Set(state.deletedImports.codexThreadIds);
  nativeTargets.codexThreadIds.forEach((threadId) => codex.add(threadId));
  state.deletedImports = {
    claudeSessionIds: [...claude],
    codexThreadIds: [...codex],
  };
};

const normalizeSessionKind = (value: SessionKind | undefined): SessionKind =>
  value === 'group' || value === 'group_member' ? value : 'standard';

const inferSessionKindFromMetadata = (
  sessionKind: SessionKind | undefined,
  group: GroupSessionMetadata | undefined,
): SessionKind => {
  if (group?.kind === 'room') {
    return 'group';
  }

  if (group?.kind === 'member') {
    return 'group_member';
  }

  return normalizeSessionKind(sessionKind);
};

const getDefaultPreviewForSessionKind = (
  sessionKind: SessionKind,
  provider?: SessionProvider,
) =>
  sessionKind === 'group'
    ? 'Start a group conversation with @claude and @codex.'
    : getDefaultPreviewForProvider(provider);

const getGroupBackingSessionTitle = (roomTitle: string) => `[Group] ${roomTitle}`;

const cloneContextReferences = (references: ContextReference[] | undefined) =>
  (references ?? []).map((reference) => ({ ...reference }));

const cloneGroupParticipants = (participants: GroupParticipant[] | undefined) =>
  (participants ?? []).map((participant) => ({ ...participant }));

const normalizeGroupMetadata = (
  value: GroupSessionMetadata | undefined,
): GroupSessionMetadata | undefined => {
  if (!value) {
    return undefined;
  }

  if (value.kind === 'member') {
    if (!value.roomSessionId || !value.participantId || !value.speakerLabel?.trim()) {
      return undefined;
    }

    return {
      kind: 'member',
      roomSessionId: value.roomSessionId,
      participantId: value.participantId,
      speakerLabel: value.speakerLabel.trim(),
    };
  }

  return {
    kind: 'room',
    nextMessageSeq:
      typeof value.nextMessageSeq === 'number' && Number.isFinite(value.nextMessageSeq) && value.nextMessageSeq > 0
        ? Math.floor(value.nextMessageSeq)
        : 1,
    participants: cloneGroupParticipants(value.participants),
  };
};

const normalizeContextReference = (reference: ContextReference): ContextReference | null => {
  if (reference.kind === 'session' && reference.sessionId) {
    return {
      ...reference,
      mode: reference.mode === 'full' ? 'full' : 'summary',
      sessionId: reference.sessionId,
      streamworkId: undefined,
      label: reference.label?.trim() || 'Referenced session',
    };
  }

  if (reference.kind === 'streamwork' && reference.streamworkId) {
    return {
      ...reference,
      mode: reference.mode === 'full' ? 'full' : 'summary',
      streamworkId: reference.streamworkId,
      sessionId: undefined,
      label: reference.label?.trim() || 'Streamwork history',
    };
  }

  return null;
};

const normalizeContextReferences = (references: ContextReference[] | undefined) =>
  cloneContextReferences(references)
    .map(normalizeContextReference)
    .filter((reference): reference is ContextReference => Boolean(reference));

const normalizeTokenUsage = (tokenUsage: TokenUsage | undefined, model: string): TokenUsage => {
  const normalizedModel = model.trim().toLowerCase();
  const isClaudeModel =
    normalizedModel.includes('fable') ||
    normalizedModel.includes('opus') ||
    normalizedModel.includes('sonnet') ||
    normalizedModel.includes('claude');
  const source = tokenUsage?.windowSource ?? 'unknown';
  const keepWindow = !isClaudeModel || source === 'runtime' || source === 'derived';

  return {
    contextWindow: keepWindow ? tokenUsage?.contextWindow ?? 0 : 0,
    used: tokenUsage?.used ?? 0,
    input: tokenUsage?.input ?? 0,
    output: tokenUsage?.output ?? 0,
    cached: tokenUsage?.cached ?? 0,
    usedPercentage: tokenUsage?.usedPercentage,
    windowSource: keepWindow ? source : 'unknown',
  };
};

const normalizeProjects = (projects: ProjectRecord[]) =>
  projects.map((project) =>
    cleanupProjectSessions({
      ...recoverProjectGroupSessions({
        ...project,
        dreams: sortDreamsWithTemporaryFirst(project.dreams).map((dream) => ({
          ...dream,
          sessions: normalizeDreamSessions(dream),
        })),
      }),
    }),
  ) as ProjectRecord[];

const normalizeDreamSessions = (dream: DreamRecord) => {
  const sessions = dream.sessions.map((session) => {
    const current = session as SessionRecord;
    const normalizedGroup = normalizeGroupMetadata(current.group);
    const sessionKind = inferSessionKindFromMetadata(current.sessionKind, normalizedGroup);
    const provider = sessionKind === 'group' ? undefined : normalizeSessionProvider(current.provider);
    const model = provider ? normalizeSessionModel(current.model, provider) : current.model ?? '';
    const legacyKind = (session as { sessionKind?: string }).sessionKind;
    const wasUnknownLegacySessionKind =
      legacyKind !== undefined &&
      legacyKind !== 'standard' &&
      legacyKind !== 'group' &&
      legacyKind !== 'group_member';

    return {
      ...current,
      dreamId: dream.id,
      dreamName: dream.name,
      provider,
      model,
      sessionKind,
      hidden: sessionKind === 'group_member' ? true : wasUnknownLegacySessionKind ? false : Boolean(current.hidden),
      group: normalizedGroup,
      contextReferences: normalizeContextReferences(current.contextReferences),
      tokenUsage: normalizeTokenUsage(current.tokenUsage, model),
      messages: current.messages ?? [],
      updatedAt: current.updatedAt,
    };
  }) as SessionRecord[];

  return dream.isTemporary ? pruneTemporaryImportedDuplicates(sessions) : sessions;
};

const mapSessionDreams = (project: ProjectRecord) => {
  const result = new Map<string, DreamRecord>();
  project.dreams.forEach((dream) => {
    dream.sessions.forEach((session) => {
      result.set(session.id, dream);
    });
  });
  return result;
};

const groupTitlePrefix = '[Group] ';
const recoveredGroupHeaderPattern =
  /^#(\d+)\s+\[([^\]]+)\]\s+\[([^\]\s]+)(?:\s+status=([^\]]+))?\](?:\s+title="([^"]*)")?$/gm;
const recoverableConversationMessageKinds = new Set([
  'message',
  'thinking',
  'tool_use',
  'tool_result',
  'progress',
  'error',
]);
const recoverableConversationMessageStatuses = new Set([
  'queued',
  'streaming',
  'running',
  'background',
  'success',
  'complete',
  'error',
]);

const getRecoveredRoomTitle = (title: string) =>
  title.startsWith(groupTitlePrefix) ? title.slice(groupTitlePrefix.length).trim() : title.trim();

const isOrphanGroupImportedSession = (session: SessionRecord) =>
  session.sessionKind === 'standard' &&
  !session.group &&
  !session.hidden &&
  session.title.startsWith(groupTitlePrefix) &&
  Boolean(session.claudeSessionId || session.codexThreadId);

const getRecoveredGroupKey = (workspace: string, roomTitle: string) =>
  `${normalizeWorkspacePath(workspace)}::${roomTitle.trim()}`;

const chooseRecoveredRoomMessage = (
  current: ConversationMessage | undefined,
  candidate: ConversationMessage,
) => {
  if (!current) {
    return candidate;
  }

  const currentContent = current.content.trim();
  const candidateContent = candidate.content.trim();
  if (!currentContent && candidateContent) {
    return candidate;
  }
  if (current.status === 'error' && candidate.status !== 'error') {
    return candidate;
  }
  if (candidateContent.length > currentContent.length) {
    return candidate;
  }

  return current;
};

const parseRecoveredGroupPromptEntries = (
  section: string,
  timestamp: string,
) => {
  const matches = [...section.matchAll(recoveredGroupHeaderPattern)];
  const result: ConversationMessage[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const seq = Number(match[1]);
    if (!Number.isFinite(seq) || seq <= 0) {
      continue;
    }

    const speaker = match[2]?.trim() || 'Assistant';
    const rawKind = match[3]?.trim() || 'message';
    const rawStatus = match[4]?.trim();
    const rawTitle = match[5]?.trim();
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = next?.index ?? section.length;
    const content = section
      .slice(contentStart, contentEnd)
      .trim()
      .replace(/\n{3,}/g, '\n\n');

    const kind = recoverableConversationMessageKinds.has(rawKind) ? rawKind : 'message';
    const status =
      rawStatus && recoverableConversationMessageStatuses.has(rawStatus)
        ? (rawStatus as ConversationMessage['status'])
        : kind === 'message'
          ? 'complete'
          : undefined;
    const provider =
      speaker === 'Claude' ? 'claude' : speaker === 'Codex' ? 'codex' : undefined;
    const role: ConversationMessage['role'] =
      kind !== 'message' ? 'system' : speaker === 'You' ? 'user' : 'assistant';
    const title =
      rawTitle ||
      firstMeaningfulLine(content).slice(0, 42) ||
      (role === 'user'
        ? 'User prompt'
        : role === 'assistant'
          ? `${speaker} response`
          : 'Recovered trace');

    result.push({
      id: randomUUID(),
      role,
      ...(kind !== 'message' ? { kind: kind as ConversationMessage['kind'] } : {}),
      seq,
      timestamp,
      title,
      content,
      ...(role !== 'user' && provider
        ? {
            speakerId: provider,
            speakerLabel: speaker,
            provider,
          }
        : role === 'user'
          ? {
              speakerId: 'user',
              speakerLabel: 'You',
            }
          : {}),
      ...(status ? { status } : {}),
    });
  }

  return result;
};

const parseRecoveredClaudeGroupPrompt = (
  prompt: string,
  timestamp: string,
) => {
  const roomContextMatch = prompt.match(/ROOM_CONTEXT through message #(\d+):/);
  if (!roomContextMatch) {
    return null;
  }

  const snapshotSeq = Number(roomContextMatch[1]);
  if (!Number.isFinite(snapshotSeq) || snapshotSeq <= 0) {
    return null;
  }

  const targetMarker = 'TARGET_MESSAGE:';
  const targetIndex = prompt.indexOf(targetMarker);
  const roomIndex = prompt.indexOf(roomContextMatch[0]);
  if (targetIndex === -1 || roomIndex === -1 || roomIndex <= targetIndex) {
    return null;
  }

  const replyIndex = prompt.indexOf('\n\nReply as ', roomIndex);
  const targetSection = prompt.slice(targetIndex + targetMarker.length, roomIndex).trim();
  const roomSectionRaw = prompt
    .slice(roomIndex + roomContextMatch[0].length, replyIndex === -1 ? prompt.length : replyIndex)
    .trim();
  const roomSection = roomSectionRaw.replace(/^Participants:.*(?:\r?\n|$)/, '').trim();

  return {
    snapshotSeq,
    entries: [
      ...parseRecoveredGroupPromptEntries(targetSection, timestamp),
      ...parseRecoveredGroupPromptEntries(roomSection, timestamp),
    ],
  };
};

const parseRecoveredCodexTranscriptPrompt = (
  prompt: string,
  timestamp: string,
) => {
  const chatContextMarker = 'Chat context:';
  const startIndex = prompt.indexOf(chatContextMarker);
  if (startIndex === -1) {
    return null;
  }

  const endTagIndex = prompt.indexOf('\n</task>', startIndex);
  const transcript = prompt
    .slice(startIndex + chatContextMarker.length, endTagIndex === -1 ? prompt.length : endTagIndex)
    .trim();
  if (!transcript) {
    return null;
  }

  const lines = transcript.split(/\r?\n/);
  const entries: ConversationMessage[] = [];
  let currentSpeaker: 'You' | 'Claude' | 'Codex' | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentSpeaker) {
      return;
    }

    const content = buffer.join('\n').trim();
    if (!content) {
      currentSpeaker = null;
      buffer = [];
      return;
    }

    const provider =
      currentSpeaker === 'Claude' ? 'claude' : currentSpeaker === 'Codex' ? 'codex' : undefined;
    const role: ConversationMessage['role'] = currentSpeaker === 'You' ? 'user' : 'assistant';
    entries.push({
      id: randomUUID(),
      role,
      timestamp,
      title:
        firstMeaningfulLine(content).slice(0, 42) ||
        (role === 'user' ? 'User prompt' : `${currentSpeaker} response`),
      content,
      ...(role === 'user'
        ? {
            speakerId: 'user',
            speakerLabel: 'You',
          }
        : provider
          ? {
              speakerId: provider,
              speakerLabel: currentSpeaker,
              provider,
            }
          : {}),
      status: 'complete',
    });

    currentSpeaker = null;
    buffer = [];
  };

  for (const line of lines) {
    const header = line.match(/^(You|Claude|Codex):\s?(.*)$/);
    if (header) {
      flush();
      currentSpeaker = header[1] as 'You' | 'Claude' | 'Codex';
      buffer = [header[2] ?? ''];
      continue;
    }

    if (currentSpeaker) {
      buffer.push(line);
    }
  }

  flush();
  return entries.length > 0 ? entries : null;
};

const reconstructRecoveredRoomMessages = (
  roomSession: SessionRecord,
  participantBackings: Map<GroupParticipantId, SessionRecord>,
) => {
  if (roomSession.group?.kind !== 'room') {
    return [] as ConversationMessage[];
  }

  const messagesBySeq = new Map<number, ConversationMessage>();
  const responseCandidates = new Map<
    number,
    Partial<Record<GroupParticipantId, { content: string; timestamp: string; sourceSessionId: string }>>
  >();
  let longestCodexTranscript:
    | {
        entries: ConversationMessage[];
        finalReply?: { content: string; timestamp: string; sourceSessionId: string; participantId: GroupParticipantId };
      }
    | undefined;

  for (const participant of roomSession.group.participants) {
    const backing = participantBackings.get(participant.id);
    if (!backing) {
      continue;
    }

    let activePrompt:
      | {
          snapshotSeq: number;
          lastAssistant: ConversationMessage | null;
          timestamp: string;
        }
      | null = null;

    for (const message of backing.messages ?? []) {
      if (message.role === 'user') {
        const parsedPrompt = parseRecoveredClaudeGroupPrompt(message.content, message.timestamp);
        const parsedCodexPrompt = parseRecoveredCodexTranscriptPrompt(message.content, message.timestamp);
        if (!parsedPrompt) {
          if (parsedCodexPrompt) {
            activePrompt = {
              snapshotSeq: parsedCodexPrompt.length,
              lastAssistant: null,
              timestamp: message.timestamp,
            };
            if (!longestCodexTranscript || parsedCodexPrompt.length >= longestCodexTranscript.entries.length) {
              longestCodexTranscript = {
                entries: parsedCodexPrompt,
              };
            }
          } else {
            activePrompt = null;
          }
          continue;
        }

        if (parsedCodexPrompt && (!longestCodexTranscript || parsedCodexPrompt.length >= longestCodexTranscript.entries.length)) {
          longestCodexTranscript = {
            entries: parsedCodexPrompt,
          };
        }

        if (!parsedPrompt) {
          activePrompt = null;
          continue;
        }

        for (const entry of parsedPrompt.entries) {
          if (typeof entry.seq !== 'number') {
            continue;
          }
          messagesBySeq.set(entry.seq, chooseRecoveredRoomMessage(messagesBySeq.get(entry.seq), entry));
        }

        activePrompt = {
          snapshotSeq: parsedPrompt.snapshotSeq,
          lastAssistant: null,
          timestamp: message.timestamp,
        };
        continue;
      }

      if (message.role === 'assistant' && activePrompt) {
        activePrompt.lastAssistant = message;
        continue;
      }
    }

    let currentPrompt:
      | {
          snapshotSeq: number;
          lastAssistant: ConversationMessage | null;
        }
      | null = null;
    for (const message of backing.messages ?? []) {
      if (message.role === 'user') {
        const parsedPrompt = parseRecoveredClaudeGroupPrompt(message.content, message.timestamp);
        const parsedCodexPrompt = parseRecoveredCodexTranscriptPrompt(message.content, message.timestamp);
        currentPrompt = parsedPrompt
          ? {
              snapshotSeq: parsedPrompt.snapshotSeq,
              lastAssistant: null,
            }
          : parsedCodexPrompt
            ? {
                snapshotSeq: parsedCodexPrompt.length,
                lastAssistant: null,
              }
            : null;
        continue;
      }

      if (message.role === 'assistant' && currentPrompt) {
        currentPrompt.lastAssistant = message;
        continue;
      }
    }

    // Capture the last visible assistant reply after each parsed prompt.
    currentPrompt = null;
    for (const message of backing.messages ?? []) {
      if (message.role === 'user') {
        const parsedPrompt = parseRecoveredClaudeGroupPrompt(message.content, message.timestamp);
        const parsedCodexPrompt = parseRecoveredCodexTranscriptPrompt(message.content, message.timestamp);
        if (currentPrompt?.lastAssistant?.content.trim()) {
          if (parsedPrompt) {
            const bucket = responseCandidates.get(currentPrompt.snapshotSeq) ?? {};
            bucket[participant.id] = {
              content: currentPrompt.lastAssistant.content,
              timestamp: currentPrompt.lastAssistant.timestamp,
              sourceSessionId: backing.id,
            };
            responseCandidates.set(currentPrompt.snapshotSeq, bucket);
          } else if (
            parsedCodexPrompt &&
            longestCodexTranscript &&
            parsedCodexPrompt.length >= longestCodexTranscript.entries.length
          ) {
            longestCodexTranscript = {
              entries: parsedCodexPrompt,
              finalReply: {
                content: currentPrompt.lastAssistant.content,
                timestamp: currentPrompt.lastAssistant.timestamp,
                sourceSessionId: backing.id,
                participantId: participant.id,
              },
            };
          }
        }
        currentPrompt = parsedPrompt
          ? {
              snapshotSeq: parsedPrompt.snapshotSeq,
              lastAssistant: null,
            }
          : parsedCodexPrompt
            ? {
                snapshotSeq: parsedCodexPrompt.length,
                lastAssistant: null,
              }
            : null;
        continue;
      }

      if (message.role === 'assistant' && currentPrompt) {
        currentPrompt.lastAssistant = message;
      }
    }

    if (currentPrompt?.lastAssistant?.content.trim()) {
      if (messagesBySeq.size > 0) {
        const bucket = responseCandidates.get(currentPrompt.snapshotSeq) ?? {};
        bucket[participant.id] = {
          content: currentPrompt.lastAssistant.content,
          timestamp: currentPrompt.lastAssistant.timestamp,
          sourceSessionId: backing.id,
        };
        responseCandidates.set(currentPrompt.snapshotSeq, bucket);
      } else if (longestCodexTranscript) {
        longestCodexTranscript = {
          ...longestCodexTranscript,
          finalReply: {
            content: currentPrompt.lastAssistant.content,
            timestamp: currentPrompt.lastAssistant.timestamp,
            sourceSessionId: backing.id,
            participantId: participant.id,
          },
        };
      }
    }
  }

  if (messagesBySeq.size === 0 && longestCodexTranscript?.entries.length) {
    longestCodexTranscript.entries.forEach((message, index) => {
      messagesBySeq.set(index + 1, {
        ...message,
        seq: index + 1,
      });
    });

    const lastRecovered = [...messagesBySeq.values()].at(-1);
    if (
      longestCodexTranscript.finalReply?.content.trim() &&
      longestCodexTranscript.finalReply.content.trim() !== lastRecovered?.content.trim()
    ) {
      const participant = roomSession.group.participants.find(
        (candidate) => candidate.id === longestCodexTranscript.finalReply?.participantId,
      );
      if (participant) {
        const nextSeq = messagesBySeq.size + 1;
        messagesBySeq.set(nextSeq, {
          id: randomUUID(),
          role: 'assistant',
          seq: nextSeq,
          timestamp: longestCodexTranscript.finalReply.timestamp,
          title:
            firstMeaningfulLine(longestCodexTranscript.finalReply.content).slice(0, 42) ||
            `${participant.label} response`,
          content: longestCodexTranscript.finalReply.content,
          speakerId: participant.id,
          speakerLabel: participant.label,
          provider: participant.provider,
          sourceSessionId: longestCodexTranscript.finalReply.sourceSessionId,
          status: 'complete',
        });
      }
    }
  }

  for (const [snapshotSeq, bucket] of [...responseCandidates.entries()].sort((left, right) => left[0] - right[0])) {
    const orderedParticipants = roomSession.group.participants.filter(
      (participant) => bucket[participant.id]?.content.trim(),
    );

    orderedParticipants.forEach((participant, index) => {
      const expectedSeq = snapshotSeq + index + 1;
      if (messagesBySeq.has(expectedSeq)) {
        return;
      }

      const candidate = bucket[participant.id];
      if (!candidate) {
        return;
      }

      messagesBySeq.set(expectedSeq, {
        id: randomUUID(),
        role: 'assistant',
        seq: expectedSeq,
        timestamp: candidate.timestamp,
        title:
          firstMeaningfulLine(candidate.content).slice(0, 42) ||
          `${participant.label} response`,
        content: candidate.content,
        speakerId: participant.id,
        speakerLabel: participant.label,
        provider: participant.provider,
        sourceSessionId: candidate.sourceSessionId,
        status: 'complete',
      });
    });
  }

  return [...messagesBySeq.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, message]) => message);
};

const getRecoveredParticipantLastAppliedRoomSeqs = (
  roomSession: SessionRecord,
  participantBackings: Map<GroupParticipantId, SessionRecord>,
) => {
  if (roomSession.group?.kind !== 'room') {
    return {} as Partial<Record<GroupParticipantId, number>>;
  }

  const recovered: Partial<Record<GroupParticipantId, number>> = {};

  for (const participant of roomSession.group.participants) {
    const backing = participantBackings.get(participant.id);
    if (!backing) {
      continue;
    }

    let maxSnapshotSeq = 0;
    for (const message of backing.messages ?? []) {
      if (message.role !== 'user') {
        continue;
      }

      const parsedPrompt = parseRecoveredClaudeGroupPrompt(message.content, message.timestamp);
      if (parsedPrompt) {
        maxSnapshotSeq = Math.max(maxSnapshotSeq, parsedPrompt.snapshotSeq);
        continue;
      }

      const parsedCodexPrompt = parseRecoveredCodexTranscriptPrompt(message.content, message.timestamp);
      if (parsedCodexPrompt) {
        maxSnapshotSeq = Math.max(maxSnapshotSeq, parsedCodexPrompt.length);
      }
    }

    if (maxSnapshotSeq > 0) {
      recovered[participant.id] = maxSnapshotSeq;
    }
  }

  return recovered;
};

const getRecoveredRoomMessageMaxSeq = (messages: ConversationMessage[] | undefined) =>
  (messages ?? []).reduce(
    (maxSeq, message) => Math.max(maxSeq, typeof message.seq === 'number' ? message.seq : 0),
    0,
  );

const getRecoveredRoomMessageContentSize = (messages: ConversationMessage[] | undefined) =>
  (messages ?? []).reduce((sum, message) => sum + message.content.trim().length, 0);

const shouldApplyRecoveredRoomMessages = (
  currentMessages: ConversationMessage[] | undefined,
  reconstructedMessages: ConversationMessage[],
) => {
  if (reconstructedMessages.length === 0) {
    return false;
  }

  const current = currentMessages ?? [];
  if (current.length === 0) {
    return true;
  }

  // Skip recovery when a live turn is in flight: reconstructed messages
  // hardcode status='complete', so replacing the room would prematurely
  // finalize an in-progress assistant message with whatever partial content
  // the backing has streamed so far.
  const hasInFlight = current.some(
    (message) =>
      message.status === 'streaming' ||
      message.status === 'queued' ||
      message.status === 'running',
  );
  if (hasInFlight) {
    return false;
  }

  const reconstructedMaxSeq = getRecoveredRoomMessageMaxSeq(reconstructedMessages);
  const currentMaxSeq = getRecoveredRoomMessageMaxSeq(current);
  if (reconstructedMaxSeq > currentMaxSeq) {
    return true;
  }

  const reconstructedContentSize = getRecoveredRoomMessageContentSize(reconstructedMessages);
  const currentContentSize = getRecoveredRoomMessageContentSize(current);
  return reconstructedMessages.length >= current.length && reconstructedContentSize > currentContentSize;
};

const applyRecoveredRoomMessages = (
  roomSession: SessionRecord,
  reconstructedMessages: ConversationMessage[],
  participantLastAppliedRoomSeqs: Partial<Record<GroupParticipantId, number>>,
) => {
  if (roomSession.group?.kind !== 'room' || reconstructedMessages.length === 0) {
    return;
  }

  const maxSeq = getRecoveredRoomMessageMaxSeq(reconstructedMessages);
  roomSession.messages = reconstructedMessages;
  roomSession.group = {
    ...roomSession.group,
    nextMessageSeq: maxSeq + 1,
    participants: roomSession.group.participants.map((participant) => ({
      ...participant,
      lastAppliedRoomSeq:
        participantLastAppliedRoomSeqs[participant.id] ?? participant.lastAppliedRoomSeq,
    })),
  };
  const latest = reconstructedMessages[reconstructedMessages.length - 1];
  roomSession.preview = latest?.content || roomSession.preview;
  roomSession.timeLabel = latest?.timestamp || roomSession.timeLabel;
};

function recoverProjectGroupSessions(project: ProjectRecord): ProjectRecord {
  const sessions = project.dreams.flatMap((dream) => dream.sessions as SessionRecord[]);
  const dreamById = new Map(project.dreams.map((dream) => [dream.id, dream]));
  const roomByKey = new Map<string, SessionRecord>();

  for (const session of sessions) {
    if (session.sessionKind === 'group' || session.group?.kind === 'room') {
      const roomTitle = getRecoveredRoomTitle(session.title);
      roomByKey.set(getRecoveredGroupKey(session.workspace, roomTitle), session);
    }
  }

  const orphanBuckets = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    if (!isOrphanGroupImportedSession(session)) {
      continue;
    }

    const roomTitle = getRecoveredRoomTitle(session.title);
    const key = getRecoveredGroupKey(session.workspace, roomTitle);
    const bucket = orphanBuckets.get(key) ?? [];
    bucket.push(session);
    orphanBuckets.set(key, bucket);
  }

  for (const [key, bucket] of orphanBuckets) {
    const sortedBucket = [...bucket].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const latest = sortedBucket[0];
    if (!latest) {
      continue;
    }

    const roomTitle = getRecoveredRoomTitle(latest.title);
    const targetDream =
      dreamById.get(latest.dreamId) ??
      project.dreams.find((dream) => dream.isTemporary) ??
      project.dreams[0];
    if (!targetDream) {
      continue;
    }

    let roomSession = roomByKey.get(key);
    if (!roomSession) {
      roomSession = createBaseSession(project, targetDream, roomTitle, latest.workspace, undefined, 'group');
      roomSession.preview = latest.preview || roomSession.preview;
      roomSession.timeLabel = latest.timeLabel;
      roomSession.updatedAt = latest.updatedAt;
      roomSession.groups = latest.groups ?? [];
      roomSession.contextReferences = normalizeContextReferences(latest.contextReferences);
      roomSession.tokenUsage = {
        contextWindow: 0,
        used: 0,
        input: 0,
        output: 0,
        cached: 0,
        windowSource: 'unknown',
      };
      roomSession.branchSnapshot = latest.branchSnapshot ?? makeEmptyBranchSnapshot(latest.workspace);
      roomSession.messages = [];
      roomSession.group = {
        kind: 'room',
        nextMessageSeq: 1,
        participants: [],
      };
      targetDream.sessions.unshift(roomSession);
      roomByKey.set(key, roomSession);
    } else {
      roomSession.title = roomTitle;
      roomSession.sessionKind = 'group';
      roomSession.hidden = false;
      roomSession.provider = undefined;
      roomSession.model = '';
      roomSession.claudeSessionId = undefined;
      roomSession.codexThreadId = undefined;
      roomSession.instructionPrompt = undefined;
      roomSession.group = roomSession.group?.kind === 'room'
        ? roomSession.group
        : {
            kind: 'room',
            nextMessageSeq: 1,
            participants: [],
          };
    }

    const participantBackings = new Map<GroupParticipantId, SessionRecord>();
    for (const session of sessions) {
      if (
        session.group?.kind === 'member' &&
        session.group.roomSessionId === roomSession.id &&
        (session.sessionKind === 'group_member' || session.hidden)
      ) {
        participantBackings.set(session.group.participantId, session);
      }
    }

    for (const provider of ['claude', 'codex'] as SessionProvider[]) {
      const participantId = getParticipantIdForProvider(provider);
      const orphan = sortedBucket.find((session) => normalizeSessionProvider(session.provider) === provider);
      let memberSession = orphan ?? participantBackings.get(participantId);

      if (!memberSession) {
        memberSession = createGroupMemberSession(project, targetDream, roomSession, participantId, provider);
        targetDream.sessions.splice(1, 0, memberSession);
      }

      memberSession.title = getGroupBackingSessionTitle(roomTitle);
      memberSession.sessionKind = 'group_member';
      memberSession.hidden = true;
      memberSession.provider = provider;
      memberSession.group = {
        kind: 'member',
        roomSessionId: roomSession.id,
        participantId,
        speakerLabel: getSpeakerLabelForProvider(provider),
      };

      participantBackings.set(participantId, memberSession);
    }

    roomSession.group = {
      kind: 'room',
      nextMessageSeq: roomSession.group?.kind === 'room' ? roomSession.group.nextMessageSeq : 1,
      participants: (['claude', 'codex'] as GroupParticipantId[]).map((participantId) => {
        const memberSession = participantBackings.get(participantId);
        const provider = participantId === 'codex' ? 'codex' : 'claude';
        if (!memberSession) {
          throw new Error(`Missing recovered group backing session for ${participantId}.`);
        }

        return buildGroupParticipantRecord(
          participantId,
          provider,
          memberSession.id,
          memberSession.model || getDefaultModelForProvider(provider),
        );
      }),
    };

    const reconstructedMessages = reconstructRecoveredRoomMessages(roomSession, participantBackings);
    const participantLastAppliedRoomSeqs = getRecoveredParticipantLastAppliedRoomSeqs(
      roomSession,
      participantBackings,
    );
    if (shouldApplyRecoveredRoomMessages(roomSession.messages, reconstructedMessages)) {
      applyRecoveredRoomMessages(
        roomSession,
        reconstructedMessages,
        participantLastAppliedRoomSeqs,
      );
    }

    sortedBucket.forEach((session) => {
      if (session.id === participantBackings.get(getParticipantIdForProvider(normalizeSessionProvider(session.provider)))?.id) {
        return;
      }

      session.hidden = true;
    });
  }

  for (const roomSession of sessions) {
    if (roomSession.group?.kind !== 'room') {
      continue;
    }

    roomSession.sessionKind = 'group';
    roomSession.hidden = false;
    roomSession.provider = undefined;
    roomSession.model = '';
    roomSession.claudeSessionId = undefined;
    roomSession.codexThreadId = undefined;

    const participantBackings = new Map<GroupParticipantId, SessionRecord>();
    for (const session of sessions) {
      if (
        session.group?.kind === 'member' &&
        session.group.roomSessionId === roomSession.id &&
        (session.sessionKind === 'group_member' || session.hidden)
      ) {
        participantBackings.set(session.group.participantId, session);
      }
    }

    const reconstructedMessages = reconstructRecoveredRoomMessages(roomSession, participantBackings);
    const participantLastAppliedRoomSeqs = getRecoveredParticipantLastAppliedRoomSeqs(
      roomSession,
      participantBackings,
    );
    if (shouldApplyRecoveredRoomMessages(roomSession.messages, reconstructedMessages)) {
      applyRecoveredRoomMessages(
        roomSession,
        reconstructedMessages,
        participantLastAppliedRoomSeqs,
      );
    }
  }

  return project;
}

const toUpdatedAt = (timestamp: string | number | undefined) => {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const getNativeClaudeProjectDirPaths = (rootPath: string) =>
  getClaudeProjectDirNameCandidates(rootPath).map((dirName) => path.join(nativeClaudeProjectsRoot(), dirName));

const getExistingNativeClaudeProjectDirPaths = (rootPath: string) =>
  getNativeClaudeProjectDirPaths(rootPath).filter((candidate) => existsSync(candidate));

const getExistingNativeClaudeProjectTreeDirPaths = async (rootPath: string) => {
  const exactPaths = getExistingNativeClaudeProjectDirPaths(rootPath);
  const rootDirNames = getClaudeProjectDirNameCandidates(rootPath);
  if (rootDirNames.length === 0) {
    return exactPaths;
  }

  const normalizedRootDirNames = rootDirNames.map((dirName) => dirName.toLowerCase());
  const nativeRoot = nativeClaudeProjectsRoot();
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await readdir(nativeRoot, { withFileTypes: true });
  } catch {
    return exactPaths;
  }

  const paths = new Set(exactPaths);
  dirents.forEach((dirent) => {
    if (!dirent.isDirectory()) {
      return;
    }
    const normalizedName = dirent.name.toLowerCase();
    if (
      normalizedRootDirNames.some(
        (rootDirName) => normalizedName === rootDirName || normalizedName.startsWith(`${rootDirName}-`),
      )
    ) {
      paths.add(path.join(nativeRoot, dirent.name));
    }
  });

  return [...paths];
};

const nativeClaudeSessionFilePath = (rootPath: string, claudeSessionId: string) => {
  const existingDir =
    getExistingNativeClaudeProjectDirPaths(rootPath)[0] ??
    getNativeClaudeProjectDirPaths(rootPath)[0];
  if (!existingDir) {
    return null;
  }

  return path.join(existingDir, `${claudeSessionId}.jsonl`);
};

const syncNativeClaudeSessionResumeMetadata = async (
  rootPath: string,
  claudeSessionId: string,
  title: string,
) => {
  const display = firstNativeClaudeHistoryDisplayLine(title);
  const sessionId = claudeSessionId.trim();
  if (!display || !sessionId) {
    return;
  }

  const filePath = nativeClaudeSessionFilePath(rootPath, sessionId);
  if (!filePath) {
    return;
  }

  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const aiTitleLine = JSON.stringify({
    type: 'ai-title',
    aiTitle: display,
    sessionId,
  });
  let hasAiTitle = false;
  let changed = false;
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        let lineChanged = false;
        // Claude 2.1.x's interactive resume picker ignores SDK/print sessions.
        if (parsed.entrypoint === 'sdk-cli') {
          parsed.entrypoint = 'cli';
          lineChanged = true;
        }
        if (parsed.promptSource === 'sdk') {
          parsed.promptSource = 'typed';
          lineChanged = true;
        }
        if (parsed.type === 'ai-title' && parsed.sessionId === sessionId) {
          hasAiTitle = true;
          if (parsed.aiTitle !== display) {
            parsed.aiTitle = display;
            lineChanged = true;
          }
        }

        if (lineChanged) {
          changed = true;
          return JSON.stringify(parsed);
        }
      } catch {
        return line;
      }

      return line;
    });

  if (!hasAiTitle) {
    lines.unshift(aiTitleLine);
    changed = true;
  }

  if (changed) {
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  }
};

const safelySyncNativeClaudeSessionResumeMetadata = async (
  rootPath: string,
  claudeSessionId: string,
  title: string,
) => {
  try {
    await syncNativeClaudeSessionResumeMetadata(rootPath, claudeSessionId, title);
  } catch (error) {
    console.warn(
      `[SESSION_STORE] Failed to update native Claude resume metadata for "${claudeSessionId}": ${describeError(error)}`,
    );
  }
};

const extractTextFromContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (typeof block === 'string') {
        return block;
      }
      if (block && typeof block === 'object' && 'type' in block && (block as { type?: string }).type === 'text') {
        return (block as { text?: string }).text ?? '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

const extractTextFromMessageBlock = (block: unknown): string => {
  if (typeof block === 'string') {
    return block;
  }
  if (!block || typeof block !== 'object') {
    return '';
  }

  const typedBlock = block as { type?: string; text?: unknown; content?: unknown };
  if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
    return typedBlock.text;
  }

  return extractTextFromContent(typedBlock.content);
};

const shouldSkipSyntheticAssistantPlaceholder = (model: string | undefined, content: string) =>
  model?.trim() === '<synthetic>' && content.trim() === 'No response requested.';

const firstMeaningfulLine = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('<')) ?? '';

const summarizeToolInput = (toolName: string, input: unknown) => {
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.command === 'string') {
      return `${toolName}(${record.command})`;
    }
    if (typeof record.pattern === 'string') {
      return `${toolName}(pattern: ${record.pattern})`;
    }
    if (typeof record.file_path === 'string') {
      return `${toolName}(${record.file_path})`;
    }
  }

  return `${toolName}`;
};

const summarizeToolResult = (content: string) => {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    return 'No output.';
  }

  const head = lines[0];
  if (lines.length === 1) {
    return head;
  }

  return `${head}\n... ${lines.length - 1} more lines`;
};

const toTimeLabel = (timestamp: string | number | undefined) => {
  if (!timestamp) {
    return 'Imported';
  }
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'Imported';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const parseNativeClaudeSessionFile = async (filePath: string) => {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages: ConversationMessage[] = [];
  const toolTraceById = new Map<string, ConversationMessage>();
  const interactiveQuestionToolIds = new Set<string>();
  let workspace = '';
  let model = 'claude';
  let firstUserText = '';
  let lastAssistantText = '';
  let lastErrorText = '';
  let lastTimestamp: string | number | undefined;
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let customTitle = '';
  let interrupted = false;
  let backgroundTaskNotificationPending = false;
  let pendingBackgroundTaskResult = '';

  const flushPendingBackgroundTaskResult = (timestamp: string | number | undefined) => {
    const content = pendingBackgroundTaskResult.trim();
    backgroundTaskNotificationPending = false;
    pendingBackgroundTaskResult = '';
    if (!content) {
      return;
    }

    const text =
      firstMeaningfulLine(content) ||
      content.split(/\r?\n/)[0]?.trim() ||
      'Background task result';
    lastAssistantText = text;
    messages.push({
      id: randomUUID(),
      role: 'assistant',
      kind: 'message',
      timestamp: toTimeLabel(timestamp),
      title: text.slice(0, 42),
      content,
      status: 'complete',
    });
  };

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.cwd === 'string') {
      workspace = parsed.cwd;
    }
    if (typeof parsed.sessionId === 'string') {
      nativeSessionId = parsed.sessionId;
    }
    if (parsed.type === 'custom-title' && typeof parsed.customTitle === 'string' && parsed.customTitle.trim()) {
      customTitle = parsed.customTitle.trim();
    }
    if (parsed.timestamp) {
      lastTimestamp = parsed.timestamp as string | number;
    }
    const backgroundTaskNotification = extractBackgroundTaskNotificationContent(parsed);
    if (backgroundTaskNotification) {
      backgroundTaskNotificationPending = true;
      pendingBackgroundTaskResult =
        parseBackgroundTaskNotificationContent(backgroundTaskNotification)?.result?.trim() ??
        pendingBackgroundTaskResult;
      if (parsed.type === 'queue-operation') {
        continue;
      }
    }

    if (parsed.type === 'user' && parsed.isMeta !== true) {
      const contentValue = (parsed.message as { content?: unknown })?.content;
      if (Array.isArray(contentValue)) {
        for (const block of contentValue) {
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            (block as { type?: string }).type === 'tool_result'
          ) {
            const resultText = extractTextFromContent((block as { content?: unknown }).content);
            const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
            const interactiveAnswer = toolUseId
              ? formatImportedAskUserQuestionAnswer(
                  (parsed as { toolUseResult?: unknown }).toolUseResult,
                  resultText || 'User completed the interactive question.',
                )
              : null;
            if (toolUseId && interactiveQuestionToolIds.has(toolUseId) && interactiveAnswer) {
              messages.push({
                id: randomUUID(),
                role: 'user',
                kind: 'message',
                timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
                title: interactiveAnswer.title.slice(0, 42),
                content: interactiveAnswer.content,
                status: 'complete',
              });
              continue;
            }
            if (toolUseId && toolTraceById.has(toolUseId)) {
              const current = toolTraceById.get(toolUseId)!;
              current.content = `${current.content}\n${summarizeToolResult(resultText || 'Tool result returned.')}`;
              current.status = (block as { is_error?: boolean }).is_error ? 'error' : 'success';
            } else {
              messages.push({
                id: randomUUID(),
                role: 'system',
                kind: 'tool_result',
                timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
                title: 'Tool Result',
                content: summarizeToolResult(resultText || 'Tool result returned.'),
                status: (block as { is_error?: boolean }).is_error ? 'error' : 'success',
              });
            }
            continue;
          }

          const content = extractTextFromMessageBlock(block);
          const text = firstMeaningfulLine(content);
          if (!text) {
            continue;
          }
          if (isBackgroundTaskNotificationContent(content)) {
            backgroundTaskNotificationPending = true;
            pendingBackgroundTaskResult =
              parseBackgroundTaskNotificationContent(content)?.result?.trim() ??
              pendingBackgroundTaskResult;
            continue;
          }
          if (pendingBackgroundTaskResult) {
            flushPendingBackgroundTaskResult(parsed.timestamp as string | number | undefined);
          }
          if (!firstUserText) {
            firstUserText = text;
          }
          messages.push({
            id: randomUUID(),
            role: 'user',
            kind: 'message',
            timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
            title: text.slice(0, 42),
            content,
            status: 'complete',
          });
        }
        continue;
      }

      const content = extractTextFromContent(contentValue);
      const text = firstMeaningfulLine(content);
      if (!text) {
        continue;
      }
      if (isBackgroundTaskNotificationContent(content)) {
        backgroundTaskNotificationPending = true;
        pendingBackgroundTaskResult =
          parseBackgroundTaskNotificationContent(content)?.result?.trim() ??
          pendingBackgroundTaskResult;
        continue;
      }
      if (pendingBackgroundTaskResult) {
        flushPendingBackgroundTaskResult(parsed.timestamp as string | number | undefined);
      }
      if (!firstUserText) {
        firstUserText = text;
      }
      messages.push({
        id: randomUUID(),
        role: 'user',
        kind: 'message',
        timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
        title: text.slice(0, 42),
        content,
        status: 'complete',
      });
      continue;
    }

    if (parsed.type === 'assistant') {
      const messageObj = parsed.message as { model?: string; content?: unknown };
      if (typeof messageObj?.model === 'string' && !isClaudeSyntheticModel(messageObj.model)) {
        model = messageObj.model;
      }
      if (!Array.isArray(messageObj?.content)) {
        const rawContent = extractTextFromContent(messageObj?.content);
        const content =
          backgroundTaskNotificationPending
            ? stripLeadingBackgroundTaskFollowupFromAssistantText(rawContent) ?? rawContent
            : rawContent;
        const text = firstMeaningfulLine(content);
        if (!text) {
          continue;
        }
        if (shouldSkipSyntheticAssistantPlaceholder(messageObj?.model, content)) {
          if (pendingBackgroundTaskResult) {
            flushPendingBackgroundTaskResult(parsed.timestamp as string | number | undefined);
          }
          continue;
        }
        if (backgroundTaskNotificationPending) {
          if (isIgnorableBackgroundTaskFollowupText(content)) {
            flushPendingBackgroundTaskResult(parsed.timestamp as string | number | undefined);
            continue;
          }
          backgroundTaskNotificationPending = false;
          pendingBackgroundTaskResult = '';
        }
        lastAssistantText = text;
        messages.push({
          id: randomUUID(),
          role: 'assistant',
          kind: 'message',
          timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
          title: text.slice(0, 42),
          content,
          status: 'complete',
        });
        continue;
      }

      for (const block of messageObj.content) {
        if (!block || typeof block !== 'object') {
          continue;
        }

        const blockType = (block as { type?: string }).type;

        if (blockType === 'text') {
          const rawContent = (block as { text?: string }).text ?? '';
          const content =
            backgroundTaskNotificationPending
              ? stripLeadingBackgroundTaskFollowupFromAssistantText(rawContent) ?? rawContent
              : rawContent;
          const text = firstMeaningfulLine(content);
          if (!text) {
            continue;
          }
          if (shouldSkipSyntheticAssistantPlaceholder(messageObj?.model, content)) {
            if (pendingBackgroundTaskResult) {
              flushPendingBackgroundTaskResult(parsed.timestamp as string | number | undefined);
            }
            continue;
          }
          if (backgroundTaskNotificationPending) {
            if (isIgnorableBackgroundTaskFollowupText(content)) {
              flushPendingBackgroundTaskResult(parsed.timestamp as string | number | undefined);
              continue;
            }
            backgroundTaskNotificationPending = false;
            pendingBackgroundTaskResult = '';
          }
          if (isIgnorableBackgroundTaskFollowupText(content) && messages.some((message) => message.role === 'assistant')) {
            continue;
          }
          lastAssistantText = text;
          messages.push({
            id: randomUUID(),
            role: 'assistant',
            kind: 'message',
            timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
            title: text.slice(0, 42),
            content,
            status: 'complete',
          });
          continue;
        }

        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          continue;
        }

        if (blockType === 'tool_use') {
          const tool = block as { id?: string; name?: string; input?: unknown };
          const interactivePrompt =
            tool.name === 'AskUserQuestion' ? formatImportedAskUserQuestionPrompt(tool.input) : null;
          if (interactivePrompt) {
            const prior = messages[messages.length - 1];
            if (
              prior &&
              prior.role === 'assistant' &&
              prior.kind === 'message' &&
              prior.timestamp === toTimeLabel(parsed.timestamp as string | number | undefined)
            ) {
              prior.content = `${prior.content.trimEnd()}\n\n${interactivePrompt.content}`;
            } else {
              messages.push({
                id: randomUUID(),
                role: 'assistant',
                kind: 'message',
                timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
                title: interactivePrompt.title.slice(0, 42),
                content: interactivePrompt.content,
                status: 'complete',
              });
            }
            if (tool.id) {
              interactiveQuestionToolIds.add(tool.id);
            }
            continue;
          }
          const toolMessage: ConversationMessage = {
            id: tool.id ?? randomUUID(),
            role: 'system',
            kind: 'tool_use',
            timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
            title: tool.name ?? 'Tool Use',
            content: summarizeToolInput(tool.name ?? 'Tool Use', tool.input),
            recordedDiff: buildRecordedCodeChangeDiff(tool.name ?? 'Tool Use', tool.input),
            status: 'running',
          };
          messages.push(toolMessage);
          if (tool.id) {
            toolTraceById.set(tool.id, toolMessage);
          }
        }
      }
    }

    if (parsed.type === 'progress') {
      const data = parsed.data as { type?: string; hookEvent?: string; statusMessage?: string; command?: string };
      if (
        shouldIgnoreImportedProgress({
          dataType: data?.type,
          hookEvent: data?.hookEvent,
          command: data?.command,
        })
      ) {
        continue;
      }
      const toolUseId = parsed.toolUseID as string | undefined;
      if (toolUseId && toolTraceById.has(toolUseId)) {
        const current = toolTraceById.get(toolUseId)!;
        current.content = `${current.content}\n${data?.statusMessage ?? data?.command ?? 'Progress update'}`;
        current.status = 'running';
      } else {
        messages.push({
          id: randomUUID(),
          role: 'system',
          kind: 'progress',
          timestamp: toTimeLabel(parsed.timestamp as string | number | undefined),
          title: 'Progress',
          content: data?.statusMessage ?? data?.command ?? 'Progress update',
          status: 'running',
        });
      }
    }

    if (parsed.type === 'system' && parsed.subtype === 'api_error') {
      const error = parsed.error as
        | { error?: { message?: string; error?: string }; message?: string }
        | undefined;
      lastErrorText =
        error?.error?.error?.trim?.() ||
        error?.error?.message?.trim?.() ||
        error?.message?.trim?.() ||
        'API error';
      continue;
    }
  }

  if (pendingBackgroundTaskResult) {
    flushPendingBackgroundTaskResult(lastTimestamp);
  }

  if (messages.some((message) => message.role === 'user' && message.content.includes('[Request interrupted by user]'))) {
    interrupted = true;
  }

  if (messages.length === 0 && !firstUserText && !lastAssistantText && !lastErrorText && !interrupted) {
    return null;
  }

  const summary = deriveImportedSessionSummary({
    customTitle,
    firstUserText,
    lastAssistantText,
    lastErrorText,
    interrupted,
    nativeSessionId,
    providerName: 'Claude',
  });

  return {
    nativeSessionId,
    workspace,
    model,
    messages,
    title: summary.title,
    preview: summary.preview,
    timeLabel: toTimeLabel(lastTimestamp),
    updatedAt: toUpdatedAt(lastTimestamp),
  };
};

const parseCachedNativeClaudeSessionFile = async (
  filePath: string,
  cache?: NativeImportCache,
): Promise<ParsedNativeClaudeSession | null> => {
  if (!cache) {
    try {
      return await parseNativeClaudeSessionFile(filePath);
    } catch {
      return null;
    }
  }

  if (!cache.parsedClaudeSessionsByFile) {
    cache.parsedClaudeSessionsByFile = new Map();
  }

  if (cache.parsedClaudeSessionsByFile.has(filePath)) {
    return cache.parsedClaudeSessionsByFile.get(filePath) ?? null;
  }

  let parsed: ParsedNativeClaudeSession | null = null;
  try {
    parsed = await parseNativeClaudeSessionFile(filePath);
  } catch {
    parsed = null;
  }

  cache.parsedClaudeSessionsByFile.set(filePath, parsed);
  return parsed;
};

const codexSessionsRoot = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.codex', 'sessions');
const codexArchivedSessionsRoot = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.codex', 'archived_sessions');
const codexSessionIndexPath = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.codex', 'session_index.jsonl');

const listJsonlFilesRecursively = async (rootDir: string): Promise<string[]> => {
  const results: string[] = [];
  const visit = async (currentDir: string) => {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }
  };

  await visit(rootDir);
  return results;
};

const extractCodexMessageText = (content: unknown): string => {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      const typedBlock = block as { type?: string; text?: unknown };
      if (
        (typedBlock.type === 'input_text' || typedBlock.type === 'output_text' || typedBlock.type === 'text') &&
        typeof typedBlock.text === 'string'
      ) {
        return typedBlock.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
};

const getImportedCodexString = (value: unknown) => (typeof value === 'string' ? value : '');

const normalizeImportedCodexToolName = (value: string) =>
  value.trim().startsWith('functions.') ? value.trim().slice('functions.'.length) : value.trim();

const stringifyImportedCodexStructuredValue = (value: unknown): string => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return stringifyImportedCodexStructuredValue(JSON.parse(trimmed));
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => stringifyImportedCodexStructuredValue(entry))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }

  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.output === 'string' && candidate.output.trim()) {
      return candidate.output.trim();
    }
    if (typeof candidate.text === 'string' && candidate.text.trim()) {
      return candidate.text.trim();
    }
    if (typeof candidate.message === 'string' && candidate.message.trim()) {
      return candidate.message.trim();
    }
    if (Array.isArray(candidate.content)) {
      const nested = stringifyImportedCodexStructuredValue(candidate.content);
      if (nested) {
        return nested;
      }
    }
    if (Array.isArray(candidate.contentItems)) {
      const nested = stringifyImportedCodexStructuredValue(candidate.contentItems);
      if (nested) {
        return nested;
      }
    }
    if (candidate.metadata && typeof candidate.metadata === 'object') {
      const nested = stringifyImportedCodexStructuredValue(candidate.metadata);
      if (nested) {
        return nested;
      }
    }
    return JSON.stringify(candidate, null, 2).trim();
  }

  return '';
};

const parseImportedCodexArgumentsObject = (value: unknown) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const buildImportedCodexCodeChangeSuccessLine = (toolName: string) => {
  switch (normalizeImportedCodexToolName(toolName)) {
    case 'Edit':
    case 'MultiEdit':
      return 'The file has been updated successfully.';
    case 'Write':
      return 'The file has been written successfully.';
    case 'ApplyPatch':
    case 'apply_patch':
      return 'The file has been patched successfully.';
    default:
      return '';
  }
};

const buildImportedCodexFunctionTraceMessage = (payload: {
  item: Record<string, unknown>;
  status: 'running' | 'success' | 'error';
  previous?: ConversationMessage;
  timestamp?: string;
}) => {
  const callId = getImportedCodexString(payload.item.call_id).trim() || getImportedCodexString(payload.item.id).trim();
  if (!callId) {
    return null;
  }

  const rawName =
    getImportedCodexString(payload.item.name).trim() ||
    getImportedCodexString(payload.item.tool).trim() ||
    payload.previous?.title ||
    'Tool';
  const name = normalizeImportedCodexToolName(rawName);
  if (name === 'shell_command') {
    return null;
  }

  const rawArguments = payload.item.arguments ?? payload.item.input ?? payload.item.prompt;
  const argumentsText = stringifyImportedCodexStructuredValue(rawArguments);
  const parsedArguments = parseImportedCodexArgumentsObject(rawArguments);
  const outputText = stringifyImportedCodexStructuredValue(
    payload.item.output ?? payload.item.result ?? payload.item.contentItems ?? payload.item.error,
  );
  const recordedDiff =
    payload.previous?.recordedDiff ??
    (parsedArguments ? buildRecordedCodeChangeDiff(name, parsedArguments) : undefined);
  const filePath = recordedDiff?.filePath || getImportedCodexString(parsedArguments?.file_path).trim();
  const contentParts = (payload.previous?.content?.trim() ?? '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!payload.previous && (filePath || argumentsText)) {
    contentParts.push(filePath || argumentsText);
  }

  if (recordedDiff && payload.status === 'success') {
    const successLine = buildImportedCodexCodeChangeSuccessLine(name);
    if (successLine && !contentParts.includes(successLine)) {
      contentParts.push(successLine);
    }
  } else if (outputText) {
    contentParts.push(outputText);
  }

  return {
    id: payload.previous?.id ?? callId,
    role: 'system' as const,
    kind: 'tool_use' as const,
    timestamp: payload.previous?.timestamp ?? payload.timestamp ?? toTimeLabel(undefined),
    title: payload.previous?.title ?? name,
    content: contentParts.join('\n\n'),
    recordedDiff,
    status: payload.status,
  };
};

const buildImportedCodexCommandTraceMessage = (payload: {
  item: Record<string, unknown>;
  status: 'success' | 'error';
  previous?: ConversationMessage;
  timestamp?: string;
}) => {
  const rawCommand = payload.item.command;
  const command =
    typeof rawCommand === 'string'
      ? rawCommand.trim()
      : Array.isArray(rawCommand)
        ? rawCommand.map((part) => (typeof part === 'string' ? part : '')).filter(Boolean).join(' ').trim()
        : '';
  if (!command) {
    return null;
  }

  const output = stringifyImportedCodexStructuredValue(
    payload.item.aggregated_output ?? payload.item.aggregatedOutput ?? payload.item.stdout ?? payload.item.stderr,
  );
  const exitCode =
    typeof payload.item.exit_code === 'number'
      ? payload.item.exit_code
      : typeof payload.item.exitCode === 'number'
        ? payload.item.exitCode
        : null;
  const contentParts = [command];
  if (output) {
    contentParts.push(output);
  }
  if (payload.status === 'error' && exitCode !== null) {
    contentParts.push(`Exit code: ${exitCode}`);
  }

  return {
    id: (payload.previous?.id ?? getImportedCodexString(payload.item.call_id).trim()) || randomUUID(),
    role: 'system' as const,
    kind: 'tool_use' as const,
    timestamp: payload.previous?.timestamp ?? payload.timestamp ?? toTimeLabel(undefined),
    title: 'Command',
    content: contentParts.join('\n\n'),
    status: payload.status,
  };
};

const isCodexImportedContextMessage = (text: string) => {
  const trimmed = text.trim();
  return (
    !trimmed ||
    trimmed.startsWith('<environment_context>') ||
    trimmed.startsWith('# AGENTS.md instructions for ') ||
    trimmed.startsWith('<INSTRUCTIONS>') ||
    trimmed.startsWith('Host behavior note:')
  );
};

const readCodexThreadNameIndex = async () => {
  const result = new Map<string, string>();
  let raw = '';
  try {
    raw = await readFile(codexSessionIndexPath(), 'utf8');
  } catch {
    return result;
  }

  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (
        typeof parsed.id === 'string' &&
        parsed.id.trim() &&
        typeof parsed.thread_name === 'string' &&
        parsed.thread_name.trim()
      ) {
        result.set(parsed.id.trim(), parsed.thread_name.trim());
      }
    } catch {
      continue;
    }
  }

  return result;
};

const boundedCatalogText = (value: string) => value.trim().slice(0, 1024);

const forEachJsonlRecord = async (
  filePath: string,
  visitor: (record: Record<string, unknown>) => boolean | void,
) => {
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        if (visitor(JSON.parse(line) as Record<string, unknown>) === false) {
          break;
        }
      } catch {
        // Native histories may contain a partial final line after a crash.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
};

const parseNativeClaudeSessionCatalogFile = async (
  filePath: string,
): Promise<NativeSessionCatalogEntry | null> => {
  let workspace = '';
  let model = '';
  let firstUserText = '';
  let lastAssistantText = '';
  let lastErrorText = '';
  let lastTimestamp: string | number | undefined;
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let customTitle = '';
  let interrupted = false;
  let hasMeaningfulContent = false;

  await forEachJsonlRecord(filePath, (parsed) => {
    if (typeof parsed.cwd === 'string') {
      workspace = parsed.cwd;
    }
    if (typeof parsed.sessionId === 'string') {
      nativeSessionId = parsed.sessionId;
    }
    if (
      (parsed.type === 'custom-title' || parsed.type === 'ai-title') &&
      typeof (parsed.customTitle ?? parsed.aiTitle) === 'string'
    ) {
      customTitle = boundedCatalogText((parsed.customTitle ?? parsed.aiTitle) as string);
    }
    if (parsed.timestamp) {
      lastTimestamp = parsed.timestamp as string | number;
    }

    if (parsed.type === 'user' && parsed.isMeta !== true) {
      if (customTitle && workspace) {
        hasMeaningfulContent = true;
        return false;
      }
      const contentValue = (parsed.message as { content?: unknown } | undefined)?.content;
      const blocks = Array.isArray(contentValue) ? contentValue : [contentValue];
      for (const block of blocks) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'tool_result'
        ) {
          continue;
        }
        const text = boundedCatalogText(firstMeaningfulLine(extractTextFromMessageBlock(block)));
        if (!text) {
          continue;
        }
        hasMeaningfulContent = true;
        firstUserText ||= text;
        interrupted ||= text.includes('[Request interrupted by user]');
      }
      return workspace && Boolean(firstUserText) ? false : undefined;
    }

    if (parsed.type === 'assistant') {
      const message = parsed.message as { model?: unknown; content?: unknown } | undefined;
      if (typeof message?.model === 'string' && !isClaudeSyntheticModel(message.model)) {
        model = message.model;
      }
      const blocks = Array.isArray(message?.content) ? message.content : [message?.content];
      for (const block of blocks) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type !== 'text'
        ) {
          continue;
        }
        const text = boundedCatalogText(firstMeaningfulLine(extractTextFromMessageBlock(block)));
        if (!text || shouldSkipSyntheticAssistantPlaceholder(message?.model as string | undefined, text)) {
          continue;
        }
        hasMeaningfulContent = true;
        lastAssistantText = text;
      }
      return workspace && Boolean(customTitle || firstUserText || lastAssistantText)
        ? false
        : undefined;
    }

    if (parsed.type === 'system' && parsed.subtype === 'api_error') {
      const error = parsed.error as
        | { error?: { message?: string; error?: string }; message?: string }
        | undefined;
      lastErrorText = boundedCatalogText(
        error?.error?.error?.trim?.() ||
          error?.error?.message?.trim?.() ||
          error?.message?.trim?.() ||
          'API error',
      );
      hasMeaningfulContent = true;
      return workspace ? false : undefined;
    }
    return undefined;
  });

  if (!hasMeaningfulContent && !customTitle && !interrupted) {
    return null;
  }
  const summary = deriveImportedSessionSummary({
    customTitle,
    firstUserText,
    lastAssistantText,
    lastErrorText,
    interrupted,
    nativeSessionId,
    providerName: 'Claude',
  });
  return {
    nativeSessionId,
    workspace,
    model,
    title: summary.title,
    preview: summary.preview,
    timeLabel: toTimeLabel(lastTimestamp),
    updatedAt: toUpdatedAt(lastTimestamp),
    filePath,
    provider: 'claude',
    sourceRevision: '',
  };
};

const parseCodexSessionCatalogFile = async (
  filePath: string,
  threadNameIndex: Map<string, string>,
): Promise<NativeSessionCatalogEntry | null> => {
  let workspace = '';
  let model = '';
  let firstUserText = '';
  let lastAssistantText = '';
  let lastTimestamp: string | number | undefined;
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let hasCatalogIdentity = false;
  let tokenUsage: TokenUsage = {
    contextWindow: 0,
    used: 0,
    input: 0,
    output: 0,
    cached: 0,
    windowSource: 'unknown',
  };

  await forEachJsonlRecord(filePath, (parsed) => {
    if (parsed.timestamp) {
      lastTimestamp = parsed.timestamp as string | number;
    }
    if (parsed.type === 'session_meta') {
      const payload = parsed.payload as { id?: unknown; cwd?: unknown } | undefined;
      if (typeof payload?.id === 'string' && payload.id.trim()) {
        nativeSessionId = payload.id.trim();
      }
      if (typeof payload?.cwd === 'string' && payload.cwd.trim()) {
        workspace = payload.cwd.trim();
      }
      if (threadNameIndex.has(nativeSessionId) && workspace) {
        hasCatalogIdentity = true;
        return false;
      }
      return undefined;
    }
    if (parsed.type === 'turn_context') {
      const payload = parsed.payload as { cwd?: unknown; model?: unknown } | undefined;
      if (typeof payload?.cwd === 'string' && payload.cwd.trim()) {
        workspace = payload.cwd.trim();
      }
      if (typeof payload?.model === 'string' && payload.model.trim()) {
        model = payload.model.trim();
      }
      return workspace && Boolean(threadNameIndex.get(nativeSessionId) || firstUserText)
        ? false
        : undefined;
    }
    if (parsed.type === 'event_msg') {
      const payload = parsed.payload as {
        type?: unknown;
        info?: {
          total_token_usage?: {
            input_tokens?: number;
            cached_input_tokens?: number;
            output_tokens?: number;
          };
          model_context_window?: number;
        };
      } | undefined;
      if (payload?.type === 'token_count' && payload.info?.total_token_usage) {
        const usage = payload.info.total_token_usage;
        const input = usage.input_tokens ?? 0;
        const cached = usage.cached_input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        tokenUsage = {
          contextWindow: payload.info.model_context_window ?? 0,
          used: input + cached + output,
          input,
          output,
          cached,
          windowSource: payload.info.model_context_window ? 'runtime' : 'unknown',
        };
      }
      return undefined;
    }
    if (parsed.type !== 'response_item') {
      return undefined;
    }
    const payload = parsed.payload as { type?: unknown; role?: unknown; content?: unknown } | undefined;
    if (payload?.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) {
      return undefined;
    }
    const text = boundedCatalogText(firstMeaningfulLine(extractCodexMessageText(payload.content)));
    if (!text || isCodexImportedContextMessage(text)) {
      return;
    }
    if (payload.role === 'user') {
      firstUserText ||= text;
      hasCatalogIdentity = true;
      return workspace ? false : undefined;
    } else if (hasCatalogIdentity) {
      lastAssistantText = text;
    }
    return undefined;
  });

  if (!hasCatalogIdentity && !threadNameIndex.has(nativeSessionId)) {
    return null;
  }
  const summary = deriveImportedSessionSummary({
    customTitle: threadNameIndex.get(nativeSessionId),
    firstUserText,
    lastAssistantText,
    nativeSessionId,
    providerName: 'Codex',
  });
  return {
    nativeSessionId,
    workspace,
    model,
    title: summary.title,
    preview: summary.preview,
    timeLabel: toTimeLabel(lastTimestamp),
    updatedAt: toUpdatedAt(lastTimestamp),
    tokenUsage,
    filePath,
    provider: 'codex',
    sourceRevision: '',
  };
};

const readNativeCatalogEntryCached = async (
  filePath: string,
  provider: SessionProvider,
  threadNameIndex = new Map<string, string>(),
  auxiliaryRevision = '',
) => {
  const fileStat = await stat(filePath);
  const cached = nativeCatalogFileCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === fileStat.mtimeMs &&
    cached.size === fileStat.size &&
    cached.auxiliaryRevision === auxiliaryRevision
  ) {
    return cached.entry;
  }
  const parsedEntry = provider === 'claude'
    ? await parseNativeClaudeSessionCatalogFile(filePath)
    : await parseCodexSessionCatalogFile(filePath, threadNameIndex);
  const entry = parsedEntry
    ? {
        ...parsedEntry,
        sourceRevision: `${fileStat.mtimeMs}:${fileStat.size}`,
        updatedAt: parsedEntry.updatedAt ?? fileStat.mtimeMs,
        timeLabel: parsedEntry.updatedAt
          ? parsedEntry.timeLabel
          : toTimeLabel(fileStat.mtimeMs),
      }
    : null;
  nativeCatalogFileCache.set(filePath, {
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    auxiliaryRevision,
    entry,
  });
  return entry;
};

const loadParsedCodexImportedSessions = async (cache?: NativeImportCache): Promise<ParsedCodexImportedSession[]> => {
  if (cache?.parsedCodexSessions) {
    return cache.parsedCodexSessions;
  }

  const files = [
    ...(await listJsonlFilesRecursively(codexSessionsRoot())),
    ...(await listJsonlFilesRecursively(codexArchivedSessionsRoot())),
  ];
  const threadNameIndex = await readCodexThreadNameIndex();
  const parsedSessions: ParsedCodexImportedSession[] = [];

  for (const file of files) {
    let parsed: Awaited<ReturnType<typeof parseCodexSessionFile>> | null = null;
    try {
      parsed = await parseCodexSessionFile(file, threadNameIndex);
    } catch {
      continue;
    }

    if (!parsed) {
      continue;
    }

    parsedSessions.push(parsed);
  }

  if (cache) {
    cache.parsedCodexSessions = parsedSessions;
  }

  return parsedSessions;
};

const parseCodexSessionFile = async (
  filePath: string,
  threadNameIndex: Map<string, string>,
) => {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages: ConversationMessage[] = [];
  const toolTraceById = new Map<string, ConversationMessage>();
  let workspace = '';
  let model = 'gpt-5.5';
  let firstUserText = '';
  let lastAssistantText = '';
  let lastErrorText = '';
  let lastTimestamp: string | number | undefined;
  let nativeSessionId = path.basename(filePath, '.jsonl');
  let tokenUsage: TokenUsage = {
    contextWindow: 0,
    used: 0,
    input: 0,
    output: 0,
    cached: 0,
    windowSource: 'unknown',
  };
  let hasMeaningfulUserMessage = false;

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.timestamp) {
      lastTimestamp = parsed.timestamp as string | number;
    }

    if (parsed.type === 'session_meta') {
      const payload = parsed.payload as { id?: unknown; cwd?: unknown } | undefined;
      if (typeof payload?.id === 'string' && payload.id.trim()) {
        nativeSessionId = payload.id.trim();
      }
      if (typeof payload?.cwd === 'string' && payload.cwd.trim()) {
        workspace = payload.cwd.trim();
      }
      continue;
    }

    if (parsed.type === 'turn_context') {
      const payload = parsed.payload as { cwd?: unknown; model?: unknown } | undefined;
      if (typeof payload?.cwd === 'string' && payload.cwd.trim()) {
        workspace = payload.cwd.trim();
      }
      if (typeof payload?.model === 'string' && payload.model.trim()) {
        model = payload.model.trim();
      }
      continue;
    }

    if (parsed.type === 'event_msg') {
      const payload = parsed.payload as
        | {
            type?: unknown;
            info?: {
              total_token_usage?: {
                input_tokens?: number;
                cached_input_tokens?: number;
                output_tokens?: number;
              };
              model_context_window?: number;
            };
            call_id?: unknown;
            id?: unknown;
            command?: unknown;
            aggregated_output?: unknown;
            aggregatedOutput?: unknown;
            exit_code?: unknown;
            exitCode?: unknown;
            status?: unknown;
          }
        | undefined;
      if (payload?.type === 'token_count' && payload.info?.total_token_usage) {
        const usage = payload.info.total_token_usage;
        const input = usage.input_tokens ?? 0;
        const cached = usage.cached_input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        tokenUsage = {
          contextWindow: payload.info.model_context_window ?? 0,
          used: input + cached + output,
          input,
          output,
          cached,
          windowSource: payload.info.model_context_window ? 'runtime' : 'unknown',
        };
        continue;
      }

      if (payload?.type === 'exec_command_end') {
        const callId = getImportedCodexString(payload.call_id).trim();
        const trace = buildImportedCodexCommandTraceMessage({
          item: payload as Record<string, unknown>,
          status:
            (typeof payload.status === 'string' && payload.status === 'failed') ||
            (typeof payload.exit_code === 'number' && payload.exit_code !== 0) ||
            (typeof payload.exitCode === 'number' && payload.exitCode !== 0)
              ? 'error'
              : 'success',
          previous: callId ? toolTraceById.get(callId) : undefined,
          timestamp: toTimeLabel(lastTimestamp),
        });
        if (trace) {
          if (callId) {
            toolTraceById.set(callId, trace);
          }
          const existingIndex = messages.findIndex((message) => message.id === trace.id);
          if (existingIndex >= 0) {
            messages[existingIndex] = trace;
          } else {
            messages.push(trace);
          }
        }
      }
      continue;
    }

    if (parsed.type !== 'response_item') {
      continue;
    }

    const payload = parsed.payload as
      | {
          type?: unknown;
          role?: unknown;
          content?: unknown;
          call_id?: unknown;
          id?: unknown;
          name?: unknown;
          tool?: unknown;
          arguments?: unknown;
          input?: unknown;
          output?: unknown;
          result?: unknown;
          contentItems?: unknown;
          error?: unknown;
        }
      | undefined;

    if (
      payload?.type === 'function_call' ||
      payload?.type === 'custom_tool_call'
    ) {
      const trace = buildImportedCodexFunctionTraceMessage({
        item: payload as Record<string, unknown>,
        status: 'running',
        timestamp: toTimeLabel(lastTimestamp),
      });
      if (trace) {
        toolTraceById.set(trace.id, trace);
        messages.push(trace);
      }
      continue;
    }

    if (
      payload?.type === 'function_call_output' ||
      payload?.type === 'custom_tool_call_output'
    ) {
      const callId = getImportedCodexString(payload.call_id).trim() || getImportedCodexString(payload.id).trim();
      const trace = buildImportedCodexFunctionTraceMessage({
        item: payload as Record<string, unknown>,
        status: payload.error ? 'error' : 'success',
        previous: callId ? toolTraceById.get(callId) : undefined,
        timestamp: toTimeLabel(lastTimestamp),
      });
      if (trace) {
        if (callId) {
          toolTraceById.set(callId, trace);
        }
        const existingIndex = messages.findIndex((message) => message.id === trace.id);
        if (existingIndex >= 0) {
          messages[existingIndex] = trace;
        } else {
          messages.push(trace);
        }
      }
      continue;
    }

    if (payload?.type !== 'message' || (payload.role !== 'user' && payload.role !== 'assistant')) {
      continue;
    }

    const text = extractCodexMessageText(payload.content);
    if (!text || isCodexImportedContextMessage(text)) {
      continue;
    }

    if (payload.role === 'user') {
      firstUserText ||= text;
      hasMeaningfulUserMessage = true;
    } else {
      if (!hasMeaningfulUserMessage) {
        continue;
      }
      lastAssistantText = text;
    }

    messages.push({
      id: randomUUID(),
      role: payload.role,
      kind: 'message',
      timestamp: toTimeLabel(lastTimestamp),
      title:
        payload.role === 'user'
          ? 'User prompt'
          : firstMeaningfulLine(text).slice(0, 42) || 'Codex response',
      content: text,
      status: 'complete',
    });
  }

  if (messages.length === 0) {
    return null;
  }

  const summary = deriveImportedSessionSummary({
    customTitle: threadNameIndex.get(nativeSessionId),
    firstUserText,
    lastAssistantText,
    lastErrorText,
    nativeSessionId,
    providerName: 'Codex',
  });

  return {
    nativeSessionId,
    workspace,
    model,
    messages,
    title: summary.title,
    preview: summary.preview,
    timeLabel: toTimeLabel(lastTimestamp),
    updatedAt: toUpdatedAt(lastTimestamp),
    tokenUsage,
  };
};

const renameNativeClaudeSession = async (rootPath: string, claudeSessionId: string, nextName: string) => {
  const filePath = nativeClaudeSessionFilePath(rootPath, claudeSessionId);
  if (!filePath) {
    return;
  }
  const title = nextName.trim();
  if (!title) {
    return;
  }

  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const nextLine = JSON.stringify({
    type: 'custom-title',
    customTitle: title,
    sessionId: claudeSessionId,
  });

  let found = false;
  const lines = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type === 'custom-title' && parsed.sessionId === claudeSessionId) {
          found = true;
          return nextLine;
        }
      } catch {
        return line;
      }

      return line;
    });

  const output = found ? lines : [nextLine, ...lines];
  await writeFile(filePath, `${output.join('\n')}\n`, 'utf8');
  await safelyUpsertNativeClaudeHistoryEntry(
    buildNativeClaudeHistoryEntryFromTitle(rootPath, claudeSessionId, title),
  );
  await safelySyncNativeClaudeSessionResumeMetadata(rootPath, claudeSessionId, title);
};

export const renameNativeCodexThread = async (codexThreadId: string, nextName: string) => {
  const threadId = codexThreadId.trim();
  const title = nextName.trim();
  if (!threadId || !title) {
    return;
  }

  let raw = '';
  try {
    raw = await readFile(codexSessionIndexPath(), 'utf8');
  } catch {
    raw = '';
  }

  const updatedAt = new Date().toISOString();
  let found = false;
  const lines = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.id === 'string' && parsed.id.trim() === threadId) {
          found = true;
          return JSON.stringify({
            ...parsed,
            id: threadId,
            thread_name: title,
            updated_at: updatedAt,
          });
        }
      } catch {
        return line;
      }

      return line;
    });

  if (!found) {
    lines.push(
      JSON.stringify({
        id: threadId,
        thread_name: title,
        updated_at: updatedAt,
      }),
    );
  }

  await mkdir(path.dirname(codexSessionIndexPath()), { recursive: true });
  await writeFile(codexSessionIndexPath(), `${lines.join('\n')}\n`, 'utf8');
};

const deleteNativeCodexThreads = async (threadIds: string[]): Promise<NativeCleanupResult> => {
  const uniqueThreadIds = [...new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean))];
  if (uniqueThreadIds.length === 0) {
    return { warnings: [] };
  }

  const threadIdSet = new Set(uniqueThreadIds);
  const files = [
    ...(await listJsonlFilesRecursively(codexSessionsRoot())),
    ...(await listJsonlFilesRecursively(codexArchivedSessionsRoot())),
  ];

  const warnings: string[] = [];
  const deleteTasks: Array<{ filePath: string; task: Promise<void> }> = [];
  for (const filePath of files) {
    const fileName = path.basename(filePath, '.jsonl');
    const quickMatch = uniqueThreadIds.some((threadId) => fileName === threadId || fileName.endsWith(`-${threadId}`));
    if (quickMatch) {
      deleteTasks.push({ filePath, task: rm(filePath, { force: true }) });
      continue;
    }

    let raw = '';
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      continue;
    }

    const matchesThread = raw
      .split(/\r?\n/)
      .some((line) => {
        if (!line) {
          return false;
        }

        try {
          const parsed = JSON.parse(line) as { type?: unknown; payload?: { id?: unknown } };
          return parsed.type === 'session_meta' && typeof parsed.payload?.id === 'string'
            ? threadIdSet.has(parsed.payload.id.trim())
            : false;
        } catch {
          return false;
        }
      });

    if (matchesThread) {
      deleteTasks.push({ filePath, task: rm(filePath, { force: true }) });
    }
  }

  const deleteResults = await Promise.allSettled(deleteTasks.map((entry) => entry.task));
  deleteResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      warnings.push(
        `Failed to delete native Codex session file "${deleteTasks[index]?.filePath}": ${describeError(result.reason)}`,
      );
    }
  });

  try {
    const raw = await readFile(codexSessionIndexPath(), 'utf8');
    const filtered = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        try {
          const parsed = JSON.parse(line) as { id?: unknown };
          return typeof parsed.id === 'string' ? !threadIdSet.has(parsed.id.trim()) : true;
        } catch {
          return true;
        }
      });
    await writeFile(codexSessionIndexPath(), filtered.length > 0 ? `${filtered.join('\n')}\n` : '', 'utf8');
  } catch (error) {
    if (!isMissingFsEntryError(error)) {
      warnings.push(
        `Failed to update native Codex session index "${codexSessionIndexPath()}": ${describeError(error)}`,
      );
    }
  }

  return { warnings };
};

const collectNativeDeleteTargets = (sessions: SessionSummary[]) => ({
  claudeSessions: sessions
    .filter((session): session is SessionSummary & { claudeSessionId: string } => Boolean(session.claudeSessionId))
    .map((session) => ({
      workspace: session.workspace,
      sessionId: session.claudeSessionId,
    })),
  codexThreadIds: sessions.flatMap((session) => (session.codexThreadId ? [session.codexThreadId] : [])),
});

const applySessionTitleRename = (
  session: SessionSummary,
  nextName: string,
  nativeRenameTasks: Array<Promise<void>>,
) => {
  const title = nextName.trim();
  if (!title) {
    return;
  }

  session.title = title;
  if (session.claudeSessionId) {
    nativeRenameTasks.push(renameNativeClaudeSession(session.workspace, session.claudeSessionId, title));
  }
  if (session.codexThreadId) {
    nativeRenameTasks.push(renameNativeCodexThread(session.codexThreadId, title));
  }
};

const latestNativeCatalogEntries = (entries: NativeSessionCatalogEntry[]) => {
  const latest = new Map<string, NativeSessionCatalogEntry>();
  for (const entry of entries) {
    const current = latest.get(entry.nativeSessionId);
    if (!current || (entry.updatedAt ?? 0) >= (current.updatedAt ?? 0)) {
      latest.set(entry.nativeSessionId, entry);
    }
  }
  return [...latest.values()];
};

const applyNativeCatalogEntries = (
  project: ProjectRecord,
  entries: NativeSessionCatalogEntry[],
  deletedImports: AppState['deletedImports'],
) => {
  const temporary = project.dreams.find((dream) => dream.isTemporary);
  if (!temporary) {
    return;
  }
  const existingSessions = [...temporary.sessions] as SessionRecord[];
  const projectSessions = project.dreams.flatMap((dream) => dream.sessions) as SessionRecord[];
  const existingDreamBySessionId = mapSessionDreams(project);
  const importedSessions: SessionRecord[] = [];
  const seenNativeIds = new Set<string>();
  const provider = entries[0]?.provider;
  if (!provider) {
    return;
  }
  const sessionIdKey = provider === 'claude' ? 'claudeSessionId' : 'codexThreadId';
  const deletedIds = provider === 'claude'
    ? deletedImports.claudeSessionIds
    : deletedImports.codexThreadIds;

  for (const parsed of latestNativeCatalogEntries(entries).sort(
    (left, right) => (left.updatedAt ?? 0) - (right.updatedAt ?? 0),
  )) {
    if (deletedIds.includes(parsed.nativeSessionId)) {
      continue;
    }
    const workspace = parsed.workspace || project.rootPath;
    if (!isWorkspaceWithinProjectTree(project.rootPath, workspace)) {
      continue;
    }
    seenNativeIds.add(parsed.nativeSessionId);
    const existing = findImportedSessionTarget(
      projectSessions,
      parsed.nativeSessionId,
      parsed.title,
      workspace,
      sessionIdKey,
      provider,
    );
    const display = resolveImportedSessionDisplay(existing, parsed);
    const existingDream = existing ? existingDreamBySessionId.get(existing.id) : undefined;
    const targetDreamId = existingDream?.id ?? existing?.dreamId ?? temporary.id;
    const targetDreamName = existingDream?.name ?? existing?.dreamName ?? temporary.name;
    const record: SessionRecord = {
      id: existing?.id ?? randomUUID(),
      title: display.title,
      preview: existing?.preview || display.preview,
      timeLabel: existing?.timeLabel || display.timeLabel,
      provider,
      model: parsed.model
        ? normalizeSessionModel(parsed.model, provider)
        : existing?.model ?? getDefaultModelForProvider(provider),
      workspace,
      projectId: project.id,
      projectName: project.name,
      dreamId: targetDreamId,
      dreamName: targetDreamName,
      claudeSessionId: provider === 'claude' ? parsed.nativeSessionId : existing?.claudeSessionId,
      codexThreadId: provider === 'codex' ? parsed.nativeSessionId : existing?.codexThreadId,
      nativeHistoryRevision: existing?.nativeHistoryRevision,
      updatedAt: display.updatedAt,
      sessionKind: existing?.sessionKind ?? 'standard',
      hidden: existing?.hidden ?? false,
      instructionPrompt: existing?.instructionPrompt,
      group: existing?.group,
      groups: existing?.groups ?? [],
      contextReferences: normalizeContextReferences(existing?.contextReferences),
      tokenUsage: (parsed.tokenUsage?.used ?? 0) > 0
        ? parsed.tokenUsage!
        : existing?.tokenUsage ?? {
        contextWindow: 0,
        used: 0,
        input: 0,
        output: 0,
        cached: 0,
        windowSource: 'unknown',
      },
      branchSnapshot: existing?.branchSnapshot ?? makeEmptyBranchSnapshot(project.rootPath),
      messages: existing?.messages ?? [],
      messagesLoaded: existing?.messagesLoaded ?? false,
    };
    const previousNativeId = existing?.[sessionIdKey];
    if (
      !existing ||
      previousNativeId !== parsed.nativeSessionId ||
      existing.nativeHistoryRevision !== parsed.sourceRevision
    ) {
      nativeSessionsNeedingHydration.add(record.id);
      if (existing?.group?.kind === 'member') {
        repairedGroupRoomSessionIds.delete(existing.group.roomSessionId);
      }
    }
    nativeSessionSources.set(record.id, {
      filePath: parsed.filePath,
      provider,
      sourceRevision: parsed.sourceRevision,
    });
    if (existing) {
      Object.assign(existing, record);
      if (existing.dreamId === temporary.id) {
        importedSessions.push(existing);
      }
    } else {
      importedSessions.push(record);
    }
  }

  temporary.sessions = pruneTemporaryImportedDuplicates(
    provider === 'claude'
      ? mergeNativeImportedSessions(existingSessions, importedSessions, seenNativeIds)
      : mergeImportedCodexSessions(existingSessions, importedSessions, seenNativeIds),
  );
};

const loadNativeClaudeCatalogEntries = async (project: ProjectRecord) => {
  const entries: NativeSessionCatalogEntry[] = [];
  for (const nativeDir of await getExistingNativeClaudeProjectTreeDirPaths(project.rootPath)) {
    let files: string[] = [];
    try {
      files = (await readdir(nativeDir))
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => path.join(nativeDir, file));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const parsed = await readNativeCatalogEntryCached(file, 'claude');
        if (parsed) {
          entries.push(parsed);
        }
      } catch {
        // Preserve the persisted catalog when one native history is unreadable.
      }
    }
  }
  return entries;
};

const loadNativeCodexCatalogEntries = async () => {
  const files = [
    ...(await listJsonlFilesRecursively(codexSessionsRoot())),
    ...(await listJsonlFilesRecursively(codexArchivedSessionsRoot())),
  ];
  const threadNameIndex = await readCodexThreadNameIndex();
  let indexRevision = '';
  try {
    const indexStat = await stat(codexSessionIndexPath());
    indexRevision = `${indexStat.mtimeMs}:${indexStat.size}`;
  } catch {
    // Missing index means native thread titles fall back to prompt-derived titles.
  }
  const entries: NativeSessionCatalogEntry[] = [];
  for (const file of files) {
    try {
      const parsed = await readNativeCatalogEntryCached(
        file,
        'codex',
        threadNameIndex,
        indexRevision,
      );
      if (parsed) {
        entries.push(parsed);
      }
    } catch {
      // Continue catalog discovery when one native history is unreadable.
    }
  }
  return entries;
};

const importNativeSessionCatalogIntoState = async (state: AppState) => {
  const codexEntries = await loadNativeCodexCatalogEntries();
  for (const project of state.projects) {
    const claudeEntries = await loadNativeClaudeCatalogEntries(project);
    applyNativeCatalogEntries(project, claudeEntries, state.deletedImports);
    applyNativeCatalogEntries(project, codexEntries, state.deletedImports);
  }
  // Catalog refresh can run while other sessions are live. Normalize metadata
  // and topology, but never apply crash-recovery status rewrites to active
  // in-memory messages.
  state.projects = normalizeProjectsForCache(normalizeProjects(state.projects));
};

const hydrateProjectCatalogForOpen = async (
  project: ProjectRecord,
  deletedImports: AppState['deletedImports'],
) => {
  const [claudeEntries, codexEntries] = await Promise.all([
    loadNativeClaudeCatalogEntries(project),
    loadNativeCodexCatalogEntries(),
  ]);
  applyNativeCatalogEntries(project, claudeEntries, deletedImports);
  applyNativeCatalogEntries(project, codexEntries, deletedImports);
};

const importNativeClaudeSessions = async (
  project: ProjectRecord,
  deletedImports: AppState['deletedImports'],
  cache?: NativeImportCache,
) => {
  const temporary = project.dreams.find((dream) => dream.isTemporary);
  if (!temporary) {
    return;
  }

  const existingSessions = [...temporary.sessions] as SessionRecord[];
  const projectSessions = project.dreams.flatMap((dream) => dream.sessions) as SessionRecord[];
  const existingDreamBySessionId = mapSessionDreams(project);
  const existingByClaudeSessionId = new Map(
    projectSessions
      .filter((session): session is SessionRecord & { claudeSessionId: string } => Boolean(session.claudeSessionId))
      .map((session) => [session.claudeSessionId, session]),
  );

  const nativeDirs = await getExistingNativeClaudeProjectTreeDirPaths(project.rootPath);
  if (nativeDirs.length === 0) {
    temporary.sessions = existingSessions;
    return;
  }
  const files: string[] = [];
  for (const nativeDir of nativeDirs) {
    try {
      const dirFiles = (await readdir(nativeDir))
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => path.join(nativeDir, file));
      files.push(...dirFiles);
    } catch {
      continue;
    }
  }
  if (files.length === 0) {
    temporary.sessions = existingSessions;
    return;
  }

  const seenNativeIds = new Set<string>();
  const importedSessions: SessionRecord[] = [];
  const latestImportedUpdatedAtBySessionId = new Map<string, number>();
  const latestImportedUpdatedAtByNativeId = new Map<string, number>();
  const importedSessionIndexByNativeId = new Map<string, number>();

  for (const file of files) {
    const parsed = await parseCachedNativeClaudeSessionFile(file, cache);
    if (!parsed) {
      continue;
    }
    const workspace = parsed.workspace || project.rootPath;
    if (!isWorkspaceWithinProjectTree(project.rootPath, workspace)) {
      continue;
    }
    if (deletedImports.claudeSessionIds.includes(parsed.nativeSessionId)) {
      continue;
    }

    const importedUpdatedAt = parsed.updatedAt ?? 0;
    const previousNativeImportedUpdatedAt = latestImportedUpdatedAtByNativeId.get(parsed.nativeSessionId);
    if (
      previousNativeImportedUpdatedAt !== undefined &&
      importedUpdatedAt <= previousNativeImportedUpdatedAt
    ) {
      continue;
    }
    latestImportedUpdatedAtByNativeId.set(parsed.nativeSessionId, importedUpdatedAt);

    seenNativeIds.add(parsed.nativeSessionId);
    const existing =
      findImportedSessionTarget(projectSessions, parsed.nativeSessionId, parsed.title, workspace, 'claudeSessionId', 'claude') ??
      existingByClaudeSessionId.get(parsed.nativeSessionId);
    if (existing) {
      const previousImportedUpdatedAt = latestImportedUpdatedAtBySessionId.get(existing.id);
      if (previousImportedUpdatedAt !== undefined && importedUpdatedAt <= previousImportedUpdatedAt) {
        continue;
      }
      latestImportedUpdatedAtBySessionId.set(existing.id, importedUpdatedAt);
    }
    const display = resolveImportedSessionDisplay(existing, parsed);
    const existingDream = existing ? existingDreamBySessionId.get(existing.id) : undefined;
    const targetDreamId = existingDream?.id ?? existing?.dreamId ?? temporary.id;
    const targetDreamName = existingDream?.name ?? existing?.dreamName ?? temporary.name;
    const importedSession: SessionRecord = {
      id: existing?.id ?? randomUUID(),
      title: display.title,
      preview: display.preview,
      timeLabel: display.timeLabel,
      provider: existing?.provider ?? 'claude',
      model: parsed.model,
      workspace,
      projectId: project.id,
      projectName: project.name,
      dreamId: targetDreamId,
      dreamName: targetDreamName,
      claudeSessionId: parsed.nativeSessionId,
      updatedAt: display.updatedAt,
      sessionKind: existing?.sessionKind ?? 'standard',
      hidden: existing?.hidden ?? false,
      instructionPrompt: existing?.instructionPrompt,
      groups: existing?.groups ?? [],
      contextReferences: normalizeContextReferences(existing?.contextReferences),
      tokenUsage: existing?.tokenUsage ?? {
        contextWindow: 0,
        used: 0,
        input: 0,
        output: 0,
        cached: 0,
        windowSource: 'unknown',
      },
      branchSnapshot: existing?.branchSnapshot ?? makeEmptyBranchSnapshot(project.rootPath),
      messages: existing
        ? mergeNativeConversationMessages(existing.messages, parsed.messages)
        : parsed.messages,
    };
    if (existing) {
      Object.assign(existing, importedSession);
      if (existing.dreamId === temporary.id) {
        importedSessions.push(existing);
      }
    } else {
      const previousIndex = importedSessionIndexByNativeId.get(parsed.nativeSessionId);
      if (previousIndex !== undefined) {
        importedSessions[previousIndex] = importedSession;
      } else {
        importedSessionIndexByNativeId.set(parsed.nativeSessionId, importedSessions.length);
        importedSessions.push(importedSession);
      }
    }
  }

  temporary.sessions = pruneTemporaryImportedDuplicates(
    mergeNativeImportedSessions(existingSessions, importedSessions, seenNativeIds),
  );
};

const isGeneratedCodexPlaceholder = (session: SessionRecord) =>
  !session.codexThreadId &&
  /^New Session \d+$/.test(session.title) &&
  session.preview === 'Start a new Codex conversation.' &&
  (session.messages?.length ?? 0) === 0;

const mergeImportedCodexSessions = (
  existingSessions: SessionRecord[],
  importedSessions: SessionRecord[],
  seenCodexIds: Set<string>,
) => {
  const preservedLocalSessions =
    importedSessions.length > 0
      ? existingSessions.filter((session) => !session.codexThreadId && !isGeneratedCodexPlaceholder(session))
      : existingSessions.filter((session) => !session.codexThreadId);

  const preservedRemoteSessions = existingSessions.filter(
    (session): session is SessionRecord & { codexThreadId: string } => Boolean(session.codexThreadId),
  );

  return [
    ...preservedLocalSessions,
    ...preservedRemoteSessions.filter((session) => !seenCodexIds.has(session.codexThreadId)),
    ...importedSessions,
  ].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
};

const importNativeCodexSessions = async (
  project: ProjectRecord,
  deletedImports: AppState['deletedImports'],
  cache?: NativeImportCache,
) => {
  const temporary = project.dreams.find((dream) => dream.isTemporary);
  if (!temporary) {
    return;
  }

  const existingSessions = [...temporary.sessions] as SessionRecord[];
  const projectSessions = project.dreams.flatMap((dream) => dream.sessions) as SessionRecord[];
  const existingDreamBySessionId = mapSessionDreams(project);
  const existingByCodexThreadId = new Map(
    projectSessions
      .filter((session): session is SessionRecord & { codexThreadId: string } => Boolean(session.codexThreadId))
      .map((session) => [session.codexThreadId, session]),
  );
  const parsedSessions = await loadParsedCodexImportedSessions(cache);

  const seenCodexIds = new Set<string>();
  const importedSessions: SessionRecord[] = [];

  for (const parsed of parsedSessions) {
    if (deletedImports.codexThreadIds.includes(parsed.nativeSessionId)) {
      continue;
    }

    const workspace = parsed.workspace || project.rootPath;
    if (!isWorkspaceWithinProjectTree(project.rootPath, workspace)) {
      continue;
    }

    seenCodexIds.add(parsed.nativeSessionId);
    const existing =
      findImportedSessionTarget(
        projectSessions,
        parsed.nativeSessionId,
        parsed.title,
        workspace,
        'codexThreadId',
        'codex',
      ) ?? existingByCodexThreadId.get(parsed.nativeSessionId);
    const display = resolveImportedSessionDisplay(existing, parsed);
    const existingDream = existing ? existingDreamBySessionId.get(existing.id) : undefined;
    const targetDreamId = existingDream?.id ?? existing?.dreamId ?? temporary.id;
    const targetDreamName = existingDream?.name ?? existing?.dreamName ?? temporary.name;
    const importedSession: SessionRecord = {
      id: existing?.id ?? randomUUID(),
      title: display.title,
      preview: display.preview,
      timeLabel: display.timeLabel,
      provider: 'codex',
      model: parsed.model,
      workspace,
      projectId: project.id,
      projectName: project.name,
      dreamId: targetDreamId,
      dreamName: targetDreamName,
      claudeSessionId: existing?.claudeSessionId,
      codexThreadId: parsed.nativeSessionId,
      updatedAt: display.updatedAt,
      sessionKind: existing?.sessionKind ?? 'standard',
      hidden: existing?.hidden ?? false,
      instructionPrompt: existing?.instructionPrompt,
      groups: existing?.groups ?? [],
      contextReferences: normalizeContextReferences(existing?.contextReferences),
      tokenUsage: parsed.tokenUsage,
      branchSnapshot: existing?.branchSnapshot ?? makeEmptyBranchSnapshot(project.rootPath),
      messages: parsed.messages,
    };

    if (existing) {
      Object.assign(existing, importedSession);
      if (existing.dreamId === temporary.id) {
        importedSessions.push(existing);
      }
    } else {
      importedSessions.push(importedSession);
    }
  }

  temporary.sessions = pruneTemporaryImportedDuplicates(
    mergeImportedCodexSessions(existingSessions, importedSessions, seenCodexIds),
  );
};

const importNativeProjectSessions = async (
  project: ProjectRecord,
  deletedImports: AppState['deletedImports'],
  cache?: NativeImportCache,
) => {
  await importNativeClaudeSessions(project, deletedImports, cache);
  await importNativeCodexSessions(project, deletedImports, cache);
};

const recoverExistingSessionsFromNativeHistory = async (
  projects: ProjectRecord[],
  cache?: NativeImportCache,
) => {
  const sessions = projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions as SessionRecord[]),
  );

  for (const session of sessions) {
    if (!session.claudeSessionId) {
      continue;
    }

    const filePath = nativeClaudeSessionFilePath(session.workspace, session.claudeSessionId);
    if (!filePath) {
      continue;
    }

    const parsed = await parseCachedNativeClaudeSessionFile(filePath, cache);
    if (!parsed || !shouldRecoverSessionFromNative(session, parsed)) {
      continue;
    }

    Object.assign(session, mergeNativeSessionIntoExisting(session, parsed));
  }
};

const importNativeSessionsIntoState = async (state: AppState) => {
  const importCache: NativeImportCache = {};
  for (const project of state.projects) {
    try {
      await importNativeProjectSessions(project, state.deletedImports, importCache);
    } catch {
      // Preserve the persisted project tree when auxiliary native-session import fails.
    }
  }

  try {
    await recoverExistingSessionsFromNativeHistory(state.projects, importCache);
  } catch {
    // Keep the persisted project tree even if native-history recovery cannot complete.
  }

  state.projects = normalizeProjectsFromPersistence(normalizeProjects(state.projects));
};

export const recoverSessionFromNativeHistory = async (sessionId: string) => {
  const state = await getMutableState();
  const sessions = state.projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions as SessionRecord[]),
  );
  const target = sessions.find((session) => session.id === sessionId);
  if (!target?.claudeSessionId) {
    return null;
  }

  const filePath = nativeClaudeSessionFilePath(target.workspace, target.claudeSessionId);
  if (!filePath) {
    return null;
  }

  const parsed = await parseCachedNativeClaudeSessionFile(filePath);
  if (!parsed || !shouldRecoverSessionFromNative(target, parsed)) {
    return null;
  }

  Object.assign(target, mergeNativeSessionIntoExisting(target, parsed));
  await saveState(state, {
    replaceSessionIds: [sessionId],
    immediateIndex: true,
  });
  return target;
};

const deleteNativeClaudeSessions = async (
  nativeSessions: Array<{ workspace: string; sessionId: string }>,
): Promise<NativeCleanupResult> => {
  if (nativeSessions.length === 0) {
    return { warnings: [] };
  }

  const uniqueSessions = [...new Map(
    nativeSessions.map((session) => [`${normalizeWorkspacePath(session.workspace)}::${session.sessionId}`, session]),
  ).values()];
  const uniqueIds = [...new Set(uniqueSessions.map((session) => session.sessionId))];
  const warnings: string[] = [];
  const deleteTasks = uniqueSessions.flatMap((session) => {
    return getNativeClaudeProjectDirPaths(session.workspace).flatMap((nativeDir) => [
      {
        targetPath: path.join(nativeDir, `${session.sessionId}.jsonl`),
        task: rm(path.join(nativeDir, `${session.sessionId}.jsonl`), { force: true }),
      },
      {
        targetPath: path.join(nativeDir, session.sessionId),
        task: rm(path.join(nativeDir, session.sessionId), { force: true, recursive: true }),
      },
    ]);
  });

  const deleteResults = await Promise.allSettled(deleteTasks.map((entry) => entry.task));
  deleteResults.forEach((result, index) => {
    if (result.status === 'rejected') {
      warnings.push(
        `Failed to delete native Claude session path "${deleteTasks[index]?.targetPath}": ${describeError(result.reason)}`,
      );
    }
  });

  try {
    const raw = await readFile(nativeClaudeHistoryPath(), 'utf8');
    const filtered = raw
      .split(/\r?\n/)
      .filter((line) => line && !uniqueIds.some((sessionId) => line.includes(`"sessionId":"${sessionId}"`)))
      .join('\n');
    await writeFile(nativeClaudeHistoryPath(), `${filtered}\n`, 'utf8');
  } catch (error) {
    if (!isMissingFsEntryError(error)) {
      warnings.push(`Failed to update native Claude history "${nativeClaudeHistoryPath()}": ${describeError(error)}`);
    }
  }

  return { warnings };
};

const ensureTemporaryStreamwork = (project: ProjectRecord) => {
  const existing = project.dreams.find((dream) => dream.isTemporary || dream.name === 'Temporary');
  if (existing) {
    existing.name = 'Temporary';
    existing.isTemporary = true;
    project.dreams = sortDreamsWithTemporaryFirst(project.dreams);
    return;
  }

  const temporaryId = `temporary-${project.id}`;
  const migratedSessions = project.dreams.flatMap((dream) =>
    dream.sessions.map((session) => ({
      ...session,
      dreamId: temporaryId,
      dreamName: 'Temporary',
    })),
  );

  project.dreams.unshift({
    id: temporaryId,
    name: 'Temporary',
    isTemporary: true,
    sessions: migratedSessions,
  });

  project.dreams = project.dreams.map((dream) =>
    dream.isTemporary
      ? dream
      : {
          ...dream,
          sessions: [],
        },
  );
  project.dreams = sortDreamsWithTemporaryFirst(project.dreams);
};

const ensureProjectHasSession = (project: ProjectRecord) => {
  const allSessions = project.dreams.flatMap((dream) => dream.sessions) as SessionRecord[];
  const existingSession =
    allSessions.find((session) => !session.hidden) ??
    allSessions[0];
  if (existingSession) {
    return existingSession;
  }

  ensureTemporaryStreamwork(project);
  const targetStreamwork = project.dreams.find((dream) => dream.isTemporary) ?? project.dreams[0];
  if (!targetStreamwork) {
    throw new Error('Project does not contain a valid streamwork.');
  }

  const session = createBaseSession(project, targetStreamwork, 'New Session 1', project.rootPath);
  targetStreamwork.sessions.unshift(session);
  return session;
};

const buildInitialProjects = () => {
  const cloned = JSON.parse(JSON.stringify(projectTree)) as ProjectRecord[];
  const messagesBySessionId = new Map(allSessions.map((session) => [session.id, session.messages]));

  cloned.forEach((project) => {
    project.dreams.forEach((dream) => {
      dream.sessions.forEach((session) => {
        (session as SessionRecord).messages = messagesBySessionId.get(session.id) ?? [];
      });
    });
    ensureTemporaryStreamwork(project);
  });

  return normalizeProjectsForCache(normalizeProjects(cloned));
};

const cloneProjects = (projects: ProjectRecord[]) => JSON.parse(JSON.stringify(projects)) as ProjectRecord[];
const cloneSessionRecord = (session: SessionRecord) => JSON.parse(JSON.stringify(session)) as SessionRecord;

const cacheState = (state: AppState) => {
  if (state === cachedState) {
    cachedState.deletedImports = normalizeDeletedImports(cachedState.deletedImports);
    return;
  }

  cachedState = {
    projects: normalizeProjectsForCache(normalizeProjects(cloneProjects(state.projects))),
    deletedImports: normalizeDeletedImports(state.deletedImports),
  };
};
const buildProjectSummaries = (projects: ProjectRecord[]) =>
  filterVisibleProjects(projects).map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) => ({
        ...(session as SessionRecord),
        messages: [],
        messagesLoaded: false,
      })),
    })),
  })) as ProjectRecord[];
const cloneVisibleProjects = (projects: ProjectRecord[]) => cloneProjects(buildProjectSummaries(projects));
const summarizeProjectsForBootstrap = (projects: ProjectRecord[]) => cloneVisibleProjects(projects);

const findSessionInProjects = (projects: ProjectRecord[], sessionId: string): SessionRecord | null => {
  for (const project of projects) {
    for (const dream of project.dreams) {
      const session = dream.sessions.find((candidate) => candidate.id === sessionId);
      if (session) {
        return session as SessionRecord;
      }
    }
  }

  return null;
};

const getAllSessionRecords = (projects: ProjectRecord[]) =>
  projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions as SessionRecord[]),
  );

const fingerprintConversationMessage = (message: ConversationMessage) =>
  createHash('sha256').update(JSON.stringify(message)).digest('hex');

const fingerprintSessionForPersistence = (session: SessionRecord) => {
  const hash = createHash('sha256');
  hash.update(session.id);
  hash.update('\0');
  hash.update(session.title);
  hash.update('\0');
  hash.update(session.preview);
  hash.update('\0');
  hash.update(String(session.updatedAt ?? 0));
  hash.update('\0');
  hash.update(session.claudeSessionId ?? '');
  hash.update('\0');
  hash.update(session.codexThreadId ?? '');
  for (const message of session.messages ?? []) {
    hash.update('\0');
    // Hash one message at a time so trace metadata/attachments are covered
    // without constructing a serialized copy of the complete store.
    hash.update(JSON.stringify(message));
  }
  return hash.digest('hex');
};

const captureSessionPersistenceFingerprints = (projects: ProjectRecord[]) =>
  new Map(
    getAllSessionRecords(projects).map((session) => [
      session.id,
      fingerprintSessionForPersistence(session),
    ]),
  );

const findChangedSessionIds = (
  projects: ProjectRecord[],
  before: Map<string, string>,
) =>
  getAllSessionRecords(projects)
    .filter((session) => before.get(session.id) !== fingerprintSessionForPersistence(session))
    .map((session) => session.id);

const ensureStateShape = (value: unknown): AppState => {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { projects?: unknown }).projects)) {
    return { projects: buildInitialProjects(), deletedImports: createEmptyDeletedImports() };
  }

  const typed = value as { projects: ProjectRecord[]; deletedImports?: unknown };
  // JSON.parse already produced an unshared object graph. Re-cloning the full
  // legacy store here doubles migration-time memory for no isolation benefit.
  const projects = typed.projects;
  projects.forEach((project) => ensureTemporaryStreamwork(project));

  return {
    projects,
    deletedImports: normalizeDeletedImports(typed.deletedImports),
  };
};

const readStateFile = async (filePath: string) => {
  const [raw, fileStat] = await Promise.all([
    readFile(filePath, 'utf8'),
    stat(filePath),
  ]);
  return {
    state: ensureStateShape(JSON.parse(raw)),
    mtimeMs: fileStat.mtimeMs,
  };
};

const listStateRecoveryFiles = async () => {
  try {
    const dir = path.dirname(storePath());
    const activeName = path.basename(storePath());
    const isRecoveryCandidate = (entryName: string) =>
      entryName !== activeName &&
      (
        (entryName.startsWith('easyaiflow-sessions.') && entryName.endsWith('.json')) ||
        (entryName.startsWith(`${activeName}.`) && entryName.endsWith('.tmp'))
      );
    const entries = await readdir(dir, { withFileTypes: true });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isRecoveryCandidate(entry.name))
        .map(async (entry) => {
          const filePath = path.join(dir, entry.name);
          try {
            return {
              filePath,
              mtimeMs: (await stat(filePath)).mtimeMs,
            };
          } catch {
            return null;
          }
        }),
    );

    let activeCandidate: { filePath: string; mtimeMs: number } | null = null;
    try {
      activeCandidate = {
        filePath: storePath(),
        mtimeMs: (await stat(storePath())).mtimeMs,
      };
    } catch {
      // The active file may be missing; recovery files are still usable.
    }

    return [...candidates, activeCandidate]
      .filter((candidate): candidate is { filePath: string; mtimeMs: number } => Boolean(candidate))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map((candidate) => candidate.filePath);
  } catch {
    return [];
  }
};

const readStateFromDisk = async () => {
  for (const filePath of await listStateRecoveryFiles()) {
    try {
      return await readStateFile(filePath);
    } catch {
      // Try the next newest valid active/recovery file.
    }
  }

  return {
    state: null,
    mtimeMs: null,
  };
};

const hydrateLoadedState = async (state: AppState) => {
  await importNativeSessionsIntoState(state);
};

const getSessionStoreV2Options = () => ({
  // V2 writes and compacts one session at a time, so the legacy global-save
  // message cap is no longer needed. Preserve every migrated message.
  maxMessages: 0,
  compactionEventCount: 64,
  compactionBytes: 1024 * 1024,
  indexDebounceMs: SAVE_DEBOUNCE_MS,
});

const loadStateUncached = async () => {
  const v2Paths = getSessionStoreV2Paths(getRuntimePaths().userDataPath);
  try {
    try {
      const loadedV2 = await openSessionStoreV2(
        getRuntimePaths().userDataPath,
        getSessionStoreV2Options(),
      );
      if (loadedV2) {
        cachedState = loadedV2.state;
        v2Store = loadedV2.store;
        cachedStateMtimeMs = null;
      }
    } catch (error) {
      if (error instanceof SessionStoreV2LockError || existsSync(v2Paths.manifestPath)) {
        throw new Error(
          `Activated V2 session store could not be loaded: ${describeError(error)}`,
          { cause: error },
        );
      }
      console.warn(`[SESSION_STORE] Failed to load V2 store; falling back to V1: ${describeError(error)}`);
      v2Store = null;
    }

    if (!cachedState) {
      const loaded = await readStateFromDisk();
      if (loaded.state) {
        cachedState = loaded.state;
        cachedStateMtimeMs = loaded.mtimeMs;
      } else {
        cachedState = { projects: buildInitialProjects(), deletedImports: createEmptyDeletedImports() };
        cachedStateMtimeMs = null;
      }
    }
  } catch (error) {
    if (error instanceof SessionStoreV2LockError || existsSync(v2Paths.manifestPath)) {
      throw error;
    }
    cachedState = { projects: buildInitialProjects(), deletedImports: createEmptyDeletedImports() };
    cachedStateMtimeMs = null;
  }

  let migrationError: unknown = null;
  if (!v2Store) {
    try {
      // Activate an exact V2 copy before native-history normalization. This
      // keeps one-time migration memory bounded and leaves V1 untouched.
      v2Store = await migrateSessionStoreV2(
        getRuntimePaths().userDataPath,
        cachedState,
        getSessionStoreV2Options(),
      );
      const catalog = await openSessionStoreV2(
        getRuntimePaths().userDataPath,
        getSessionStoreV2Options(),
      );
      if (!catalog) {
        throw new Error('Activated V2 session store could not be reopened.');
      }
      cachedState = catalog.state;
      v2Store = catalog.store;
      cachedStateMtimeMs = null;
    } catch (error) {
      migrationError = error;
    }
  }

  if (v2Store) {
    return cachedState;
  }

  await hydrateLoadedState(cachedState);
  console.warn(`[SESSION_STORE] Failed to migrate V1 store to V2: ${describeError(migrationError)}`);
  await saveState(cachedState);

  return cachedState;
};

export const loadState = async () => {
  if (cachedState) {
    cachedState.projects.forEach((project) => ensureTemporaryStreamwork(project));
    return cachedState;
  }

  if (!loadingStatePromise) {
    loadingStatePromise = loadStateUncached().finally(() => {
      loadingStatePromise = null;
    });
  }

  return loadingStatePromise;
};

const getMutableState = async () => cachedState ?? await loadState();

let nativeImportRefreshPromise: Promise<void> | null = null;

const refreshNativeImports = async (state: AppState, force = false) => {
  if (v2Store && !force && Date.now() - nativeCatalogLastRefreshAt < 1_000) {
    return;
  }
  if (nativeImportRefreshPromise) {
    await nativeImportRefreshPromise;
    return;
  }

  nativeImportRefreshPromise = (async () => {
    if (v2Store) {
      await importNativeSessionCatalogIntoState(state);
      await saveState(state, { immediateIndex: true });
      nativeCatalogLastRefreshAt = Date.now();
      return;
    }
    const before = captureSessionPersistenceFingerprints(state.projects);
    await importNativeSessionsIntoState(state);
    await saveState(state, {
      replaceSessionIds: findChangedSessionIds(state.projects, before),
      immediateIndex: true,
    });
  })().finally(() => {
    nativeImportRefreshPromise = null;
  });

  await nativeImportRefreshPromise;
};

let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 800;

/**
 * Cap on messages persisted per session. The whole store is held in memory and
 * fully re-serialized (and the previous file re-read + re-parsed) on every
 * debounced save, so an unbounded message history makes each save allocate
 * gigabytes transiently — overlapping saves then breach the V8 heap ceiling.
 * Trimming bounds the persisted file (and therefore every save's peak memory).
 * Older messages remain available in the rotating backups / .tmp files on disk.
 * Override with EASYAIFLOW_MAX_PERSISTED_MESSAGES (0 disables trimming).
 */
const MAX_PERSISTED_MESSAGES_PER_SESSION = (() => {
  const raw = Number(process.env.EASYAIFLOW_MAX_PERSISTED_MESSAGES);
  return Number.isFinite(raw) && raw >= 0 ? raw : 400;
})();

/**
 * Builds a persist-time view of the state with each session's message history
 * capped to the last N. Uses shallow structural copies and Array.slice (which
 * shares the retained message objects), so it adds negligible memory versus the
 * full deep clone a naive trim would cost.
 */
export const buildPersistableState = (state: AppState): AppState => {
  const limit = MAX_PERSISTED_MESSAGES_PER_SESSION;
  if (!limit) {
    return state;
  }

  let trimmedAny = false;
  const projects = state.projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) => {
        const messages = (session as SessionRecord).messages;
        if (!messages || messages.length <= limit) {
          return session;
        }
        trimmedAny = true;
        return { ...(session as SessionRecord), messages: messages.slice(-limit) };
      }),
    })),
  }));

  return trimmedAny ? { ...state, projects } : state;
};

const writeLegacyToDisk = async () => {
  if (!cachedState) {
    return;
  }
  await mkdir(path.dirname(storePath()), { recursive: true });
  const onDisk = await readStateFromDisk();
  if (
    onDisk.state &&
    (
      cachedStateMtimeMs === null ||
      (onDisk.mtimeMs !== null && onDisk.mtimeMs !== cachedStateMtimeMs)
    )
  ) {
    cacheState(mergeSessionStoreStates(onDisk.state, cachedState));
  }

  const filePath = storePath();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = `${filePath}.last-good.json`;
  const serialized = JSON.stringify(buildPersistableState(cachedState), null, 2);
  await writeFile(tempPath, serialized, 'utf8');
  if (onDisk.state) {
    try {
      await copyFile(filePath, backupPath);
    } catch {
      // Best-effort backup; the temp file still gives us atomic replacement.
    }
  }
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
    if (code !== 'EEXIST' && code !== 'EPERM') {
      throw error;
    }
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  }
  try {
    cachedStateMtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    cachedStateMtimeMs = null;
  }
};

type SaveStateOptions = {
  sessionMutations?: SessionStoreV2SessionMutation[];
  replaceSessionIds?: string[];
  replaceAllSessions?: boolean;
  deletedSessionIds?: string[];
  immediateIndex?: boolean;
};

const messagesForV2Persistence = (messages: ConversationMessage[]) => messages;

const buildV2SessionMutations = (
  state: AppState,
  options: SaveStateOptions,
): SessionStoreV2SessionMutation[] => {
  const mutations = [...(options.sessionMutations ?? [])];
  const replaceIds = new Set(options.replaceSessionIds ?? []);
  if (options.replaceAllSessions) {
    getAllSessionRecords(state.projects).forEach((session) => replaceIds.add(session.id));
  }
  replaceIds.forEach((sessionId) => {
    const session = findSessionInProjects(state.projects, sessionId);
    if (!session) {
      return;
    }
    mutations.push({
      type: 'replace-messages',
      sessionId,
      messages: messagesForV2Persistence(session.messages ?? []),
    });
  });
  return mutations;
};

export const saveState = async (state: AppState, options: SaveStateOptions = {}) => {
  cacheState(state);

  if (v2Store && cachedState) {
    await v2Store.persist(cachedState, {
      sessionMutations: buildV2SessionMutations(cachedState, options),
      deletedSessionIds: options.deletedSessionIds,
      immediateIndex: options.immediateIndex ?? true,
    });
    return;
  }

  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
  }
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    void writeLegacyToDisk();
  }, SAVE_DEBOUNCE_MS);
};

/** Flush any pending debounced write immediately. Call before app exit. */
export const flushPendingSave = async () => {
  if (v2Store && cachedState) {
    await v2Store.flush(cachedState);
    return;
  }
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  await writeLegacyToDisk();
};

export const getProjects = async () => {
  const state = await loadState();
  await refreshNativeImports(state);
  return cloneVisibleProjects(state.projects);
};

export const getProjectsForBootstrap = async () => {
  const state = await loadState();
  await refreshNativeImports(state, true);
  return summarizeProjectsForBootstrap(state.projects);
};

const hydrateNativeSessionMessages = async (session: SessionRecord) => {
  if (!v2Store || !cachedState) {
    return;
  }
  const source = nativeSessionSources.get(session.id);
  if (!source) {
    return;
  }
  const existing = nativeSessionHydrationPromises.get(session.id);
  if (existing) {
    await existing;
    return;
  }

  const hydration = (async () => {
    const parsed = source.provider === 'claude'
      ? await parseNativeClaudeSessionFile(source.filePath)
      : await parseCodexSessionFile(source.filePath, await readCodexThreadNameIndex());
    if (!parsed) {
      return;
    }
    session.title = parsed.title || session.title;
    session.preview = parsed.preview || session.preview;
    session.timeLabel = parsed.timeLabel || session.timeLabel;
    session.updatedAt = parsed.updatedAt ?? session.updatedAt;
    session.model = normalizeSessionModel(parsed.model, source.provider);
    const parsedTokenUsage = (parsed as { tokenUsage?: TokenUsage }).tokenUsage;
    if (parsedTokenUsage) {
      session.tokenUsage = parsedTokenUsage;
    }
    session.nativeHistoryRevision = source.sourceRevision;
    await v2Store!.persist(cachedState!, {
      sessionMutations: [{
        type: 'replace-messages',
        sessionId: session.id,
        messages: parsed.messages,
      }],
      immediateIndex: true,
    });
    nativeSessionsNeedingHydration.delete(session.id);
  })().finally(() => {
    nativeSessionHydrationPromises.delete(session.id);
  });
  nativeSessionHydrationPromises.set(session.id, hydration);
  await hydration;
};

const readAllV2SessionMessages = async (sessionId: string) => {
  if (!v2Store) {
    return [] as ConversationMessage[];
  }
  const pages: ConversationMessage[][] = [];
  let page = await v2Store.readMessagePage(sessionId);
  pages.push(page.messages);
  while (page.hasMoreBefore && page.nextBefore) {
    page = await v2Store.readMessagePage(sessionId, page.nextBefore);
    pages.push(page.messages);
  }
  return pages.reverse().flat();
};

const recoverLoadedMessagesAfterCrash = async (
  session: SessionRecord,
  messages: ConversationMessage[],
) => {
  if (!v2Store || !cachedState) {
    return messages;
  }
  const hasLiveBuffer = (session.messages ?? []).some((message) =>
    message.status === 'queued' ||
    message.status === 'streaming' ||
    message.status === 'running' ||
    message.status === 'background'
  );
  if (hasLiveBuffer) {
    return messages;
  }
  const recovered = session.sessionKind === 'group'
    ? recoverStaleGroupRoomMessages(messages)
    : recoverStaleSessionMessagesForProvider(messages, normalizeSessionProvider(session.provider));
  const changed = recovered.filter(
    (message, index) =>
      fingerprintConversationMessage(message) !==
      fingerprintConversationMessage(messages[index] ?? message),
  );
  if (changed.length > 0) {
    await v2Store.persist(cachedState, {
      sessionMutations: changed.map((message) => ({
        type: 'upsert-message' as const,
        sessionId: session.id,
        message,
      })),
      immediateIndex: false,
    });
  }
  return recovered;
};

const repairGroupRoomFromNativeHistory = async (roomSession: SessionRecord) => {
  if (!v2Store || !cachedState || roomSession.group?.kind !== 'room') {
    return;
  }
  if (repairedGroupRoomSessionIds.has(roomSession.id)) {
    return;
  }
  const backingSessions = roomSession.group.participants
    .map((participant) => findSessionInProjects(cachedState!.projects, participant.backingSessionId))
    .filter((session): session is SessionRecord => Boolean(session));
  const participantBackings = new Map<GroupParticipantId, SessionRecord>();
  for (const participant of roomSession.group.participants) {
    const backing = backingSessions.find((session) => session.id === participant.backingSessionId);
    if (!backing) {
      continue;
    }
    if (nativeSessionsNeedingHydration.has(backing.id)) {
      await hydrateNativeSessionMessages(backing);
    }
    participantBackings.set(participant.id, {
      ...cloneSessionRecord(backing),
      messages: await readAllV2SessionMessages(backing.id),
    });
  }

  const recoveredRoom: SessionRecord = {
    ...cloneSessionRecord(roomSession),
    group: roomSession.group.kind === 'room'
      ? {
          ...roomSession.group,
          participants: roomSession.group.participants.map((participant) => ({ ...participant })),
        }
      : roomSession.group,
    messages: await readAllV2SessionMessages(roomSession.id),
  };
  const reconstructedMessages = reconstructRecoveredRoomMessages(
    recoveredRoom,
    participantBackings,
  );
  if (!shouldApplyRecoveredRoomMessages(recoveredRoom.messages, reconstructedMessages)) {
    repairedGroupRoomSessionIds.add(roomSession.id);
    return;
  }
  applyRecoveredRoomMessages(
    recoveredRoom,
    reconstructedMessages,
    getRecoveredParticipantLastAppliedRoomSeqs(recoveredRoom, participantBackings),
  );
  await v2Store.persist(cachedState, {
    sessionMutations: [{
      type: 'replace-messages',
      sessionId: roomSession.id,
      messages: recoveredRoom.messages,
    }],
    immediateIndex: true,
  });
  roomSession.preview = recoveredRoom.preview;
  roomSession.timeLabel = recoveredRoom.timeLabel;
  roomSession.group = recoveredRoom.group;
  await saveState(cachedState, { immediateIndex: true });
  repairedGroupRoomSessionIds.add(roomSession.id);
};

export const materializeSessionHistoryForRuntime = async (sessionId: string) => {
  const state = await loadState();
  const session = findSessionInProjects(state.projects, sessionId);
  if (
    !session ||
    !v2Store ||
    (session.messagesLoaded === true && !nativeSessionsNeedingHydration.has(sessionId))
  ) {
    return session;
  }
  await repairGroupRoomFromNativeHistory(session);
  let newest = await v2Store.readMessagePage(sessionId);
  if (
    nativeSessionSources.has(sessionId) &&
    (newest.messages.length === 0 || nativeSessionsNeedingHydration.has(sessionId))
  ) {
    await hydrateNativeSessionMessages(session);
    newest = await v2Store.readMessagePage(sessionId);
  }
  const messages = newest.hasMoreBefore
    ? await readAllV2SessionMessages(sessionId)
    : newest.messages;
  session.messages = await recoverLoadedMessagesAfterCrash(session, messages);
  session.messagesLoaded = true;
  return session;
};

export const getSessionRecordForBootstrap = async (sessionId: string) => {
  const state = await loadState();
  await refreshNativeImports(state);
  const session = findSessionInProjects(state.projects, sessionId);
  if (!session) {
    return null;
  }
  if (!v2Store) {
    return cloneSessionRecord(session);
  }

  const hasChangedNativeGroupBacking =
    session.sessionKind === 'group' &&
    session.group?.kind === 'room' &&
    session.group.participants.some((participant) =>
      nativeSessionsNeedingHydration.has(participant.backingSessionId),
    );
  if (hasChangedNativeGroupBacking) {
    await repairGroupRoomFromNativeHistory(session);
  }
  let page = await v2Store.readMessagePage(sessionId);
  if (
    nativeSessionSources.has(sessionId) &&
    (page.messages.length === 0 || nativeSessionsNeedingHydration.has(sessionId))
  ) {
    await hydrateNativeSessionMessages(session);
    page = await v2Store.readMessagePage(sessionId);
  }
  page = {
    ...page,
    messages: await recoverLoadedMessagesAfterCrash(session, page.messages),
  };
  return {
    ...cloneSessionRecord(session),
    messages: page.messages,
    messagesLoaded: true,
    historyPage: {
      nextBefore: page.nextBefore,
      hasMoreBefore: page.hasMoreBefore,
      sessionRevision: page.sessionRevision,
    },
  };
};

export const getSessionMessagePage = async (
  sessionId: string,
  before?: string,
): Promise<SessionMessagePage> => {
  const state = await loadState();
  if (!findSessionInProjects(state.projects, sessionId)) {
    throw new Error('Session not found.');
  }
  if (!v2Store) {
    const session = findSessionInProjects(state.projects, sessionId) as SessionRecord;
    return {
      sessionId,
      pageId: '',
      messages: cloneSessionRecord(session).messages,
      hasMoreBefore: false,
      sessionRevision: 0,
    };
  }
  return v2Store.readMessagePage(sessionId, before);
};

export const releaseMaterializedSessionHistory = async (sessionId: string) => {
  if (!v2Store) {
    return false;
  }
  const state = await loadState();
  const session = findSessionInProjects(state.projects, sessionId);
  if (!session) {
    return false;
  }
  const hasInFlightMessages = (session.messages ?? []).some((message) =>
    message.status === 'queued' ||
    message.status === 'streaming' ||
    message.status === 'running' ||
    message.status === 'background'
  );
  if (hasInFlightMessages) {
    return false;
  }
  session.messages = [];
  session.messagesLoaded = false;
  return true;
};

const forEachSession = (projects: ProjectRecord[], visitor: (session: SessionRecord, dreamName: string, projectName: string) => void) => {
  projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      dream.sessions.forEach((session) => {
        visitor(session as SessionRecord, dream.name, project.name);
      });
    });
  });
};

export const findSession = async (sessionId: string): Promise<SessionRecord | null> => {
  const state = await loadState();
  return findSessionInProjects(state.projects, sessionId);
};

const assignGroupMessageSeq = (
  session: SessionRecord,
  message: ConversationMessage,
) => {
  if (session.sessionKind !== 'group' || session.group?.kind !== 'room') {
    return message;
  }

  const nextSeq = session.group.nextMessageSeq > 0 ? session.group.nextMessageSeq : 1;
  const assignedSeq =
    typeof message.seq === 'number' && Number.isFinite(message.seq) && message.seq > 0
      ? Math.floor(message.seq)
      : nextSeq;

  session.group = {
    ...session.group,
    nextMessageSeq: Math.max(nextSeq, assignedSeq + 1),
  };

  return typeof message.seq === 'number' && Number.isFinite(message.seq) && message.seq > 0
    ? message
    : {
        ...message,
        seq: assignedSeq,
      };
};

const assignMessagesForSession = (session: SessionRecord, messages: ConversationMessage[]) =>
  messages.map((message) => assignGroupMessageSeq(session, message));

export const ensureSessionRecord = async (session: SessionSummary): Promise<SessionRecord> => {
  const state = await loadState();
  let found: SessionRecord | null = null;

  forEachSession(state.projects, (current) => {
    if (current.id === session.id) {
      found = current;
    }
  });

  if (found) {
    return found;
  }

  const project = state.projects.find((item) => item.id === session.projectId);
  const dream = project?.dreams.find((item) => item.id === session.dreamId);
  if (!project || !dream) {
    throw new Error('Session context not found.');
  }

  const record: SessionRecord = {
    ...session,
    updatedAt: session.updatedAt ?? Date.now(),
    group: normalizeGroupMetadata(session.group),
    contextReferences: normalizeContextReferences(session.contextReferences),
    messages: [],
  };

  dream.sessions.unshift(record);
  await saveState(state, {
    replaceSessionIds: [record.id],
    immediateIndex: true,
  });
  return record;
};

export const updateSessionRecord = async (
  sessionId: string,
  updater: (session: SessionRecord) => void,
) => {
  const state = await loadState();
  let updatedSession: SessionRecord | null = null;
  let sessionMutations: SessionStoreV2SessionMutation[] = [];

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    const beforeIds = (session.messages ?? []).map((message) => message.id);
    const beforeDigests = new Map(
      (session.messages ?? []).map((message) => [message.id, fingerprintConversationMessage(message)]),
    );
    updater(session);
    session.updatedAt = Date.now();
    const afterMessages = session.messages ?? [];
    const preservesExistingOrder = beforeIds.every(
      (id, index) => afterMessages[index]?.id === id,
    );
    if (afterMessages.length >= beforeIds.length && preservesExistingOrder) {
      const changed = afterMessages
        .slice(0, beforeIds.length)
        .filter((message) => beforeDigests.get(message.id) !== fingerprintConversationMessage(message))
        .map((message): SessionStoreV2SessionMutation => ({
          type: 'upsert-message',
          sessionId,
          message,
        }));
      const appended = afterMessages.slice(beforeIds.length);
      sessionMutations = [
        ...changed,
        ...(appended.length > 0
          ? [{ type: 'append-messages' as const, sessionId, messages: appended }]
          : []),
      ];
    } else {
      sessionMutations = [{ type: 'replace-messages', sessionId, messages: afterMessages }];
    }
    updatedSession = {
      ...session,
      messages: [...(session.messages ?? [])],
    };
  });

  if (!updatedSession) {
    throw new Error('Session not found.');
  }

  await saveState(state, {
    sessionMutations,
    immediateIndex: false,
  });

  return {
    projects: cloneVisibleProjects(state.projects),
    session: updatedSession,
  };
};

export const appendMessagesToSession = async (
  sessionId: string,
  messages: ConversationMessage[],
  preview: string,
  timeLabel: string,
) => {
  const state = await loadState();
  let persistedMessages: ConversationMessage[] = [];

  forEachSession(state.projects, (session) => {
    if (session.id === sessionId) {
      const nextMessages = assignMessagesForSession(session, messages);
      persistedMessages = nextMessages;
      session.messages = [...(session.messages ?? []), ...nextMessages];
      session.preview = preview;
      session.timeLabel = timeLabel;
      session.updatedAt = Date.now();
    }
  });

  await saveState(state, {
    sessionMutations: persistedMessages.length > 0
      ? [{ type: 'append-messages', sessionId, messages: persistedMessages }]
      : [],
    immediateIndex: false,
  });
  return cloneVisibleProjects(state.projects);
};

export const appendTraceMessagesToSession = async (
  sessionId: string,
  messages: ConversationMessage[],
) => {
  const state = await loadState();
  let persistedMessages: ConversationMessage[] = [];

  forEachSession(state.projects, (session) => {
    if (session.id === sessionId) {
      const nextMessages = assignMessagesForSession(session, messages);
      persistedMessages = nextMessages;
      session.messages = [...(session.messages ?? []), ...nextMessages];
      session.updatedAt = Date.now();
    }
  });

  await saveState(state, {
    sessionMutations: persistedMessages.length > 0
      ? [{ type: 'append-messages', sessionId, messages: persistedMessages }]
      : [],
    immediateIndex: false,
  });
};

export const upsertSessionMessage = async (
  sessionId: string,
  message: ConversationMessage,
) => {
  const state = await loadState();
  let persistedMessage: ConversationMessage | null = null;

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    const index = session.messages?.findIndex((item) => item.id === message.id) ?? -1;
    if (index >= 0) {
      session.messages[index] = message;
      persistedMessage = message;
    } else {
      const nextMessage = assignGroupMessageSeq(session, message);
      session.messages = [...(session.messages ?? []), nextMessage];
      persistedMessage = nextMessage;
    }
    session.updatedAt = Date.now();
  });

  await saveState(state, {
    sessionMutations: persistedMessage
      ? [{ type: 'upsert-message', sessionId, message: persistedMessage }]
      : [],
    immediateIndex: false,
  });
};

export const upsertSessionMessageInMemory = async (
  sessionId: string,
  message: ConversationMessage,
) => {
  const state = await getMutableState();

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    const index = session.messages?.findIndex((item) => item.id === message.id) ?? -1;
    if (index >= 0) {
      session.messages[index] = message;
    } else {
      const nextMessage = assignGroupMessageSeq(session, message);
      session.messages = [...(session.messages ?? []), nextMessage];
    }
    session.updatedAt = Date.now();
  });
};

export const updateAssistantMessage = async (
  sessionId: string,
  messageId: string,
  updater: (message: ConversationMessage, session: SessionSummary) => void,
) => {
  const state = await loadState();
  let persistedMessage: ConversationMessage | null = null;

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    const target = session.messages?.find((message) => message.id === messageId);
    if (target) {
      updater(target, session);
      session.updatedAt = Date.now();
      persistedMessage = target;
    }
  });

  await saveState(state, {
    sessionMutations: persistedMessage
      ? [{ type: 'upsert-message', sessionId, message: persistedMessage }]
      : [],
    immediateIndex: false,
  });
};

export const updateAssistantMessageInMemory = async (
  sessionId: string,
  messageId: string,
  updater: (message: ConversationMessage, session: SessionSummary) => void,
) => {
  const state = await getMutableState();

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    const target = session.messages?.find((message) => message.id === messageId);
    if (target) {
      updater(target, session);
      session.updatedAt = Date.now();
    }
  });
};

export const setSessionRuntime = async (
  sessionId: string,
  values: {
    claudeSessionId?: string | null;
    codexThreadId?: string | null;
    model?: string;
    preview?: string;
    timeLabel?: string;
    tokenUsage?: TokenUsage;
  },
) => {
  const state = await loadState();
  const nativeClaudeHistoryEntries: NativeClaudeHistoryEntry[] = [];
  const nativeClaudeResumeMetadataTasks: Array<Promise<void>> = [];

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    if (values.claudeSessionId !== undefined) {
      session.claudeSessionId = values.claudeSessionId || undefined;
    }
    if (values.codexThreadId !== undefined) {
      session.codexThreadId = values.codexThreadId || undefined;
    }
    if (values.model) {
      session.model = values.model;
    }
    if (values.preview) {
      session.preview = values.preview;
    }
    if (values.timeLabel) {
      session.timeLabel = values.timeLabel;
    }
    if (values.tokenUsage) {
      session.tokenUsage = values.tokenUsage;
    }
    session.updatedAt = Date.now();
    if (session.provider === 'claude' && session.claudeSessionId) {
      const entry = buildNativeClaudeHistoryEntry(session);
      if (entry) {
        nativeClaudeHistoryEntries.push(entry);
      }
      if (values.claudeSessionId !== undefined) {
        nativeClaudeResumeMetadataTasks.push(
          safelySyncNativeClaudeSessionResumeMetadata(
            session.workspace,
            session.claudeSessionId,
            session.title,
          ),
        );
      }
    }
  });

  await saveState(state);
  await Promise.all([
    ...nativeClaudeHistoryEntries.map((entry) => safelyUpsertNativeClaudeHistoryEntry(entry)),
    ...nativeClaudeResumeMetadataTasks,
  ]);
};

export const updateSessionContextReferences = async (
  sessionId: string,
  references: ContextReference[],
): Promise<SessionContextUpdateResult> => {
  const state = await loadState();
  let updatedSession: SessionRecord | null = null;

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    session.contextReferences = normalizeContextReferences(references);
    session.updatedAt = Date.now();
    updatedSession = JSON.parse(JSON.stringify(session)) as SessionRecord;
  });

  if (!updatedSession) {
    throw new Error('Session not found.');
  }

  await saveState(state);

  return {
    projects: cloneVisibleProjects(state.projects),
    session: updatedSession,
  };
};

const makeEmptyBranchSnapshot = (workspace: string): BranchSnapshot => ({
  branch: 'new-session',
  tracking: undefined,
  ahead: 0,
  behind: 0,
  dirty: false,
  changedFiles: workspace ? [] : [],
});

const makeStreamworkHistoryReference = (streamwork: DreamRecord): ContextReference => ({
  id: randomUUID(),
  kind: 'streamwork',
  label: `${streamwork.name} history`,
  mode: 'summary',
  streamworkId: streamwork.id,
  auto: true,
});

const buildGroupParticipantRecord = (
  id: GroupParticipantId,
  provider: SessionProvider,
  backingSessionId: string,
  model: string,
): GroupParticipant => ({
  id,
  label: provider === 'codex' ? 'Codex' : 'Claude',
  provider,
  backingSessionId,
  enabled: true,
  model,
  lastAppliedRoomSeq: 0,
});

const getParticipantIdForProvider = (provider: SessionProvider): GroupParticipantId =>
  provider === 'codex' ? 'codex' : 'claude';

const getSpeakerLabelForProvider = (provider: SessionProvider) =>
  provider === 'codex' ? 'Codex' : 'Claude';

export const createSession = async (
  sourceSessionId?: string,
  includeStreamworkSummary = false,
  provider?: SessionProvider,
  sessionKind: SessionKind = 'standard',
): Promise<SessionCreateResult> => {
  const state = await loadState();

  let sourceSession: SessionRecord | null = null;
  let sourceProject: ProjectRecord | null = null;
  let sourceDreamIndex = -1;

  state.projects.forEach((project) => {
    project.dreams.forEach((dream, dreamIndex) => {
      dream.sessions.forEach((session) => {
        if (session.id === sourceSessionId) {
          sourceSession = session as SessionRecord;
          sourceProject = project;
          sourceDreamIndex = dreamIndex;
        }
      });
    });
  });

  const fallbackProject = sourceProject ?? state.projects[0];
  const fallbackDream = fallbackProject?.dreams[sourceDreamIndex >= 0 ? sourceDreamIndex : 0];
  if (!fallbackProject || !fallbackDream) {
    throw new Error('No project or streamwork is available to create a session.');
  }

  const hadExistingSessions = fallbackDream.sessions.length > 0;
  if (sessionKind === 'group') {
    const nextIndex = fallbackDream.sessions.filter((session) => (session as SessionRecord).sessionKind === 'group').length + 1;
    const session = createGroupSessionInStreamwork(
      fallbackProject,
      fallbackDream,
      `New Group ${nextIndex}`,
      (sourceSession ?? (fallbackDream.sessions[0] as SessionRecord | undefined))?.workspace ?? fallbackProject.rootPath,
    );
    if (includeStreamworkSummary && hadExistingSessions) {
      session.contextReferences = [makeStreamworkHistoryReference(fallbackDream)];
    }
    await saveState(state);

    return {
      projects: summarizeProjectsForBootstrap(state.projects),
      session: JSON.parse(JSON.stringify(session)) as SessionRecord,
    };
  }

  const templateSession = (sourceSession ?? fallbackDream.sessions[0]) as SessionRecord | undefined;
  const sessionProvider = normalizeSessionProvider(provider ?? templateSession?.provider);
  const nextIndex = fallbackDream.sessions.length + 1;
  const now = new Date();
  const nextSession: SessionRecord = {
    id: randomUUID(),
    title: `New Session ${nextIndex}`,
    preview: getDefaultPreviewForProvider(sessionProvider),
    timeLabel: new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      month: 'numeric',
      day: 'numeric',
    }).format(now),
    updatedAt: now.getTime(),
    provider: sessionProvider,
    model:
      provider === undefined && normalizeSessionProvider(templateSession?.provider) === sessionProvider
        ? templateSession?.model ?? getDefaultModelForProvider(sessionProvider)
        : getDefaultModelForProvider(sessionProvider),
    workspace: templateSession?.workspace ?? fallbackProject.rootPath,
    projectId: fallbackProject.id,
    projectName: fallbackProject.name,
    dreamId: fallbackDream.id,
    dreamName: fallbackDream.name,
    claudeSessionId: undefined,
    codexThreadId: undefined,
    sessionKind: 'standard',
    hidden: false,
    instructionPrompt: undefined,
    group: undefined,
    groups: templateSession?.groups ?? [],
    contextReferences:
      includeStreamworkSummary && fallbackDream.sessions.length > 0
        ? [makeStreamworkHistoryReference(fallbackDream)]
        : [],
    tokenUsage: {
      contextWindow: templateSession?.tokenUsage.contextWindow ?? 0,
      used: 0,
      input: 0,
      output: 0,
      cached: 0,
      windowSource: templateSession?.tokenUsage.windowSource ?? 'unknown',
    },
    branchSnapshot: templateSession?.branchSnapshot ?? makeEmptyBranchSnapshot(fallbackProject.rootPath),
    messages: [],
  };

  fallbackDream.sessions.unshift(nextSession);
  await saveState(state);

  return {
    projects: summarizeProjectsForBootstrap(state.projects),
    session: JSON.parse(JSON.stringify(nextSession)) as SessionRecord,
  };
};

const createBaseSession = (
  project: ProjectRecord,
  streamwork: DreamRecord,
  title: string,
  workspace: string,
  provider?: SessionProvider,
  sessionKind: SessionKind = 'standard',
): SessionRecord => {
  const now = new Date();
  const normalizedKind = normalizeSessionKind(sessionKind);
  const normalizedProvider =
    normalizedKind === 'group' ? undefined : normalizeSessionProvider(provider);

  return {
    id: randomUUID(),
    title,
    preview: getDefaultPreviewForSessionKind(normalizedKind, normalizedProvider),
    timeLabel: new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      month: 'numeric',
      day: 'numeric',
    }).format(now),
    updatedAt: now.getTime(),
    provider: normalizedProvider,
    model: normalizedProvider ? getDefaultModelForProvider(normalizedProvider) : '',
    workspace,
    projectId: project.id,
    projectName: project.name,
    dreamId: streamwork.id,
    dreamName: streamwork.name,
    claudeSessionId: undefined,
    codexThreadId: undefined,
    sessionKind: normalizedKind,
    hidden: normalizedKind === 'group_member',
    instructionPrompt: undefined,
    group: undefined,
    groups: [],
    contextReferences: [],
    tokenUsage: {
      contextWindow: 0,
      used: 0,
      input: 0,
      output: 0,
      cached: 0,
      windowSource: 'unknown',
    },
    branchSnapshot: makeEmptyBranchSnapshot(workspace),
    messages: [],
  };
};

const createGroupMemberSession = (
  project: ProjectRecord,
  streamwork: DreamRecord,
  roomSession: SessionRecord,
  participantId: GroupParticipantId,
  provider: SessionProvider,
) => {
  const speakerLabel = provider === 'codex' ? 'Codex' : 'Claude';
  const memberSession = createBaseSession(
    project,
    streamwork,
    getGroupBackingSessionTitle(roomSession.title),
    roomSession.workspace,
    provider,
    'group_member',
  );
  memberSession.hidden = true;
  memberSession.preview = `${speakerLabel} group member session.`;
  memberSession.instructionPrompt = undefined;
  memberSession.group = {
    kind: 'member',
    roomSessionId: roomSession.id,
    participantId,
    speakerLabel,
  };
  return memberSession;
};

const createGroupSessionInStreamwork = (
  project: ProjectRecord,
  streamwork: DreamRecord,
  title: string,
  workspace: string,
) => {
  const roomSession = createBaseSession(project, streamwork, title, workspace, undefined, 'group');
  const claudeSession = createGroupMemberSession(project, streamwork, roomSession, 'claude', 'claude');
  const codexSession = createGroupMemberSession(project, streamwork, roomSession, 'codex', 'codex');

  roomSession.group = {
    kind: 'room',
    nextMessageSeq: 1,
    participants: [
      buildGroupParticipantRecord('claude', 'claude', claudeSession.id, claudeSession.model),
      buildGroupParticipantRecord('codex', 'codex', codexSession.id, codexSession.model),
    ],
  };

  streamwork.sessions.unshift(codexSession);
  streamwork.sessions.unshift(claudeSession);
  streamwork.sessions.unshift(roomSession);

  return roomSession;
};

export const ensureGroupRoomBackingSessions = async (sessionId: string): Promise<SessionRecord> => {
  await materializeSessionHistoryForRuntime(sessionId);
  const state = await loadState();
  let targetProject: ProjectRecord | undefined;
  let targetDream: DreamRecord | undefined;
  let targetSession: SessionRecord | undefined;

  state.projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      dream.sessions.forEach((session) => {
        if (session.id === sessionId) {
          targetProject = project;
          targetDream = dream;
          targetSession = session as SessionRecord;
        }
      });
    });
  });

  if (!targetProject || !targetDream || !targetSession) {
    throw new Error('Session not found.');
  }

  const project = targetProject;
  const dream = targetDream;
  const roomSession = targetSession;

  if (roomSession.sessionKind !== 'group' || roomSession.group?.kind !== 'room') {
    return JSON.parse(JSON.stringify(roomSession)) as SessionRecord;
  }

  const existingSessions = new Map(
    state.projects.flatMap((project) =>
      project.dreams.flatMap((dream) =>
        dream.sessions.map((session) => [session.id, session as SessionRecord] as const),
      ),
    ),
  );

  const roomIndex = dream.sessions.findIndex((session) => session.id === roomSession.id);
  if (roomIndex === -1) {
    throw new Error('Failed to locate the group room inside its streamwork.');
  }

  let insertedCount = 0;
  let changed = false;
  const nativeRenameTasks: Array<Promise<void>> = [];
  roomSession.group.participants = roomSession.group.participants.map((participant) => {
    const existing = existingSessions.get(participant.backingSessionId);
    if (
      existing &&
      existing.sessionKind === 'group_member' &&
      existing.group?.kind === 'member' &&
      existing.group.roomSessionId === roomSession.id &&
      existing.group.participantId === participant.id
    ) {
      const expectedTitle = getGroupBackingSessionTitle(roomSession.title);
      if (
        existing.hidden !== true ||
        existing.title !== expectedTitle ||
        existing.model !== (participant.model || existing.model) ||
        existing.instructionPrompt !== undefined
      ) {
        changed = true;
      }
      existing.hidden = true;
      if (existing.title !== expectedTitle) {
        existing.title = expectedTitle;
        if (existing.claudeSessionId) {
          nativeRenameTasks.push(
            renameNativeClaudeSession(existing.workspace, existing.claudeSessionId, expectedTitle),
          );
        }
        if (existing.codexThreadId) {
          nativeRenameTasks.push(renameNativeCodexThread(existing.codexThreadId, expectedTitle));
        }
      }
      existing.model = participant.model || existing.model;
      existing.instructionPrompt = undefined;
      return participant;
    }

    const recreated = createGroupMemberSession(
      project,
      dream,
      roomSession,
      participant.id,
      participant.provider,
    );
    recreated.model = participant.model || recreated.model;
    dream.sessions.splice(roomIndex + 1 + insertedCount, 0, recreated);
    insertedCount += 1;
    changed = true;

    return {
      ...participant,
      backingSessionId: recreated.id,
      model: recreated.model,
    };
  });

  if (changed || nativeRenameTasks.length > 0) {
    await Promise.allSettled(nativeRenameTasks);
    await saveState(state);
  }

  return JSON.parse(JSON.stringify(roomSession)) as SessionRecord;
};

export const ensureGroupRoomSession = async (sessionId: string): Promise<SessionRecord> => {
  await materializeSessionHistoryForRuntime(sessionId);
  const state = await loadState();
  let targetProject: ProjectRecord | undefined;
  let targetDream: DreamRecord | undefined;
  let targetSession: SessionRecord | undefined;

  state.projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      dream.sessions.forEach((session) => {
        if (session.id === sessionId) {
          targetProject = project;
          targetDream = dream;
          targetSession = session as SessionRecord;
        }
      });
    });
  });

  if (!targetProject || !targetDream || !targetSession) {
    throw new Error('Session not found.');
  }

  if (targetSession.sessionKind === 'group') {
    await saveState(state);
    return JSON.parse(JSON.stringify(targetSession)) as SessionRecord;
  }

  if (targetSession.sessionKind === 'group_member') {
    throw new Error('Cannot enter group mode from a hidden participant session.');
  }

  const baseProvider = normalizeSessionProvider(targetSession.provider);
  const primaryParticipantId = getParticipantIdForProvider(baseProvider);
  const primaryLabel = getSpeakerLabelForProvider(baseProvider);
  const roomSessionId = targetSession.id;
  const originalMessages = (targetSession.messages ?? []).map((message) => ({ ...message }));
  const highestExistingSeq = originalMessages.length;
  const nativeRenameTasks: Array<Promise<void>> = [];

  const primaryMemberSession = createGroupMemberSession(
    targetProject,
    targetDream,
    targetSession,
    primaryParticipantId,
    baseProvider,
  );
  primaryMemberSession.model = targetSession.model || primaryMemberSession.model;
  if (baseProvider === 'claude' && targetSession.claudeSessionId) {
    primaryMemberSession.claudeSessionId = targetSession.claudeSessionId;
    nativeRenameTasks.push(
      renameNativeClaudeSession(
        targetSession.workspace,
        targetSession.claudeSessionId,
        primaryMemberSession.title,
      ),
    );
  }
  if (baseProvider === 'codex' && targetSession.codexThreadId) {
    primaryMemberSession.codexThreadId = targetSession.codexThreadId;
    nativeRenameTasks.push(renameNativeCodexThread(targetSession.codexThreadId, primaryMemberSession.title));
  }

  const secondaryProvider: SessionProvider = baseProvider === 'codex' ? 'claude' : 'codex';
  const secondaryParticipantId = getParticipantIdForProvider(secondaryProvider);
  const secondaryMemberSession = createGroupMemberSession(
    targetProject,
    targetDream,
    targetSession,
    secondaryParticipantId,
    secondaryProvider,
  );

  targetSession.provider = undefined;
  targetSession.model = '';
  targetSession.claudeSessionId = undefined;
  targetSession.codexThreadId = undefined;
  targetSession.sessionKind = 'group';
  targetSession.hidden = false;
  targetSession.instructionPrompt = undefined;
  targetSession.group = {
    kind: 'room',
    nextMessageSeq: highestExistingSeq + 1,
    participants: [
      {
        ...buildGroupParticipantRecord(
          primaryParticipantId,
          baseProvider,
          primaryMemberSession.id,
          primaryMemberSession.model,
        ),
        lastAppliedRoomSeq: highestExistingSeq,
      },
      buildGroupParticipantRecord(
        secondaryParticipantId,
        secondaryProvider,
        secondaryMemberSession.id,
        secondaryMemberSession.model,
      ),
    ],
  };
  targetSession.messages = originalMessages.map((message, index) => ({
    ...message,
    seq: index + 1,
    speakerId: message.role === 'user' ? 'user' : primaryParticipantId,
    speakerLabel: message.role === 'user' ? 'You' : primaryLabel,
    provider: message.role === 'user' ? undefined : baseProvider,
    sourceSessionId: message.role === 'user' ? undefined : primaryMemberSession.id,
  }));
  targetSession.preview = targetSession.preview || 'Group chat is ready.';

  const insertionIndex = targetDream.sessions.findIndex((session) => session.id === roomSessionId);
  if (insertionIndex === -1) {
    throw new Error('Failed to locate the session inside its streamwork.');
  }

  targetDream.sessions.splice(insertionIndex + 1, 0, primaryMemberSession, secondaryMemberSession);
  await Promise.allSettled(nativeRenameTasks);
  await saveState(state, {
    replaceSessionIds: [targetSession.id],
    immediateIndex: true,
  });

  return JSON.parse(JSON.stringify(targetSession)) as SessionRecord;
};

export const createProject = async (name: string, rootPath: string): Promise<ProjectCreateResult> => {
  const state = await loadState();

  const existingProject = state.projects.find((project) => sameWorkspacePath(project.rootPath, rootPath));
  if (existingProject) {
    existingProject.name = name;
    existingProject.isClosed = false;
    ensureTemporaryStreamwork(existingProject);
    if (v2Store) {
      await hydrateProjectCatalogForOpen(existingProject, state.deletedImports);
    } else {
      await hydrateProjectForOpen(
        existingProject,
        (project) => importNativeProjectSessions(project, state.deletedImports),
        ensureProjectHasSession,
      );
    }
    const normalizedExistingProject = normalizeProjects([existingProject])[0] as ProjectRecord | undefined;
    if (!normalizedExistingProject) {
      throw new Error('Failed to normalize the reopened project.');
    }
    Object.assign(existingProject, normalizedExistingProject);
    const existingSession = ensureProjectHasSession(existingProject);
    await saveState(state, { immediateIndex: true });

    return {
      projects: cloneVisibleProjects(state.projects),
      project: JSON.parse(JSON.stringify(existingProject)) as ProjectRecord,
      session: JSON.parse(JSON.stringify(existingSession)) as SessionRecord,
    };
  }

  const project: ProjectRecord = {
    id: randomUUID(),
    name,
    rootPath,
    isClosed: false,
    dreams: [],
  };

  const temporaryStreamwork: DreamRecord = {
    id: randomUUID(),
    name: 'Temporary',
    isTemporary: true,
    sessions: [],
  };

  const streamwork: DreamRecord = {
    id: randomUUID(),
    name: 'Main Streamwork',
    sessions: [],
  };

  project.dreams.push(temporaryStreamwork, streamwork);
  if (v2Store) {
    await hydrateProjectCatalogForOpen(project, state.deletedImports);
  } else {
    await hydrateProjectForOpen(
      project,
      (targetProject) => importNativeProjectSessions(targetProject, state.deletedImports),
      ensureProjectHasSession,
    );
  }
  const normalizedProject = normalizeProjects([project])[0] as ProjectRecord | undefined;
  if (!normalizedProject) {
    throw new Error('Failed to normalize the created project.');
  }
  Object.assign(project, normalizedProject);
  const session = ensureProjectHasSession(project);
  state.projects.unshift(project);

  await saveState(state, { immediateIndex: true });

  return {
    projects: cloneVisibleProjects(state.projects),
    project: JSON.parse(JSON.stringify(project)) as ProjectRecord,
    session: JSON.parse(JSON.stringify(session)) as SessionRecord,
  };
};

export const createStreamwork = async (projectId: string, name: string): Promise<StreamworkCreateResult> => {
  const state = await loadState();
  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error('Project not found.');
  }

  const streamwork: DreamRecord = {
    id: randomUUID(),
    name,
    sessions: [],
  };

  const session = createBaseSession(project, streamwork, 'New Session 1', project.rootPath);
  streamwork.sessions.push(session);
  project.dreams.unshift(streamwork);

  await saveState(state);

  return {
    projects: cloneVisibleProjects(state.projects),
    streamwork: JSON.parse(JSON.stringify(streamwork)) as DreamRecord,
    session: JSON.parse(JSON.stringify(session)) as SessionRecord,
  };
};

export const createSessionInStreamwork = async (
  streamworkId: string,
  name?: string,
  includeStreamworkSummary = false,
  provider: SessionProvider = 'claude',
  sessionKind: SessionKind = 'standard',
): Promise<SessionCreateResult> => {
  const state = await loadState();
  let foundProject: ProjectRecord | undefined;
  let foundStreamwork: DreamRecord | undefined;

  state.projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      if (dream.id === streamworkId) {
        foundProject = project;
        foundStreamwork = dream;
      }
    });
  });

  if (!foundProject || !foundStreamwork) {
    throw new Error('Streamwork not found.');
  }

  const targetProject = foundProject;
  const targetStreamwork = foundStreamwork;
  const hadExistingSessions = targetStreamwork.sessions.length > 0;
  const nextIndex = targetStreamwork.sessions.filter((session) => !((session as SessionRecord).hidden)).length + 1;
  const session =
    sessionKind === 'group'
      ? createGroupSessionInStreamwork(
          targetProject,
          targetStreamwork,
          name?.trim() || `New Group ${nextIndex}`,
          targetProject.rootPath,
        )
      : createBaseSession(
          targetProject,
          targetStreamwork,
          name?.trim() || `New Session ${nextIndex}`,
          targetProject.rootPath,
          normalizeSessionProvider(provider),
        );
  if (includeStreamworkSummary && hadExistingSessions) {
    session.contextReferences = [makeStreamworkHistoryReference(targetStreamwork)];
  }
  if (sessionKind !== 'group') {
    targetStreamwork.sessions.unshift(session);
  }
  await saveState(state);

  return {
    projects: summarizeProjectsForBootstrap(state.projects),
    session: JSON.parse(JSON.stringify(session)) as SessionRecord,
  };
};

export const renameEntity = async (
  kind: 'project' | 'streamwork' | 'session',
  id: string,
  nextName: string,
): Promise<RenameEntityResult> => {
  const state = await loadState();
  const nativeRenameTasks: Array<Promise<void>> = [];

  state.projects.forEach((project) => {
    if (kind === 'project' && project.id === id) {
      project.name = nextName;
    }

    project.dreams.forEach((dream) => {
      if (kind === 'streamwork' && dream.id === id) {
        if (dream.isTemporary) {
          return;
        }
        dream.name = nextName;
      }

      dream.sessions.forEach((session) => {
        if (kind === 'session' && session.id === id) {
          applySessionTitleRename(session, nextName, nativeRenameTasks);
          if (session.sessionKind === 'group' && session.group?.kind === 'room') {
            const backingSessionIds = new Set(
              session.group.participants.map((participant) => participant.backingSessionId),
            );
            dream.sessions.forEach((candidate) => {
              if (backingSessionIds.has(candidate.id)) {
                applySessionTitleRename(
                  candidate,
                  getGroupBackingSessionTitle(nextName),
                  nativeRenameTasks,
                );
              }
            });
          }
        }
        if (kind === 'project' && session.projectId === project.id) {
          session.projectName = project.name;
        }
        if (kind === 'streamwork' && session.dreamId === dream.id) {
          session.dreamName = dream.name;
        }
        session.contextReferences = normalizeContextReferences(session.contextReferences).map((reference) => {
          if (kind === 'session' && reference.kind === 'session' && reference.sessionId === id) {
            return {
              ...reference,
              label: nextName,
            };
          }

          if (kind === 'streamwork' && reference.kind === 'streamwork' && reference.streamworkId === id) {
            return {
              ...reference,
              label: `${nextName} history`,
            };
          }

          return reference;
        });
      });
    });
  });

  await Promise.allSettled(nativeRenameTasks);
  await saveState(state);
  return {
    projects: cloneVisibleProjects(state.projects),
  };
};

export const reorderStreamworks = async (
  projectId: string,
  sourceStreamworkId: string,
  targetStreamworkId: string,
): Promise<RenameEntityResult> => {
  const state = await loadState();
  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error('Project not found.');
  }

  const sourceIndex = project.dreams.findIndex((dream) => dream.id === sourceStreamworkId);
  const targetIndex = project.dreams.findIndex((dream) => dream.id === targetStreamworkId);

  if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
    return {
      projects: cloneVisibleProjects(state.projects),
    };
  }

  if (project.dreams[sourceIndex]?.isTemporary || project.dreams[targetIndex]?.isTemporary) {
    return {
      projects: cloneVisibleProjects(state.projects),
    };
  }

  const [moved] = project.dreams.splice(sourceIndex, 1);
  project.dreams.splice(targetIndex, 0, moved);
  project.dreams = sortDreamsWithTemporaryFirst(project.dreams);

  await saveState(state);

  return {
    projects: cloneVisibleProjects(state.projects),
  };
};

export const closeProject = async (projectId: string): Promise<CloseProjectResult> => {
  const state = await loadState();
  const project = state.projects.find((item) => item.id === projectId);

  if (!project) {
    throw new Error('Project not found.');
  }

  project.isClosed = true;
  const closedSessionIds = project.dreams.flatMap((dream) => dream.sessions.map((session) => session.id));
  await saveState(state);

  return {
    projects: cloneVisibleProjects(state.projects),
    closedSessionIds,
  };
};

export const deleteStreamwork = async (streamworkId: string): Promise<DeleteEntityResult> => {
  const state = await loadState();
  let deletedSessionIds: string[] = [];
  let deletedNativeSessions: Array<{ workspace: string; sessionId: string }> = [];
  let deletedNativeCodexThreads: string[] = [];

  state.projects.forEach((project) => {
    project.dreams = project.dreams.filter((dream) => {
      if (dream.id !== streamworkId) {
        return true;
      }
      if (dream.isTemporary) {
        return true;
      }
      deletedSessionIds = dream.sessions.map((session) => session.id);
      const nativeTargets = collectNativeDeleteTargets(dream.sessions);
      deletedNativeSessions = nativeTargets.claudeSessions;
      deletedNativeCodexThreads = nativeTargets.codexThreadIds;
      rememberDeletedImports(state, nativeTargets);
      return false;
    });
  });

  const [claudeCleanup, codexCleanup] = await Promise.all([
    deleteNativeClaudeSessions(deletedNativeSessions),
    deleteNativeCodexThreads(deletedNativeCodexThreads),
  ]);
  const warnings = [...claudeCleanup.warnings, ...codexCleanup.warnings];
  logNativeCleanupWarnings(warnings);
  await saveState(state, {
    deletedSessionIds,
    immediateIndex: true,
  });
  return {
    projects: cloneVisibleProjects(state.projects),
    deletedSessionIds,
    warning: summarizeDeleteWarning(warnings),
  };
};

export const deleteSession = async (sessionId: string): Promise<DeleteEntityResult> => {
  const state = await loadState();
  const deletedSessionIds = new Set<string>();
  let deletedNativeSessions: Array<{ workspace: string; sessionId: string }> = [];
  let deletedNativeCodexThreads: string[] = [];

  state.projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      const target = dream.sessions.find((session) => session.id === sessionId);
      const extraDeletedIds =
        target?.sessionKind === 'group' && target.group?.kind === 'room'
          ? target.group.participants.map((participant) => participant.backingSessionId)
          : [];
      const removedSessions = dream.sessions.filter(
        (session) => session.id === sessionId || extraDeletedIds.includes(session.id),
      );
      const nativeTargets = collectNativeDeleteTargets(removedSessions);
      deletedNativeSessions.push(...nativeTargets.claudeSessions);
      deletedNativeCodexThreads.push(...nativeTargets.codexThreadIds);
      rememberDeletedImports(state, nativeTargets);
      const nextSessions = dream.sessions.filter(
        (session) => session.id !== sessionId && !extraDeletedIds.includes(session.id),
      );
      if (nextSessions.length !== dream.sessions.length) {
        deletedSessionIds.add(sessionId);
        extraDeletedIds.forEach((id) => deletedSessionIds.add(id));
      }
      dream.sessions = nextSessions;
    });
  });

  const [claudeCleanup, codexCleanup] = await Promise.all([
    deleteNativeClaudeSessions(deletedNativeSessions),
    deleteNativeCodexThreads(deletedNativeCodexThreads),
  ]);
  const warnings = [...claudeCleanup.warnings, ...codexCleanup.warnings];
  logNativeCleanupWarnings(warnings);
  await saveState(state, {
    deletedSessionIds: [...deletedSessionIds],
    immediateIndex: true,
  });
  return {
    projects: cloneVisibleProjects(state.projects),
    deletedSessionIds: [...deletedSessionIds],
    warning: summarizeDeleteWarning(warnings),
  };
};
