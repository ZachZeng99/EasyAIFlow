import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configureRuntimePaths } from '../backend/runtimePaths.js';
import {
  appendMessagesToSession,
  closeProject,
  createProject,
  createSession,
  createSessionInStreamwork,
  createStreamwork,
  deleteSession,
  deleteStreamwork,
  ensureSessionRecord,
  findSession,
  getProjects,
  renameEntity,
  reorderStreamworks,
  setSessionRuntime,
  updateSessionContextReferences,
  upsertSessionMessage,
  updateAssistantMessage,
} from './sessionStore.js';
import { getClaudeSyntheticApiError } from './claudeErrors.js';
import { applyParsedSessionMetadata, extractClaudeSessionId } from './claudeSessionId.js';
import {
  applyAssistantTextToRunState,
  createClaudeRunState,
  getRunSessionRuntimeUpdate,
  markClaudeRunCompleted,
  markRunSessionRuntimePersisted,
  noteBackgroundTaskNotificationInRunState,
  shouldCompleteClaudeRunOnClose,
  type ClaudeRunStateCompletion,
} from './claudeRunState.js';
import { extractBackgroundTaskNotificationContent } from './backgroundTaskNotification.js';
import {
  buildClaudeAskUserQuestionToolResultLine,
  buildClaudeControlResponseLine,
  buildClaudeUserMessageLine,
  parseClaudeAskUserQuestionControlRequest,
  parseClaudePermissionControlRequest,
  type ClaudePermissionControlRequest,
} from './claudeControlMessages.js';
import { buildClaudePrintArgs } from './claudePrintArgs.js';
import { buildClaudeSessionArgs } from './claudeSessionArgs.js';
import { buildPermissionRulesForPath } from './permissionRules.js';
import { readLatestNativeClaudeApiError } from './nativeClaudeError.js';
import { getClaudeSpawnOptions } from './claudeSpawn.js';
import { createSequentialLineProcessor } from './sequentialLineProcessor.js';
import { createSessionRunQueue, enqueueSessionRun, hasSessionRunQueued } from './sessionRunQueue.js';
import {
  createSessionStopVersionRegistry,
  readSessionStopVersion,
  requestSessionStop,
  stopAssistantMessage,
  stopPendingSessionMessages,
} from './sessionStop.js';
import { getFileDiff } from './fileDiff.js';
import { buildRecordedCodeChangeDiff } from './recordedCodeChangeDiff.js';
import { shouldOpenExternally } from './externalNavigation.js';
import {
  addActiveClaudeRun,
  createActiveClaudeRunRegistry,
  listActiveClaudeRunsForSession,
  removeActiveClaudeRun,
  type ActiveClaudeRun as RegisteredClaudeRun,
} from './claudeRunRegistry.js';
import {
  extractAskUserQuestionResponsePayload,
  hasAskUserQuestionResponse,
  parseAskUserQuestions,
  type AskUserQuestion,
} from '../src/data/askUserQuestion.js';
import type {
  BtwResponse,
  ClaudeStreamEvent,
  ConversationMessage,
  ContextReference,
  MessageAttachment,
  PendingAttachment,
  ProjectRecord,
  SessionRecord,
  SessionSummary,
  TokenUsage,
} from '../src/data/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const devServerUrl = 'http://127.0.0.1:4173';
const execFileAsync = promisify(execFile);
type ClaudeChildProcess = ReturnType<typeof spawn>;
type ActiveClaudeRun = RegisteredClaudeRun<ClaudeChildProcess>;

type PendingPermissionRequest = {
  sessionId: string;
  activeRun: ActiveClaudeRun;
  request: ClaudePermissionControlRequest;
};

type PendingAskUserQuestion = {
  sessionId: string;
  activeRun: ActiveClaudeRun;
  toolUseId: string;
  questions: AskUserQuestion[];
};

const activeRuns = createActiveClaudeRunRegistry<ClaudeChildProcess>();
const pendingPermissionRequests = new Map<string, PendingPermissionRequest>();
const pendingAskUserQuestions = new Map<string, PendingAskUserQuestion>();
const sessionRunQueue = createSessionRunQueue();
const sessionStopVersions = createSessionStopVersionRegistry();
const slashCommandCache = new Map<string, { commands: string[]; expiresAt: number }>();
const attachmentRoot = () => path.join(app.getPath('userData'), 'attachments');
const claudeSettingsPath = () => path.join(process.env.USERPROFILE ?? app.getPath('home'), '.claude', 'settings.json');

const readClaudeSettings = async () => {
  try {
    const raw = await readFile(claudeSettingsPath(), 'utf8');
    return JSON.parse(raw) as { model?: unknown };
  } catch {
    return undefined;
  }
};

const getConfiguredClaudeModel = async () => {
  const parsed = await readClaudeSettings();
  return typeof parsed?.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined;
};

const getSlashCommands = async (cwd: string, model?: string) => {
  const cacheKey = `${cwd}::${model ?? ''}`;
  const cached = slashCommandCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.commands;
  }

  return new Promise<string[]>((resolve) => {
    const args = [
      '-p',
      'Reply with only OK',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
    ];

    if (model) {
      args.push('--model', model);
    }

    const child = spawn('claude', args, getClaudeSpawnOptions(cwd));

    let stdoutBuffer = '';
    let settled = false;

    const finish = (commands: string[]) => {
      if (settled) {
        return;
      }
      settled = true;
      const normalized = [...new Set(commands.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
      slashCommandCache.set(cacheKey, {
        commands: normalized,
        expiresAt: Date.now() + 60_000,
      });
      if (!child.killed) {
        child.kill();
      }
      resolve(normalized);
    };

    const timeout = setTimeout(() => finish([]), 8_000);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.type === 'system' && parsed.subtype === 'init' && Array.isArray(parsed.slash_commands)) {
            clearTimeout(timeout);
            finish(
              parsed.slash_commands.filter((item): item is string => typeof item === 'string'),
            );
            return;
          }
        } catch {
          continue;
        }
      }
    });

    child.on('error', () => {
      clearTimeout(timeout);
      finish([]);
    });

    child.on('close', () => {
      clearTimeout(timeout);
      finish([]);
    });
  });
};

