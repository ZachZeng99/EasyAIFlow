import assert from 'node:assert/strict';
import {
  codexPermissionPolicy,
  getPermissionModeOptions,
  isPermissionModeForProvider,
  resolveClaudePermissionMode,
  resolveSessionPermissionMode,
} from '../src/data/permissionModes.ts';
import { buildClaudePrintArgs } from '../electron/claudePrintArgs.ts';
import { attachCodexApprovalHandler, buildCodexApprovalResponse, getCodexApprovalSnapshots, respondToCodexApproval } from '../backend/codexApprovals.ts';
import type { CodexAppServerClient, CodexServerRequest } from '../backend/codexAppServer.ts';
import { resolvePermissionRequestState } from '../src/data/sessionInteraction.ts';
import { applyClaudeEventToProjects } from '../src/data/liveSessionEvents.ts';
import type { ClaudeStreamEvent, ProjectRecord } from '../src/data/types.ts';

const run = async (name: string, test: () => unknown | Promise<unknown>) => {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('unset modes keep the historical unattended defaults', () => {
  assert.equal(resolveSessionPermissionMode('claude', undefined), 'bypassPermissions');
  assert.equal(resolveSessionPermissionMode('codex', undefined), 'full-access');
  assert.equal(resolveSessionPermissionMode('codex', 'acceptEdits'), 'full-access');
  assert.equal(resolveClaudePermissionMode('manual'), 'default');
  assert.equal(isPermissionModeForProvider('claude', 'read-only'), false);
  assert.equal(isPermissionModeForProvider('codex', 'read-only'), true);
  assert.deepEqual(getPermissionModeOptions('codex').map((option) => option.value), ['read-only', 'auto', 'full-access']);
});

await run('Codex presets map to app-server approval and sandbox policies', () => {
  assert.deepEqual(codexPermissionPolicy('auto'), { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } });
  assert.deepEqual(codexPermissionPolicy('read-only').sandboxPolicy, { type: 'readOnly' });
  assert.equal(codexPermissionPolicy('full-access').approvalPolicy, 'never');
});

await run('Claude args pass the session mode and keep bypass switchable', () => {
  const args = buildClaudePrintArgs({ permissionMode: 'default', allowBypassSwitch: true });
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  assert.ok(args.includes('--allow-dangerously-skip-permissions'));
  assert.ok(!buildClaudePrintArgs({ allowBypassSwitch: true }).includes('--allow-dangerously-skip-permissions'));
  assert.ok(!buildClaudePrintArgs({ permissionMode: 'dontAsk' }).includes('--allow-dangerously-skip-permissions'));
});

await run('Codex approval responses use the protocol decision shapes', () => {
  assert.deepEqual(buildCodexApprovalResponse('item/commandExecution/requestApproval', {}, 'allow'), { decision: 'accept' });
  assert.deepEqual(buildCodexApprovalResponse('item/fileChange/requestApproval', {}, 'deny'), { decision: 'decline' });
  const permissions = { fileSystem: { write: ['D:/repo'] } };
  assert.deepEqual(buildCodexApprovalResponse('item/permissions/requestApproval', { permissions }, 'allow'), { permissions, scope: 'turn' });
  assert.deepEqual(buildCodexApprovalResponse('item/permissions/requestApproval', { permissions }, 'deny'), { permissions: {} });
});

