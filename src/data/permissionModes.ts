import { normalizeSessionProvider } from './sessionProvider.js';
import type { SessionProvider } from './types.js';

export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
export const CODEX_PERMISSION_MODES = ['read-only', 'auto', 'full-access'] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number];
export type SessionPermissionMode = ClaudePermissionMode | CodexPermissionMode;

// Sessions without a stored mode keep the historical unattended behavior.
export const DEFAULT_CLAUDE_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'full-access';

const PERMISSION_MODE_LABELS: Record<SessionProvider, Record<string, { label: string; description: string }>> = {
  claude: {
    default: { label: '每次询问', description: '编辑文件和执行命令前请求批准' },
    acceptEdits: { label: '自动接受编辑', description: '自动批准工作区内的文件编辑，命令仍需批准' },
    plan: { label: '计划模式', description: '只读分析并给出计划，批准后再执行' },
    auto: { label: '自动判断', description: '由 Claude 的安全分类器决定是否需要批准' },
    bypassPermissions: { label: '完全放行', description: '不请求任何批准（EAF 默认）' },
  },
  codex: {
    'read-only': { label: '只读', description: '只能读取文件，修改和执行需要批准' },
    auto: { label: '自动', description: '可在工作区内读写和执行，越界操作需要批准' },
    'full-access': { label: '完全访问', description: '不请求批准，无沙箱限制（EAF 默认）' },
  },
};

export const getPermissionModeOptions = (provider: SessionProvider | string | undefined) => {
  const normalized = normalizeSessionProvider(provider);
  const modes = normalized === 'codex' ? CODEX_PERMISSION_MODES : CLAUDE_PERMISSION_MODES;
  return modes.map((value) => ({ value, ...PERMISSION_MODE_LABELS[normalized][value] }));
};

export const isPermissionModeForProvider = (provider: SessionProvider | string | undefined, value: unknown): value is SessionPermissionMode =>
  typeof value === 'string' &&
  (normalizeSessionProvider(provider) === 'codex'
    ? (CODEX_PERMISSION_MODES as readonly string[]).includes(value)
    : (CLAUDE_PERMISSION_MODES as readonly string[]).includes(value));

export const resolveClaudePermissionMode = (value: string | undefined): ClaudePermissionMode => {
  // Newer CLIs report "manual" for what older CLIs and EAF call "default".
  if (value === 'manual') return 'default';
  return isPermissionModeForProvider('claude', value) ? value as ClaudePermissionMode : DEFAULT_CLAUDE_PERMISSION_MODE;
};

export const resolveCodexPermissionMode = (value: string | undefined): CodexPermissionMode =>
  isPermissionModeForProvider('codex', value) ? value as CodexPermissionMode : DEFAULT_CODEX_PERMISSION_MODE;

export const resolveSessionPermissionMode = (provider: SessionProvider | string | undefined, value: string | undefined): SessionPermissionMode =>
  normalizeSessionProvider(provider) === 'codex' ? resolveCodexPermissionMode(value) : resolveClaudePermissionMode(value);

/** app-server policies; turn/start overrides apply to the turn and later turns. */
export const codexPermissionPolicy = (mode: CodexPermissionMode) => {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } } as const;
    case 'auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } } as const;
    default:
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } } as const;
  }
};