const deleteNativeClaudeSession = async (cwd: string, claudeSessionId?: string) => {
  if (!claudeSessionId) {
    return;
  }

  const normalized = cwd.replace(/\//g, '\\').replace(/\\+$/, '');
  const match = normalized.match(/^([A-Za-z]):\\?(.*)$/);
  if (!match) {
    return;
  }

  const drive = match[1];
  const rest = match[2]
    .split('\\')
    .filter(Boolean)
    .join('-');
  const dirName = rest ? `${drive}--${rest}` : `${drive}--`;
  const nativeDir = path.join(process.env.USERPROFILE ?? app.getPath('home'), '.claude', 'projects', dirName);

  await Promise.allSettled([
    import('node:fs/promises').then(({ rm }) => rm(path.join(nativeDir, `${claudeSessionId}.jsonl`), { force: true })),
    import('node:fs/promises').then(({ rm }) => rm(path.join(nativeDir, claudeSessionId), { force: true, recursive: true })),
  ]);
};

const grantPathPermission = async (projectRoot: string, targetPath: string) => {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
  const homeDir = process.env.USERPROFILE ?? app.getPath('home');
  const rules = buildPermissionRulesForPath(targetPath, homeDir);

  let parsed: { permissions?: { allow?: string[]; additionalDirectories?: string[] } } = {};
  try {
    parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as typeof parsed;
  } catch {
    parsed = {};
  }

  const allow = new Set(parsed.permissions?.allow ?? []);
  rules.forEach((rule) => allow.add(rule));

  const next = {
    ...parsed,
    permissions: {
      ...parsed.permissions,
      allow: [...allow],
      additionalDirectories: parsed.permissions?.additionalDirectories ?? [],
    },
  };

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
};

const runBtwPrompt = async (
  prompt: string,
  cwd: string,
  options?: {
    sessionId?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    claudeSessionId?: string;
    baseClaudeSessionId?: string;
  },
): Promise<BtwResponse> =>
  new Promise((resolve, reject) => {
    void (async () => {
      let inheritedContext = false;
      const sessionArgs: string[] = [];

      if (options?.claudeSessionId) {
        sessionArgs.push('--resume', options.claudeSessionId);
        inheritedContext = true;
      } else if (options?.baseClaudeSessionId) {
        sessionArgs.push('--resume', options.baseClaudeSessionId, '--fork-session');
        inheritedContext = true;
      } else {
        sessionArgs.push('-n', 'BTW');
      }

      const args = buildClaudePrintArgs({
        model: options?.model,
        effort: options?.effort,
        sessionArgs,
      });
      const child = spawn('claude', args, getClaudeSpawnOptions(cwd));

      let stderrBuffer = '';
      let content = '';
      let claudeSessionId = options?.claudeSessionId;
      let model = options?.model;
      let tokenUsage: TokenUsage | undefined;

      const processLine = (line: string) => {
        if (!line.trim()) {
          return;
        }

        const parsed = JSON.parse(line) as Record<string, unknown>;
        const askUserQuestionRequest = parseClaudeAskUserQuestionControlRequest(parsed);
        if (askUserQuestionRequest) {
          const stdin = child.stdin;
          if (isWritableStdin(child) && stdin) {
            stdin.write(`${buildClaudeControlResponseLine(askUserQuestionRequest, 'allow')}\n`);
          }
          return;
        }

        const permissionControlRequest = parseClaudePermissionControlRequest(parsed);
        if (permissionControlRequest) {
          pendingPermissionRequests.set(permissionControlRequest.requestId, {
            sessionId: options?.sessionId ?? '',
            activeRun: {
              runId: randomUUID(),
              sessionId: options?.sessionId ?? '',
              child,
              projectRoot: cwd,
            },
            request: permissionControlRequest,
          });

          if (options?.sessionId) {
            broadcastClaudeEvent({
              type: 'permission-request',
              sessionId: options.sessionId,
              requestId: permissionControlRequest.requestId,
              toolName: permissionControlRequest.toolName,
              targetPath: permissionControlRequest.targetPath,
              command: permissionControlRequest.command,
              description: permissionControlRequest.description,
              decisionReason: permissionControlRequest.decisionReason,
              sensitive: permissionControlRequest.sensitive,
            });
          }
          return;
        }
        const resolvedClaudeSessionId = extractClaudeSessionId(parsed);
        if (resolvedClaudeSessionId) {
          claudeSessionId = resolvedClaudeSessionId;
        }

        if (parsed.type === 'assistant') {
          const message = parsed.message as {
            model?: string;
            content?: Array<{ type?: string; text?: string; name?: string; id?: string; input?: unknown }>;
          };
          if (typeof message?.model === 'string' && message.model.trim()) {
            model = message.model.trim();
          }
          const text = message?.content
            ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
          if (text) {
            content = text;
          }

          for (const block of message?.content ?? []) {
            if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion' || !options?.sessionId) {
              continue;
            }

            const questions = parseAskUserQuestions(block.input);
            if (questions.length === 0) {
              continue;
            }

            registerAskUserQuestion(
              options.sessionId,
              {
                runId: randomUUID(),
                sessionId: options.sessionId,
                child,
                projectRoot: cwd,
              },
              String(block.id ?? randomUUID()),
              questions,
            );
          }
        }

        if (parsed.type === 'result') {
          tokenUsage = mapTokenUsage(parsed);
          if (!content) {
            content = String(parsed.result ?? '');
          }
        }
      };

      const stdoutProcessor = createSequentialLineProcessor(async (line) => {
        processLine(line);
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutProcessor.pushChunk(chunk.toString());
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrBuffer += chunk.toString();
      });

      child.stdin.write(`${buildClaudeUserMessageLine(prompt)}\n`);

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        void (async () => {
          for (const [requestId, pending] of pendingPermissionRequests) {
            if (pending.activeRun.child === child) {
              pendingPermissionRequests.delete(requestId);
            }
          }
          for (const [toolUseId, pending] of pendingAskUserQuestions) {
            if (pending.activeRun.child === child) {
              pendingAskUserQuestions.delete(toolUseId);
            }
          }
          try {
            await stdoutProcessor.flush();
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }

          if (code !== 0) {
            reject(new Error(stderrBuffer.trim() || `Claude exited with code ${code ?? 'unknown'}.`));
            return;
          }

          resolve({
            claudeSessionId,
            model,
            content,
            tokenUsage,
            inheritedContext,
          });
        })();
      });
    })().catch(reject);
  });

const stopSessions = (sessionIds: string[]) => {
  sessionIds.forEach((sessionId) => {
    requestSessionStop(sessionStopVersions, sessionId);
    const runs = listActiveClaudeRunsForSession(activeRuns, sessionId);
    runs.forEach((run) => {
      if (!run.child.killed) {
        run.child.kill();
      }
      removeActiveClaudeRun(activeRuns, run.runId);
    });
    for (const [requestId, pending] of pendingPermissionRequests) {
      if (pending.sessionId === sessionId) {
        pendingPermissionRequests.delete(requestId);
      }
    }
    for (const [toolUseId, pending] of pendingAskUserQuestions) {
      if (pending.sessionId === sessionId) {
        pendingAskUserQuestions.delete(toolUseId);
      }
    }
  });
};

const loadDevServer = async (window: BrowserWindow, retries = 20) => {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await window.loadURL(devServerUrl);
      return;
    } catch (error) {
      if (attempt === retries - 1) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
};

