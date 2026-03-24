import type {
  BtwResponse,
  ClaudeStreamEvent,
  CloseProjectResult,
  ContextReference,
  DeleteEntityResult,
  DiffPayload,
  PendingAttachment,
  ProjectOpenResult,
  ProjectCreateResult,
  ProjectRecord,
  RenameEntityResult,
  SessionCreateResult,
  SessionContextUpdateResult,
  SessionSummary,
  StreamworkCreateResult,
} from './data/types';

export {};

declare global {
  interface Window {
    easyAIFlow?: {
      writeClipboardText: (value: string) => Promise<void>;
      getAppMeta: () => Promise<{
        name: string;
        version: string;
        platform: string;
        defaultModel?: string;
      }>;
      getGitSnapshot: (cwd: string) => Promise<{
        branch: string;
        tracking?: string;
        ahead: number;
        behind: number;
        dirty: boolean;
        changedFiles: Array<{
          path: string;
          status: string;
          additions: number;
          deletions: number;
        }>;
        rootPath?: string;
        source: 'git' | 'mock';
      } | null>;
      getSlashCommands: (payload: { cwd: string; model?: string }) => Promise<{
        commands: string[];
      }>;
      sendBtwMessage: (payload: {
        sessionId?: string;
        cwd: string;
        prompt: string;
        model?: string;
        effort?: 'low' | 'medium' | 'high' | 'max';
        claudeSessionId?: string;
        baseClaudeSessionId?: string;
      }) => Promise<BtwResponse>;
      discardBtwSession: (payload: { cwd: string; claudeSessionId?: string }) => Promise<void>;
      getFileDiff: (payload: { cwd: string; filePath: string }) => Promise<DiffPayload>;
      getPathForFile: (file: File) => string;
      getProjects: () => Promise<{
        projects: ProjectRecord[];
      }>;
      grantPathPermission: (payload: { projectRoot: string; targetPath: string }) => Promise<void>;
      respondToPermissionRequest: (payload: {
        requestId: string;
        behavior: 'allow' | 'deny';
      }) => Promise<{
        mode: 'interactive' | 'fallback' | 'missing';
      }>;
      openProjectDirectory: () => Promise<ProjectOpenResult | null>;
      closeProject: (payload: { projectId: string }) => Promise<CloseProjectResult>;
      createProject: (payload: { name: string; rootPath: string }) => Promise<ProjectCreateResult>;
      createStreamwork: (payload: { projectId: string; name: string }) => Promise<StreamworkCreateResult>;
      deleteStreamwork: (payload: { streamworkId: string }) => Promise<DeleteEntityResult>;
      reorderStreamworks: (payload: { projectId: string; sourceId: string; targetId: string }) => Promise<RenameEntityResult>;
      createSessionInStreamwork: (payload: {
        streamworkId: string;
        name?: string;
        includeStreamworkSummary?: boolean;
      }) => Promise<SessionCreateResult>;
      createSession: (payload?: {
        sourceSessionId?: string;
        includeStreamworkSummary?: boolean;
      }) => Promise<SessionCreateResult>;
      deleteSession: (payload: { sessionId: string }) => Promise<DeleteEntityResult>;
      updateSessionContextReferences: (payload: {
        sessionId: string;
        references: ContextReference[];
      }) => Promise<SessionContextUpdateResult>;
      renameEntity: (payload: { kind: 'project' | 'streamwork' | 'session'; id: string; name: string }) => Promise<RenameEntityResult>;
      sendMessage: (payload: {
        sessionId: string;
        prompt: string;
        attachments?: PendingAttachment[];
        session?: SessionSummary;
        references?: ContextReference[];
        model?: string;
        effort?: 'low' | 'medium' | 'high' | 'max';
      }) => Promise<{
        projects: ProjectRecord[];
        queued: {
          sessionId: string;
          userMessageId: string;
          assistantMessageId: string;
        };
      }>;
      onClaudeEvent: (listener: (event: ClaudeStreamEvent) => void) => () => void;
    };
  }
}
