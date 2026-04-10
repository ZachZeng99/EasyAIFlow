const { contextBridge, ipcRenderer, webUtils } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('easyAIFlow', {
  runtime: 'desktop',
  writeClipboardText: (value: string) => ipcRenderer.invoke('clipboard:write-text', value),
  getAppMeta: () => ipcRenderer.invoke('app:meta'),
  getGitSnapshot: (cwd: string) => ipcRenderer.invoke('git:snapshot', cwd),
  getSlashCommands: (payload: { cwd: string; model?: string }) => ipcRenderer.invoke('claude:list-slash-commands', payload),
  sendBtwMessage: (payload: {
    sessionId?: string;
    cwd: string;
    prompt: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
    baseClaudeSessionId?: string;
  }) => ipcRenderer.invoke('claude:btw-message', payload),
  discardBtwSession: (payload: { cwd: string; claudeSessionId?: string }) => ipcRenderer.invoke('claude:btw-discard', payload),
  getFileDiff: (payload: { cwd: string; filePath: string }) => ipcRenderer.invoke('git:file-diff', payload),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getProjects: () => ipcRenderer.invoke('sessions:bootstrap'),
  getSessionRecord: (payload: { sessionId: string }) => ipcRenderer.invoke('sessions:get-record', payload),
  grantPathPermission: (payload: { projectRoot: string; targetPath: string }) =>
    ipcRenderer.invoke('permissions:grant-path', payload),
  respondToPermissionRequest: (payload: { requestId: string; behavior: 'allow' | 'deny' }) =>
    ipcRenderer.invoke('permissions:respond', payload),
  respondToPlanModeRequest: (payload: {
    requestId: string;
    behavior: 'allow' | 'deny';
    choice?: 'clear-auto' | 'auto' | 'manual' | 'revise';
    notes?: string;
  }) =>
    ipcRenderer.invoke('plan-mode:respond', payload),
  respondToAskUserQuestion: (payload: {
    toolUseId: string;
    answers: Record<string, string>;
    annotations?: Record<string, { notes?: string }>;
  }) => ipcRenderer.invoke('ask-user-question:respond', payload),
  respondToPlanMode: (payload: {
    toolUseId: string;
    mode: import('../src/data/planMode.js').PlanModeResponsePayload['mode'];
    selectedPromptIndex?: number;
    notes?: string;
  }) => ipcRenderer.invoke('plan-mode:respond', payload),
  openProjectDirectory: () => ipcRenderer.invoke('projects:open-directory'),
  closeProject: (payload: { projectId: string }) => ipcRenderer.invoke('projects:close', payload),
  createProject: (payload: { name: string; rootPath: string }) => ipcRenderer.invoke('projects:create', payload),
  createStreamwork: (payload: { projectId: string; name: string }) => ipcRenderer.invoke('streamworks:create', payload),
  deleteStreamwork: (payload: { streamworkId: string }) => ipcRenderer.invoke('streamworks:delete', payload),
  reorderStreamworks: (payload: { projectId: string; sourceId: string; targetId: string }) =>
    ipcRenderer.invoke('streamworks:reorder', payload),
  createSessionInStreamwork: (payload: {
    streamworkId: string;
    name?: string;
    includeStreamworkSummary?: boolean;
  }) =>
    ipcRenderer.invoke('sessions:create-in-streamwork', payload),
  bootstrapHarness: (payload: { sessionId: string }) => ipcRenderer.invoke('sessions:bootstrap-harness', payload),
  runHarness: (payload: {
    sessionId: string;
    maxSprints?: number;
    maxContractRounds?: number;
    maxImplementationRounds?: number;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }) => ipcRenderer.invoke('sessions:run-harness', payload),
  createSession: (payload?: { sourceSessionId?: string; includeStreamworkSummary?: boolean }) =>
    ipcRenderer.invoke('sessions:create', payload),
  deleteSession: (payload: { sessionId: string }) => ipcRenderer.invoke('sessions:delete', payload),
  updateSessionContextReferences: (payload: {
    sessionId: string;
    references: import('../src/data/types.js').ContextReference[];
  }) => ipcRenderer.invoke('sessions:update-context-references', payload),
  renameEntity: (payload: { kind: 'project' | 'streamwork' | 'session'; id: string; name: string }) =>
    ipcRenderer.invoke('entities:rename', payload),
  sendMessage: (payload: {
    sessionId: string;
    prompt: string;
    attachments?: import('../src/data/types.js').PendingAttachment[];
    session?: import('../src/data/types.js').SessionSummary;
    references?: import('../src/data/types.js').ContextReference[];
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'max';
  }) =>
    ipcRenderer.invoke('claude:send-message', payload),
  stopSessionRun: (payload: { sessionId: string }) => ipcRenderer.invoke('claude:stop-session', payload),
  disconnectSession: (payload: { sessionId: string }) => ipcRenderer.invoke('claude:disconnect-session', payload),
  onClaudeEvent: (listener: (event: import('../src/data/types.js').ClaudeStreamEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: import('../src/data/types.js').ClaudeStreamEvent) =>
      listener(payload);
    ipcRenderer.on('claude:event', handler);
    return () => {
      ipcRenderer.removeListener('claude:event', handler);
    };
  },
});
