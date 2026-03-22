import type { ConversationMessage, ProjectRecord, SessionRecord } from './types.js';

const groups = {
  ui: {
    id: 'ui-shell',
    name: 'UI Shell',
    color: '#f59e0b',
    status: 'active' as const,
    focus: '桌面聊天壳、布局稳定性和响应速度。',
    workspace: 'D:\\AIAgent\\EasyAIFlow',
  },
  relay: {
    id: 'claude-bridge',
    name: 'Claude Bridge',
    color: '#22c55e',
    status: 'active' as const,
    focus: 'Claude Code 进程管理、输出回流和状态同步。',
    workspace: 'D:\\AIAgent\\EasyAIFlow\\electron',
  },
  memory: {
    id: 'session-memory',
    name: 'Session Memory',
    color: '#60a5fa',
    status: 'idle' as const,
    focus: '历史记录、检索和跨会话引用。',
    workspace: 'D:\\AIAgent\\EasyAIFlow\\src\\data',
  },
};

export const projectTree: ProjectRecord[] = [
  {
    id: 'easyaiflow',
    name: 'EasyAIFlow',
    rootPath: 'D:\\AIAgent\\EasyAIFlow',
    dreams: [
      {
        id: 'desktop-dream',
        name: 'Desktop Dream',
        sessions: [
          {
            id: 'desktop-shell',
            title: 'Desktop shell rebuild',
            preview: '改成 exe 方向，三栏工作区和图片粘贴输入。',
            timeLabel: '15 mins ago',
            model: 'opus[1m]',
            workspace: 'D:\\AIAgent\\EasyAIFlow',
            projectId: 'easyaiflow',
            projectName: 'EasyAIFlow',
            dreamId: 'desktop-dream',
            dreamName: 'Desktop Dream',
            groups: [groups.ui, groups.relay, groups.memory],
            tokenUsage: {
              contextWindow: 0,
              used: 84210,
              input: 54320,
              output: 17640,
              cached: 12250,
              windowSource: 'unknown',
            },
            branchSnapshot: {
              branch: 'codex/desktop-shell',
              tracking: 'origin/codex/desktop-shell',
              ahead: 3,
              behind: 0,
              dirty: true,
              changedFiles: [
                { path: 'src/App.tsx', status: 'M', additions: 84, deletions: 31 },
                { path: 'src/components/ChatComposer.tsx', status: 'M', additions: 56, deletions: 12 },
                { path: 'electron/main.ts', status: 'M', additions: 18, deletions: 2 },
              ],
            },
          },
          {
            id: 'three-level-tree',
            title: 'Three-level session tree',
            preview: '左侧项目 -> dream -> session 层级视图。',
            timeLabel: '42 mins ago',
            model: 'opus[1m]',
            workspace: 'D:\\AIAgent\\EasyAIFlow',
            projectId: 'easyaiflow',
            projectName: 'EasyAIFlow',
            dreamId: 'desktop-dream',
            dreamName: 'Desktop Dream',
            groups: [groups.ui, groups.memory],
            tokenUsage: {
              contextWindow: 0,
              used: 49280,
              input: 34020,
              output: 9180,
              cached: 6080,
              windowSource: 'unknown',
            },
            branchSnapshot: {
              branch: 'codex/session-tree',
              tracking: 'origin/codex/session-tree',
              ahead: 1,
              behind: 0,
              dirty: true,
              changedFiles: [
                { path: 'src/components/ChatHistory.tsx', status: 'M', additions: 70, deletions: 15 },
                { path: 'src/data/mockSessions.ts', status: 'M', additions: 66, deletions: 11 },
              ],
            },
          },
        ],
      },
      {
        id: 'bridge-dream',
        name: 'Bridge Dream',
        sessions: [
          {
            id: 'multi-group-routing',
            title: 'Multi-group routing',
            preview: '把不同工作组的上下文映射到一个会话视图。',
            timeLabel: '1 hr ago',
            model: 'opus[1m]',
            workspace: 'D:\\AIAgent\\EasyAIFlow',
            projectId: 'easyaiflow',
            projectName: 'EasyAIFlow',
            dreamId: 'bridge-dream',
            dreamName: 'Bridge Dream',
            groups: [groups.relay, groups.memory],
            tokenUsage: {
              contextWindow: 0,
              used: 61600,
              input: 42000,
              output: 10300,
              cached: 9300,
              windowSource: 'unknown',
            },
            branchSnapshot: {
              branch: 'codex/group-routing',
              tracking: 'origin/codex/group-routing',
              ahead: 2,
              behind: 1,
              dirty: false,
              changedFiles: [],
            },
          },
        ],
      },
    ],
  },
  {
    id: 'gpu-capture',
    name: 'GPUCapture',
    rootPath: 'X:\\GPUCapture',
    dreams: [
      {
        id: 'share-dream',
        name: 'Share Dream',
        sessions: [
          {
            id: 'initial-greeting',
            title: 'Initial greeting',
            preview: '整理目录、找 HTML、处理共享路径。',
            timeLabel: 'Yesterday 12:29',
            model: 'gpt-5.4',
            workspace: 'X:\\GPUCapture',
            projectId: 'gpu-capture',
            projectName: 'GPUCapture',
            dreamId: 'share-dream',
            dreamName: 'Share Dream',
            groups: [groups.memory],
            tokenUsage: {
              contextWindow: 128000,
              used: 21240,
              input: 14030,
              output: 4600,
              cached: 2610,
            },
            branchSnapshot: {
              branch: 'not-a-git-repo',
              ahead: 0,
              behind: 0,
              dirty: false,
              changedFiles: [
                { path: 'SMRT_vs_HRTT_Report.html', status: 'A', additions: 1, deletions: 0 },
              ],
            },
          },
        ],
      },
    ],
  },
];

