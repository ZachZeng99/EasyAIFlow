import type { ConversationMessage, NativeAgentRecord } from './types.js';

export type NativeAgentView = { agent: NativeAgentRecord; content: string; ownerLabel?: string; depth: number };
export const mergeNativeAgentMessages = (previous: ConversationMessage[], incoming: ConversationMessage[]) => {
  const merged = new Map<string, ConversationMessage>();
  for (const message of [...previous, ...incoming]) {
    if (!message.nativeAgent) continue;
    const current = merged.get(message.nativeAgent.id);
    if (!current || (message.nativeAgent.revision ?? 0) >= (current.nativeAgent?.revision ?? 0)) merged.set(message.nativeAgent.id, message);
  }
  return [...merged.values()];
};
export const collectNativeAgents = (messages: ConversationMessage[]): NativeAgentView[] => {
  const nodes = new Map<string, Omit<NativeAgentView, 'depth'>>();
  for (const message of messages) {
    if (message.kind !== 'native_agent' || !message.nativeAgent) continue;
    nodes.set(message.nativeAgent.id, { agent: message.nativeAgent, content: message.content, ownerLabel: message.speakerLabel });
  }
  const children = new Map<string | undefined, Array<Omit<NativeAgentView, 'depth'>>>();
  for (const node of nodes.values()) {
    const parent = node.agent.parentId && nodes.has(node.agent.parentId) && node.agent.parentId !== node.agent.id ? node.agent.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const result: NativeAgentView[] = [];
  const seen = new Set<string>();
  const visit = (node: Omit<NativeAgentView, 'depth'>, depth: number) => {
    if (seen.has(node.agent.id)) return;
    seen.add(node.agent.id);
    result.push({ ...node, depth });
    for (const child of children.get(node.agent.id) ?? []) visit(child, Math.min(8, depth + 1));
  };
  for (const node of children.get(undefined) ?? []) visit(node, 0);
  for (const node of nodes.values()) visit(node, 0);
  return result;
};

export const nativeAgentStatusLabel: Record<NativeAgentRecord['status'], string> = {
  pending: '等待启动', running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止', unknown: '状态待确认',
};
