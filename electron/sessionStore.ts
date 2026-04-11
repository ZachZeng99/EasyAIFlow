import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
import { normalizeClaudeModelSelection } from './claudeModel.js';
import { mergeNativeImportedSessions } from './nativeSessionMerge.js';
import { mergeNativeSessionIntoExisting, shouldRecoverSessionFromNative } from './nativeSessionRecovery.js';
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
  toClaudeProjectDirName,
} from './workspacePaths.js';
import { filterVisibleProjects } from './projectVisibility.js';
import { normalizeProjectsForCache, normalizeProjectsFromPersistence } from './sessionStoreNormalization.js';
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
  SessionCreateResult,
  SessionRecord,
  SessionSummary,
  StreamworkCreateResult,
  TokenUsage,
  RenameEntityResult,
} from '../src/data/types.js';

type AppState = {
  projects: ProjectRecord[];
};

let cachedState: AppState | null = null;
const storePath = () => path.join(getRuntimePaths().userDataPath, 'easyaiflow-sessions.json');
const nativeClaudeProjectsRoot = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.claude', 'projects');
const nativeClaudeHistoryPath = () =>
  path.join(process.env.USERPROFILE ?? getRuntimePaths().homePath, '.claude', 'history.jsonl');

const normalizeSessionModel = (model: string, provider: SessionProvider) =>
  provider === 'claude' ? normalizeClaudeModelSelection(model) ?? model.trim() : model.trim();

const normalizeSessionKind = (value: SessionKind | undefined): SessionKind =>
  value === 'group' || value === 'group_member' ? value : 'standard';

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
    normalizedModel.includes('opus') || normalizedModel.includes('sonnet') || normalizedModel.includes('claude');
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
      ...project,
      dreams: sortDreamsWithTemporaryFirst(project.dreams).map((dream) => ({
        ...dream,
        sessions: normalizeDreamSessions(dream),
      })),
    }),
  ) as ProjectRecord[];

const normalizeDreamSessions = (dream: DreamRecord) => {
  const sessions = dream.sessions.map((session) => {
    const current = session as SessionRecord;
    const sessionKind = normalizeSessionKind(current.sessionKind);
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
      provider,
      model,
      sessionKind,
      hidden: wasUnknownLegacySessionKind ? false : Boolean(current.hidden),
      group: normalizeGroupMetadata(current.group),
      contextReferences: normalizeContextReferences(current.contextReferences),
      tokenUsage: normalizeTokenUsage(current.tokenUsage, model),
      messages: current.messages ?? [],
      updatedAt: current.updatedAt,
    };
  }) as SessionRecord[];

  return dream.isTemporary ? pruneTemporaryImportedDuplicates(sessions) : sessions;
};

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