const broadcastClaudeEvent = (payload: ClaudeStreamEvent) => {
  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('claude:event', payload);
  });
};

const emitTraceMessage = async (
  sessionId: string,
  message: ConversationMessage,
) => {
  await upsertSessionMessage(sessionId, message);
  broadcastClaudeEvent({
    type: 'trace',
    sessionId,
    message,
  });
};

const isWritableStdin = (child: ClaudeChildProcess) => {
  const stdin = child.stdin;
  return Boolean(stdin && !child.killed && !stdin.destroyed && !stdin.writableEnded);
};

const registerAskUserQuestion = (
  sessionId: string,
  activeRun: ActiveClaudeRun,
  toolUseId: string,
  questions: AskUserQuestion[],
) => {
  if (pendingAskUserQuestions.has(toolUseId)) {
    return;
  }

  pendingAskUserQuestions.set(toolUseId, {
    sessionId,
    activeRun,
    toolUseId,
    questions,
  });
  broadcastClaudeEvent({
    type: 'ask-user-question',
    sessionId,
    toolUseId,
    questions,
  });
};

const nowLabel = () =>
  new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'numeric',
    day: 'numeric',
  }).format(new Date());

const buildMessageTitle = (content: string, fallback: string) => {
  const firstLine = content.split(/\r?\n/)[0]?.trim();
  if (!firstLine) {
    return fallback;
  }

  return firstLine.slice(0, 42);
};

const truncateText = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}\n...[truncated]`;
};

const compactText = (value: string, maxLength = 220) =>
  truncateText(
    value
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    maxLength,
  );

const compactMultilineText = (value: string, maxLength = 600) =>
  truncateText(
    value
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line, index, lines) => line || (index > 0 && index < lines.length - 1))
      .join('\n')
      .trim(),
    maxLength,
  );

const getConversationMessages = (session: SessionRecord) =>
  (session.messages ?? []).filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') && Boolean(message.content.trim()),
  );

const buildSessionSummaryContext = (session: SessionRecord) => {
  const messages = getConversationMessages(session);
  const firstUser = messages.find((message) => message.role === 'user');
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const userCount = messages.filter((message) => message.role === 'user').length;
  const assistantCount = messages.filter((message) => message.role === 'assistant').length;
  const recentExcerpts = messages
    .slice(-4)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${compactText(message.content, 140)}`);

  return [
    `Session: ${session.title}`,
    `Session ID: ${session.id}`,
    `Project: ${session.projectName}`,
    `Streamwork: ${session.dreamName}`,
    `Updated: ${session.timeLabel}`,
    `Model: ${session.model}`,
    `Messages: ${userCount} user / ${assistantCount} assistant`,
    latestAssistant ? `Final assistant conclusion:\n${compactMultilineText(latestAssistant.content, 900)}` : '',
    latestUser ? `Latest user intent: ${compactText(latestUser.content, 260)}` : '',
    firstUser ? `Initial ask: ${compactText(firstUser.content)}` : '',
    recentExcerpts.length > 0 ? `Recent excerpts:\n${recentExcerpts.map((item) => `- ${item}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const buildSessionTranscriptContext = (session: SessionRecord) => {
  const transcript = getConversationMessages(session)
    .map(
      (message) =>
        `[${message.role.toUpperCase()} | ${message.timestamp}${message.title ? ` | ${message.title}` : ''}]\n${message.content.trim()}`,
    )
    .join('\n\n');

  return truncateText(
    [
      `Session: ${session.title}`,
      `Session ID: ${session.id}`,
      `Project: ${session.projectName}`,
      `Streamwork: ${session.dreamName}`,
      'Transcript:',
      transcript || 'No user or assistant messages were recorded.',
    ].join('\n'),
    16000,
  );
};

const buildContextReferencePrompt = async (sessionId: string, overrideReferences?: ContextReference[]) => {
  const currentSession = await findSession(sessionId);
  if (!currentSession) {
    return '';
  }

  const references = (overrideReferences ?? currentSession.contextReferences ?? []).filter(Boolean);
  if (references.length === 0) {
    return '';
  }

  const projects = await getProjects();
  const storedSessions = projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions.map((session) => session as SessionRecord)),
  );
  const sessionById = new Map(storedSessions.map((session) => [session.id, session]));

  const blocks = references
    .map((reference) => {
      const resolvedSessions =
        reference.kind === 'session'
          ? reference.sessionId && reference.sessionId !== currentSession.id
            ? [sessionById.get(reference.sessionId)].filter((session): session is SessionRecord => Boolean(session))
            : []
          : storedSessions
              .filter(
                (session) =>
                  session.dreamId === reference.streamworkId &&
                  session.id !== currentSession.id,
              )
              .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

      if (resolvedSessions.length === 0) {
        return '';
      }

      const detail =
        reference.mode === 'full'
          ? resolvedSessions.map((session) => buildSessionTranscriptContext(session)).join('\n\n')
          : resolvedSessions.map((session) => buildSessionSummaryContext(session)).join('\n\n');

      const title =
        reference.kind === 'session'
          ? `Referenced session (${reference.mode})`
          : `Referenced streamwork history (${reference.mode})`;

      const label =
        reference.kind === 'session'
          ? reference.label || resolvedSessions[0]?.title || 'Session'
          : reference.label || `${resolvedSessions[0]?.dreamName ?? 'Streamwork'} history`;

      return truncateText(
        [
          `## ${title}`,
          `Label: ${label}`,
          `Entries: ${resolvedSessions.length}`,
          detail,
        ].join('\n'),
        reference.mode === 'full' ? 36000 : 22000,
      );
    })
    .filter(Boolean);

  if (blocks.length === 0) {
    return '';
  }

  return [
    'Referenced conversation context is provided below.',
    'Use it as supporting context when it is relevant to the current request.',
    'Do not claim events or files beyond the injected context.',
    blocks.join('\n\n'),
  ].join('\n\n');
};

type ClaudeRunState = ClaudeRunStateCompletion & {
  claudeSessionId?: string;
  model?: string;
  persistedClaudeSessionId?: string;
  persistedModel?: string;
  tokenUsage?: TokenUsage;
  terminalError?: string;
  toolTraces: Map<string, ConversationMessage>;
};

type ClaudePrintOptions = {
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  references?: ContextReference[];
};

type PreparedClaudeRun = {
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  session: SessionSummary;
  resolvedPrompt: string;
  options?: ClaudePrintOptions;
  projects: ProjectRecord[];
  assistantWasQueued: boolean;
  stopVersion: number;
};

