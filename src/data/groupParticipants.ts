import type { GroupParticipantConfig } from './types.js';
import { RpcRejectedError } from './rpcOperations.js';

export const MAX_GROUP_PARTICIPANTS = 8;
const reservedIds = new Set(['all', 'user', 'constructor', 'prototype']);

export const validateGroupParticipantConfigs = (value: unknown): GroupParticipantConfig[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_GROUP_PARTICIPANTS) {
    throw new RpcRejectedError(`群聊需要 1–${MAX_GROUP_PARTICIPANTS} 位成员。`);
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  const participants = value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new RpcRejectedError('群成员配置无效。');
    const { id, label, provider, enabled, model, effort, instructions } = raw;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(id) || reservedIds.has(id) || ids.has(id)) {
      throw new RpcRejectedError('成员标识必须唯一，以小写字母开头，仅使用字母、数字、连字符或下划线；不能使用 all 或 user。');
    }
    const name = typeof label === 'string' ? label.trim() : '';
    if (!name || name.length > 60 || /[\r\n]/.test(name) || labels.has(name.toLowerCase())) throw new RpcRejectedError('成员名称需要填写、互不重复，且不超过 60 个字符。');
    if (provider !== 'claude' && provider !== 'codex') throw new RpcRejectedError('请选择 Claude 或 Codex。');
    if (typeof enabled !== 'boolean') throw new RpcRejectedError('成员启用状态无效。');
    for (const [field, limit] of [[model, 200], [effort, 40], [instructions, 8000]] as const) {
      if (field !== undefined && (typeof field !== 'string' || field.length > limit)) throw new RpcRejectedError('成员模型、推理档位或角色说明过长。');
    }
    ids.add(id);
    labels.add(name.toLowerCase());
    return { id, label: name, provider, enabled, model: model?.trim() || undefined, effort: effort?.trim() || 'default', instructions: instructions?.trim() || undefined } as GroupParticipantConfig;
  });
  if (!participants.some((participant) => participant.enabled)) throw new RpcRejectedError('至少启用一位群成员。');
  return participants;
};

export const nextGroupParticipantId = (provider: string, existingIds: string[]) => {
  let suffix = 2;
  while (existingIds.includes(`${provider}-${suffix}`)) suffix += 1;
  return `${provider}-${suffix}`;
};