const nativeClaudeSessionFilePath = (rootPath: string, claudeSessionId: string) => {
  const dirName = toClaudeProjectDirName(rootPath);
  if (!dirName) {
    return null;
  }

  return path.join(nativeClaudeProjectsRoot(), dirName, `${claudeSessionId}.jsonl`);
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
      if (typeof messageObj?.model === 'string') {
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

const parseCodexSessionFile = async (
  filePath: string,
  threadNameIndex: Map<string, string>,
) => {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages: ConversationMessage[] = [];
  let workspace = '';
  let model = 'gpt-5.4';
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
        }
      | undefined;
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

  let raw = '';
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return;
  }

  const nextLine = JSON.stringify({
    type: 'custom-title',
    customTitle: nextName,
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
};

const renameNativeCodexThread = async (codexThreadId: string, nextName: string) => {
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

const importNativeClaudeSessions = async (project: ProjectRecord) => {
  const temporary = project.dreams.find((dream) => dream.isTemporary);
  if (!temporary) {
    return;
  }

  const existingSessions = [...temporary.sessions] as SessionRecord[];
  const projectSessions = project.dreams.flatMap((dream) => dream.sessions) as SessionRecord[];
  const existingByClaudeSessionId = new Map(
    projectSessions
      .filter((session): session is SessionRecord & { claudeSessionId: string } => Boolean(session.claudeSessionId))
      .map((session) => [session.claudeSessionId, session]),
  );

  const dirName = toClaudeProjectDirName(project.rootPath);
  if (!dirName) {
    temporary.sessions = existingSessions;
    return;
  }

  const nativeDir = path.join(nativeClaudeProjectsRoot(), dirName);
  let files: string[] = [];

  try {
    files = (await readdir(nativeDir)).filter((file) => file.endsWith('.jsonl'));
  } catch {
    temporary.sessions = existingSessions;
    return;
  }

  const seenNativeIds = new Set<string>();
  const importedSessions: SessionRecord[] = [];

  for (const file of files) {
    let parsed:
      | Awaited<ReturnType<typeof parseNativeClaudeSessionFile>>
      | undefined;
    try {
      parsed = await parseNativeClaudeSessionFile(path.join(nativeDir, file));
    } catch {
      continue;
    }
    const workspace = parsed.workspace || project.rootPath;
    if (!sameWorkspacePath(workspace, project.rootPath)) {
      continue;
    }

    seenNativeIds.add(parsed.nativeSessionId);
    const existing =
      findImportedSessionTarget(projectSessions, parsed.nativeSessionId, parsed.title, workspace, 'claudeSessionId', 'claude') ??
      existingByClaudeSessionId.get(parsed.nativeSessionId);
    const display = resolveImportedSessionDisplay(existing, parsed);
    const targetDreamId = existing?.dreamId ?? temporary.id;
    const targetDreamName = existing?.dreamName ?? temporary.name;
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

const importNativeCodexSessions = async (project: ProjectRecord) => {
  const temporary = project.dreams.find((dream) => dream.isTemporary);
  if (!temporary) {
    return;
  }

  const existingSessions = [...temporary.sessions] as SessionRecord[];
  const projectSessions = project.dreams.flatMap((dream) => dream.sessions) as SessionRecord[];
  const existingByCodexThreadId = new Map(
    projectSessions
      .filter((session): session is SessionRecord & { codexThreadId: string } => Boolean(session.codexThreadId))
      .map((session) => [session.codexThreadId, session]),
  );

  const files = [
    ...(await listJsonlFilesRecursively(codexSessionsRoot())),
    ...(await listJsonlFilesRecursively(codexArchivedSessionsRoot())),
  ];
  const threadNameIndex = await readCodexThreadNameIndex();

  const seenCodexIds = new Set<string>();
  const importedSessions: SessionRecord[] = [];

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
      dreamId: temporary.id,
      dreamName: temporary.name,
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

const importNativeProjectSessions = async (project: ProjectRecord) => {
  await importNativeClaudeSessions(project);
  await importNativeCodexSessions(project);
};

const recoverExistingSessionsFromNativeHistory = async (projects: ProjectRecord[]) => {
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

    let parsed:
      | Awaited<ReturnType<typeof parseNativeClaudeSessionFile>>
      | undefined;
    try {
      parsed = await parseNativeClaudeSessionFile(filePath);
    } catch {
      parsed = undefined;
    }

    if (!parsed || !shouldRecoverSessionFromNative(session, parsed)) {
      continue;
    }

    Object.assign(session, mergeNativeSessionIntoExisting(session, parsed));
  }
};

const deleteNativeClaudeSessions = async (nativeSessions: Array<{ workspace: string; sessionId: string }>) => {
  if (nativeSessions.length === 0) {
    return;
  }

  const uniqueSessions = [...new Map(
    nativeSessions.map((session) => [`${normalizeWorkspacePath(session.workspace)}::${session.sessionId}`, session]),
  ).values()];
  const uniqueIds = [...new Set(uniqueSessions.map((session) => session.sessionId))];

  await Promise.all(
    uniqueSessions.flatMap((session) => {
      const dirName = toClaudeProjectDirName(session.workspace);
      if (!dirName) {
        return [];
      }

      const nativeDir = path.join(nativeClaudeProjectsRoot(), dirName);
      return [
        rm(path.join(nativeDir, `${session.sessionId}.jsonl`), { force: true }),
        rm(path.join(nativeDir, session.sessionId), { force: true, recursive: true }),
      ];
    }),
  ).catch(() => undefined);

  try {
    const raw = await readFile(nativeClaudeHistoryPath(), 'utf8');
    const filtered = raw
      .split(/\r?\n/)
      .filter((line) => line && !uniqueIds.some((sessionId) => line.includes(`"sessionId":"${sessionId}"`)))
      .join('\n');
    await writeFile(nativeClaudeHistoryPath(), `${filtered}\n`, 'utf8');
  } catch {
    // Ignore history cleanup failures.
  }
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
  const existingSession = project.dreams.flatMap((dream) => dream.sessions)[0] as SessionRecord | undefined;
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
const cloneVisibleProjects = (projects: ProjectRecord[]) => cloneProjects(filterVisibleProjects(projects));

const ensureStateShape = (value: unknown): AppState => {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { projects?: unknown }).projects)) {
    return { projects: buildInitialProjects() };
  }

  const projects = cloneProjects((value as { projects: ProjectRecord[] }).projects);
  projects.forEach((project) => ensureTemporaryStreamwork(project));

  return {
    projects: normalizeProjectsForCache(normalizeProjects(projects)),
  };
};

const hydrateLoadedState = async (state: AppState) => {
  for (const project of state.projects) {
    try {
    await importNativeProjectSessions(project);
    } catch {
      // Preserve the persisted project tree when auxiliary native-session import fails.
    }
  }

  try {
    await recoverExistingSessionsFromNativeHistory(state.projects);
  } catch {
    // Keep the persisted project tree even if native-history recovery cannot complete.
  }

  state.projects = normalizeProjectsFromPersistence(normalizeProjects(state.projects));
};

export const loadState = async () => {
  if (cachedState) {
    cachedState.projects = normalizeProjectsForCache(normalizeProjects(cachedState.projects));
    cachedState.projects.forEach((project) => ensureTemporaryStreamwork(project));
    return cachedState;
  }

  try {
    const raw = await readFile(storePath(), 'utf8');
    cachedState = ensureStateShape(JSON.parse(raw));
  } catch {
    cachedState = { projects: buildInitialProjects() };
  }

  await hydrateLoadedState(cachedState);
  await saveState(cachedState);

  return cachedState;
};

let pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 800;

const writeToDisk = async () => {
  if (!cachedState) {
    return;
  }
  await mkdir(path.dirname(storePath()), { recursive: true });
  await writeFile(storePath(), JSON.stringify(cachedState, null, 2), 'utf8');
};

export const saveState = async (state: AppState) => {
  cachedState = {
    projects: normalizeProjectsForCache(normalizeProjects(cloneProjects(state.projects))),
  };

  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
  }
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    void writeToDisk();
  }, SAVE_DEBOUNCE_MS);
};

