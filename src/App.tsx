import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BtwPanel, type BtwMessage } from './components/BtwPanel';
import { ChatComposer, type ComposerAttachment } from './components/ChatComposer';
import { ChatHistory } from './components/ChatHistory';
import { ManageDialog } from './components/ManageDialog';
import { PermissionDialog } from './components/PermissionDialog';
import { ChatThread } from './components/ChatThread';
import { ContextPanel } from './components/ContextPanel';
import { projectTree } from './data/mockSessions';
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

    if (event.type === 'permission-request') {
      return session;
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

type DialogKind = 'create-streamwork' | 'create-session' | 'close-project' | 'delete-streamwork' | 'delete-session';

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
  claudeSessionId?: string;
  tokenUsage?: BtwResponse['tokenUsage'];
  inheritedContext: boolean;
  messages: BtwMessage[];
};

type SessionIndicator = {
  state: SessionActivityState;
};

type ActivePermissionRequest = {
  path: string;
  sensitive: boolean;
  requestId?: string;
  sessionId?: string;
};

export default function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>(projectTree);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [draft, setDraft] = useState('');
  const [appVersion, setAppVersion] = useState('desktop');
  const [isSending, setIsSending] = useState(false);
  const [model, setModel] = useState('opus[1m]');
  const [modelSelectionSource, setModelSelectionSource] = useState<ModelSelectionSource>('implicit');
  const [effort, setEffort] = useState<'low' | 'medium' | 'high' | 'max'>('high');
  const [isResizingPane, setIsResizingPane] = useState(false);
  const [leftPaneWidth, setLeftPaneWidth] = useState(338);
  const [isDialogBusy, setIsDialogBusy] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<DialogState | null>(null);
  const [permissionRequest, setPermissionRequest] = useState<ActivePermissionRequest | null>(null);
  const [isGrantingPermission, setIsGrantingPermission] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
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
  const selectedSession = useMemo(
    () => allSessions.find((session) => session.id === selectedSessionId) ?? allSessions[0],
    [allSessions, selectedSessionId],
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
  const sessionIndicators = useMemo<Record<string, SessionIndicator>>(
    () =>
      Object.fromEntries(
        allSessions.map((session) => {
          const lastAssistant = findLastAssistantMessage(session);
          const isResponding = isAssistantPendingStatus(lastAssistant?.status);
          const hasUnread = unreadSessionIds.includes(session.id);

          if (isResponding) {
            return [session.id, { state: 'responding' }];
          }

          if (hasUnread) {
            return [session.id, { state: 'unread' }];
          }

          return [session.id, { state: 'idle' }];
        }),
      ),
    [allSessions, unreadSessionIds],
  );

  const getBridge = () => {
    if (!window.easyAIFlow) {
      throw new Error('EasyAIFlow desktop bridge is unavailable. Please run inside the Electron app.');
    }

    return window.easyAIFlow;
  };

  const getOriginalFilePath = (file: File) => {
    try {
      const candidate = getBridge().getPathForFile(file);
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
    if (allSessions.length === 0) {
      if (selectedSessionId) {
        setSelectedSessionId('');
      }
      return;
    }

    if (!selectedSessionId || !allSessions.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(allSessions[0].id);
    }
  }, [allSessions, selectedSessionId]);

  useEffect(() => {
    const loadMeta = async () => {
      try {
        const bridge = getBridge();
        const [meta, bootstrap] = await Promise.all([bridge.getAppMeta(), bridge.getProjects()]);

        if (meta?.version) {
          setAppVersion(meta.version);
        }
        if (meta?.defaultModel) {
          setModel(meta.defaultModel);
          setModelSelectionSource('implicit');
        }

        if (bootstrap?.projects?.length) {
          setProjects(bootstrap.projects);
          const firstSession = flattenSessions(bootstrap.projects)[0];
          if (firstSession) {
            setSelectedSessionId((current) => current || firstSession.id);
          }
        }
      } catch (error) {
        setUiError(error instanceof Error ? error.message : 'Failed to initialize EasyAIFlow.');
      }
    };

    void loadMeta();
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = getBridge().onClaudeEvent((event) => {
        setProjects((current) => applyClaudeEvent(current, event));
        if (event.type === 'permission-request') {
          setPermissionRequest({
            path: event.targetPath ?? event.command ?? event.description ?? event.toolName,
            sensitive: event.sensitive,
            requestId: event.requestId,
            sessionId: event.sessionId,
          });
        }
        if (event.type === 'trace' && event.message.status === 'error') {
          const request = parsePermissionRequest(event.message.content);
          if (request) {
            setPermissionRequest({
              path: request.targetPath,
              sensitive: request.sensitive,
            });
          }
        }
        if (event.type === 'complete') {
          playReplyCompleteTone();
        }
        if (event.sessionId !== selectedSessionId && (event.type === 'complete' || event.type === 'error')) {
          setUnreadSessionIds((current) =>
            current.includes(event.sessionId) ? current : [...current, event.sessionId],
          );
        }
      });
    } catch {
      unsubscribe = undefined;
    }

    return () => {
      unsubscribe?.();
    };
  }, [playReplyCompleteTone, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) {
      return;
    }

    setUnreadSessionIds((current) => current.filter((sessionId) => sessionId !== selectedSessionId));
  }, [selectedSessionId]);

  useEffect(() => {
    const validSessionIds = new Set(allSessions.map((session) => session.id));
    setUnreadSessionIds((current) => current.filter((sessionId) => validSessionIds.has(sessionId)));
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
      const liveSnapshot = await getBridge().getGitSnapshot(selectedSession.workspace);
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
    void getBridge()
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
    const result = await getBridge().updateSessionContextReferences({
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

    const outgoingPrompt = prompt || 'Please inspect the attached files and describe anything relevant.';
    const pendingAttachments: PendingAttachment[] = attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      path: attachment.path,
      dataUrl: attachment.dataUrl,
    }));

    try {
      const result = await getBridge().sendMessage({
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

      if (displayContextReferences.length > 0) {
        await getBridge().updateSessionContextReferences({
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
      setProjects((current) =>
        updateSessionInProjects(current, selectedSession.id, (session) => ({
          ...session,
          messages: [
            ...(session.messages ?? []),
            {
              id: `local-error-${Date.now()}`,
              role: 'assistant',
              timestamp: new Date().toLocaleString('zh-CN'),
              title: 'Claude error',
              content: message,
              status: 'error',
            },
          ],
        })),
      );
    } finally {
      setIsSending(false);
    }
  };

  const handleSendBtwMessage = async (overridePrompt?: string) => {
    if (!selectedSession) {
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
      const result = await getBridge().sendBtwMessage({
        sessionId: selectedSession.id,
        cwd: selectedSession.workspace,
        prompt,
        model: resolveRequestedModelArg(model, modelSelectionSource),
        effort,
        claudeSessionId: btwState.claudeSessionId,
        baseClaudeSessionId: btwState.claudeSessionId ? undefined : selectedSession.claudeSessionId,
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
        claudeSessionId: result.claudeSessionId ?? current.claudeSessionId,
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

  const handleCloseBtw = async () => {
    if (!selectedSession) {
      return;
    }

    const claudeSessionId = btwState.claudeSessionId;
    const cwd = selectedSession.workspace;
    setBtwState({
      isOpen: false,
      draft: '',
      isSending: false,
      inheritedContext: false,
      messages: [],
    });
    try {
      await getBridge().discardBtwSession({ cwd, claudeSessionId });
    } catch {
      // Ignore cleanup failures for ephemeral BTW sessions.
    }
  };

  const handleOpenProject = async () => {
    try {
      const result = await getBridge().openProjectDirectory();
      if (result) {
        setProjects(result.projects);
        setSelectedSessionId(result.session.id);
        setUiError(null);
      }
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to open project.');
    }
  };

  const handleGrantPermission = async () => {
    if (!permissionRequest) {
      return;
    }

    setIsGrantingPermission(true);
    try {
      if (permissionRequest.requestId) {
        await getBridge().respondToPermissionRequest({
          requestId: permissionRequest.requestId,
          behavior: 'allow',
        });
      } else {
        if (!selectedProject) {
          throw new Error('No active project available to persist this permission.');
        }

        await getBridge().grantPathPermission({
          projectRoot: selectedProject.rootPath,
          targetPath: permissionRequest.path,
        });
      }
      setPermissionRequest(null);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to grant permission.');
    } finally {
      setIsGrantingPermission(false);
    }
  };

  const handleCancelPermission = async () => {
    if (!permissionRequest?.requestId) {
      setPermissionRequest(null);
      return;
    }

    setIsGrantingPermission(true);
    try {
      await getBridge().respondToPermissionRequest({
        requestId: permissionRequest.requestId,
        behavior: 'deny',
      });
      setPermissionRequest(null);
      setUiError(null);
    } catch (error) {
      setUiError(error instanceof Error ? error.message : 'Failed to deny permission.');
    } finally {
      setIsGrantingPermission(false);
    }
  };

  const handleCreateStreamwork = async (projectId: string, name: string) => {
    try {
      const result = await getBridge().createStreamwork({
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
      const result = await getBridge().renameEntity({
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
      const result = await getBridge().reorderStreamworks({
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

      return getBridge().getFileDiff({ cwd: selectedSession.workspace, filePath });
    },
    [selectedSession?.workspace],
  );

  const handleCloseProject = async (projectId: string) => {
    try {
      const result = await getBridge().closeProject({ projectId });
      setProjects(result.projects);
      const nextSession = flattenSessions(result.projects)[0];
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
      const result = await getBridge().deleteStreamwork({ streamworkId });
      setProjects(result.projects);
      const nextSession = flattenSessions(result.projects)[0];
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
      const result = await getBridge().deleteSession({ sessionId });
      setProjects(result.projects);
      const nextSession = flattenSessions(result.projects)[0];
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
      await getBridge().writeClipboardText(`[[session:${sessionId}]]`);
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
    const requiresName = dialogState.kind === 'create-streamwork' || dialogState.kind === 'create-session';

    if (requiresName && !name) {
      setUiError('Please complete the required fields.');
      return;
    }

    setIsDialogBusy(true);
    setUiError(null);

    try {
      if (dialogState.kind === 'create-streamwork') {
        await handleCreateStreamwork(dialogState.targetId, name);
      } else if (dialogState.kind === 'create-session') {
        const result = await getBridge().createSessionInStreamwork({
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
    dialogState?.kind === 'create-streamwork'
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
    dialogState?.kind === 'close-project'
      ? 'This will close the project and stop all running Claude conversations under it.'
      : dialogState?.kind === 'delete-streamwork'
        ? 'This will permanently delete this streamwork and all its session history.'
        : dialogState?.kind === 'delete-session'
          ? 'This will permanently delete this session history.'
          : undefined;

  const dialogConfirmLabel =
    dialogState?.kind === 'close-project'
      ? 'Close'
      : dialogState?.kind === 'delete-streamwork' || dialogState?.kind === 'delete-session'
        ? 'Delete'
        : 'Save';

  const dialogFields = dialogState
    ? Object.entries(dialogState.fields).map(([key, value]) => ({
        key,
        value,
        label: 'Name',
        placeholder: 'Enter name',
      }))
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

  return (
    <div
      className={`desktop-shell${isResizingPane ? ' resizing' : ''}`}
      style={{ gridTemplateColumns: `${leftPaneWidth}px 8px minmax(0, 1fr) 340px` }}
    >
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
        }}
      />

      <div
        className="pane-resizer"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={() => setIsResizingPane(true)}
      />

      {hasActiveSession ? (
        <>
          <main className="conversation-layout">
            {uiError ? <div className="ui-error-banner">{uiError}</div> : null}
            <ChatThread
              session={selectedSession}
              messages={selectedSession.messages ?? []}
              onRequestDiff={handleRequestDiff}
              onRequestPermission={(request) =>
                setPermissionRequest({
                  path: request.targetPath,
                  sensitive: request.sensitive,
                })
              }
            />
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
            <ChatComposer
              draft={draft}
              tokenUsage={selectedSession.tokenUsage}
              sessionModel={selectedSession.model}
              contextReferences={displayContextReferences}
              slashCommands={slashCommands}
              attachments={attachments}
              isSending={isSending}
              model={model}
              effort={effort}
              onDraftChange={handleDraftChange}
              onModelChange={(value) => {
                setModel(value);
                setModelSelectionSource('explicit');
              }}
              onEffortChange={setEffort}
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
            />
          </main>

          <ContextPanel
            session={selectedSession}
            appVersion={appVersion}
            gitSnapshot={gitSnapshot}
            onRequestDiff={handleRequestDiff}
          />
        </>
      ) : (
        <>
          <main className="conversation-layout empty-state-panel">
            {uiError ? <div className="ui-error-banner">{uiError}</div> : null}
            <section className="empty-state-card">
              <p className="empty-state-kicker">Workspace</p>
              <h1>No open project</h1>
              <p>Open a project folder from the left panel to restore the workspace.</p>
            </section>
          </main>
          <aside className="empty-side-panel" />
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
      <PermissionDialog
        open={Boolean(permissionRequest)}
        path={permissionRequest?.path ?? ''}
        sensitive={Boolean(permissionRequest?.sensitive)}
        interactive={Boolean(permissionRequest?.requestId)}
        busy={isGrantingPermission}
        onCancel={() => {
          void handleCancelPermission();
        }}
        onGrant={() => {
          void handleGrantPermission();
        }}
      />
    </div>
  );
}
