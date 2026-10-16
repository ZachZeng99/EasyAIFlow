export const MUTATING_RPC_METHODS = new Set([
  'sendMessage', 'sendBtwMessage', 'discardBtwSession', 'switchModel', 'switchEffort',
  'stopSessionRun', 'disconnectSession', 'respondToPermissionRequest',
  'respondToPlanModeRequest', 'respondToAskUserQuestion', 'respondToPlanMode',
  'grantPathPermission', 'createProject', 'closeProject', 'createStreamwork',
  'deleteStreamwork', 'reorderStreamworks', 'createSession', 'createSessionInStreamwork',
  'deleteSession', 'setSessionPinned', 'updateSessionContextReferences', 'renameEntity',
]);

const READ_RPC_METHODS = new Set([
  'getAppMeta', 'getProjects', 'getSessionRecord', 'getSessionHistoryRevision',
  'getSessionMessagePage', 'getGitSnapshot', 'getSlashCommands', 'getFileDiff',
  'getOperationStatus', 'getDeviceStatus', 'getProviderModels', 'clipboard:write-text',
]);
export const isUiRpcMethod = (method: string) => MUTATING_RPC_METHODS.has(method) || READ_RPC_METHODS.has(method);

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

export const stripRpcMetadata = (method: string, payload: unknown) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const result = { ...payload } as Record<string, unknown>;
  delete result.operationId;
  // The service owns session state; stale renderer snapshots must not recreate
  // deleted sessions or change a retried operation's identity.
  if (['sendMessage', 'switchModel', 'switchEffort'].includes(method)) delete result.session;
  return result;
};