const summarizeToolInput = (input: unknown) => {
  if (typeof input === 'string') {
    return input.trim();
  }

  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    if (typeof record.command === 'string') {
      return record.command;
    }
    if (typeof record.pattern === 'string') {
      return `pattern: ${record.pattern}`;
    }
    if (typeof record.file_path === 'string') {
      return record.file_path;
    }

    const serialized = JSON.stringify(input, null, 2);
    return serialized === '{}' || serialized === '[]' ? '' : serialized;
  }

  return typeof input === 'undefined' || input === null ? '' : String(input);
};

const appendTraceContent = (current: string, next: string) => {
  const normalizedCurrent = current.trim();
  const normalizedNext = next.trim();
  if (!normalizedNext) {
    return normalizedCurrent;
  }
  if (!normalizedCurrent) {
    return normalizedNext;
  }
  return `${normalizedCurrent}\n${normalizedNext}`;
};

const finalizeToolTraces = async (sessionId: string, state: ClaudeRunState) => {
  for (const trace of state.toolTraces.values()) {
    if (!trace.status || trace.status === 'running' || trace.status === 'streaming') {
      trace.status = 'complete';
      await emitTraceMessage(sessionId, trace);
    }
  }
};

const syncRunSessionRuntime = async (sessionId: string, state: ClaudeRunState) => {
  const update = getRunSessionRuntimeUpdate(state);
  if (!update) {
    return;
  }

  await setSessionRuntime(sessionId, update);
  Object.assign(state, markRunSessionRuntimePersisted(state));
};

const completeAssistantRun = async (
  sessionId: string,
  assistantMessageId: string,
  state: ClaudeRunState,
  fallbackContent = '',
) => {
  const content = state.content || fallbackContent;
  Object.assign(state, markClaudeRunCompleted(state, content));
  await finalizeToolTraces(sessionId, state);

  await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
    message.content = content;
    message.status = 'complete';
    message.title = buildMessageTitle(message.content, 'Claude response');
  });

  await setSessionRuntime(sessionId, {
    claudeSessionId: state.claudeSessionId,
    model: state.model,
    preview: content,
    timeLabel: 'Just now',
    tokenUsage: state.tokenUsage,
  });

  broadcastClaudeEvent({
    type: 'complete',
    sessionId,
    messageId: assistantMessageId,
    content,
    claudeSessionId: state.claudeSessionId,
    tokenUsage: state.tokenUsage,
  });
};

const parseGitBranchLine = (line: string) => {
  const normalized = line.replace(/^##\s*/, '').trim();
  const branchPart = normalized.split(' [')[0] ?? normalized;
  const [branch, tracking] = branchPart.split('...');
  const aheadMatch = normalized.match(/ahead (\d+)/);
  const behindMatch = normalized.match(/behind (\d+)/);

  return {
    branch: branch?.trim() || 'unknown',
    tracking: tracking?.trim(),
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
};

const parseGitStatusCode = (rawCode: string) => {
  const code = rawCode.trim();
  if (code === '??') {
    return '??';
  }
  if (code.includes('A')) {
    return 'A';
  }
  if (code.includes('D')) {
    return 'D';
  }
  if (code.includes('R')) {
    return 'R';
  }
  return 'M';
};

const getGitSnapshot = async (cwd: string) => {
  try {
    const [{ stdout: statusStdout }, { stdout: rootStdout }] = await Promise.all([
      execFileAsync('git', ['status', '--short', '--branch', '--untracked-files=all'], { cwd }),
      execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd }),
    ]);

    const lines = statusStdout.split(/\r?\n/).filter(Boolean);
    const branchMeta = parseGitBranchLine(lines[0] ?? '## unknown');
    const files = lines.slice(1).map((line) => {
      const statusCode = line.slice(0, 2);
      const filePath = line.slice(3).trim();

      return {
        path: filePath,
        status: parseGitStatusCode(statusCode),
        additions: 0,
        deletions: 0,
      };
    });

    return {
      ...branchMeta,
      dirty: files.length > 0,
      changedFiles: files,
      rootPath: rootStdout.trim(),
      source: 'git' as const,
    };
  } catch {
    return null;
  }
};

const readNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const mapTokenUsage = (payload: Record<string, unknown>): TokenUsage | undefined => {
  const resultUsage = payload.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  const modelUsage = payload.modelUsage as Record<string, { contextWindow?: number }> | undefined;
  const modelMeta = modelUsage ? Object.values(modelUsage)[0] : undefined;
  const resultPayload =
    payload.result && typeof payload.result === 'object' ? (payload.result as Record<string, unknown>) : undefined;
  const contextWindowData =
    (payload.context_window as Record<string, unknown> | undefined) ??
    (resultPayload?.context_window as Record<string, unknown> | undefined);

  const input = readNumber(contextWindowData?.total_input_tokens) ?? resultUsage?.input_tokens ?? 0;
  const output = readNumber(contextWindowData?.total_output_tokens) ?? resultUsage?.output_tokens ?? 0;
  const cached = (resultUsage?.cache_read_input_tokens ?? 0) + (resultUsage?.cache_creation_input_tokens ?? 0);
  const used = input + output + cached;

  const modelContextWindow = readNumber(modelMeta?.contextWindow);
  const explicitContextWindow =
    readNumber(contextWindowData?.max_tokens) ??
    readNumber(contextWindowData?.max_input_tokens) ??
    readNumber(contextWindowData?.window_size) ??
    readNumber(contextWindowData?.context_window) ??
    readNumber(contextWindowData?.total_tokens);
  const rawUsedPercentage = readNumber(contextWindowData?.used_percentage);
  const usedPercentage =
    rawUsedPercentage !== undefined
      ? Math.max(0, Math.min(100, rawUsedPercentage <= 1 ? rawUsedPercentage * 100 : rawUsedPercentage))
      : undefined;

  const hasContextMetadata =
    contextWindowData !== undefined ||
    modelContextWindow !== undefined ||
    explicitContextWindow !== undefined ||
    usedPercentage !== undefined;

  if (!hasContextMetadata) {
    return undefined;
  }

  let contextWindow = explicitContextWindow ?? modelContextWindow ?? 0;
  let windowSource: TokenUsage['windowSource'] = contextWindow > 0 ? 'runtime' : 'unknown';

  if (contextWindow === 0 && usedPercentage && used > 0) {
    contextWindow = Math.round(used / (usedPercentage / 100));
    windowSource = contextWindow > 0 ? 'derived' : 'unknown';
  }
  return {
    contextWindow,
    used,
    input,
    output,
    cached,
    usedPercentage,
    windowSource,
  };
};

const extensionFromMime = (mimeType: string) => {
  if (mimeType === 'image/png') {
    return '.png';
  }
  if (mimeType === 'image/jpeg') {
    return '.jpg';
  }
  if (mimeType === 'image/webp') {
    return '.webp';
  }
  if (mimeType === 'image/gif') {
    return '.gif';
  }
  return '.bin';
};

const sanitizeAttachmentName = (value: string) => {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim();
  return sanitized || 'attachment';
};