/** Flush any pending debounced write immediately. Call before app exit. */
export const flushPendingSave = async () => {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  await writeToDisk();
};

export const getProjects = async () => {
  const state = await loadState();
  return cloneVisibleProjects(state.projects);
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
  let found: SessionRecord | null = null;

  forEachSession(state.projects, (session) => {
    if (session.id === sessionId) {
      found = session;
    }
  });

  return found;
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
  await saveState(state);
  return record;
};

export const updateSessionRecord = async (
  sessionId: string,
  updater: (session: SessionRecord) => void,
) => {
  const state = await loadState();
  let updatedSession: SessionRecord | null = null;

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    updater(session);
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

export const appendMessagesToSession = async (
  sessionId: string,
  messages: ConversationMessage[],
  preview: string,
  timeLabel: string,
) => {
  const state = await loadState();

  forEachSession(state.projects, (session) => {
    if (session.id === sessionId) {
      const nextMessages = assignMessagesForSession(session, messages);
      session.messages = [...(session.messages ?? []), ...nextMessages];
      session.preview = preview;
      session.timeLabel = timeLabel;
      session.updatedAt = Date.now();
    }
  });

  await saveState(state);
  return cloneVisibleProjects(state.projects);
};

export const appendTraceMessagesToSession = async (
  sessionId: string,
  messages: ConversationMessage[],
) => {
  const state = await loadState();

  forEachSession(state.projects, (session) => {
    if (session.id === sessionId) {
      const nextMessages = assignMessagesForSession(session, messages);
      session.messages = [...(session.messages ?? []), ...nextMessages];
      session.updatedAt = Date.now();
    }
  });

  await saveState(state);
};

export const upsertSessionMessage = async (
  sessionId: string,
  message: ConversationMessage,
) => {
  const state = await loadState();

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

  await saveState(state);
};

export const updateAssistantMessage = async (
  sessionId: string,
  messageId: string,
  updater: (message: ConversationMessage, session: SessionSummary) => void,
) => {
  const state = await loadState();

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

  await saveState(state);
};

export const setSessionRuntime = async (
  sessionId: string,
  values: {
    claudeSessionId?: string;
    codexThreadId?: string;
    model?: string;
    preview?: string;
    timeLabel?: string;
    tokenUsage?: TokenUsage;
  },
) => {
  const state = await loadState();

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    if (values.claudeSessionId) {
      session.claudeSessionId = values.claudeSessionId;
    }
    if (values.codexThreadId) {
      session.codexThreadId = values.codexThreadId;
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
  });

  await saveState(state);
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
      projects: cloneVisibleProjects(state.projects),
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
    projects: cloneVisibleProjects(state.projects),
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

  const primaryMemberSession = createGroupMemberSession(
    targetProject,
    targetDream,
    targetSession,
    primaryParticipantId,
    baseProvider,
  );
  primaryMemberSession.model = targetSession.model || primaryMemberSession.model;

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
  await saveState(state);

  return JSON.parse(JSON.stringify(targetSession)) as SessionRecord;
};

