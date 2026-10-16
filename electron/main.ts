import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceServiceClient } from '../backend/deviceServiceClient.js';
import { shouldOpenExternally } from './externalNavigation.js';
import { isUiRpcMethod } from '../src/data/rpcOperations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const devServerUrl = 'http://127.0.0.1:4173';
let device: DeviceServiceClient | undefined;
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
  device = new DeviceServiceClient({
    dataDirectory: process.env.EASYAIFLOW_DATA_DIR || app.getPath('userData'),
    homeDirectory: process.env.EASYAIFLOW_HOME_DIR || app.getPath('home'),
  });
  device.onEvent((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send('claude:event', event);
    }
  });
  await device.connect();
  const channels: Record<string, string> = {
    'claude:list-slash-commands': 'getSlashCommands',
    'claude:btw-message': 'sendBtwMessage',
    'claude:btw-discard': 'discardBtwSession',
    'sessions:bootstrap': 'getProjects',
    'sessions:get-record': 'getSessionRecord',
    'sessions:get-native-history-revision': 'getSessionHistoryRevision',
    'sessions:get-message-page': 'getSessionMessagePage',
    'sessions:create': 'createSession',
    'sessions:create-in-streamwork': 'createSessionInStreamwork',
    'projects:create': 'createProject',
    'permissions:grant-path': 'grantPathPermission',
    'permissions:respond': 'respondToPermissionRequest',
    'ask-user-question:respond': 'respondToAskUserQuestion',
    'plan-mode:respond': 'respondToPlanMode',
    'plan-mode:respond-request': 'respondToPlanModeRequest',
    'projects:close': 'closeProject',
    'streamworks:create': 'createStreamwork',
    'streamworks:delete': 'deleteStreamwork',
    'entities:rename': 'renameEntity',
    'sessions:delete': 'deleteSession',
    'sessions:set-pinned': 'setSessionPinned',
    'sessions:update-context-references': 'updateSessionContextReferences',
    'streamworks:reorder': 'reorderStreamworks',
    'git:file-diff': 'getFileDiff',
    'claude:switch-model': 'switchModel',
    'claude:switch-effort': 'switchEffort',
    'claude:send-message': 'sendMessage',
    'sessions:native-agents': 'getSessionNativeAgents',
    'groups:update-participants': 'updateGroupParticipants',
    'claude:stop-session': 'stopSessionRun',
    'claude:disconnect-session': 'disconnectSession',
    'device:operation-status': 'getOperationStatus',
    'device:provider-models': 'getProviderModels',
  };
  for (const [channel, method] of Object.entries(channels)) {
    ipcMain.handle(channel, (_event, payload?: { operationId?: string }) => device!.request(method, payload, payload?.operationId));
  }
  ipcMain.handle('device:rpc', (_event, input: { method: string; payload?: { operationId?: string }; deviceId?: string }) => {
    if (!input || !isUiRpcMethod(input.method)) throw new Error('Unsupported device operation.');
    return device!.request(input.method, input.payload, input.payload?.operationId, input.deviceId);
  });
  ipcMain.handle('clipboard:write-text', (_event, value: string) => clipboard.writeText(value));
  ipcMain.handle('git:snapshot', (_event, cwd: string) => device!.request('getGitSnapshot', { cwd }));
  ipcMain.handle('app:meta', async () => ({
    ...await device!.request<Record<string, unknown>>('getAppMeta'), version: app.getVersion(), platform: process.platform,
  }));
  ipcMain.handle('projects:open-directory', async () => {
    const selected = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open Project Folder' });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const rootPath = selected.filePaths[0];
    return device!.request('createProject', { rootPath, name: path.basename(rootPath) });
  });
  await createMainWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createMainWindow();
  });
}).catch((error) => {
  dialog.showErrorBox('EasyAIFlow', error instanceof Error ? error.message : String(error));
  app.quit();
});

// The daemon owns CLI processes. Quitting a client only disconnects its transport.
app.on('before-quit', () => device?.close());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