const buildAttachmentFileName = (attachment: PendingAttachment) => {
  const preferredName = sanitizeAttachmentName(path.basename(attachment.name || 'attachment'));
  const hasExtension = path.extname(preferredName).length > 0;
  const safeName = hasExtension ? preferredName : `${preferredName}${extensionFromMime(attachment.mimeType)}`;
  return `${Date.now()}-${attachment.id}-${safeName}`;
};

const saveAttachments = async (sessionId: string, attachments: PendingAttachment[]): Promise<MessageAttachment[]> => {
  if (attachments.length === 0) {
    return [];
  }

  const dir = path.join(attachmentRoot(), sessionId);
  const needsCopy = attachments.some((attachment) => !attachment.path);
  if (needsCopy) {
    await mkdir(dir, { recursive: true });
  }

  const saved = await Promise.all(
    attachments.map(async (attachment) => {
      if (attachment.path) {
        return {
          id: attachment.id,
          name: attachment.name,
          path: attachment.path,
          mimeType: attachment.mimeType,
          size: attachment.size,
        };
      }

      if (!attachment.dataUrl) {
        throw new Error(`Attachment ${attachment.name || attachment.id} is missing both path and data.`);
      }

      const [, base64 = ''] = (attachment.dataUrl ?? '').split(',');
      const fileName = buildAttachmentFileName(attachment);
      const filePath = path.join(dir, fileName);
      await writeFile(filePath, Buffer.from(base64, 'base64'));

      return {
        id: attachment.id,
        name: attachment.name,
        path: filePath,
        mimeType: attachment.mimeType,
        size: attachment.size,
      };
    }),
  );

  return saved;
};

const buildPromptWithAttachments = (
  prompt: string,
  attachments: MessageAttachment[],
  referenceContext?: string,
) => {
  const parts: string[] = [];

  if (referenceContext?.trim()) {
    parts.push(referenceContext.trim());
  }

  parts.push(prompt);

  if (attachments.length > 0) {
    const lines = attachments.map(
      (attachment) => `- ${attachment.path} (${attachment.mimeType || 'application/octet-stream'}, ${attachment.size} bytes)`,
    );
    parts.push(
      `Attached local files:\n${lines.join('\n')}\n\nPlease inspect these local files if they are relevant to the request.`,
    );
  }

  return parts.join('\n\n');
};

const cloneMessageContextReferences = (references: ContextReference[] | undefined) =>
  (references ?? []).map((reference) => ({
    ...reference,
  }));

const openProjectDirectory = async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Open Project Folder',
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const rootPath = result.filePaths[0];
  const name = path.basename(rootPath);
  return createProject(name, rootPath);
};

const handleClaudeLine = async (
  sessionId: string,
  assistantMessageId: string,
  line: string,
  state: ClaudeRunState,
  activeRun: ActiveClaudeRun,
  releaseQueuedTurn: () => void,
) => {
  if (!line.trim()) {
    return;
  }
  if (activeRun.child.killed) {
    return;
  }

  const parsed = JSON.parse(line) as Record<string, unknown>;
  Object.assign(state, applyParsedSessionMetadata(state, parsed));
  await syncRunSessionRuntime(sessionId, state);
  const backgroundTaskNotification = extractBackgroundTaskNotificationContent(parsed);
  if (backgroundTaskNotification) {
    Object.assign(state, noteBackgroundTaskNotificationInRunState(state, backgroundTaskNotification));
    if (parsed.type === 'queue-operation') {
      return;
    }
  }
  const askUserQuestionRequest = parseClaudeAskUserQuestionControlRequest(parsed);
  if (askUserQuestionRequest) {
    const stdin = activeRun.child.stdin;
    if (isWritableStdin(activeRun.child) && stdin) {
      stdin.write(`${buildClaudeControlResponseLine(askUserQuestionRequest, 'allow')}\n`);
    }
    return;
  }

  const permissionControlRequest = parseClaudePermissionControlRequest(parsed);
  if (permissionControlRequest) {
    pendingPermissionRequests.set(permissionControlRequest.requestId, {
      sessionId,
      activeRun,
      request: permissionControlRequest,
    });

    broadcastClaudeEvent({
      type: 'permission-request',
      sessionId,
      requestId: permissionControlRequest.requestId,
      toolName: permissionControlRequest.toolName,
      targetPath: permissionControlRequest.targetPath,
      command: permissionControlRequest.command,
      description: permissionControlRequest.description,
      decisionReason: permissionControlRequest.decisionReason,
      sensitive: permissionControlRequest.sensitive,
    });
    return;
  }
  const syntheticApiError = getClaudeSyntheticApiError(parsed);
  if (syntheticApiError) {
    state.terminalError = syntheticApiError;
    await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
      message.content = syntheticApiError;
      message.status = 'error';
      message.title = 'Claude error';
    });

    broadcastClaudeEvent({
      type: 'error',
      sessionId,
      messageId: assistantMessageId,
      error: syntheticApiError,
    });
    return;
  }

  if (parsed.type === 'stream_event') {
    const event = parsed.event as {
      type?: string;
      delta?: { type?: string; text?: string };
      content_block?: { type?: string; name?: string; input?: unknown };
    };
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      state.content += event.delta.text;
      await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
        message.content = state.content;
        message.status = 'streaming';
        message.title = buildMessageTitle(state.content, 'Claude response');
      });

      broadcastClaudeEvent({
        type: 'delta',
        sessionId,
        messageId: assistantMessageId,
        delta: event.delta.text,
      });
    }

    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const toolId = String((event.content_block as { id?: string }).id ?? randomUUID());
      const questions =
        event.content_block.name === 'AskUserQuestion' ? parseAskUserQuestions(event.content_block.input) : [];
      if (questions.length > 0) {
        registerAskUserQuestion(sessionId, activeRun, toolId, questions);
      }
      const recordedDiff = buildRecordedCodeChangeDiff(
        event.content_block.name ?? 'Tool Use',
        event.content_block.input,
      );
      const message: ConversationMessage = {
        id: toolId,
        role: 'system',
        kind: 'tool_use',
        timestamp: nowLabel(),
        title: event.content_block.name ?? 'Tool Use',
        content: summarizeToolInput(event.content_block.input),
        recordedDiff,
        status: 'running',
      };
      state.toolTraces.set(toolId, message);
      await emitTraceMessage(sessionId, message);
    }
  }

  if (parsed.type === 'assistant') {
    const message = parsed.message as {
      model?: string;
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
    };
    if (typeof message?.model === 'string' && message.model.trim()) {
      state.model = message.model.trim();
    }
    const finalText = message?.content
      ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('') ?? state.content;
    Object.assign(state, applyAssistantTextToRunState(state, finalText));

    for (const block of message?.content ?? []) {
      if (block.type === 'tool_use') {
        const inputSummary = summarizeToolInput(block.input);
        const toolId = String((block as { id?: string }).id ?? randomUUID());
        const questions = block.name === 'AskUserQuestion' ? parseAskUserQuestions(block.input) : [];
        if (questions.length > 0) {
          registerAskUserQuestion(sessionId, activeRun, toolId, questions);
        }
        const recordedDiff = buildRecordedCodeChangeDiff(block.name ?? 'Tool Use', block.input);
        const existing = state.toolTraces.get(toolId) ?? {
          id: toolId,
          role: 'system',
          kind: 'tool_use',
          timestamp: nowLabel(),
          title: block.name ?? 'Tool Use',
          content: inputSummary,
          recordedDiff,
          status: 'running',
        };
        existing.title = block.name ?? existing.title;
        if (!existing.content && inputSummary) {
          existing.content = inputSummary;
        }
        if (!existing.recordedDiff && recordedDiff) {
          existing.recordedDiff = recordedDiff;
        }
        state.toolTraces.set(toolId, existing);
        await emitTraceMessage(sessionId, existing);
      }
    }
  }

  if (parsed.type === 'progress') {
    const toolUseId = String(parsed.toolUseID ?? '');
    if (toolUseId && state.toolTraces.has(toolUseId)) {
      const current = state.toolTraces.get(toolUseId)!;
      current.content = appendTraceContent(
        current.content,
        String((parsed.data as { statusMessage?: string; command?: string })?.statusMessage ?? (parsed.data as { command?: string })?.command ?? 'Progress update'),
      );
      current.status = 'running';
      await emitTraceMessage(sessionId, current);
    }
  }

  if (parsed.type === 'user' && parsed.isMeta !== true) {
    const content = (parsed.message as { content?: unknown })?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: string }).type === 'tool_result' &&
          typeof (block as { tool_use_id?: string }).tool_use_id === 'string'
        ) {
          const toolUseId = (block as { tool_use_id: string }).tool_use_id;
          const pendingAskUserQuestion = pendingAskUserQuestions.get(toolUseId);
          const askUserQuestionResponse = extractAskUserQuestionResponsePayload(
            (parsed as { toolUseResult?: unknown }).toolUseResult,
          );
          if (pendingAskUserQuestion && !hasAskUserQuestionResponse(askUserQuestionResponse)) {
            requestSessionStop(sessionStopVersions, sessionId);
            if (!pendingAskUserQuestion.activeRun.child.killed) {
              pendingAskUserQuestion.activeRun.child.kill();
            }
            continue;
          }

          pendingAskUserQuestions.delete(toolUseId);
          const current = state.toolTraces.get(toolUseId);
          if (current) {
            const resultText = String((block as { content?: string }).content ?? 'Tool result returned.');
            current.content = appendTraceContent(current.content, resultText);
            current.status = (block as { is_error?: boolean }).is_error ? 'error' : 'success';
            await emitTraceMessage(sessionId, current);
          }
        }
      }
    }
  }

  if (parsed.type === 'result') {
    state.receivedResult = true;
    state.tokenUsage = mapTokenUsage(parsed);
    try {
      await completeAssistantRun(sessionId, assistantMessageId, state, String(parsed.result ?? ''));
    } finally {
      releaseQueuedTurn();
      activeRun.child.stdin?.end();
    }
  }
};

