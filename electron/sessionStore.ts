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
} from './backgroundTaskNotification.js';
import { mergeNativeImportedSessions } from './nativeSessionMerge.js';
import { mergeNativeSessionIntoExisting, shouldRecoverSessionFromNative } from './nativeSessionRecovery.js';
import { hydrateProjectForOpen } from './projectOpen.js';
import { buildRecordedCodeChangeDiff } from './recordedCodeChangeDiff.js';
import { sortDreamsWithTemporaryFirst } from '../src/data/streamworkOrder.js';
import { normalizeWorkspacePath, sameWorkspacePath, toClaudeProjectDirName } from './workspacePaths.js';
import { filterVisibleProjects } from './projectVisibility.js';
import { normalizeProjectsForCache, normalizeProjectsFromPersistence } from './sessionStoreNormalization.js';
import type {
  BranchSnapshot,
  CloseProjectResult,
  ConversationMessage,
  ContextReference,
  DeleteEntityResult,
  DreamRecord,
  HarnessBootstrapResult,
  HarnessSessionState,
  HarnessRole,
  ProjectCreateResult,
  ProjectRecord,
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

const normalizeSessionModel = (model: string) => model.trim();

const normalizeSessionKind = (value: SessionKind | undefined): SessionKind =>
  value === 'harness' || value === 'harness_role' ? value : 'standard';

const sanitizeHarnessFileSegment = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session';

const cloneContextReferences = (references: ContextReference[] | undefined) =>
  (references ?? []).map((reference) => ({ ...reference }));

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

const normalizeHarnessState = (state: HarnessSessionState | undefined): HarnessSessionState | undefined => {
  if (!state) {
    return undefined;
  }

  return {
    plannerSessionId: state.plannerSessionId,
    generatorSessionId: state.generatorSessionId,
    evaluatorSessionId: state.evaluatorSessionId,
    artifactDir: state.artifactDir,
    status:
      state.status === 'running' ||
      state.status === 'completed' ||
      state.status === 'failed' ||
      state.status === 'cancelled'
        ? state.status
        : 'ready',
    currentOwner: state.currentOwner,
    currentStage: state.currentStage ?? 'idle',
    currentSprint: state.currentSprint ?? 0,
    currentRound: state.currentRound ?? 0,
    completedSprints: state.completedSprints ?? 0,
    maxSprints: state.maxSprints ?? 0,
    completedTurns: state.completedTurns ?? 0,
    totalTurns: state.totalTurns ?? 0,
    lastDecision: state.lastDecision ?? 'NOT_STARTED',
    summary: state.summary,
    updatedAt: state.updatedAt,
  };
};

const buildHarnessArtifactDir = (workspace: string, rootSessionId: string) =>
  path.join(workspace, '.easyaiflow', 'harness', sanitizeHarnessFileSegment(rootSessionId));

const buildHarnessArtifactPaths = (artifactDir: string) => ({
  spec: path.join(artifactDir, 'product-spec.md'),
  contract: path.join(artifactDir, 'sprint-contract.md'),
  evaluation: path.join(artifactDir, 'evaluation-report.md'),
  handoff: path.join(artifactDir, 'handoff.md'),
  manifest: path.join(artifactDir, 'manifest.json'),
});

const buildHarnessInstructionPrompt = (
  role: HarnessRole,
  artifactDir: string,
  workspace: string,
) => {
  const files = buildHarnessArtifactPaths(artifactDir);

  const shared = [
    'You are part of a long-running multi-agent coding harness inside EasyAIFlow.',
    `Workspace root: ${workspace}`,
    `Artifact directory: ${artifactDir}`,
    `Shared files: spec=${files.spec}, contract=${files.contract}, evaluation=${files.evaluation}, handoff=${files.handoff}`,
    'Treat the shared files as the source of truth for handoff between sessions.',
    'When you make progress, update the relevant shared file before you finish your turn.',
    'Keep outputs structured, terse, and easy for the next agent to continue from.',
  ];

  if (role === 'planner') {
    return [
      ...shared,
      'Role: planner.',
      'Expand short product asks into an ambitious but still coherent product spec.',
      'Stay at product scope and high-level technical design. Do not lock in fragile low-level implementation details too early.',
      'Write the working spec into product-spec.md and write actionable next steps for generator and evaluator into handoff.md.',
    ].join('\n');
  }

  if (role === 'generator') {
    return [
      ...shared,
      'Role: generator.',
      'Implement the product in small, testable sprints instead of trying to finish everything in one pass.',
      'Before coding, refine sprint-contract.md so it states what this sprint will deliver, how done will be verified, and what is explicitly out of scope.',
      'After coding, update handoff.md with what changed, remaining risks, and the next recommended sprint.',
      'Prefer incremental, verifiable progress over broad but fragile scope.',
    ].join('\n');
  }

  return [
    ...shared,
    'Role: evaluator.',
    'Be skeptical. Do not praise incomplete or brittle work.',
    'Review the current sprint against four criteria: product depth, functionality, visual design, and code quality.',
    'If a criterion is below bar, explain the failure concretely and write the blocking issues into evaluation-report.md.',
    'Use sprint-contract.md to verify the agreed definition of done and write precise retry guidance into handoff.md.',
  ].join('\n');
};

const buildHarnessArtifactTemplate = (
  type: keyof ReturnType<typeof buildHarnessArtifactPaths>,
  session: SessionRecord,
) => {
  if (type === 'spec') {
    return `# Product Spec

Source session: ${session.title}
Source session id: ${session.id}
Workspace: ${session.workspace}

## Product goal
- Capture the user request at product level.

## User journeys
- List the primary flows the app must support.

## Scope
- Core features
- Stretch features
- Explicit non-goals

## Technical direction
- Architecture
- Data/storage
- Runtime/tooling

## Risks and open questions
- Unknowns
- Tradeoffs
`;
  }

  if (type === 'contract') {
    return `# Sprint Contract

## Current sprint
- Objective:
- Why this sprint now:

## Done means
- [ ] User-visible behavior
- [ ] Tests/checks
- [ ] Data/state expectations

## Out of scope
- 

## Verification plan
- Manual checks:
- Automated checks:
`;
  }

  if (type === 'evaluation') {
    return `# Evaluation Report

## Overall status
- Pass/Fail:

## Scorecard
- Product depth:
- Functionality:
- Visual design:
- Code quality:

## Bugs and regressions
- 

## Required fixes before next pass
- 
`;
  }

  if (type === 'handoff') {
    return `# Handoff

## Latest state
- 

## Next recommended owner
- Planner / Generator / Evaluator

## Next action
- 

## Risks
- 
`;
  }

  return JSON.stringify(
    {
      sourceSessionId: session.id,
      sourceSessionTitle: session.title,
      workspace: session.workspace,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  );
};

const ensureFileWithTemplate = async (
  filePath: string,
  content: string,
) => {
  try {
    await readFile(filePath, 'utf8');
  } catch {
    await writeFile(filePath, content, 'utf8');
  }
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
    const model = normalizeSessionModel(current.model);

    return {
      ...current,
      model,
      sessionKind: normalizeSessionKind(current.sessionKind),
      hidden: Boolean(current.hidden),
      contextReferences: normalizeContextReferences(current.contextReferences),
      harnessState: normalizeHarnessState(current.harnessState),
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
            continue;
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
        continue;
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
        const content = extractTextFromContent(messageObj?.content);
        const text = firstMeaningfulLine(content);
        if (!text) {
          continue;
        }
        if (shouldSkipSyntheticAssistantPlaceholder(messageObj?.model, content)) {
          continue;
        }
        if (backgroundTaskNotificationPending) {
          backgroundTaskNotificationPending = false;
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

      for (const block of messageObj.content) {
        if (!block || typeof block !== 'object') {
          continue;
        }

        const blockType = (block as { type?: string }).type;

        if (blockType === 'text') {
          const content = (block as { text?: string }).text ?? '';
          const text = firstMeaningfulLine(content);
          if (!text) {
            continue;
          }
          if (shouldSkipSyntheticAssistantPlaceholder(messageObj?.model, content)) {
            continue;
          }
          if (backgroundTaskNotificationPending) {
            backgroundTaskNotificationPending = false;
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
      findImportedSessionTarget(projectSessions, parsed.nativeSessionId, parsed.title, workspace) ??
      existingByClaudeSessionId.get(parsed.nativeSessionId);
    const display = resolveImportedSessionDisplay(existing, parsed);
    const targetDreamId = existing?.dreamId ?? temporary.id;
    const targetDreamName = existing?.dreamName ?? temporary.name;
    const importedSession: SessionRecord = {
      id: existing?.id ?? randomUUID(),
      title: display.title,
      preview: display.preview,
      timeLabel: display.timeLabel,
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
      harness: existing?.harness,
      harnessState: normalizeHarnessState(existing?.harnessState),
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
      await importNativeClaudeSessions(project);
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

export const saveState = async (state: AppState) => {
  cachedState = {
    projects: normalizeProjectsForCache(normalizeProjects(cloneProjects(state.projects))),
  };

  await mkdir(path.dirname(storePath()), { recursive: true });
  await writeFile(storePath(), JSON.stringify(cachedState, null, 2), 'utf8');
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
    contextReferences: normalizeContextReferences(session.contextReferences),
    messages: [],
  };

  dream.sessions.unshift(record);
  await saveState(state);
  return record;
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
      session.messages = [...(session.messages ?? []), ...messages];
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
      session.messages = [...(session.messages ?? []), ...messages];
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
      session.messages = [...(session.messages ?? []), message];
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

export const createSession = async (
  sourceSessionId?: string,
  includeStreamworkSummary = false,
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

  const templateSession = (sourceSession ?? fallbackDream.sessions[0]) as SessionRecord | undefined;
  const nextIndex = fallbackDream.sessions.length + 1;
  const now = new Date();
  const nextSession: SessionRecord = {
    id: randomUUID(),
    title: `New Session ${nextIndex}`,
    preview: 'Start a new Claude conversation.',
    timeLabel: new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      month: 'numeric',
      day: 'numeric',
    }).format(now),
    updatedAt: now.getTime(),
    model: templateSession?.model ?? 'opus[1m]',
    workspace: templateSession?.workspace ?? fallbackProject.rootPath,
    projectId: fallbackProject.id,
    projectName: fallbackProject.name,
    dreamId: fallbackDream.id,
    dreamName: fallbackDream.name,
    claudeSessionId: undefined,
    sessionKind: 'standard',
    hidden: false,
    instructionPrompt: undefined,
    harness: undefined,
    harnessState: undefined,
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
): SessionRecord => {
  const now = new Date();

  return {
    id: randomUUID(),
    title,
    preview: 'Start a new Claude conversation.',
    timeLabel: new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      month: 'numeric',
      day: 'numeric',
    }).format(now),
    updatedAt: now.getTime(),
    model: 'opus[1m]',
    workspace,
    projectId: project.id,
    projectName: project.name,
    dreamId: streamwork.id,
    dreamName: streamwork.name,
    claudeSessionId: undefined,
    sessionKind: 'standard',
    hidden: false,
    instructionPrompt: undefined,
    harness: undefined,
    harnessState: undefined,
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

const ensureHarnessArtifacts = async (session: SessionRecord, artifactDir: string) => {
  const files = buildHarnessArtifactPaths(artifactDir);
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    ensureFileWithTemplate(files.spec, buildHarnessArtifactTemplate('spec', session)),
    ensureFileWithTemplate(files.contract, buildHarnessArtifactTemplate('contract', session)),
    ensureFileWithTemplate(files.evaluation, buildHarnessArtifactTemplate('evaluation', session)),
    ensureFileWithTemplate(files.handoff, buildHarnessArtifactTemplate('handoff', session)),
    writeFile(files.manifest, buildHarnessArtifactTemplate('manifest', session), 'utf8'),
  ]);
};

const ensureHarnessSession = (
  project: ProjectRecord,
  streamwork: DreamRecord,
  rootSession: SessionRecord,
  role: HarnessRole,
  artifactDir: string,
) => {
  const existing = streamwork.sessions.find(
    (session) =>
      (session as SessionRecord).harness?.rootSessionId === rootSession.id &&
      (session as SessionRecord).harness?.role === role,
  ) as SessionRecord | undefined;

  const instructionPrompt = buildHarnessInstructionPrompt(role, artifactDir, rootSession.workspace);
  const title = `[${role}] ${rootSession.title}`;
  const harness = {
    role,
    rootSessionId: rootSession.id,
    artifactDir,
  } as const;
  const references = [
    {
      id: randomUUID(),
      kind: 'session' as const,
      label: rootSession.title,
      mode: 'summary' as const,
      sessionId: rootSession.id,
      auto: true,
    },
  ];

  if (existing) {
    existing.title = title;
    existing.workspace = rootSession.workspace;
    existing.projectId = project.id;
    existing.projectName = project.name;
    existing.dreamId = streamwork.id;
    existing.dreamName = streamwork.name;
    existing.sessionKind = 'harness_role';
    existing.hidden = true;
    existing.instructionPrompt = instructionPrompt;
    existing.harness = harness;
    existing.harnessState = undefined;
    existing.contextReferences = references;
    existing.updatedAt = Date.now();
    return existing;
  }

  const nextSession = createBaseSession(project, streamwork, title, rootSession.workspace);
  nextSession.preview = `${role} harness session`;
  nextSession.sessionKind = 'harness_role';
  nextSession.hidden = true;
  nextSession.instructionPrompt = instructionPrompt;
  nextSession.harness = harness;
  nextSession.harnessState = undefined;
  nextSession.contextReferences = references;
  streamwork.sessions.unshift(nextSession);
  return nextSession;
};

export const bootstrapHarnessFromSession = async (sessionId: string): Promise<HarnessBootstrapResult> => {
  const state = await loadState();
  let sourceSession: SessionRecord | undefined;
  let sourceProject: ProjectRecord | undefined;
  let sourceStreamwork: DreamRecord | undefined;

  state.projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      dream.sessions.forEach((session) => {
        const current = session as SessionRecord;
        if (current.id === sessionId) {
          sourceSession = current;
          sourceProject = project;
          sourceStreamwork = dream;
        }
      });
    });
  });

  if (!sourceSession || !sourceProject || !sourceStreamwork) {
    throw new Error('Session not found.');
  }

  const rootSessionId = sourceSession.harness?.rootSessionId ?? sourceSession.id;
  const rootSession =
    state.projects
      .flatMap((project) => project.dreams.flatMap((dream) => dream.sessions as SessionRecord[]))
      .find((session) => session.id === rootSessionId) ?? sourceSession;
  const artifactDir = buildHarnessArtifactDir(rootSession.workspace, rootSessionId);
  await ensureHarnessArtifacts(rootSession, artifactDir);

  // Root session doubles as the planner — it already holds the full conversation,
  // so there is no need for a separate planner session or a self-referencing context reference.
  const generator = ensureHarnessSession(sourceProject, sourceStreamwork, rootSession, 'generator', artifactDir);
  const evaluator = ensureHarnessSession(sourceProject, sourceStreamwork, rootSession, 'evaluator', artifactDir);

  rootSession.sessionKind = 'harness';
  rootSession.hidden = false;
  rootSession.instructionPrompt = buildHarnessInstructionPrompt('planner', artifactDir, rootSession.workspace);
  rootSession.preview = 'Harness bootstrapped. Ready to run.';
  rootSession.timeLabel = 'Just now';
  rootSession.updatedAt = Date.now();
  rootSession.harnessState = {
    plannerSessionId: rootSession.id,
    generatorSessionId: generator.id,
    evaluatorSessionId: evaluator.id,
    artifactDir,
    status: 'ready',
    currentOwner: undefined,
    currentStage: 'ready',
    currentSprint: 0,
    currentRound: 0,
    completedSprints: 0,
    maxSprints: 0,
    completedTurns: 0,
    totalTurns: 0,
    lastDecision: 'READY',
    summary: 'Harness bootstrapped. Ready to run.',
    updatedAt: Date.now(),
  };

  await saveState(state);

  return {
    projects: cloneVisibleProjects(state.projects),
    rootSessionId: rootSession.id,
    plannerSessionId: rootSession.id,
    generatorSessionId: generator.id,
    evaluatorSessionId: evaluator.id,
    artifactDir,
  };
};

export const updateHarnessState = async (
  sessionId: string,
  updater: (current: HarnessSessionState | undefined) => HarnessSessionState,
) => {
  const state = await loadState();
  let updatedState: HarnessSessionState | undefined;

  forEachSession(state.projects, (session) => {
    if (session.id !== sessionId) {
      return;
    }

    const nextState = updater(normalizeHarnessState(session.harnessState));
    session.sessionKind = 'harness';
    session.hidden = false;
    session.harnessState = nextState;
    session.preview = nextState.summary ?? session.preview;
    session.timeLabel = 'Just now';
    session.updatedAt = Date.now();
    updatedState = nextState;
  });

  if (!updatedState) {
    throw new Error('Harness root session not found.');
  }

  await saveState(state);
  return {
    projects: cloneVisibleProjects(state.projects),
    state: updatedState,
  };
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
      importNativeClaudeSessions,
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
  const session = await hydrateProjectForOpen(project, importNativeClaudeSessions, ensureProjectHasSession);
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
  const nextIndex = targetStreamwork.sessions.length + 1;
  const session = createBaseSession(
    targetProject,
    targetStreamwork,
    name?.trim() || `New Session ${nextIndex}`,
    targetProject.rootPath,
  );
  if (includeStreamworkSummary && targetStreamwork.sessions.length > 0) {
    session.contextReferences = [makeStreamworkHistoryReference(targetStreamwork)];
  }

  targetStreamwork.sessions.unshift(session);
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
          session.title = nextName;
          if (session.claudeSessionId) {
            nativeRenameTasks.push(renameNativeClaudeSession(session.workspace, session.claudeSessionId, nextName));
          }
          // Sync harness role session titles when the root harness session is renamed.
          if ((session as SessionRecord).sessionKind === 'harness') {
            dream.sessions.forEach((sibling) => {
              const role = (sibling as SessionRecord).harness;
              if (role?.rootSessionId === id) {
                sibling.title = `[${role.role}] ${nextName}`;
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
  let deleted = false;
  let deletedNativeSessions: Array<{ workspace: string; sessionId: string }> = [];

  state.projects.forEach((project) => {
    project.dreams.forEach((dream) => {
      const target = dream.sessions.find((session) => session.id === sessionId);
      if (target?.claudeSessionId) {
        deletedNativeSessions.push({
          workspace: target.workspace,
          sessionId: target.claudeSessionId,
        });
      }
      const nextSessions = dream.sessions.filter((session) => session.id !== sessionId);
      if (nextSessions.length !== dream.sessions.length) {
        deleted = true;
      }
      dream.sessions = nextSessions;
    });
  });

  await deleteNativeClaudeSessions(deletedNativeSessions);
  await saveState(state);
  return {
    projects: cloneVisibleProjects(state.projects),
    deletedSessionIds: deleted ? [sessionId] : [],
  };
};
