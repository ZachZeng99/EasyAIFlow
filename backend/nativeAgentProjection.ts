import type { ConversationMessage, NativeAgentRecord, SessionProvider } from '../src/data/types.js';
import { sanitizeTraceContent, TRACE_CONTENT_MAX_CHARS } from '../src/data/traceContent.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const blocks = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
const visibleText = (value: unknown) => typeof value === 'string' ? value : blocks(value).filter((block) => block.type === 'text').map((block) => text(block.text)).join('\n');
const active = (status: NativeAgentRecord['status']) => status === 'pending' || status === 'running';
const status = (value: unknown): NativeAgentRecord['status'] | undefined => {
  if (['completed', 'done'].includes(text(value))) return 'completed';
  if (['failed', 'errored', 'error'].includes(text(value))) return 'failed';
  if (['stopped', 'shutdown', 'interrupted'].includes(text(value))) return 'stopped';
  if (['running', 'in_progress', 'inProgress', 'started', 'interacted'].includes(text(value))) return 'running';
  if (value === 'pendingInit' || value === 'pending') return 'pending';
  if (value === 'notFound') return 'unknown';
  return undefined;
};

export class NativeAgentProjection {
  private readonly messages = new Map<string, ConversationMessage>();
  private readonly aliases = new Map<string, string>();
  private readonly output = new Map<string, Map<string, string>>();
  private readonly streams = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly changed = new Set<string>();
  constructor(readonly provider: SessionProvider, readonly sessionId: string, restored: ConversationMessage[] = []) {
    for (const message of restored) {
      if (message.nativeAgent?.provider !== provider) continue;
      this.messages.set(message.nativeAgent.id, message);
      this.aliases.set(message.nativeAgent.nativeId, message.nativeAgent.id);
      if (message.nativeAgent.nativeTaskId) this.aliases.set(message.nativeAgent.nativeTaskId, message.nativeAgent.id);
    }
  }
  private lookup(nativeId: string) { return this.messages.get(this.aliases.get(nativeId) ?? ''); }
  private ensure(nativeId: string, owner: string, patch: Partial<NativeAgentRecord> = {}) {
    const previous = this.lookup(nativeId);
    if (!nativeId || (!owner && !previous)) return undefined;
    const id = previous?.nativeAgent!.id ?? `native-agent:${this.provider}:${this.sessionId}:${encodeURIComponent(nativeId)}`;
    const agent: NativeAgentRecord = { id, provider: this.provider, controller: 'runtime', nativeId,
      rootAssistantMessageId: owner, label: this.provider === 'claude' ? 'Claude 子 agent' : 'Codex 子 agent', status: 'pending',
      ...previous?.nativeAgent, ...patch, updatedAt: Date.now(), revision: (previous?.nativeAgent?.revision ?? 0) + 1 };
    agent.label = agent.label.slice(0, 160);
    if (agent.prompt) agent.prompt = sanitizeTraceContent(agent.prompt).slice(0, 16000);
    const message: ConversationMessage = { ...previous, id, role: 'system', kind: 'native_agent',
      timestamp: previous?.timestamp ?? new Date().toLocaleString('zh-CN'), title: agent.label,
      content: previous?.content ?? '', provider: this.provider, nativeAgent: agent,
      status: active(agent.status) ? 'running' : agent.status === 'failed' ? 'error' : 'complete' };
    this.messages.set(id, message);
    this.aliases.set(nativeId, id);
    if (agent.nativeTaskId) this.aliases.set(agent.nativeTaskId, id);
    this.changed.add(id);
    return message;
  }
  private setOutput(nativeId: string, itemId: string, content: string, append = false) {
    const message = this.lookup(nativeId);
    if (!message?.nativeAgent || !content) return;
    if (message.nativeAgent.outputMessageIds?.includes(itemId)) return;
    const parts = this.output.get(message.id) ?? new Map<string, string>();
    if (!parts.size && message.content) parts.set('restored', message.content);
    parts.set(itemId, sanitizeTraceContent(append ? `${parts.get(itemId) ?? ''}${content}` : content));
    let retainedLength = [...parts.values()].reduce((total, value) => total + value.length, 0);
    let trimmed = false;
    while (parts.size > 64 || retainedLength > TRACE_CONTENT_MAX_CHARS && parts.size > 1) {
      const key = parts.keys().next().value!;
      retainedLength -= parts.get(key)!.length;
      parts.delete(key);
      trimmed = true;
    }
    this.output.set(message.id, parts);
    this.messages.set(message.id, { ...message,
      nativeAgent: { ...message.nativeAgent, revision: (message.nativeAgent.revision ?? 0) + 1,
        ...(trimmed ? { outputNote: '较早的输出已从当前视图省略。' } : {}),
        ...(!append ? { outputMessageIds: [...(message.nativeAgent.outputMessageIds ?? []), itemId].slice(-256) } : {}), },
      content: sanitizeTraceContent([...parts.values()].filter(Boolean).join('\n\n')) });
    this.changed.add(message.id);
  }
  drain() {
    const changes = [...this.changed].map((id) => this.messages.get(id)!);
    this.changed.clear();
    // Keep memory bounded across long-lived sessions. Journal history remains available.
    if (this.messages.size > 256) {
      for (const [id, message] of this.messages) {
        if (this.messages.size <= 256) break;
        if (active(message.nativeAgent!.status)) continue;
        this.messages.delete(id); this.output.delete(id);
        for (const [key, value] of this.aliases) if (value === id) { this.aliases.delete(key); this.streams.delete(key); }
      }
    }
    return changes;
  }
  activeNativeIds(owner: string) {
    return [...this.messages.values()].filter((message) => message.nativeAgent?.rootAssistantMessageId === owner && active(message.nativeAgent.status)).map((message) => message.nativeAgent!.nativeId);
  }
  settleOpen(owner: string, next: 'unknown' | 'stopped', note?: string) {
    for (const nativeId of this.activeNativeIds(owner)) this.ensure(nativeId, owner, { status: next, outputNote: note });
  }
  observeClaude(frame: Record<string, unknown>, owner: string) {
    const parentTool = text(frame.parent_tool_use_id);
    const childPayload = Boolean(parentTool && ['assistant', 'user', 'stream_event', 'tool_progress', 'result'].includes(text(frame.type)));
    const uuid = text(frame.uuid);
    if (uuid && this.seen.has(uuid)) return childPayload;
    if (uuid) { this.seen.add(uuid); if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!); }
    const parent = parentTool ? this.ensure(parentTool, owner, this.lookup(parentTool) ? {} : { status: 'running' }) : undefined;
    const currentOwner = parent?.nativeAgent?.rootAssistantMessageId || owner;
    const content = blocks(object(frame.message).content);
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const input = object(block.input);
      if (block.name === 'Agent' || block.name === 'Task') {
        this.ensure(text(block.id), currentOwner, {
          parentId: parent?.nativeAgent?.id, status: 'running',
          label: text(input.description) || text(input.name) || 'Claude 子 agent',
          prompt: sanitizeTraceContent(text(input.prompt)), model: text(input.model) || undefined,
        });
      } else if (block.name === 'SendMessage') {
        const target = this.lookup(text(input.to));
        if (target) {
          this.aliases.set(text(block.id), target.id);
          this.ensure(text(input.to), currentOwner, { rootAssistantMessageId: currentOwner, status: 'running' });
        }
      }
    }
    if (parent && frame.type === 'assistant') {
      this.ensure(parentTool, currentOwner, { model: text(object(frame.message).model) || parent.nativeAgent?.model,
        label: text(frame.task_description) || parent.title });
      this.setOutput(parentTool, text(object(frame.message).id) || uuid || 'reply', visibleText(object(frame.message).content));
    }
    if (parent && frame.type === 'stream_event') {
      const event = object(frame.event);
      if (event.type === 'message_start') this.streams.set(parentTool, text(object(event.message).id) || uuid);
      if (event.type === 'content_block_delta' && object(event.delta).type === 'text_delta') {
        this.setOutput(parentTool, this.streams.get(parentTool) || 'stream', text(object(event.delta).text), true);
      }
    }
    if (frame.type === 'system' && text(frame.subtype).startsWith('task_')) {
      const nativeId = text(frame.tool_use_id) || text(frame.task_id);
      const known = this.lookup(nativeId);
      if (frame.task_type === 'local_agent' || known) {
        const patch = object(frame.patch);
        const nextStatus = status(frame.status ?? patch.status) ?? (frame.subtype === 'task_started' ? 'running' : undefined);
        this.ensure(nativeId, currentOwner, { nativeTaskId: text(frame.task_id) || known?.nativeAgent?.nativeTaskId,
          ...(text(frame.description) ? { label: text(frame.description) } : {}),
          ...(text(frame.prompt) ? { prompt: sanitizeTraceContent(text(frame.prompt)) } : {}),
          ...(nextStatus ? { status: nextStatus } : {}),
        });
        if (frame.subtype === 'task_notification' && text(frame.summary) && !this.lookup(nativeId)?.content) this.setOutput(nativeId, 'summary', text(frame.summary));
      }
    }
    if (frame.type === 'user') {
      const result = object(frame.tool_use_result ?? frame.toolUseResult);
      for (const block of content.filter((entry) => entry.type === 'tool_result')) {
        const nativeId = text(block.tool_use_id);
        const known = this.lookup(nativeId);
        if (!known) continue;
        const nextStatus = block.is_error ? 'failed' : status(result.status) ?? (result.isAsync === true ? 'running' : 'completed');
        this.ensure(nativeId, currentOwner, { status: nextStatus, nativeTaskId: text(result.agentId) || known.nativeAgent?.nativeTaskId,
          model: text(result.resolvedModel) || known.nativeAgent?.model });
        const reply = visibleText(result.content);
        if (reply && !this.lookup(nativeId)?.content.trimEnd().endsWith(reply.trim())) this.setOutput(nativeId, `result:${nativeId}`, reply);
      }
    }
    return childPayload;
  }

  observeCodex(notification: { method: string; params: Record<string, unknown> }, rootThreadId: string, owner: string) {
    const { method, params } = notification;
    const scope = text(params.threadId);
    const known = this.lookup(scope);
    if (method === 'thread/started') {
      const thread = object(params.thread);
      const parentId = text(thread.parentThreadId);
      if (parentId && (parentId === rootThreadId || this.lookup(parentId))) this.ensure(text(thread.id), owner, {
        parentId: this.lookup(parentId)?.nativeAgent?.id, label: text(thread.agentNickname) || text(thread.agentRole) || 'Codex 子 agent', status: 'running', model: text(thread.model) || undefined,
      });
    }
    if (scope !== rootThreadId && !known) return { child: false, inspect: [] as string[] };
    const item = object(params.item);
    if (text(item.id) && (method === 'item/started' || method === 'item/completed')) {
      const key = `${method}:${scope}:${text(item.id)}:${text(item.kind)}:${text(item.status)}`;
      if (this.seen.has(key)) return { child: Boolean(known), inspect: [] as string[] };
      this.seen.add(key);
      if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!);
    }
    const inspect = new Set<string>();
    if ((method === 'item/started' || method === 'item/completed') && item.type === 'subAgentActivity') {
      const nativeId = text(item.agentThreadId);
      const previous = this.lookup(nativeId);
      const agentPath = text(item.agentPath);
      const parentPath = agentPath.slice(0, agentPath.lastIndexOf('/'));
      const parent = [...this.messages.values()].find((entry) => entry.nativeAgent?.nativeId === parentPath || entry.nativeAgent?.label === parentPath);
      this.ensure(nativeId, owner, { parentId: known?.nativeAgent?.id ?? parent?.nativeAgent?.id,
        label: agentPath || previous?.title || 'Codex 子 agent', model: text(item.model) || previous?.nativeAgent?.model,
        ...(['started', 'interacted'].includes(text(item.kind)) ? { rootAssistantMessageId: owner } : {}),
        status: status(item.kind) ?? previous?.nativeAgent?.status ?? 'running' });
      inspect.add(nativeId);
    }
    if ((method === 'item/started' || method === 'item/completed') && ['collabAgentToolCall', 'collabToolCall'].includes(text(item.type))) {
      const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.map(text) : [text(item.newThreadId || item.receiverThreadId)].filter(Boolean);
      for (const nativeId of receivers) {
        const nativeState = object(object(item.agentsStates)[nativeId]);
        const previous = this.lookup(nativeId);
        const spawned = item.tool === 'spawnAgent' || item.tool === 'spawn_agent';
        // Messaging a peer or a parent is not evidence that it is our child.
        if (!previous && !spawned || nativeId === rootThreadId) continue;
        const sender = this.lookup(text(item.senderThreadId)) ?? known;
        this.ensure(nativeId, owner, { parentId: previous?.nativeAgent?.parentId ?? sender?.nativeAgent?.id,
          status: status(nativeState.status ?? item.agentStatus) ?? previous?.nativeAgent?.status ?? 'running',
          prompt: text(item.prompt) || previous?.nativeAgent?.prompt, model: text(item.model) || previous?.nativeAgent?.model });
        if (text(nativeState.message) && !this.lookup(nativeId)?.content.trimEnd().endsWith(text(nativeState.message).trim())) this.setOutput(nativeId, `report:${text(item.id)}:${text(nativeState.status)}`, text(nativeState.message));
        inspect.add(nativeId);
      }
    }
    if (known && item.type === 'agentMessage' && method === 'item/completed') this.setOutput(scope, text(item.id) || 'reply', text(item.text));
    if (known && method === 'item/agentMessage/delta') this.setOutput(scope, text(params.itemId) || 'reply', text(params.delta), true);
    if (known && method === 'turn/completed') this.ensure(scope, owner, { status: status(object(params.turn).status) ?? 'unknown' });
    return { child: Boolean(known), inspect: [...inspect] };
  }

  setCodexSnapshot(nativeId: string, turns: unknown[], note?: string, rootTurnId?: string) {
    const known = this.lookup(nativeId);
    if (!known?.nativeAgent) return;
    const ordered = turns.map(object).reverse();
    const items = ordered.flatMap((turn) => blocks(turn.items).filter((item) => item.type === 'agentMessage').map((item) => ({ id: text(item.id), text: sanitizeTraceContent(text(item.text)), complete: turn.status === 'completed' }))).slice(-64);
    let retainedLength = items.reduce((total, item) => total + item.text.length, 0);
    while (retainedLength > TRACE_CONTENT_MAX_CHARS && items.length > 1) { retainedLength -= items.shift()!.text.length; note = '较早的输出已从当前视图省略。'; }
    // History can lag the live lifecycle event. It supplies text, never a rollback
    // from completed to running or premature completion of a new follow-up.
    const newest = object(turns[0]);
    const observedStatus = status(newest.status);
    const currentWorkEnded = rootTurnId && newest.rootTurnId === rootTurnId && observedStatus && !active(observedStatus);
    this.ensure(nativeId, known.nativeAgent.rootAssistantMessageId, { outputNote: note,
      ...(currentWorkEnded && active(known.nativeAgent.status) ? { status: observedStatus } : {}),
    });
    if (items.length) {
      this.output.set(known.id, new Map(items.map((item, index) => [item.id || `snapshot-${index}`, sanitizeTraceContent(item.text)])));
      const message = this.messages.get(known.id)!;
      this.messages.set(known.id, { ...message, content: sanitizeTraceContent(items.map((item) => item.text).filter(Boolean).join('\n\n')),
        nativeAgent: { ...message.nativeAgent!, outputMessageIds: [...new Set([...(message.nativeAgent?.outputMessageIds ?? []), ...items.filter((item) => item.complete).map((item) => item.id)])].slice(-256) } });
      this.changed.add(known.id);
    }
  }
}
