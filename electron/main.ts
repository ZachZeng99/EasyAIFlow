import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopAllCodexRuns } from '../backend/codexInteraction.js';
import { configureRuntimePaths } from '../backend/runtimePaths.js';
import type { ClaudeInteractionContext } from '../backend/claudeInteractionContext.js';
import { createClaudeInteractionState } from '../backend/claudeInteractionState.js';
import { getGitSnapshot } from '../backend/claudeHelpers.js';
import {
  grantPathPermission,
  getConfiguredClaudeModel,
} from '../backend/claudeInteraction.js';
import {
  handleRespondToPermission,
  handleRespondToAskUserQuestion,
  handleRespondToPlanMode,
  handleStopSession,
  handleDisconnectSession,
  handleSendMessage,
  handleSwitchEffort,
  handleSwitchModel,
  handleBootstrapHarness,
  handleRunHarness,
  handleBtwMessage,
  handleBtwDiscard,
  handleGetAppMeta,
  handleBootstrapSessions,
  handleGetSlashCommands,
  handleCloseProject,
  handleDeleteStreamwork,
  handleDeleteSession,
} from '../backend/claudeRpcOperations.js';
import {
  bootstrapHarnessFromSession,
  createProject,
  createSession,
  createSessionInStreamwork,
  createStreamwork,
  findSession,
  renameEntity,
  reorderStreamworks,
  updateSessionContextReferences,
  flushPendingSave,
} from './sessionStore.js';
import { getFileDiff } from './fileDiff.js';
import { shouldOpenExternally } from './externalNavigation.js';
import type {
  ClaudeStreamEvent,
  ContextReference,
  PendingAttachment,
  SessionSummary,
} from '../src/data/types.js';
import type { PlanModeResponsePayload } from '../src/data/planMode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const devServerUrl = 'http://127.0.0.1:4173';

const ctx: ClaudeInteractionContext = {
  broadcastEvent: (event: ClaudeStreamEvent) => {
    BrowserWindow.getAllWindows().forEach((window) => {
      window.webContents.send('claude:event', event);
    });
  },
  attachmentRoot: () => path.join(app.getPath('userData'), 'attachments'),
  claudeSettingsPath: () => path.join(process.env.USERPROFILE ?? app.getPath('home'), '.claude', 'settings.json'),
  homePath: () => process.env.USERPROFILE ?? app.getPath('home'),
};