export const createProject = async (name: string, rootPath: string): Promise<ProjectCreateResult> => {
  const state = await loadState();

  const existingProject = state.projects.find((project) => sameWorkspacePath(project.rootPath, rootPath));
  if (existingProject) {
    existingProject.name = name;
    existingProject.isClosed = false;
    ensureTemporaryStreamwork(existingProject);
    const existingSession = await hydrateProjectForOpen(
      existingProject,
      importNativeProjectSessions,
      ensureProjectHasSession,
    );
    await saveState(state);

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
  const session = await hydrateProjectForOpen(project, importNativeProjectSessions, ensureProjectHasSession);
  state.projects.unshift(project);

  await saveState(state);

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
    projects: cloneVisibleProjects(state.projects),
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

  state.projects.forEach((project) => {
    project.dreams = project.dreams.filter((dream) => {
      if (dream.id !== streamworkId) {
        return true;
      }
      if (dream.isTemporary) {
        return true;
      }
      deletedSessionIds = dream.sessions.map((session) => session.id);
      deletedNativeSessions = dream.sessions
        .filter((session): session is SessionRecord & { claudeSessionId: string } => Boolean(session.claudeSessionId))
        .map((session) => ({
          workspace: session.workspace,
          sessionId: session.claudeSessionId,
        }));
      return false;
    });
  });

  await deleteNativeClaudeSessions(deletedNativeSessions);
  await saveState(state);
  return {
    projects: cloneVisibleProjects(state.projects),
    deletedSessionIds,
  };
};

export const deleteSession = async (sessionId: string): Promise<DeleteEntityResult> => {
  const state = await loadState();
  const deletedSessionIds = new Set<string>();
  let deletedNativeSessions: Array<{ workspace: string; sessionId: string }> = [];

  state.projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      const target = dream.sessions.find((session) => session.id === sessionId);
      const extraDeletedIds =
        target?.sessionKind === 'group' && target.group?.kind === 'room'
          ? target.group.participants.map((participant) => participant.backingSessionId)
          : [];
      if (target?.claudeSessionId) {
        deletedNativeSessions.push({
          workspace: target.workspace,
          sessionId: target.claudeSessionId,
        });
      }
      dream.sessions.forEach((session) => {
        if (extraDeletedIds.includes(session.id) && session.claudeSessionId) {
          deletedNativeSessions.push({
            workspace: session.workspace,
            sessionId: session.claudeSessionId,
          });
        }
      });
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

  await deleteNativeClaudeSessions(deletedNativeSessions);
  await saveState(state);
  return {
    projects: cloneVisibleProjects(state.projects),
    deletedSessionIds: [...deletedSessionIds],
  };
};