await run('Codex approval requests surface as permission dialogs and answer the right JSON-RPC id', () => {
  const requestHandlers = new Set<(request: CodexServerRequest) => boolean>();
  const notificationHandlers = new Set<(notification: { method: string; params: Record<string, unknown> }) => void>();
  const responses: Array<{ id: number | string; result: Record<string, unknown> }> = [];
  const client = {
    addServerRequestHandler: (handler: (request: CodexServerRequest) => boolean) => requestHandlers.add(handler),
    removeServerRequestHandler: (handler: (request: CodexServerRequest) => boolean) => requestHandlers.delete(handler),
    addNotificationHandler: (handler: (notification: { method: string; params: Record<string, unknown> }) => void) => notificationHandlers.add(handler),
    removeNotificationHandler: (handler: (notification: { method: string; params: Record<string, unknown> }) => void) => notificationHandlers.delete(handler),
    respond: (id: number | string, result: Record<string, unknown>) => { responses.push({ id, result }); return true; },
  } as unknown as CodexAppServerClient;
  const events: ClaudeStreamEvent[] = [];
  const ctx = { broadcastEvent: (event: ClaudeStreamEvent) => events.push(event) } as never;
  const detach = attachCodexApprovalHandler(ctx, client, 'session-1', () => 'thread-1', () => undefined);
  const offer = (request: CodexServerRequest) => [...requestHandlers].some((handler) => handler(request));
  const notify = (method: string, params: Record<string, unknown>) => notificationHandlers.forEach((handler) => handler({ method, params }));

  assert.equal(offer({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'other', command: 'ls' } }), false);
  assert.equal(offer({ id: 8, method: 'item/tool/call', params: { threadId: 'thread-1' } }), false);

  notify('item/started', { item: { id: 'fc-1', type: 'fileChange', changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] } });
  assert.equal(offer({ id: 9, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', itemId: 'fc-1' } }), true);
  assert.equal(offer({ id: 10, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'npm test', reason: 'run tests' } }), true);
  const requests = events.filter((event): event is Extract<ClaudeStreamEvent, { type: 'permission-request' }> => event.type === 'permission-request');
  assert.deepEqual(requests.map((event) => [event.toolName, event.targetPath, event.command]), [
    ['Edit', 'src/a.ts 等 2 个文件', undefined],
    ['Bash', undefined, 'npm test'],
  ]);
  assert.equal(getCodexApprovalSnapshots().get('session-1')?.length, 2);

  assert.deepEqual(respondToCodexApproval(ctx, requests[1].requestId, 'allow'), { mode: 'interactive' });
  assert.deepEqual(responses, [{ id: 10, result: { decision: 'accept' } }]);
  assert.equal(respondToCodexApproval(ctx, 'claude-request', 'allow'), null);

  // The runtime can resolve a request on its own (e.g. turn interrupted).
  notify('serverRequest/resolved', { requestId: 9, threadId: 'thread-1' });
  assert.equal(getCodexApprovalSnapshots().get('session-1'), undefined);
  assert.deepEqual(respondToCodexApproval(ctx, requests[0].requestId, 'allow'), { mode: 'missing' });
  assert.equal(events.filter((event) => event.type === 'interaction-resolved').length, 2);

  detach();
  assert.equal(requestHandlers.size, 0);
  assert.equal(notificationHandlers.size, 0);
});

await run('permissions answered elsewhere leave the queue in order', () => {
  const request = (requestId: string) => ({ path: requestId, sensitive: false, requestId, sessionId: 's' });
  const state = { permission: request('a'), pendingPermissions: [request('b'), request('c')] };
  assert.deepEqual(resolvePermissionRequestState(state, 'a').permission?.requestId, 'b');
  assert.deepEqual(resolvePermissionRequestState(state, 'a').pendingPermissions?.map((item) => item.requestId), ['c']);
  assert.deepEqual(resolvePermissionRequestState(state, 'b').permission?.requestId, 'a');
  assert.deepEqual(resolvePermissionRequestState(state, 'b').pendingPermissions?.map((item) => item.requestId), ['c']);
  assert.equal(resolvePermissionRequestState(state, 'missing'), state);
});

await run('session-settings events update the stored permission mode only', () => {
  const session = { id: 's1', title: 't', preview: '', timeLabel: '', model: 'm', workspace: 'w', projectId: 'p', projectName: 'p',
    dreamId: 'd', dreamName: 'd', groups: [], tokenUsage: { contextWindow: 0, used: 0, input: 0, output: 0, cached: 0, windowSource: 'unknown' },
    branchSnapshot: { branch: 'main', changedFiles: [] }, messages: [] };
  const projects = [{ id: 'p', name: 'p', rootPath: 'w', dreams: [{ id: 'd', name: 'd', sessions: [session] }] }] as unknown as ProjectRecord[];
  const next = applyClaudeEventToProjects(projects, { type: 'session-settings', sessionId: 's1', permissionMode: 'plan' });
  assert.equal(next[0].dreams[0].sessions[0].permissionMode, 'plan');
  assert.equal(applyClaudeEventToProjects(next, { type: 'session-settings', sessionId: 's1', permissionMode: 'plan' }), next);
});
