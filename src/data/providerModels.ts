import type { SessionEffort, SessionProvider } from './types.js';

export const modelEffortOptions = (model: ProviderModel | undefined): SessionEffort[] =>
  [...new Set(['default', ...(model?.supportedEfforts ?? [])])];

export type ProviderModel = {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  isDefault?: boolean;
  supportedEfforts?: string[];
  defaultEffort?: string;
  contextWindow?: number;
};
export type ProviderModelCatalog = {
  provider: SessionProvider;
  models: ProviderModel[];
  updatedAt: number | null;
  stale: boolean;
  error?: string;
  runtimeVersion?: string;
  runtimePath?: string;
  runtimeSource?: 'path' | 'desktop' | 'override';
  commands?: string[];
};

export const describeModelCatalog = (catalog: ProviderModelCatalog | null | undefined) => {
  if (!catalog) return '';
  const source = catalog.runtimeSource === 'desktop' ? '桌面安装' : catalog.runtimeSource === 'override' ? '指定运行时' : catalog.runtimeSource === 'path' ? 'PATH 安装' : undefined;
  return [catalog.runtimeVersion, source, `${catalog.models.length} 个模型`, catalog.stale ? '缓存' : '运行时获取'].filter(Boolean).join(' · ');
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export const normalizeProviderModels = (provider: SessionProvider, values: unknown): ProviderModel[] => {
  if (!Array.isArray(values)) return [];
  const models = new Map<string, ProviderModel>();
  for (const value of values) {
    const item = object(value);
    if (item.hidden === true) continue;
    const alias = text(item.value);
    const id = provider === 'claude'
      ? text(item.resolvedModel) || alias
      : text(item.model) || text(item.id);
    if (!id) continue;
    const efforts = provider === 'claude' ? item.supportedEffortLevels : item.supportedReasoningEfforts;
    const model: ProviderModel = {
      id,
      label: text(item.displayName) || id,
      description: text(item.description) || undefined,
      aliases: alias ? [alias] : undefined,
      isDefault: item.isDefault === true || alias === 'default',
      supportedEfforts: Array.isArray(efforts)
        ? efforts.map((effort) => text(typeof effort === 'string' ? effort : object(effort).reasoningEffort)).filter(Boolean)
        : undefined,
      defaultEffort: text(item.defaultReasoningEffort) || undefined,
      contextWindow: typeof item.contextWindow === 'number' && item.contextWindow > 0 ? item.contextWindow : undefined,
    };
    const existing = models.get(id);
    if (existing) {
      models.set(id, {
        ...model,
        isDefault: existing.isDefault || model.isDefault,
        supportedEfforts: model.supportedEfforts ?? existing.supportedEfforts,
        defaultEffort: model.defaultEffort ?? existing.defaultEffort,
        contextWindow: model.contextWindow ?? existing.contextWindow,
        aliases: [...new Set([...(existing.aliases ?? []), ...(model.aliases ?? [])])],
      });
    } else models.set(id, model);
  }
  return [...models.values()];
};

export const modelOptionsWithCurrent = (models: ProviderModel[], current: string[]) => {
  const result = models.map((model) => ({ value: model.id, label: `${model.label}${model.isDefault ? ' · 推荐' : ''}` }));
  const known = new Set(result.map((item) => item.value));
  for (const value of current) {
    if (value.trim() && !known.has(value.trim())) {
      result.unshift({ value: value.trim(), label: `${value.trim()} · 当前选择` });
      known.add(value.trim());
    }
  }
  return result;
};
