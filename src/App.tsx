import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BtwPanel, type BtwMessage } from './components/BtwPanel';
import { ChatComposer, type ComposerAttachment } from './components/ChatComposer';
import { ChatHistory } from './components/ChatHistory';
import { bridge } from './bridge';
import { ManageDialog } from './components/ManageDialog';
import { ChatThread } from './components/ChatThread';
import { ContextPanel } from './components/ContextPanel';
import { HarnessDashboard } from './components/HarnessDashboard';
import { buildOptimisticSendState } from './data/optimisticSend';
import {
  buildAskUserQuestionFollowUpPrompt,
  buildAskUserQuestionResponsePayload,
  type AskUserQuestionDraft,
} from './data/askUserQuestion';
import {
  clearSessionBackgroundTasks,
  setSessionRuntimeState,
  upsertSessionBackgroundTask,
  type SessionInteractionState,
} from './data/sessionInteraction';
import {
  buildPlanModeFollowUpPrompt,
  parsePlanModeAllowedPrompts,
  type PlanModeRequest,
  type PlanModeResponsePayload,
} from './data/planMode';
import { parsePermissionRequest } from './data/permissionRequest';
import { resolveRequestedModelArg, syncImplicitModelSelection, type ModelSelectionSource } from './data/modelSelection';
import type {
  BtwResponse,
  ClaudeStreamEvent,
  ContextReference,
  ContextReferenceMode,
  DiffPayload,
  GitSnapshot,
  PendingAttachment,
  ProjectRecord,
  SessionRecord,
  SessionActivityState,
} from './data/types';

const makeAttachmentId = () => `attachment-${Math.random().toString(36).slice(2, 10)}`;

const flattenSessions = (projects: ProjectRecord[]) =>
  projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions.map((session) => session as SessionRecord)),
  );

const flattenVisibleSessions = (projects: ProjectRecord[]) =>
  flattenSessions(projects).filter((session) => !session.hidden && session.sessionKind !== 'harness_role');

const isTerminalBackgroundTaskStatus = (
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped',
) => status === 'completed' || status === 'failed' || status === 'stopped';

const parsePlanModeTracePayload = (message: SessionRecord['messages'][number]): PlanModeRequest | null => {
  if (
    message.role !== 'system' ||
    message.kind !== 'tool_use' ||
    message.title !== 'ExitPlanMode' ||
    message.status !== 'running'
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(message.content) as {
      plan?: unknown;
      planFilePath?: unknown;
      allowedPrompts?: unknown;
    };
    const planFilePath = typeof parsed.planFilePath === 'string' ? parsed.planFilePath : undefined;

    return {
      toolUseId: message.id,
      toolName: 'ExitPlanMode',
      plan: typeof parsed.plan === 'string' ? parsed.plan : '',
      allowedPrompts: parsePlanModeAllowedPrompts(parsed.allowedPrompts),
      ...(planFilePath ? { planFilePath } : {}),
    };
  } catch {
    // Content is plain text (from buildPlanModeTraceContent) — use it as the plan directly
    return {
      toolUseId: message.id,
      toolName: 'ExitPlanMode',
      plan: message.content || '',
      allowedPrompts: [],
    };
  }
};

const findLastAssistantMessage = (session: SessionRecord) =>
  [...(session.messages ?? [])].reverse().find((message) => message.role === 'assistant');

const isAssistantPendingStatus = (status: string | undefined) =>
  status === 'queued' || status === 'streaming' || status === 'running';

const updateSessionInProjects = (
  projects: ProjectRecord[],
  sessionId: string,
  updater: (session: SessionRecord) => SessionRecord,
) =>
  projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) =>
        session.id === sessionId ? updater(session as SessionRecord) : session,
      ),
    })),
  }));

const applyClaudeEvent = (projects: ProjectRecord[], event: ClaudeStreamEvent) =>
  updateSessionInProjects(projects, event.sessionId, (session) => {
    const updatedAt = Date.now();

    if (
      event.type === 'permission-request' ||
      event.type === 'ask-user-question' ||
      event.type === 'plan-mode-request' ||
      event.type === 'background-task' ||
      event.type === 'runtime-state'
    ) {
      return session;
    }

    if (event.type === 'harness-state') {
      return {
        ...session,
        harnessState: event.state,
        preview: event.state.summary ?? session.preview,
        timeLabel: 'Just now',
        updatedAt,
      };
    }

    if (event.type === 'trace') {
      const messages = [...(session.messages ?? [])];
      const existingIndex = messages.findIndex((message) => message.id === event.message.id);
      if (existingIndex >= 0) {
        messages[existingIndex] = event.message;
      } else {
        messages.push(event.message);
      }

      return {
        ...session,
        messages,
        updatedAt,
      };
    }

    const messages = [...(session.messages ?? [])];
    const targetIndex = messages.findIndex((message) => message.id === event.messageId);
    if (targetIndex === -1) {
      return session;
    }

    const target = { ...messages[targetIndex] };

    if (event.type === 'status') {
      if (typeof event.content === 'string') {
        target.content = event.content;
      }
      if (typeof event.title === 'string') {
        target.title = event.title;
      }
      if (event.status) {
        target.status = event.status;
      }
      messages[targetIndex] = target;
      return {
        ...session,
        messages,
        preview: target.content || session.preview,
        timeLabel: 'Just now',
        updatedAt,
      };
    }

    if (event.type === 'delta') {
      target.content += event.delta;
      target.status = 'streaming';
      messages[targetIndex] = target;
      return {
        ...session,
        messages,
        preview: target.content || session.preview,
        timeLabel: 'Just now',
        updatedAt,
      };
    }

    if (event.type === 'complete') {
      target.content = event.content;
      target.status = 'complete';
      messages[targetIndex] = target;
      return {
        ...session,
        messages,
        preview: event.content || session.preview,
        timeLabel: 'Just now',
        updatedAt,
        claudeSessionId: event.claudeSessionId ?? session.claudeSessionId,
        tokenUsage: event.tokenUsage ?? session.tokenUsage,
      };
    }

    target.content = event.type === 'error' ? event.error : target.content;
    target.status = 'error';
    messages[targetIndex] = target;
    return {
      ...session,
      messages,
      preview: 'Claude error',
      timeLabel: 'Just now',
      updatedAt,
    };
  });

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
    reader.readAsDataURL(file);
  });

const appendPathsToDraft = (currentDraft: string, paths: string[]) => {
  const normalizedPaths = paths.filter((path) => path.trim());
  if (normalizedPaths.length === 0) {
    return currentDraft;
  }

  const prefix = currentDraft.trim().length > 0 && !currentDraft.endsWith('\n') ? '\n' : '';
  return `${currentDraft}${prefix}${normalizedPaths.join('\n')}`;
};

const referenceTokenPattern = /\[\[(session|streamwork):([^[\]|]+?)(?:\|(summary|full))?\]\]/gi;

const makeContextReferenceId = () =>
  globalThis.crypto?.randomUUID?.() ?? `ctx-${Math.random().toString(36).slice(2, 10)}`;

const getContextReferenceKey = (reference: ContextReference) =>
  reference.kind === 'session'
    ? `session:${reference.sessionId ?? ''}`
    : `streamwork:${reference.streamworkId ?? ''}`;

const mergeContextReferences = (
  currentReferences: ContextReference[] = [],
  incomingReferences: ContextReference[] = [],
) => {
  const merged = new Map<string, ContextReference>();

  currentReferences.forEach((reference) => {
    merged.set(getContextReferenceKey(reference), reference);
  });

  incomingReferences.forEach((reference) => {
    const key = getContextReferenceKey(reference);
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, ...reference, id: existing.id } : reference);
  });

  return [...merged.values()];
};

