import type { ClaudeInteractionContext } from './claudeInteractionContext.js';
import type { ClaudeInteractionState } from './claudeInteractionState.js';
import type { CodexAppServerClient } from './codexAppServer.js';
import { findSession, upsertSessionMessage } from '../electron/sessionStore.js';
import { NativeAgentProjection } from './nativeAgentProjection.js';

const claudeProjections = new WeakMap<ClaudeInteractionState, Map<string, Promise<NativeAgentProjection>>>();
export const persistNativeAgents = async (ctx: ClaudeInteractionContext, sessionId: string, projection: NativeAgentProjection) => {
  for (const message of projection.drain()) {
    await upsertSessionMessage(sessionId, message);
    ctx.broadcastEvent({ type: 'trace', sessionId, message });
  }
};
export const observeClaudeNativeAgents = async (
  ctx: ClaudeInteractionContext, state: ClaudeInteractionState, sessionId: string,
  parsed: Record<string, unknown>, owner = '',
) => {
  let sessions = claudeProjections.get(state);
  const content = (parsed.message as { content?: Array<{ name?: string }> } | undefined)?.content;
  const relevant = parsed.parent_tool_use_id || parsed.task_type === 'local_agent' ||
    Array.isArray(content) && content.some((block) => block.name === 'Agent' || block.name === 'Task');
  if (!sessions?.has(sessionId) && !relevant) return false;
  if (!sessions) { sessions = new Map(); claudeProjections.set(state, sessions); }
  let pending = sessions.get(sessionId);
  if (!pending) {
    pending = findSession(sessionId).then((session) => new NativeAgentProjection('claude', sessionId, session?.messages));
    sessions.set(sessionId, pending);
  }
  const projection = await pending;
  const child = projection.observeClaude(parsed, owner);
  await persistNativeAgents(ctx, sessionId, projection);
  return child;
};
export const forgetClaudeNativeAgents = (state: ClaudeInteractionState, sessionId: string) => claudeProjections.get(state)?.delete(sessionId);

export const readCodexAgentOutput = async (client: CodexAppServerClient, projection: NativeAgentProjection, nativeId: string, rootTurnId?: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [turns, items] = await Promise.race([
      Promise.all([
        client.request<{ data: Array<Record<string, unknown>>; nextCursor?: string | null }>('thread/turns/list', { threadId: nativeId, limit: 4, sortDirection: 'desc', itemsView: 'notLoaded' }),
        client.request<{ data: Array<{ turnId: string; item: Record<string, unknown> }>; nextCursor?: string | null }>('thread/items/list', { threadId: nativeId, limit: 100, sortDirection: 'desc' }),
      ]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('子 agent 输出读取超时')), 5000); }),
    ]);
    const entries = [...items.data].reverse();
    projection.setCodexSnapshot(nativeId, turns.data.map((turn) => ({ ...turn, items: entries.filter((entry) => entry.turnId === turn.id).map((entry) => entry.item) })),
      turns.nextCursor || items.nextCursor ? '显示最近 4 轮、最多 100 项记录中的文本输出。' : undefined, rootTurnId);
  } catch {
    projection.setCodexSnapshot(nativeId, [], '运行时尚未提供可读取的输出。');
  } finally { clearTimeout(timer); }
};

export const interruptCodexNativeAgents = async (client: CodexAppServerClient, projection: NativeAgentProjection, owner: string) => {
  const unknown: string[] = [];
  for (const threadId of projection.activeNativeIds(owner)) {
    try {
      const response = await client.request<{ data: Array<{ id: string; status: string }> }>('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      const turn = response.data[0];
      if (!turn) { unknown.push(threadId); continue; }
      if (turn.status === 'inProgress') await client.turnInterrupt({ threadId, turnId: turn.id });
    } catch { unknown.push(threadId); }
  }
  projection.settleOpen(owner, unknown.length ? 'unknown' : 'stopped', unknown.length ? '停止请求已发出，部分子 agent 的结束状态尚未确认。' : undefined);
};