const state = createClaudeInteractionState();

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
  ipcMain.handle('app:meta', async () => handleGetAppMeta(ctx, app.getVersion()));
  ipcMain.handle('git:snapshot', (_event, cwd: string) => getGitSnapshot(cwd));
  ipcMain.handle('claude:list-slash-commands', async (_event, payload: { cwd: string; model?: string }) =>
    handleGetSlashCommands(ctx, state, payload),
  );
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
        baseClaudeSessionId?: string;
      },
    ) => handleBtwMessage(ctx, state, payload),
  );
  ipcMain.handle('claude:btw-discard', async (_event, payload: { cwd: string; claudeSessionId?: string }) =>
    handleBtwDiscard(ctx, state, payload),
  );
  ipcMain.handle('sessions:bootstrap', async () => handleBootstrapSessions(state));
  ipcMain.handle('sessions:get-record', async (_event, payload: { sessionId: string }) => {
    const session = await findSession(payload.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    return {
      ...session,
      messagesLoaded: true,
    };
  });
  ipcMain.handle(
    'sessions:create',
    async (
      _event,
      payload?: {
        sourceSessionId?: string;
        includeStreamworkSummary?: boolean;
        provider?: import('../src/data/types.js').SessionProvider;
      },
    ) =>
      createSession(
        payload?.sourceSessionId,
        Boolean(payload?.includeStreamworkSummary),
        payload?.provider,
      ),
  );
  ipcMain.handle(
    'sessions:create-in-streamwork',
    async (
      _event,
      payload: {
        streamworkId: string;
        name?: string;
        includeStreamworkSummary?: boolean;
        provider?: import('../src/data/types.js').SessionProvider;
      },
    ) =>
      createSessionInStreamwork(
        payload.streamworkId,
        payload.name,
        Boolean(payload.includeStreamworkSummary),
        payload.provider,
      ),
  );
  ipcMain.handle('sessions:bootstrap-harness', async (_event, payload: { sessionId: string }) =>
    handleBootstrapHarness(ctx, state, payload),
  );
  ipcMain.handle(
    'sessions:run-harness',
    async (
      _event,
      payload: {
        sessionId: string;
        maxSprints?: number;
        maxContractRounds?: number;
        maxImplementationRounds?: number;
        model?: string;
        effort?: 'low' | 'medium' | 'high' | 'max';
      },
    ) => handleRunHarness(ctx, state, payload),
  );
  ipcMain.handle('projects:create', async (_event, payload: { name: string; rootPath: string }) =>
    createProject(payload.name, payload.rootPath),
  );
  ipcMain.handle('permissions:grant-path', async (_event, payload: { projectRoot: string; targetPath: string }) => {
    await grantPathPermission(ctx, payload.projectRoot, payload.targetPath);
  });
  ipcMain.handle(
    'permissions:respond',
    async (_event, payload: { requestId: string; behavior: 'allow' | 'deny' }) =>
      handleRespondToPermission(ctx, state, payload),
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
    ) => handleRespondToAskUserQuestion(ctx, state, payload),
  );
  ipcMain.handle(
    'plan-mode:respond',
    async (
      _event,
      payload: {
        toolUseId: string;
        mode: PlanModeResponsePayload['mode'];
        selectedPromptIndex?: number;
        notes?: string;
      },
    ) => handleRespondToPlanMode(ctx, state, payload),
  );
  ipcMain.handle('projects:open-directory', async () => openProjectDirectory());
  ipcMain.handle('projects:close', async (_event, payload: { projectId: string }) =>
    handleCloseProject(ctx, state, payload),
  );
  ipcMain.handle('streamworks:create', async (_event, payload: { projectId: string; name: string }) =>
    createStreamwork(payload.projectId, payload.name),
  );
  ipcMain.handle('streamworks:delete', async (_event, payload: { streamworkId: string }) =>
    handleDeleteStreamwork(ctx, state, payload),
  );
  ipcMain.handle(
    'entities:rename',
    async (_event, payload: { kind: 'project' | 'streamwork' | 'session'; id: string; name: string }) =>
      renameEntity(payload.kind, payload.id, payload.name),
  );
  ipcMain.handle('sessions:delete', async (_event, payload: { sessionId: string }) =>
    handleDeleteSession(ctx, state, payload),
  );
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
    'claude:switch-model',
    async (
      _event,
      payload: {
        sessionId: string;
        session?: SessionSummary;
        model: string;
        effort?: 'low' | 'medium' | 'high' | 'max';
      },
    ) => handleSwitchModel(ctx, state, payload),
  );
  ipcMain.handle(
    'claude:switch-effort',
    async (
      _event,
      payload: {
        sessionId: string;
        session?: SessionSummary;
        effort: 'low' | 'medium' | 'high' | 'max';
      },
    ) => handleSwitchEffort(ctx, state, payload),
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
    ) => handleSendMessage(ctx, state, payload),
  );
  ipcMain.handle('claude:stop-session', async (_event, payload: { sessionId: string }) =>
    handleStopSession(ctx, state, payload),
  );
  ipcMain.handle('claude:disconnect-session', async (_event, payload: { sessionId: string }) =>
    handleDisconnectSession(ctx, state, payload),
  );

  await createMainWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  void flushPendingSave();
  stopAllCodexRuns();
  state.activeRuns.forEach((run) => {
    if (!run.child.killed) {
      run.child.kill();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