const resolveContextReferenceLabel = (
  reference: ContextReference,
  projects: ProjectRecord[],
  sessions: SessionRecord[],
) => {
  if (reference.kind === 'session' && reference.sessionId) {
    return sessions.find((session) => session.id === reference.sessionId)?.title ?? reference.label;
  }

  if (reference.kind === 'streamwork' && reference.streamworkId) {
    const streamwork = projects
      .flatMap((project) => project.dreams)
      .find((dream) => dream.id === reference.streamworkId);
    return streamwork ? `${streamwork.name} history` : reference.label;
  }

  return reference.label;
};

const consumeReferenceTokens = (
  value: string,
  projects: ProjectRecord[],
  sessions: SessionRecord[],
) => {
  const references: ContextReference[] = [];

  const cleanedDraft = value
    .replace(referenceTokenPattern, (token, rawKind: string, rawId: string, rawMode?: string) => {
      const kind = rawKind === 'streamwork' ? 'streamwork' : 'session';
      const mode: ContextReferenceMode = rawMode === 'full' ? 'full' : 'summary';
      const targetId = String(rawId ?? '').trim();

      if (!targetId) {
        return token;
      }

      if (kind === 'session') {
        const session = sessions.find((candidate) => candidate.id === targetId);
        if (!session) {
          return token;
        }

        references.push({
          id: makeContextReferenceId(),
          kind: 'session',
          sessionId: session.id,
          label: session.title,
          mode,
        });
        return '';
      }

      const streamwork = projects
        .flatMap((project) => project.dreams)
        .find((candidate) => candidate.id === targetId);
      if (!streamwork) {
        return token;
      }

      references.push({
        id: makeContextReferenceId(),
        kind: 'streamwork',
        streamworkId: streamwork.id,
        label: `${streamwork.name} history`,
        mode,
      });
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart();

  return {
    cleanedDraft,
    references,
  };
};

type DialogKind =
  | 'create-project'
  | 'create-streamwork'
  | 'create-session'
  | 'close-project'
  | 'delete-streamwork'
  | 'delete-session';

type DialogState = {
  kind: DialogKind;
  targetId: string;
  fields: Record<string, string>;
  toggles: Record<string, boolean>;
};

type BtwState = {
  isOpen: boolean;
  draft: string;
  isSending: boolean;
  tokenUsage?: BtwResponse['tokenUsage'];
  inheritedContext: boolean;
  messages: BtwMessage[];
};

type SessionIndicator = {
  state: SessionActivityState;
  online?: boolean;
};

type MobilePanel = 'history' | 'session' | 'context';

export default function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [appVersion, setAppVersion] = useState('desktop');
  const [isSending, setIsSending] = useState(false);
  const [model, setModel] = useState('opus[1m]');
  const [modelSelectionSource, setModelSelectionSource] = useState<ModelSelectionSource>('implicit');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('high');
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [isResizingPane, setIsResizingPane] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(338);
  const [isDialogBusy, setIsDialogBusy] = useState(false);
  const [isBootstrappingHarness, setIsBootstrappingHarness] = useState(false);
  const [isRunningHarness, setIsRunningHarness] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);
  const [sessionInteractions, setSessionInteractions] = useState<Map<string, SessionInteractionState>>(new Map());

  const updateSessionInteraction = useCallback(
    (sessionId: string, updater: (state: SessionInteractionState) => SessionInteractionState) => {
      setSessionInteractions((current) => {
        const next = new Map(current);
        next.set(sessionId, updater(next.get(sessionId) ?? {}));
        return next;
      });
    },
    [],
  );

  const clearSessionInteraction = useCallback((sessionId: string) => {
    setSessionInteractions((current) => {
      const next = new Map(current);
      next.delete(sessionId);
      return next;
    });
  }, []);
  const [isMobileLayout, setIsMobileLayout] = useState(() =>
    globalThis.matchMedia ? globalThis.matchMedia('(max-width: 920px)').matches : false,
  );
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('session');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const submittedPlanToolUseIds = useRef(new Set<string>());
  const [slashCommands, setSlashCommands] = useState<string[]>([]);
  const [unreadSessionIds, setUnreadSessionIds] = useState<string[]>([]);
  const [btwState, setBtwState] = useState<BtwState>({
    isOpen: false,
    draft: '',
    isSending: false,
    inheritedContext: false,
    messages: [],
  });
  const [gitSnapshot, setGitSnapshot] = useState<GitSnapshot>({
    branch: 'loading',
    tracking: undefined,
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFiles: [],
    source: 'mock',
  });

  const allSessions = useMemo(() => flattenSessions(projects), [projects]);
  const visibleSessions = useMemo(() => flattenVisibleSessions(projects), [projects]);
  const selectedSession = useMemo(
    () => allSessions.find((session) => session.id === selectedSessionId) ?? visibleSessions[0] ?? allSessions[0],
    [allSessions, selectedSessionId, visibleSessions],
  );
  const selectedInteractionState = useMemo(
    () => sessionInteractions.get(selectedSession?.id ?? ''),
    [selectedSession?.id, sessionInteractions],
  );
  useEffect(() => {
    setComposerNotice(null);
  }, [selectedSession?.id]);
  useEffect(() => {
    const appliedEffort = selectedInteractionState?.runtime?.appliedEffort;
    if (!composerNotice || !appliedEffort) {
      return;
    }

    if (appliedEffort === effort) {
      setComposerNotice(`Thinking ${effort} is now active for this session.`);
    }
  }, [composerNotice, effort, selectedInteractionState?.runtime?.appliedEffort]);
  const activeSelectedSessionId = selectedSession?.id ?? selectedSessionId;
  const harnessPlannerSession = useMemo(
    () =>
      selectedSession?.sessionKind === 'harness' && selectedSession.harnessState
        ? allSessions.find((session) => session.id === selectedSession.harnessState?.plannerSessionId)
        : undefined,
    [allSessions, selectedSession],
  );
  const harnessGeneratorSession = useMemo(
    () =>
      selectedSession?.sessionKind === 'harness' && selectedSession.harnessState
        ? allSessions.find((session) => session.id === selectedSession.harnessState?.generatorSessionId)
        : undefined,
    [allSessions, selectedSession],
  );
  const harnessEvaluatorSession = useMemo(
    () =>
      selectedSession?.sessionKind === 'harness' && selectedSession.harnessState
        ? allSessions.find((session) => session.id === selectedSession.harnessState?.evaluatorSessionId)
        : undefined,
    [allSessions, selectedSession],
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedSession?.projectId) ?? projects[0],
    [projects, selectedSession],
  );
  const selectedStreamwork = useMemo(
    () => selectedProject?.dreams.find((dream) => dream.id === selectedSession?.dreamId) ?? selectedProject?.dreams[0],
    [selectedProject, selectedSession],
  );
  const displayContextReferences = useMemo(
    () =>
      (selectedSession?.contextReferences ?? []).map((reference) => ({
        ...reference,
        label: resolveContextReferenceLabel(reference, projects, allSessions),
      })),
    [allSessions, projects, selectedSession],
  );
  const isSelectedSessionResponding = useMemo(
    () =>
      sessionInteractions.get(selectedSession?.id ?? '')?.runtime
        ? sessionInteractions.get(selectedSession?.id ?? '')?.runtime?.phase === 'running' ||
          sessionInteractions.get(selectedSession?.id ?? '')?.runtime?.phase === 'awaiting_reply' ||
          sessionInteractions.get(selectedSession?.id ?? '')?.runtime?.phase === 'terminating'
        : selectedSession
          ? selectedSession.sessionKind === 'harness'
            ? selectedSession.harnessState?.status === 'running'
            : isAssistantPendingStatus(findLastAssistantMessage(selectedSession)?.status)
          : false,
    [selectedSession, sessionInteractions],
  );
  const sessionIndicators = useMemo<Record<string, SessionIndicator>>(
    () =>
      Object.fromEntries(
        visibleSessions.map((session) => {
          const relatedRoleSessions =
            session.sessionKind === 'harness' && session.harnessState
              ? allSessions.filter((candidate) =>
                  [
                    session.harnessState?.plannerSessionId,
                    session.harnessState?.generatorSessionId,
                    session.harnessState?.evaluatorSessionId,
                  ].includes(candidate.id),
                )
              : [];
          const lastAssistant = findLastAssistantMessage(session);
          const isResponding =
            session.sessionKind === 'harness'
              ? session.harnessState?.status === 'running' ||
                relatedRoleSessions.some((candidate) => isAssistantPendingStatus(findLastAssistantMessage(candidate)?.status))
              : isAssistantPendingStatus(lastAssistant?.status);
          const hasUnread =
            session.id !== activeSelectedSessionId && unreadSessionIds.includes(session.id);
          const interaction = sessionInteractions.get(session.id);
          const hasActiveBackgroundTasks = Boolean(
            interaction?.backgroundTasks?.some(
              (task) => task.status === 'pending' || task.status === 'running',
            ),
          );
          const runtimePhase = interaction?.runtime?.phase;
          const isOnline = Boolean(interaction?.runtime?.processActive);
          const hasBlockingInteraction = Boolean(
            interaction?.permission || interaction?.askUserQuestion || interaction?.planModeRequest,
          );

          if (hasBlockingInteraction) {
            return [session.id, { state: 'awaiting_reply', online: isOnline }];
          }

          if (runtimePhase === 'awaiting_reply') {
            return [session.id, { state: 'awaiting_reply', online: isOnline }];
          }

          if (runtimePhase === 'background') {
            return [session.id, { state: 'background', online: isOnline }];
          }

          if (runtimePhase === 'running' || runtimePhase === 'terminating') {
            return [session.id, { state: 'responding', online: isOnline }];
          }

          if (hasActiveBackgroundTasks) {
            return [session.id, { state: 'background', online: isOnline }];
          }

          if (isResponding) {
            return [session.id, { state: 'responding', online: isOnline }];
          }

          if (hasUnread) {
            return [session.id, { state: 'unread', online: isOnline }];
          }

          return [session.id, { state: 'idle', online: isOnline }];
        }),
      ),
    [activeSelectedSessionId, allSessions, sessionInteractions, unreadSessionIds, visibleSessions],
  );
  const isWebRuntime = bridge.runtime === 'web';
  const selectedInteraction = sessionInteractions.get(selectedSession?.id ?? '');
  const hasBlockingInteraction = Boolean(
    selectedInteraction?.permission || selectedInteraction?.askUserQuestion || selectedInteraction?.planModeRequest,
  );
  const hasActiveSelectedBackgroundTasks = Boolean(
    selectedInteraction?.backgroundTasks?.some(
      (task) => task.status === 'pending' || task.status === 'running',
    ),
  );
  const canDisconnectSelectedSession = Boolean(selectedInteraction?.runtime?.processActive);

  const getOriginalFilePath = (file: File) => {
    try {
      const candidate = bridge.getPathForFile(file);
      return typeof candidate === 'string' && candidate.trim() ? candidate : undefined;
    } catch {
      return undefined;
    }
  };

  const playReplyCompleteTone = useCallback(() => {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        return;
      }

      const context = audioContextRef.current ?? new AudioContextCtor();
      audioContextRef.current = context;

      if (context.state === 'suspended') {
        void context.resume().catch(() => undefined);
      }

      const startAt = context.currentTime + 0.02;
      const notes = [784, 1046.5];

      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const offset = index * 0.12;
        const noteStart = startAt + offset;
        const noteEnd = noteStart + 0.16;

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, noteStart);

        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(0.045, noteStart + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteEnd + 0.02);
      });
    } catch {
      // Ignore notification audio failures.
    }
  }, []);

  const openDialog = (kind: DialogKind, targetId: string) => {
    const presets: Record<DialogKind, DialogState> = {
      'create-project': {
        kind,
        targetId,
        fields: {
          name: '',
          rootPath: '',
        },
        toggles: {},
      },
      'create-streamwork': {
        kind,
        targetId,
        fields: {
          name: 'New Streamwork',
        },
        toggles: {},
      },
      'create-session': {
        kind,
        targetId,
        fields: {
          name: 'New Session',
        },
        toggles: {
          includeStreamworkSummary: false,
        },
      },
      'close-project': {
        kind,
        targetId,
        fields: {},
        toggles: {},
      },
      'delete-streamwork': {
        kind,
        targetId,
        fields: {},
        toggles: {},
      },
      'delete-session': {
        kind,
        targetId,
        fields: {},
        toggles: {},
      },
    };

    setDialogState(presets[kind]);
  };

  useEffect(() => {
    if (!globalThis.matchMedia) {
      return;
    }

    const mediaQuery = globalThis.matchMedia('(max-width: 920px)');
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobileLayout(event.matches);
      if (!event.matches) {
        setMobilePanel('session');
      }
    };

    setIsMobileLayout(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, []);

  useEffect(() => {
    if (isMobileLayout && visibleSessions.length === 0) {
      setMobilePanel('history');
    }
  }, [isMobileLayout, visibleSessions.length]);

  useEffect(() => {
    if (visibleSessions.length === 0) {
      if (selectedSessionId) {
        setSelectedSessionId('');
      }
      return;
    }

    if (!selectedSessionId || !visibleSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(visibleSessions[0].id);
    }
  }, [selectedSessionId, visibleSessions]);

  useEffect(() => {
    const loadMeta = async () => {
      try {
        const [meta, bootstrap] = await Promise.all([bridge.getAppMeta(), bridge.getProjects()]);

        if (meta?.version) {
          setAppVersion(meta.version);
        }
        if (meta?.defaultModel) {
          setModel(meta.defaultModel);
          setModelSelectionSource('implicit');
        }

        const nextProjects = bootstrap?.projects ?? [];
        setProjects(nextProjects);
        setSessionInteractions(new Map(Object.entries(bootstrap?.interactions ?? {})));
        const firstSession = flattenVisibleSessions(nextProjects)[0];
        if (firstSession) {
          setSelectedSessionId((current) => current || firstSession.id);
        } else {
          setSelectedSessionId('');
        }
      } catch (error) {
        setUiError(error instanceof Error ? error.message : 'Failed to initialize EasyAIFlow.');
      }
    };

    void loadMeta();
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const EVENT_THROTTLE_MS = 33; // ~30 fps
    let pendingDeltas: ClaudeStreamEvent[] = [];
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;

    const flushDeltas = () => {
      if (pendingDeltas.length === 0) {
        return;
      }
      const batch = pendingDeltas;
      pendingDeltas = [];
      setProjects((current) => batch.reduce(applyClaudeEvent, current));
    };

    const processEvent = (event: ClaudeStreamEvent) => {
      if (event.type === 'permission-request') {
        updateSessionInteraction(event.sessionId, (state) => ({
          ...state,
          permission: {
            path: event.targetPath ?? event.command ?? event.description ?? event.toolName,
            sensitive: event.sensitive,
            requestId: event.requestId,
            sessionId: event.sessionId,
          },
        }));
      }
      if (event.type === 'ask-user-question') {
        updateSessionInteraction(event.sessionId, (state) => ({
          ...state,
          askUserQuestion: {
            sessionId: event.sessionId,
            toolUseId: event.toolUseId,
            questions: event.questions,
          },
          isSubmittingAskUserQuestion: false,
        }));
      }
      if (event.type === 'plan-mode-request') {
        updateSessionInteraction(event.sessionId, (state) => ({
          ...state,
          planModeRequest: {
            sessionId: event.sessionId,
            request: event.request,
          },
        }));
      }
      if (event.type === 'background-task') {
        updateSessionInteraction(event.sessionId, (state) =>
          upsertSessionBackgroundTask(state, event.task),
        );
      }
      if (event.type === 'runtime-state') {
        updateSessionInteraction(event.sessionId, (state) =>
          setSessionRuntimeState(state, event.runtime),
        );
      }
      if (event.type === 'trace' && event.message.status === 'error') {
        const request = parsePermissionRequest(event.message.content);
        if (request) {
          updateSessionInteraction(event.sessionId, (state) => ({
            ...state,
            permission: {
              path: request.targetPath,
              sensitive: request.sensitive,
              sessionId: event.sessionId,
            },
          }));
        }
      }
      if (event.type === 'complete') {
        playReplyCompleteTone();
      }
      if (
        event.sessionId !== activeSelectedSessionId &&
        (
          event.type === 'complete' ||
          event.type === 'error' ||
          (event.type === 'runtime-state' && event.runtime.phase === 'inactive') ||
          (event.type === 'background-task' && isTerminalBackgroundTaskStatus(event.task.status))
        )
      ) {
        setUnreadSessionIds((current) =>
          current.includes(event.sessionId) ? current : [...current, event.sessionId],
        );
      }
    };

    try {
      unsubscribe = bridge.onClaudeEvent((event) => {
        if (event.type === 'delta') {
          pendingDeltas.push(event);
          if (!deltaTimer) {
            deltaTimer = setTimeout(() => {
              deltaTimer = null;
              flushDeltas();
            }, EVENT_THROTTLE_MS);
          }
          return;
        }

        // Non-delta event: flush pending deltas first to maintain ordering, then apply immediately.
        if (deltaTimer) {
          clearTimeout(deltaTimer);
          deltaTimer = null;
        }
        flushDeltas();
        setProjects((current) => applyClaudeEvent(current, event));
        processEvent(event);
      });
    } catch {
      unsubscribe = undefined;
    }

    return () => {
      if (deltaTimer) {
        clearTimeout(deltaTimer);
      }
      flushDeltas();
      unsubscribe?.();
    };
  }, [activeSelectedSessionId, playReplyCompleteTone]);

  useEffect(() => {
    if (!activeSelectedSessionId) {
      return;
    }

    setUnreadSessionIds((current) => current.filter((sessionId) => sessionId !== activeSelectedSessionId));
  }, [activeSelectedSessionId]);

  useEffect(() => {
    const validSessionIds = new Set(allSessions.map((session) => session.id));
    setUnreadSessionIds((current) => current.filter((sessionId) => validSessionIds.has(sessionId)));
  }, [allSessions]);

  useEffect(() => {
    const validSessionIds = new Set(allSessions.map((session) => session.id));
    setSessionInteractions((current) => {
      let changed = false;
      const next = new Map<string, SessionInteractionState>();
      current.forEach((value, sessionId) => {
        if (validSessionIds.has(sessionId)) {
          next.set(sessionId, value);
          return;
        }
        changed = true;
      });
      return changed ? next : current;
    });
  }, [allSessions]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    setModel((current) => {
      const next = syncImplicitModelSelection(current, modelSelectionSource, selectedSession.model);
      if (next.source !== modelSelectionSource) {
        setModelSelectionSource(next.source);
      }
      return next.model;
    });

    setGitSnapshot({
      ...selectedSession.branchSnapshot,
      source: 'mock',
    });

    const loadGitSnapshot = async () => {
      const liveSnapshot = await bridge.getGitSnapshot(selectedSession.workspace);
      if (liveSnapshot) {
        setGitSnapshot(liveSnapshot);
      }
    };

    void loadGitSnapshot().catch(() => undefined);
  }, [selectedSession]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    let cancelled = false;
    void bridge
      .getSlashCommands({
        cwd: selectedSession.workspace,
        model: resolveRequestedModelArg(model, modelSelectionSource),
      })
      .then((result) => {
        if (!cancelled) {
          setSlashCommands(['btw', ...result.commands.filter((command) => command !== 'btw')]);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSlashCommands(['btw']);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSession?.workspace, model, modelSelectionSource]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    // Harness sessions manage their own orchestration flow; skip stale plan trace detection.
    if (selectedSession.sessionKind === 'harness') {
      return;
    }

    const existing = sessionInteractions.get(selectedSession.id);
    if (existing?.planModeRequest) {
      return;
    }

    const pendingPlanTrace = [...(selectedSession.messages ?? [])]
      .reverse()
      .map((message) => parsePlanModeTracePayload(message))
      .find((item) => Boolean(item));

    if (!pendingPlanTrace || submittedPlanToolUseIds.current.has(pendingPlanTrace.toolUseId)) {
      return;
    }

    updateSessionInteraction(selectedSession.id, (state) => ({
      ...state,
      planModeRequest: {
        sessionId: selectedSession.id,
        request: pendingPlanTrace,
      },
    }));
  }, [sessionInteractions, selectedSession, updateSessionInteraction]);

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.url));
      audioContextRef.current?.close().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!isResizingPane) {
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      setLeftPaneWidth(Math.min(520, Math.max(280, event.clientX)));
    };

    const handleMouseUp = () => {
      setIsResizingPane(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingPane]);

  const clearAttachments = () => {
    setAttachments((current) => {
      current.forEach((attachment) => URL.revokeObjectURL(attachment.url));
      return [];
    });
  };

  const persistContextReferences = async (sessionId: string, references: ContextReference[]) => {
    const result = await bridge.updateSessionContextReferences({
      sessionId,
      references,
    });
    setProjects(result.projects);
  };

  const handleUpdateContextReferences = (
    references: ContextReference[],
    sessionId = selectedSession?.id ?? '',
  ) => {
    if (!sessionId) {
      return;
    }

    setProjects((current) =>
      updateSessionInProjects(current, sessionId, (session) => ({
        ...session,
        contextReferences: references,
      })),
    );

    void persistContextReferences(sessionId, references).catch((error) => {
      setUiError(error instanceof Error ? error.message : 'Failed to update session references.');
    });
  };

  const handleDraftChange = (value: string) => {
    const { cleanedDraft, references } = consumeReferenceTokens(value, projects, allSessions);

    if (references.length > 0) {
      handleUpdateContextReferences(
        mergeContextReferences(selectedSession.contextReferences ?? [], references),
      );
    }

    setDraft(cleanedDraft);
  };

  const handleAttachFiles = async (files: FileList | null) => {
    if (!files) {
      return;
    }

    try {
      const nextAttachments = await Promise.all(
        Array.from(files).map(async (file) => ({
          id: makeAttachmentId(),
          name: file.name || 'attachment',
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          url: URL.createObjectURL(file),
          path: getOriginalFilePath(file),
          dataUrl: getOriginalFilePath(file) ? undefined : await fileToDataUrl(file),
        })),
      );

      if (nextAttachments.length > 0) {
        setAttachments((current) => [...current, ...nextAttachments]);
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to import attached files.');
    }
  };

  const handleInsertDroppedPaths = (files: FileList | null) => {
    if (!files) {
      return;
    }

    if (bridge.runtime === 'web') {
      void handleAttachFiles(files);
      return;
    }

    const paths = Array.from(files)
      .map((file) => getOriginalFilePath(file))
      .filter((path): path is string => Boolean(path));

    if (paths.length === 0) {
      setUiError('Failed to read dropped file paths.');
      return;
    }

    setUiError(null);
    handleDraftChange(appendPathsToDraft(draft, paths));
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === attachmentId);
      if (target) {
        URL.revokeObjectURL(target.url);
      }
      return current.filter((attachment) => attachment.id !== attachmentId);
    });
  };

  const handleSend = async () => {
    if (!selectedSession) {
      return;
    }

    if (hasBlockingInteraction) {
      setUiError('Resolve the current interactive Claude request before sending another message.');
      return;
    }

    const prompt = draft.trim();
    if ((!prompt && attachments.length === 0) || isSending) {
      return;
    }

    if (prompt.startsWith('/btw')) {
      const btwPrompt = prompt.replace(/^\/btw\b/, '').trim();
      setDraft('');
      clearAttachments();
      setBtwState((current) => ({
        ...current,
        isOpen: true,
      }));
      if (btwPrompt) {
        setBtwState((current) => ({
          ...current,
          draft: btwPrompt,
        }));
        setTimeout(() => {
          void handleSendBtwMessage(btwPrompt);
        }, 0);
      }
      return;
    }

    setIsSending(true);
    setUiError(null);
    setUnreadSessionIds((current) => current.filter((sessionId) => sessionId !== selectedSession.id));
    updateSessionInteraction(selectedSession.id, (state) => clearSessionBackgroundTasks(state));

    const outgoingPrompt = prompt || 'Please inspect the attached files and describe anything relevant.';
    const pendingAttachments: PendingAttachment[] = attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      path: attachment.path,
      dataUrl: attachment.dataUrl,
    }));
    const optimisticSend = buildOptimisticSendState({
      projects,
      sessionId: selectedSession.id,
      prompt: outgoingPrompt,
      attachments: pendingAttachments,
      references: displayContextReferences,
      queued: isSelectedSessionResponding,
    });

    setProjects(optimisticSend.projects);

    try {
      const result = await bridge.sendMessage({
        sessionId: selectedSession.id,
        prompt: outgoingPrompt,
        attachments: pendingAttachments,
        session: selectedSession,
        references: displayContextReferences,
        model: resolveRequestedModelArg(model, modelSelectionSource),
        effort,
      });

      if (result?.projects) {
        setProjects(result.projects);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send message.';
      setUiError(message);
      setProjects((current) =>
        updateSessionInProjects(current, selectedSession.id, (session) => ({
          ...session,
          preview: 'Claude error',
          timeLabel: 'Just now',
          updatedAt: Date.now(),
          messages: (session.messages ?? []).map((entry) =>
            entry.id === optimisticSend.assistantMessageId
              ? {
                  ...entry,
                  title: 'Claude error',
                  content: message,
                  status: 'error',
                }
              : entry,
          ),
        })),
      );
      return;
    }

    try {
      if (displayContextReferences.length > 0) {
        await bridge.updateSessionContextReferences({
          sessionId: selectedSession.id,
          references: [],
        }).then((next) => {
          setProjects(next.projects);
        });
      }

      setDraft('');
      clearAttachments();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send message.';
      setUiError(message);
    } finally {
      setIsSending(false);
    }
  };

  const handleStop = async () => {
    if (!selectedSession) {
      return;
    }

    try {
      setUiError(null);
      setIsSending(false);
      const result = await bridge.stopSessionRun({
        sessionId: selectedSession.id,
      });
      if (result?.projects) {
        setProjects(result.projects);
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to stop Claude.');
    }
  };

  const handleSendBtwMessage = async (overridePrompt?: string) => {
    if (!selectedSession) {
      return;
    }

    if (hasBlockingInteraction) {
      setUiError('Resolve the current interactive Claude request before sending another message.');
      return;
    }

    const prompt = (overridePrompt ?? btwState.draft).trim();
    if (!prompt || btwState.isSending) {
      return;
    }

    const userMessage: BtwMessage = {
      id: `btw-user-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: new Date().toLocaleString('zh-CN'),
      status: 'complete',
    };

    setBtwState((current) => ({
      ...current,
      isOpen: true,
      isSending: true,
      draft: '',
      messages: [...current.messages, userMessage],
    }));

    try {
      const result = await bridge.sendBtwMessage({
        sessionId: selectedSession.id,
        cwd: selectedSession.workspace,
        prompt,
        model: resolveRequestedModelArg(model, modelSelectionSource),
        effort,
        baseClaudeSessionId: selectedSession.claudeSessionId,
      });

      const assistantMessage: BtwMessage = {
        id: `btw-assistant-${Date.now()}`,
        role: 'assistant',
        content: result.content,
        timestamp: new Date().toLocaleString('zh-CN'),
        status: 'complete',
      };

      setBtwState((current) => ({
        ...current,
        isSending: false,
        isOpen: true,
        tokenUsage: result.tokenUsage ?? current.tokenUsage,
        inheritedContext: result.inheritedContext,
        messages: [...current.messages, assistantMessage],
      }));
    } catch (error) {
      const assistantMessage: BtwMessage = {
        id: `btw-error-${Date.now()}`,
        role: 'assistant',
        content: error instanceof Error ? error.message : 'BTW request failed.',
        timestamp: new Date().toLocaleString('zh-CN'),
        status: 'error',
      };

      setBtwState((current) => ({
        ...current,
        isSending: false,
        isOpen: true,
        messages: [...current.messages, assistantMessage],
      }));
    }
  };

  const handleCloseBtw = () => {
    setBtwState({
      isOpen: false,
      draft: '',
      isSending: false,
      inheritedContext: false,
      messages: [],
    });
  };

  const handleDisconnect = async (sessionId = selectedSession?.id ?? '') => {
    if (!sessionId) {
      return;
    }

    try {
      setUiError(null);
      setIsSending(false);
      const result = await bridge.disconnectSession({ sessionId });
      if (result?.projects) {
        setProjects(result.projects);
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to disconnect Claude.');
    }
  };

  const handleOpenProject = async () => {
    if (isWebRuntime) {
      openDialog('create-project', '');
      return;
    }

    try {
      const result = await bridge.openProjectDirectory();
      if (result) {
        setProjects(result.projects);
        setSelectedSessionId(result.session.id);
        setUiError(null);
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to open project.');
    }
  };

  const handleGrantPermission = async (sessionId: string) => {
    const interaction = sessionInteractions.get(sessionId);
    const request = interaction?.permission;
    if (!request) {
      return;
    }

    updateSessionInteraction(sessionId, (s) => ({ ...s, isGrantingPermission: true }));
    try {
      if (request.requestId) {
        await bridge.respondToPermissionRequest({
          requestId: request.requestId,
          behavior: 'allow',
        });
      } else {
        const project = projects.find((p) =>
          p.dreams.some((d) => d.sessions.some((s) => s.id === sessionId)),
        );
        if (!project) {
          throw new Error('No active project available to persist this permission.');
        }

        await bridge.grantPathPermission({
          projectRoot: project.rootPath,
          targetPath: request.path,
        });
      }
      updateSessionInteraction(sessionId, (s) => ({ ...s, permission: undefined, isGrantingPermission: false }));
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to grant permission.');
      updateSessionInteraction(sessionId, (s) => ({ ...s, isGrantingPermission: false }));
    }
  };

  const handleCancelPermission = async (sessionId: string) => {
    const interaction = sessionInteractions.get(sessionId);
    const request = interaction?.permission;
    if (!request?.requestId) {
      updateSessionInteraction(sessionId, (s) => ({ ...s, permission: undefined }));
      return;
    }

    updateSessionInteraction(sessionId, (s) => ({ ...s, isGrantingPermission: true }));
    try {
      await bridge.respondToPermissionRequest({
        requestId: request.requestId,
        behavior: 'deny',
      });
      updateSessionInteraction(sessionId, (s) => ({ ...s, permission: undefined, isGrantingPermission: false }));
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to deny permission.');
      updateSessionInteraction(sessionId, (s) => ({ ...s, isGrantingPermission: false }));
    }
  };

  const handleSubmitAskUserQuestion = async (sessionId: string, draft?: AskUserQuestionDraft) => {
    const interaction = sessionInteractions.get(sessionId);
    const askQuestion = interaction?.askUserQuestion;
    if (!askQuestion) {
      return;
    }

    const response = draft
      ? buildAskUserQuestionResponsePayload(askQuestion.questions, draft)
      : {
          answers: {},
          annotations: {},
        };

    updateSessionInteraction(sessionId, (s) => ({ ...s, isSubmittingAskUserQuestion: true }));
    try {
      const mode = await bridge.respondToAskUserQuestion({
        toolUseId: askQuestion.toolUseId,
        answers: response.answers,
        annotations: response.annotations,
      });

      if (mode.mode !== 'interactive') {
        const targetSession = allSessions.find((session) => session.id === askQuestion.sessionId);
        if (!targetSession) {
          throw new Error('Unable to resume the session for the answered questions.');
        }

        const result = await bridge.sendMessage({
          sessionId: targetSession.id,
          prompt: buildAskUserQuestionFollowUpPrompt(askQuestion.questions, response),
          session: targetSession,
          references: targetSession.contextReferences ?? [],
          model: resolveRequestedModelArg(model, modelSelectionSource),
          effort,
        });

        if (result?.projects) {
          setProjects(result.projects);
        }
      }

      updateSessionInteraction(sessionId, (s) => ({
        ...s,
        askUserQuestion: undefined,
        isSubmittingAskUserQuestion: false,
      }));
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to answer Claude question.');
      updateSessionInteraction(sessionId, (s) => ({ ...s, isSubmittingAskUserQuestion: false }));
    }
  };

  const handleSubmitPlanMode = async (sessionId: string, payload: PlanModeResponsePayload) => {
    const interaction = sessionInteractions.get(sessionId);
    const planRequest = interaction?.planModeRequest;
    if (!planRequest) {
      return;
    }

    submittedPlanToolUseIds.current.add(planRequest.request.toolUseId);
    updateSessionInteraction(sessionId, (s) => ({ ...s, isSubmittingPlanMode: true }));
    try {
      const mode = await bridge.respondToPlanMode({
        toolUseId: planRequest.request.toolUseId,
        mode: payload.mode,
        selectedPromptIndex: payload.selectedPromptIndex,
        notes: payload.notes,
      });

      if (mode.mode !== 'interactive') {
        const targetSession = allSessions.find((session) => session.id === planRequest.sessionId);
        if (!targetSession) {
          throw new Error('Unable to resume the session for the plan decision.');
        }

        const result = await bridge.sendMessage({
          sessionId: targetSession.id,
          prompt: buildPlanModeFollowUpPrompt(planRequest.request, payload),
          session: targetSession,
          references: targetSession.contextReferences ?? [],
          model: resolveRequestedModelArg(model, modelSelectionSource),
          effort,
        });

        if (result?.projects) {
          setProjects(result.projects);
        }
      }

      updateSessionInteraction(sessionId, (s) => ({
        ...s,
        planModeRequest: undefined,
        isSubmittingPlanMode: false,
      }));
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to submit the plan decision.');
      updateSessionInteraction(sessionId, (s) => ({ ...s, isSubmittingPlanMode: false }));
    }
  };

  const handleCreateStreamwork = async (projectId: string, name: string) => {
    try {
      const result = await bridge.createStreamwork({
        projectId,
        name: name.trim(),
      });
      setProjects(result.projects);
      setSelectedSessionId(result.session.id);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to create streamwork.');
    }
  };

  const handleRenameEntity = async (kind: 'streamwork' | 'session', id: string, nextName: string) => {
    const defaults = {
      streamwork: {
        id,
        name: projects.flatMap((project) => project.dreams).find((dream) => dream.id === id)?.name ?? '',
        label: 'Streamwork',
      },
      session: {
        id,
        name: allSessions.find((session) => session.id === id)?.title ?? '',
        label: 'Session',
      },
    }[kind];

    if (!nextName?.trim() || nextName.trim() === defaults.name) {
      return;
    }

    try {
      const result = await bridge.renameEntity({
        kind,
        id: defaults.id,
        name: nextName.trim(),
      });
      setProjects(result.projects);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : `Failed to rename ${defaults.label.toLowerCase()}.`);
    }
  };

  const handleReorderStreamworks = async (projectId: string, sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      return;
    }

    try {
      const result = await bridge.reorderStreamworks({
        projectId,
        sourceId,
        targetId,
      });
      setProjects(result.projects);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to reorder streamworks.');
    }
  };

  const handleRequestDiff = useCallback(
    async (filePath: string): Promise<DiffPayload> => {
      if (!selectedSession) {
        throw new Error('No active session.');
      }

      return bridge.getFileDiff({ cwd: selectedSession.workspace, filePath });
    },
    [selectedSession?.workspace],
  );

  const handleBootstrapHarness = async () => {
    if (!selectedSession) {
      return;
    }

    setIsBootstrappingHarness(true);
    try {
      const result = await bridge.bootstrapHarness({
        sessionId: selectedSession.id,
      });
      setProjects(result.projects);
      setSelectedSessionId(result.rootSessionId);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to bootstrap harness.');
    } finally {
      setIsBootstrappingHarness(false);
    }
  };

  const handleRunHarness = async () => {
    if (!selectedSession) {
      return;
    }

    setIsRunningHarness(true);
    try {
      const result = await bridge.runHarness({
        sessionId: selectedSession.id,
        maxSprints: 3,
        maxContractRounds: 2,
        maxImplementationRounds: 2,
        model: resolveRequestedModelArg(model, modelSelectionSource),
        effort,
      });
      setProjects(result.projects);
      setSelectedSessionId(result.rootSessionId);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to run harness.');
    } finally {
      setIsRunningHarness(false);
    }
  };

  const handleCloseProject = async (projectId: string) => {
    try {
      const result = await bridge.closeProject({ projectId });
      setProjects(result.projects);
      const nextSession = flattenVisibleSessions(result.projects)[0];
      if (nextSession) {
        setSelectedSessionId(nextSession.id);
      }
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to close project.');
    }
  };

  const handleDeleteStreamwork = async (streamworkId: string) => {
    try {
      const result = await bridge.deleteStreamwork({ streamworkId });
      setProjects(result.projects);
      const nextSession = flattenVisibleSessions(result.projects)[0];
      if (nextSession) {
        setSelectedSessionId(nextSession.id);
      }
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to delete streamwork.');
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      const result = await bridge.deleteSession({ sessionId });
      setProjects(result.projects);
      clearSessionInteraction(sessionId);
      const nextSession = flattenVisibleSessions(result.projects)[0];
      if (nextSession) {
        setSelectedSessionId(nextSession.id);
      }
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to delete session.');
    }
  };

  const handleCopySessionReference = async (sessionId: string) => {
    try {
      await bridge.writeClipboardText(`[[session:${sessionId}]]`);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to copy session reference.');
    }
  };

  const handleSubmitDialog = async () => {
    if (!dialogState) {
      return;
    }

    const name = dialogState.fields.name?.trim() ?? '';
    const rootPath = dialogState.fields.rootPath?.trim() ?? '';
    const requiresName =
      dialogState.kind === 'create-streamwork' || dialogState.kind === 'create-session';

    if (requiresName && !name) {
      setUiError('Please complete the required fields.');
      return;
    }

    if (dialogState.kind === 'create-project' && !rootPath) {
      setUiError('Please provide a project root path.');
      return;
    }

    setIsDialogBusy(true);
    setUiError(null);

    try {
      if (dialogState.kind === 'create-project') {
        const fallbackName =
          name || rootPath.split(/[\\/]/).filter(Boolean).at(-1) || 'Project';
        const result = await bridge.createProject({
          name: fallbackName,
          rootPath,
        });
        setProjects(result.projects);
        setSelectedSessionId(result.session.id);
      } else if (dialogState.kind === 'create-streamwork') {
        await handleCreateStreamwork(dialogState.targetId, name);
      } else if (dialogState.kind === 'create-session') {
        const result = await bridge.createSessionInStreamwork({
          streamworkId: dialogState.targetId,
          name,
          includeStreamworkSummary: Boolean(dialogState.toggles.includeStreamworkSummary),
        });
        setProjects(result.projects);
        setSelectedSessionId(result.session.id);
      } else if (dialogState.kind === 'close-project') {
        await handleCloseProject(dialogState.targetId);
      } else if (dialogState.kind === 'delete-streamwork') {
        await handleDeleteStreamwork(dialogState.targetId);
      } else if (dialogState.kind === 'delete-session') {
        await handleDeleteSession(dialogState.targetId);
      }

      setDialogState(null);
    } finally {
      setIsDialogBusy(false);
    }
  };

  const dialogTitle =
    dialogState?.kind === 'create-project'
      ? 'Connect Project'
      : dialogState?.kind === 'create-streamwork'
      ? 'Create Streamwork'
      : dialogState?.kind === 'create-session'
          ? 'Create Session'
          : dialogState?.kind === 'close-project'
            ? 'Close Project'
            : dialogState?.kind === 'delete-streamwork'
              ? 'Delete Streamwork'
              : dialogState?.kind === 'delete-session'
                ? 'Delete Session'
          : '';

  const dialogDescription =
    dialogState?.kind === 'create-project'
      ? 'Web mode cannot open the native folder picker. Enter a project path that the server machine can access.'
      : dialogState?.kind === 'close-project'
      ? 'This will close the project and stop all running Claude conversations under it.'
      : dialogState?.kind === 'delete-streamwork'
        ? 'This will permanently delete this streamwork and all its session history.'
        : dialogState?.kind === 'delete-session'
          ? 'This will permanently delete this session history.'
          : undefined;

  const dialogConfirmLabel =
    dialogState?.kind === 'create-project'
      ? 'Connect'
      : dialogState?.kind === 'close-project'
      ? 'Close'
      : dialogState?.kind === 'delete-streamwork' || dialogState?.kind === 'delete-session'
        ? 'Delete'
        : 'Save';

  const dialogFields = dialogState
    ? Object.entries(dialogState.fields).map(([key, value]) => {
        if (dialogState.kind === 'create-project' && key === 'rootPath') {
          return {
            key,
            value,
            label: 'Root Path',
            placeholder: 'D:\\repo or /srv/repo',
          };
        }

        return {
          key,
          value,
          label: key === 'name' ? 'Name' : key,
          placeholder: key === 'name' ? 'Enter name' : 'Enter value',
        };
      })
    : [];
  const dialogToggles =
    dialogState?.kind === 'create-session'
      ? [
          {
            key: 'includeStreamworkSummary',
            checked: Boolean(dialogState.toggles.includeStreamworkSummary),
            label: 'Inject streamwork history summary',
            description: 'Only inject summaries of previous sessions in this streamwork for the new session.',
          },
        ]
      : [];

  const hasActiveSession = Boolean(selectedSession && selectedProject && selectedStreamwork);
  const canBootstrapHarness = Boolean(
    selectedSession &&
      selectedSession.sessionKind !== 'harness' &&
      selectedSession.sessionKind !== 'harness_role' &&
      (selectedSession.messages ?? []).some(
        (message) => (message.role === 'user' || message.role === 'assistant') && message.content.trim(),
      ),
  );
  const canRunHarness = Boolean(
    selectedSession?.sessionKind === 'harness' &&
      selectedSession.harnessState,
  );
  const shellStyle = isMobileLayout
    ? undefined
    : { gridTemplateColumns: `${leftPaneWidth}px 8px minmax(0, 1fr) 340px` };

  return (
    <div
      className={`desktop-shell${isResizingPane ? ' resizing' : ''}${isMobileLayout ? ' mobile-layout' : ''}`}
      style={shellStyle}
    >
      {isMobileLayout ? (
        <nav className="mobile-shell-nav" aria-label="Mobile sections">
          <button
            type="button"
            className={`mobile-shell-tab${mobilePanel === 'history' ? ' active' : ''}`}
            onClick={() => setMobilePanel('history')}
          >
            History
          </button>
          <button
            type="button"
            className={`mobile-shell-tab${mobilePanel === 'session' ? ' active' : ''}`}
            onClick={() => setMobilePanel('session')}
          >
            Session
          </button>
          <button
            type="button"
            className={`mobile-shell-tab${mobilePanel === 'context' ? ' active' : ''}`}
            onClick={() => setMobilePanel('context')}
            disabled={!hasActiveSession}
          >
            Context
          </button>
        </nav>
      ) : null}

      {!isMobileLayout || mobilePanel === 'history' ? (
        <ChatHistory
          projects={projects}
          selectedSessionId={selectedSession?.id ?? selectedSessionId}
          sessionIndicators={sessionIndicators}
          onOpenProject={() => {
            void handleOpenProject();
          }}
          onCreateStreamwork={(projectId) => openDialog('create-streamwork', projectId)}
          onCreateSession={(streamworkId) => openDialog('create-session', streamworkId)}
          onRenameStreamwork={(streamworkId, name) => {
            void handleRenameEntity('streamwork', streamworkId, name);
          }}
          onRenameSession={(sessionId, name) => {
            void handleRenameEntity('session', sessionId, name);
          }}
          onCloseProject={(projectId) => openDialog('close-project', projectId)}
          onDeleteStreamwork={(streamworkId) => openDialog('delete-streamwork', streamworkId)}
          onDeleteSession={(sessionId) => openDialog('delete-session', sessionId)}
          onCopySessionReference={(sessionId) => {
            void handleCopySessionReference(sessionId);
          }}
          onReorderStreamworks={(projectId, sourceId, targetId) => {
            void handleReorderStreamworks(projectId, sourceId, targetId);
          }}
          onSelectSession={(session) => {
            setSelectedSessionId(session.id);
            setUnreadSessionIds((current) => current.filter((sessionId) => sessionId !== session.id));
            setDraft('');
            clearAttachments();
            if (isMobileLayout) {
              setMobilePanel('session');
            }
          }}
        />
      ) : null}

      {!isMobileLayout ? (
        <div
          className="pane-resizer"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={() => setIsResizingPane(true)}
        />
      ) : null}

      {hasActiveSession ? (
        <>
          {!isMobileLayout || mobilePanel === 'session' ? (
            <main className="conversation-layout">
              {uiError ? <div className="ui-error-banner">{uiError}</div> : null}
              {selectedSession.sessionKind === 'harness' ? (
                <HarnessDashboard
                  session={selectedSession}
                  plannerSession={harnessPlannerSession}
                  generatorSession={harnessGeneratorSession}
                  evaluatorSession={harnessEvaluatorSession}
                  roleInteractions={sessionInteractions}
                  onRunHarness={() => {
                    void handleRunHarness();
                  }}
                  canRunHarness={canRunHarness}
                  isRunningHarness={isRunningHarness}
                  model={model}
                  effort={effort}
                  slashCommands={slashCommands}
                  isWebRuntime={isWebRuntime}
                  onRequestDiff={handleRequestDiff}
                  onRequestPermission={(sid, targetPath, sensitive) =>
                    updateSessionInteraction(sid, (s) => ({
                      ...s,
                      permission: { path: targetPath, sensitive, sessionId: sid },
                    }))
                  }
                  onSendRoleMessage={(sid, prompt) => {
                    void (async () => {
                      try {
                        const roleSession = allSessions.find((s) => s.id === sid);
                        if (!roleSession) {
                          return;
                        }
                        updateSessionInteraction(sid, (state) => clearSessionBackgroundTasks(state));
                        const result = await bridge.sendMessage({
                          sessionId: sid,
                          prompt,
                          attachments: [],
                          session: roleSession,
                          references: roleSession.contextReferences ?? [],
                          model: resolveRequestedModelArg(model, modelSelectionSource),
                          effort,
                        });
                        if (result?.projects) {
                          setProjects(result.projects);
                        }
                      } catch (error) {
                        setUiError(error instanceof Error ? error.message : 'Failed to send message.');
                      }
                    })();
                  }}
                  onStopRole={(sid) => {
                    void (async () => {
                      try {
                        const result = await bridge.stopSessionRun({ sessionId: sid });
                        if (result?.projects) {
                          setProjects(result.projects);
                        }
                      } catch (error) {
                        setUiError(error instanceof Error ? error.message : 'Failed to stop session.');
                      }
                    })();
                  }}
                  onDisconnectRole={(sid) => {
                    void handleDisconnect(sid);
                  }}
                  onGrantPermission={(sid) => {
                    void handleGrantPermission(sid);
                  }}
                  onDenyPermission={(sid) => {
                    void handleCancelPermission(sid);
                  }}
                  onSubmitAskUserQuestion={(sid, d) => {
                    void handleSubmitAskUserQuestion(sid, d);
                  }}
                  onSubmitPlanMode={(sid, payload) => {
                    void handleSubmitPlanMode(sid, payload);
                  }}
                />
              ) : (
                <ChatThread
                  session={selectedSession}
                  messages={selectedSession.messages ?? []}
                  isCliOnline={canDisconnectSelectedSession}
                  onDisconnect={() => {
                    void handleDisconnect(selectedSession.id);
                  }}
                  onRequestDiff={handleRequestDiff}
                  onRequestPermission={(request) =>
                    updateSessionInteraction(selectedSession.id, (state) => ({
                      ...state,
                      permission: {
                        path: request.targetPath,
                        sensitive: request.sensitive,
                        sessionId: selectedSession.id,
                      },
                    }))
                  }
                  interaction={sessionInteractions.get(selectedSession.id)}
                  onGrantPermission={() => {
                    void handleGrantPermission(selectedSession.id);
                  }}
                  onDenyPermission={() => {
                    void handleCancelPermission(selectedSession.id);
                  }}
                  onSubmitAskUserQuestion={(draft) => {
                    void handleSubmitAskUserQuestion(selectedSession.id, draft);
                  }}
                  onSubmitPlanMode={(payload) => {
                    void handleSubmitPlanMode(selectedSession.id, payload);
                  }}
                />
              )}
              {selectedSession.sessionKind !== 'harness' ? (
                <BtwPanel
                  isOpen={btwState.isOpen}
                  draft={btwState.draft}
                  messages={btwState.messages}
                  isSending={btwState.isSending}
                  tokenUsage={btwState.tokenUsage}
                  inheritedContext={btwState.inheritedContext}
                  onDraftChange={(value) =>
                    setBtwState((current) => ({
                      ...current,
                      draft: value,
                    }))
                  }
                  onSend={() => {
                    void handleSendBtwMessage();
                  }}
                  onClose={() => {
                    void handleCloseBtw();
                  }}
                />
              ) : null}
              {selectedSession.sessionKind !== 'harness' ? (
                <ChatComposer
                  draft={draft}
                  tokenUsage={selectedSession.tokenUsage}
                  sessionModel={selectedSession.model}
                  contextReferences={displayContextReferences}
                  slashCommands={slashCommands}
                  attachments={attachments}
                  isSending={isSending}
                  isResponding={isSelectedSessionResponding}
                  allowSendWhileResponding={hasActiveSelectedBackgroundTasks}
                  model={model}
                  effort={effort}
                  appliedEffort={selectedInteraction?.runtime?.appliedEffort}
                  notice={composerNotice}
                  supportsPathDrop={!isWebRuntime}
                  onDraftChange={handleDraftChange}
                  onModelChange={(value) => {
                    setModel(value);
                    setModelSelectionSource('explicit');
                  }}
                  onEffortChange={(value) => {
                    setEffort(value);
                    setComposerNotice(
                      `Thinking changed to ${value}. Claude effort takes effect after the session restarts.`,
                    );
                  }}
                  onUpdateContextReferenceMode={(referenceId, mode) => {
                    handleUpdateContextReferences(
                      displayContextReferences.map((reference) =>
                        reference.id === referenceId
                          ? {
                              ...reference,
                              mode,
                            }
                          : reference,
                      ),
                    );
                  }}
                  onRemoveContextReference={(referenceId) => {
                    handleUpdateContextReferences(
                      displayContextReferences.filter((reference) => reference.id !== referenceId),
                    );
                  }}
                  onInsertDroppedPaths={handleInsertDroppedPaths}
                  onAttachFiles={(files) => {
                    void handleAttachFiles(files);
                  }}
                  onRemoveAttachment={handleRemoveAttachment}
                  onSend={() => {
                    void handleSend();
                  }}
                  onStop={() => {
                    void handleStop();
                  }}
                />
              ) : null}
            </main>
          ) : null}

          {!isMobileLayout || mobilePanel === 'context' ? (
            <ContextPanel
              session={selectedSession}
              messages={selectedSession.messages ?? []}
              interaction={selectedInteraction}
              requestedEffort={effort}
              appVersion={appVersion}
              gitSnapshot={gitSnapshot}
              onRequestDiff={handleRequestDiff}
              onBootstrapHarness={() => {
                void handleBootstrapHarness();
              }}
              onRunHarness={() => {
                void handleRunHarness();
              }}
              canBootstrapHarness={canBootstrapHarness}
              canRunHarness={canRunHarness}
              isBootstrappingHarness={isBootstrappingHarness}
              isRunningHarness={isRunningHarness}
            />
          ) : null}
        </>
      ) : (
        <>
          {!isMobileLayout || mobilePanel !== 'history' ? (
            <main className="conversation-layout empty-state-panel">
              {uiError ? <div className="ui-error-banner">{uiError}</div> : null}
              <section className="empty-state-card">
                <p className="empty-state-kicker">Workspace</p>
                <h1>{isWebRuntime ? 'No connected project' : 'No open project'}</h1>
                <p>
                  {isWebRuntime
                    ? 'Connect a server-accessible project path from the history panel to start using the web app.'
                    : 'Open a project folder from the left panel to restore the workspace.'}
                </p>
              </section>
            </main>
          ) : null}
          {!isMobileLayout ? <aside className="empty-side-panel" /> : null}
        </>
      )}

      <ManageDialog
        open={Boolean(dialogState)}
        title={dialogTitle}
        description={dialogDescription}
        fields={dialogFields}
        toggles={dialogToggles}
        confirmLabel={dialogConfirmLabel}
        busy={isDialogBusy}
        onChange={(key, value) =>
          setDialogState((current) =>
            current
              ? {
                  ...current,
                  fields: {
                    ...current.fields,
                    [key]: value,
                  },
                }
              : current,
          )
        }
        onToggleChange={(key, checked) =>
          setDialogState((current) =>
            current
              ? {
                  ...current,
                  toggles: {
                    ...current.toggles,
                    [key]: checked,
                  },
                }
              : current,
          )
        }
        onCancel={() => setDialogState(null)}
        onSubmit={() => {
          void handleSubmitDialog();
        }}
      />
    </div>
  );
}
