import { randomUUID } from 'node:crypto';
import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type { CodexAppServerClient, CodexServerRequest } from './codexAppServer.js';
import { emitRuntimeState } from './codexInteraction.js';
import type { SessionPermissionRequest } from '../src/data/sessionInteraction.js';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

type PendingCodexApproval = {
  sessionId: string;
  client: CodexAppServerClient;
  rpcId: number | string;
  method: string;
  params: Record<string, unknown>;
  threadId: string;
  path: string;
};

const pendingCodexApprovals = new Map<string, PendingCodexApproval>();

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const describeFileChange = (item: Record<string, unknown> | undefined) => {
  const changes = Array.isArray(item?.changes) ? item.changes : [];
  const paths = changes
    .map((change) => (change && typeof change === 'object' ? text((change as { path?: unknown }).path) : undefined))
    .filter((value): value is string => Boolean(value));
  return paths.length > 1 ? `${paths[0]} 等 ${paths.length} 个文件` : paths[0];
};

const describePermissions = (params: Record<string, unknown>) => {
  const permissions = (params.permissions ?? {}) as {
    fileSystem?: { read?: string[]; write?: string[]; entries?: Array<{ path?: string; access?: string }> };
    network?: { enabled?: boolean };
  };
  const parts = [
    ...(permissions.fileSystem?.write ?? []).map((path) => `写入 ${path}`),
    ...(permissions.fileSystem?.read ?? []).map((path) => `读取 ${path}`),
    ...(permissions.fileSystem?.entries ?? []).map((entry) => `${entry.access ?? 'access'} ${entry.path ?? ''}`.trim()),
    ...(permissions.network?.enabled ? ['网络访问'] : []),
  ];
  return parts.join('，') || undefined;
};

const resolvePending = (ctx: ClaudeInteractionContext, requestId: string, pending: PendingCodexApproval) => {
  pendingCodexApprovals.delete(requestId);
  ctx.broadcastEvent({ type: 'interaction-resolved', sessionId: pending.sessionId, interaction: 'permission', requestId });
  if (![...pendingCodexApprovals.values()].some((item) => item.sessionId === pending.sessionId)) {
    emitRuntimeState(ctx, pending.sessionId, 'running', true);
  }
};

/** Routes approval requests for one thread to EAF's permission dialog. Returns a disposer. */
export const attachCodexApprovalHandler = (
  ctx: ClaudeInteractionContext,
  client: CodexAppServerClient,
  sessionId: string,
  getThreadId: () => string,
  getItem: (itemId: string) => Record<string, unknown> | undefined,
) => {
  // Notifications reach turn state through an async queue; keep file changes synchronously.
  const fileChangeItems = new Map<string, Record<string, unknown>>();
  const handler = (request: CodexServerRequest) => {
    if (!APPROVAL_METHODS.has(request.method)) return false;
    const threadId = text(request.params.threadId);
    if (!threadId || threadId !== getThreadId()) return false;

    const requestId = `codex-${randomUUID()}`;
    const itemId = text(request.params.itemId);
    const reason = text(request.params.reason);
    const isCommand = request.method === 'item/commandExecution/requestApproval';
    const isFileChange = request.method === 'item/fileChange/requestApproval';
    const command = isCommand ? text(request.params.command) : undefined;
    const targetPath = isFileChange && itemId ? describeFileChange(fileChangeItems.get(itemId) ?? getItem(itemId)) : undefined;
    const description = isCommand || isFileChange ? reason : describePermissions(request.params) ?? reason;
    const toolName = isCommand ? 'Bash' : isFileChange ? 'Edit' : 'Permissions';
    pendingCodexApprovals.set(requestId, {
      sessionId,
      client,
      rpcId: request.id,
      method: request.method,
      params: request.params,
      threadId,
      path: targetPath ?? command ?? description ?? toolName,
    });
    emitRuntimeState(ctx, sessionId, 'awaiting_reply', true);
    ctx.broadcastEvent({
      type: 'permission-request',
      sessionId,
      requestId,
      toolName,
      targetPath,
      command,
      description,
      decisionReason: reason,
      sensitive: false,
    });
    return true;
  };
  const onNotification = (notification: { method: string; params: Record<string, unknown> }) => {
    const item = notification.params.item as Record<string, unknown> | undefined;
    if (notification.method === 'item/started' && item?.type === 'fileChange' && text(item.id)) {
      fileChangeItems.set(item.id as string, item);
      return;
    }
    if (notification.method !== 'serverRequest/resolved') return;
    for (const [requestId, pending] of pendingCodexApprovals) {
      if (pending.client === client && pending.rpcId === notification.params.requestId) {
        resolvePending(ctx, requestId, pending);
      }
    }
  };
  client.addServerRequestHandler(handler);
  client.addNotificationHandler(onNotification);
  return () => {
    client.removeServerRequestHandler(handler);
    client.removeNotificationHandler(onNotification);
    for (const [requestId, pending] of pendingCodexApprovals) {
      if (pending.client === client && pending.sessionId === sessionId) {
        pendingCodexApprovals.delete(requestId);
        ctx.broadcastEvent({ type: 'interaction-resolved', sessionId, interaction: 'permission', requestId });
      }
    }
  };
};

export const buildCodexApprovalResponse = (method: string, params: Record<string, unknown>, behavior: 'allow' | 'deny') => {
  if (method === 'item/permissions/requestApproval') {
    return behavior === 'allow' ? { permissions: params.permissions ?? {}, scope: 'turn' } : { permissions: {} };
  }
  return { decision: behavior === 'allow' ? 'accept' : 'decline' };
};

/** Returns null when the request does not belong to Codex. */
export const respondToCodexApproval = (
  ctx: ClaudeInteractionContext,
  requestId: string,
  behavior: 'allow' | 'deny',
) => {
  if (!requestId.startsWith('codex-')) return null;
  const pending = pendingCodexApprovals.get(requestId);
  if (!pending) return { mode: 'missing' as const };
  const sent = pending.client.respond(pending.rpcId, buildCodexApprovalResponse(pending.method, pending.params, behavior));
  resolvePending(ctx, requestId, pending);
  return { mode: sent ? 'interactive' as const : 'missing' as const };
};

export const getCodexApprovalSnapshots = () => {
  const bySession = new Map<string, SessionPermissionRequest[]>();
  pendingCodexApprovals.forEach((pending, requestId) => {
    bySession.set(pending.sessionId, [
      ...(bySession.get(pending.sessionId) ?? []),
      { path: pending.path, sensitive: false, requestId, sessionId: pending.sessionId },
    ]);
  });
  return bySession;
};

export const hasPendingCodexApproval = (sessionId: string) =>
  [...pendingCodexApprovals.values()].some((pending) => pending.sessionId === sessionId);