const prepareClaudeRun = async (
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: ClaudePrintOptions,
  assistantStatus: 'queued' | 'streaming' = 'streaming',
): Promise<PreparedClaudeRun> => {
  let session = (await findSession(sessionId)) ?? (fallbackSession ? await ensureSessionRecord(fallbackSession) : null);
  if (!session) {
    throw new Error('Session not found');
  }

  if (options?.references) {
    await updateSessionContextReferences(sessionId, options.references);
    session = await findSession(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
  }

  const attachments = await saveAttachments(sessionId, pendingAttachments);
  const referenceContext = await buildContextReferencePrompt(sessionId, options?.references);
  const resolvedPrompt = buildPromptWithAttachments(prompt, attachments, referenceContext);

  const userMessage: ConversationMessage = {
    id: randomUUID(),
    role: 'user',
    timestamp: nowLabel(),
    title: buildMessageTitle(prompt, 'User prompt'),
    content: prompt,
    status: 'complete',
    contextReferences: cloneMessageContextReferences(options?.references),
    attachments,
  };

  const assistantMessage: ConversationMessage = {
    id: randomUUID(),
    role: 'assistant',
    timestamp: nowLabel(),
    title: assistantStatus === 'queued' ? 'Claude queued' : 'Claude response',
    content: assistantStatus === 'queued' ? 'Queued. Claude will start this message after the current run completes.' : '',
    status: assistantStatus,
  };

  const projects = await appendMessagesToSession(
    sessionId,
    [userMessage, assistantMessage],
    prompt,
    'Just now',
  );

  return {
    sessionId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    session,
    resolvedPrompt,
    options,
    projects,
    assistantWasQueued: assistantStatus === 'queued',
    stopVersion: readSessionStopVersion(sessionStopVersions, sessionId),
  };
};

const markPreparedClaudeRunStarted = async (prepared: PreparedClaudeRun) => {
  if (!prepared.assistantWasQueued) {
    return;
  }

  await updateAssistantMessage(prepared.sessionId, prepared.assistantMessageId, (message) => {
    message.content = '';
    message.status = 'streaming';
    message.title = 'Claude response';
  });

  broadcastClaudeEvent({
    type: 'status',
    sessionId: prepared.sessionId,
    messageId: prepared.assistantMessageId,
    status: 'streaming',
    content: '',
    title: 'Claude response',
  });
};

const executePreparedClaudeRun = async (
  prepared: PreparedClaudeRun,
  releaseQueuedTurn: () => void,
) =>
  new Promise<void>((resolve) => {
    const { sessionId, assistantMessageId, session, resolvedPrompt, options } = prepared;
    const args = buildClaudePrintArgs({
      model: options?.model,
      effort: options?.effort,
      sessionArgs: buildClaudeSessionArgs(session.claudeSessionId, session.title),
    });

    const child = spawn('claude', args, getClaudeSpawnOptions(session.workspace));
    const activeRun = addActiveClaudeRun(activeRuns, {
      runId: randomUUID(),
      sessionId,
      child,
      projectRoot: session.workspace,
    });

    let stderrBuffer = '';
    let finalizing = false;
    const beginFinalize = () => {
      if (finalizing) {
        return false;
      }
      finalizing = true;
      for (const [requestId, pending] of pendingPermissionRequests) {
        if (pending.activeRun.runId === activeRun.runId) {
          pendingPermissionRequests.delete(requestId);
        }
      }
      for (const [toolUseId, pending] of pendingAskUserQuestions) {
        if (pending.activeRun.runId === activeRun.runId) {
          pendingAskUserQuestions.delete(toolUseId);
        }
      }
      removeActiveClaudeRun(activeRuns, activeRun.runId);
      releaseQueuedTurn();
      return true;
    };
    const runState: ClaudeRunState = {
      ...createClaudeRunState(),
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      persistedClaudeSessionId: session.claudeSessionId,
      persistedModel: session.model,
      tokenUsage: session.tokenUsage,
      toolTraces: new Map<string, ConversationMessage>(),
    };

    const stdoutProcessor = createSequentialLineProcessor((line) =>
      handleClaudeLine(sessionId, assistantMessageId, line, runState, activeRun, releaseQueuedTurn),
    );

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutProcessor.pushChunk(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrBuffer += chunk.toString();
    });

    child.stdin.write(`${buildClaudeUserMessageLine(resolvedPrompt)}\n`);

    child.on('close', (code) => {
      if (!beginFinalize()) {
        return;
      }

      void (async () => {
        try {
          await stdoutProcessor.flush();

          if (readSessionStopVersion(sessionStopVersions, sessionId) !== prepared.stopVersion) {
            const stopped = await stopAssistantMessage(sessionId, assistantMessageId);
            if (stopped) {
              broadcastClaudeEvent({
                type: 'status',
                sessionId,
                messageId: assistantMessageId,
                status: stopped.status,
                title: stopped.title,
                content: stopped.content,
              });
            }
            return;
          }

          if (code === 0) {
            if (runState.terminalError) {
              await setSessionRuntime(sessionId, {
                claudeSessionId: runState.claudeSessionId,
                model: runState.model,
                preview: runState.terminalError,
                timeLabel: 'Just now',
              });
              return;
            }
            if (shouldCompleteClaudeRunOnClose(runState)) {
              await completeAssistantRun(sessionId, assistantMessageId, runState);
            }
            return;
          }

          const nativeApiError = await readLatestNativeClaudeApiError(
            session.workspace,
            runState.claudeSessionId ?? session.claudeSessionId,
          );
          const errorMessage =
            stderrBuffer.trim() ||
            runState.terminalError ||
            nativeApiError ||
            `Claude exited with code ${code ?? 'unknown'}.`;
          await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
            message.content = errorMessage;
            message.status = 'error';
            message.title = 'Claude error';
          });
          await setSessionRuntime(sessionId, {
            claudeSessionId: runState.claudeSessionId,
            model: runState.model,
            preview: errorMessage,
            timeLabel: 'Just now',
          });

          broadcastClaudeEvent({
            type: 'error',
            sessionId,
            messageId: assistantMessageId,
            error: errorMessage,
          });
        } finally {
          resolve();
        }
      })();
    });

    child.on('error', (error) => {
      if (!beginFinalize()) {
        return;
      }

      void (async () => {
        try {
          if (readSessionStopVersion(sessionStopVersions, sessionId) !== prepared.stopVersion) {
            const stopped = await stopAssistantMessage(sessionId, assistantMessageId);
            if (stopped) {
              broadcastClaudeEvent({
                type: 'status',
                sessionId,
                messageId: assistantMessageId,
                status: stopped.status,
                title: stopped.title,
                content: stopped.content,
              });
            }
            return;
          }

          await updateAssistantMessage(sessionId, assistantMessageId, (message) => {
            message.content = error.message;
            message.status = 'error';
            message.title = 'Claude error';
          });
          await setSessionRuntime(sessionId, {
            claudeSessionId: runState.claudeSessionId,
            model: runState.model,
            preview: error.message,
            timeLabel: 'Just now',
          });

          broadcastClaudeEvent({
            type: 'error',
            sessionId,
            messageId: assistantMessageId,
            error: error.message,
          });
        } finally {
          resolve();
        }
      })();
    });
  });