const desktopShellMessages: ConversationMessage[] = [
  {
    id: 'm1',
    role: 'user',
    timestamp: '3月22日 20:12',
    title: '重做 EasyAIFlow 结构',
    content: '不要前后端架构，最后我要一个 exe。中间是聊天框，左边是聊天记录。',
  },
  {
    id: 'm2',
    role: 'assistant',
    timestamp: '3月22日 20:13',
    title: '桌面单体方案',
    content:
      '改成 Electron 单体应用，渲染层负责聊天界面，主进程负责桌面窗口和后续 Claude Code 进程桥接，不再走独立 API 服务。',
    steps: [
      { id: 's1', command: 'drop express server scaffold', status: 'complete' },
      { id: 's2', command: 'add electron main/preload', status: 'complete' },
      { id: 's3', command: 'reshape UI into chat layout', status: 'complete' },
    ],
  },
  {
    id: 'm3',
    role: 'assistant',
    timestamp: '3月22日 20:28',
    title: '本轮 UI 目标',
    content:
      '左边改成项目、dream、session 三层；底部输入区显示 token 总量和已使用量；同时支持直接把剪贴板图片粘贴进聊天框。',
  },
];

const sessionTreeMessages: ConversationMessage[] = [
  {
    id: 't1',
    role: 'user',
    timestamp: '3月22日 19:42',
    title: '左侧树需要三层',
    content: '项目或者目录名一层，下面 dream 名，再下面才是每一次 session。',
  },
  {
    id: 't2',
    role: 'assistant',
    timestamp: '3月22日 19:44',
    title: 'Tree model',
    content: '用 project -> dream -> session 的嵌套结构建模，后面才能继续挂分支、token 和工作区信息。',
  },
];

const routingMessages: ConversationMessage[] = [
  {
    id: 'r1',
    role: 'user',
    timestamp: '3月22日 18:02',
    title: 'How should group context merge?',
    content: '把 UI、bridge、memory 三组数据汇总到一个当前会话里。',
  },
  {
    id: 'r2',
    role: 'assistant',
    timestamp: '3月22日 18:04',
    title: 'Session projection',
    content: '每个 group 单独保存状态，但在当前 session 顶部聚合标签和上下文摘要。',
  },
];

const greetingMessages: ConversationMessage[] = [
  {
    id: 'g1',
    role: 'user',
    timestamp: '3月21日 12:29',
    title: '整理共享路径',
    content: '把当前文件夹变成共享文件夹，并把 html 最终的共享路径给我。',
  },
  {
    id: 'g2',
    role: 'assistant',
    timestamp: '3月21日 12:31',
    title: 'Checked filesystem and share state',
    content: '先检查 HTML 文件、目录位置和当前共享状态，再决定是直接复用还是创建新的共享。',
    steps: [
      { id: 'g2-1', command: 'Get-ChildItem -Recurse -File -Include *.html,*.htm', status: 'complete' },
      { id: 'g2-2', command: 'net share', status: 'complete' },
      { id: 'g2-3', command: 'net share GPUCapture=...', status: 'blocked' },
    ],
  },
];

export const sessionMessages: Record<string, ConversationMessage[]> = {
  'desktop-shell': desktopShellMessages,
  'three-level-tree': sessionTreeMessages,
  'multi-group-routing': routingMessages,
  'initial-greeting': greetingMessages,
};

export const allSessions: SessionRecord[] = projectTree.flatMap((project) =>
  project.dreams.flatMap((dream: ProjectRecord['dreams'][number]) =>
    dream.sessions.map((session: ProjectRecord['dreams'][number]['sessions'][number]) => ({
      ...session,
      messages: sessionMessages[session.id] ?? [],
    })),
  ),
);