const runClaudePrint = async (
  sessionId: string,
  prompt: string,
  pendingAttachments: PendingAttachment[] = [],
  fallbackSession?: SessionSummary,
  options?: ClaudePrintOptions,
) => {
  const queued = hasSessionRunQueued(sessionRunQueue, sessionId);
  const scheduledRun = enqueueSessionRun(sessionRunQueue, sessionId);
  const preparedRun = prepareClaudeRun(
    sessionId,
    prompt,
    pendingAttachments,
    fallbackSession,
    options,
    queued ? 'queued' : 'streaming',
  );
  void (async () => {
    try {
      const prepared = await preparedRun;
      await scheduledRun.whenReady;
      if (readSessionStopVersion(sessionStopVersions, sessionId) !== prepared.stopVersion) {
        const stopped = await stopAssistantMessage(prepared.sessionId, prepared.assistantMessageId);
        if (stopped) {
          broadcastClaudeEvent({
            type: 'status',
            sessionId: prepared.sessionId,
            messageId: prepared.assistantMessageId,
            status: stopped.status,
            title: stopped.title,
            content: stopped.content,
          });
        }
        scheduledRun.release();
        return;
      }
      await markPreparedClaudeRunStarted(prepared);
      await executePreparedClaudeRun(prepared, scheduledRun.release);
    } catch {
      scheduledRun.release();
    }
  })();
  void scheduledRun.completion.catch(() => undefined);
  const prepared = await preparedRun;

  return {
    projects: prepared.projects,
    queued: {
      sessionId,
      userMessageId: prepared.userMessageId,
      assistantMessageId: prepared.assistantMessageId,
    },
  };
};

const createMainWindow = async () => {
  const window = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#161412',
    autoHideMenuBar: true,
    title: 'EasyAIFlow',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!shouldOpenExternally({ currentUrl: window.webContents.getURL(), targetUrl })) {
      return;
    }

    event.preventDefault();
    void shell.openExternal(targetUrl);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!shouldOpenExternally({ currentUrl: window.webContents.getURL(), targetUrl: url })) {
      return { action: 'allow' };
    }

    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (app.isPackaged) {
    await window.loadFile(path.join(__dirname, '../dist/index.html'));
    return;
  }

  await loadDevServer(window);
  window.webContents.openDevTools({ mode: 'detach' });
};

app.whenReady().then(async () => {
  configureRuntimePaths({
    mode: 'desktop',
    userDataPath: app.getPath('userData'),
    homePath: app.getPath('home'),
  });

  ipcMain.handle('clipboard:write-text', async (_event, value: string) => {
    clipboard.writeText(value);
  });
  ipcMain.handle('app:meta', async () => ({
    name: 'EasyAIFlow',
    version: app.getVersion(),
    platform: process.platform,
    defaultModel: await getConfiguredClaudeModel(),
  }));
  ipcMain.handle('git:snapshot', (_event, cwd: string) => getGitSnapshot(cwd));
  ipcMain.handle('claude:list-slash-commands', async (_event, payload: { cwd: string; model?: string }) => ({
    commands: await getSlashCommands(payload.cwd, payload.model),
  }));
  ipcMain.handle(
    'claude:btw-message',
    async (
      _event,
      payload: {
        sessionId?: string;
        cwd: string;
        prompt: string;
        model?: string;
        effort?: 'low' | 'medium' | 'high' | 'max';
        claudeSessionId?: string;
        baseClaudeSessionId?: string;
      },
    ) => runBtwPrompt(payload.prompt, payload.cwd, payload),
  );
  ipcMain.handle('claude:btw-discard', async (_event, payload: { cwd: string; claudeSessionId?: string }) => {
    await deleteNativeClaudeSession(payload.cwd, payload.claudeSessionId);
  });
  ipcMain.handle('sessions:bootstrap', async () => ({
    projects: await getProjects(),
  }));
  ipcMain.handle(
    'sessions:create',
    async (_event, payload?: { sourceSessionId?: string; includeStreamworkSummary?: boolean }) =>
      createSession(payload?.sourceSessionId, Boolean(payload?.includeStreamworkSummary)),
  );
  ipcMain.handle(
    'sessions:create-in-streamwork',
    async (_event, payload: { streamworkId: string; name?: string; includeStreamworkSummary?: boolean }) =>
      createSessionInStreamwork(
        payload.streamworkId,
        payload.name,
        Boolean(payload.includeStreamworkSummary),
      ),
  );
  ipcMain.handle('projects:create', async (_event, payload: { name: string; rootPath: string }) =>
    createProject(payload.name, payload.rootPath),
  );
  ipcMain.handle('permissions:grant-path', async (_event, payload: { projectRoot: string; targetPath: string }) => {
    await grantPathPermission(payload.projectRoot, payload.targetPath);
  });
  ipcMain.handle(
    'permissions:respond',
    async (_event, payload: { requestId: string; behavior: 'allow' | 'deny' }) => {
      const pending = pendingPermissionRequests.get(payload.requestId);
      if (!pending) {
        return { mode: 'missing' as const };
      }

      pendingPermissionRequests.delete(payload.requestId);

      if (payload.behavior === 'allow' && pending.request.targetPath) {
        await grantPathPermission(pending.activeRun.projectRoot, pending.request.targetPath);
      }

      const stdin = pending.activeRun.child.stdin;
      if (
        stdin &&
        !pending.activeRun.child.killed &&
        !stdin.destroyed &&
        !stdin.writableEnded
      ) {
        stdin.write(`${buildClaudeControlResponseLine(pending.request, payload.behavior)}\n`);
        return { mode: 'interactive' as const };
      }

      if (payload.behavior === 'allow' && pending.request.targetPath) {
        await runClaudePrint(
          pending.sessionId,
          `Permission was granted for ${pending.request.targetPath}. Retry only the blocked tool action.`,
        );
        return { mode: 'fallback' as const };
      }

      return { mode: 'missing' as const };
    },
  );
  ipcMain.handle(
    'ask-user-question:respond',
    async (
      _event,
      payload: {
        toolUseId: string;
        answers: Record<string, string>;
        annotations?: Record<string, { notes?: string }>;
      },
    ) => {
      const pending = pendingAskUserQuestions.get(payload.toolUseId);
      if (!pending) {
        return { mode: 'missing' as const };
      }

      pendingAskUserQuestions.delete(payload.toolUseId);
      if (!isWritableStdin(pending.activeRun.child)) {
        return { mode: 'missing' as const };
      }

      const stdin = pending.activeRun.child.stdin;
      if (!stdin) {
        return { mode: 'missing' as const };
      }

      stdin.write(
        `${buildClaudeAskUserQuestionToolResultLine({
          toolUseId: pending.toolUseId,
          questions: pending.questions,
          response: {
            answers: payload.answers,
            annotations: payload.annotations ?? {},
          },
        })}\n`,
      );
      return { mode: 'interactive' as const };
    },
  );
  ipcMain.handle('projects:open-directory', async () => openProjectDirectory());
  ipcMain.handle('projects:close', async (_event, payload: { projectId: string }) => {
    const result = await closeProject(payload.projectId);
    stopSessions(result.closedSessionIds);
    return result;
  });
  ipcMain.handle('streamworks:create', async (_event, payload: { projectId: string; name: string }) =>
    createStreamwork(payload.projectId, payload.name),
  );
  ipcMain.handle('streamworks:delete', async (_event, payload: { streamworkId: string }) => {
    const result = await deleteStreamwork(payload.streamworkId);
    stopSessions(result.deletedSessionIds);
    return result;
  });
  ipcMain.handle(
    'entities:rename',
    async (_event, payload: { kind: 'project' | 'streamwork' | 'session'; id: string; name: string }) =>
      renameEntity(payload.kind, payload.id, payload.name),
  );
  ipcMain.handle('sessions:delete', async (_event, payload: { sessionId: string }) => {
    const result = await deleteSession(payload.sessionId);
    stopSessions(result.deletedSessionIds);
    return result;
  });
  ipcMain.handle(
    'sessions:update-context-references',
    async (_event, payload: { sessionId: string; references: ContextReference[] }) =>
      updateSessionContextReferences(payload.sessionId, payload.references),
  );
  ipcMain.handle(
    'streamworks:reorder',
    async (_event, payload: { projectId: string; sourceId: string; targetId: string }) =>
      reorderStreamworks(payload.projectId, payload.sourceId, payload.targetId),
  );
  ipcMain.handle('git:file-diff', async (_event, payload: { cwd: string; filePath: string }) =>
    getFileDiff(payload.cwd, payload.filePath),
  );
  ipcMain.handle(
    'claude:send-message',
    async (
      _event,
      payload: {
        sessionId: string;
        prompt: string;
        attachments?: PendingAttachment[];
        session?: SessionSummary;
        references?: ContextReference[];
        model?: string;
        effort?: 'low' | 'medium' | 'high' | 'max';
      },
    ) =>
      runClaudePrint(payload.sessionId, payload.prompt, payload.attachments ?? [], payload.session, {
        references: payload.references,
        model: payload.model,
        effort: payload.effort,
      }),
  );
  ipcMain.handle('claude:stop-session', async (_event, payload: { sessionId: string }) => {
    stopSessions([payload.sessionId]);
    const result = await stopPendingSessionMessages(payload.sessionId);
    result.changedMessages.forEach((message) => {
      if (message.role === 'assistant') {
        broadcastClaudeEvent({
          type: 'status',
          sessionId: payload.sessionId,
          messageId: message.id,
          status: message.status,
          title: message.title,
          content: message.content,
        });
        return;
      }

      broadcastClaudeEvent({
        type: 'trace',
        sessionId: payload.sessionId,
        message,
      });
    });
    return {
      projects: result.projects,
    };
  });

  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
