import { memo, useEffect, useMemo, useState } from 'react';
import { DiffContent } from './DiffContent';
import { extractCodeChangeSummaries } from '../data/codeChangeSummary';
import { getProviderDisplayName, providerSupportsHarness } from '../data/sessionProvider';
import type { SessionInteractionState } from '../data/sessionInteraction';
import type { ConversationMessage, DiffPayload, GitSnapshot, SessionSummary } from '../data/types';

type ContextPanelProps = {
  session: SessionSummary;
  messages: ConversationMessage[];
  interaction?: SessionInteractionState;
  requestedEffort: 'low' | 'medium' | 'high' | 'max';
  appVersion: string;
  gitSnapshot: GitSnapshot;
  onRequestDiff: (filePath: string) => Promise<DiffPayload>;
  onBootstrapHarness: () => void;
  onRunHarness: () => void;
  canBootstrapHarness?: boolean;
  canRunHarness?: boolean;
  isBootstrappingHarness?: boolean;
  isRunningHarness?: boolean;
};

function ContextPanelComponent({
  session,
  messages,
  interaction,
  requestedEffort,
  appVersion,
  gitSnapshot,
  onRequestDiff,
  onBootstrapHarness,
  onRunHarness,
  canBootstrapHarness = false,
  canRunHarness = false,
  isBootstrappingHarness = false,
  isRunningHarness = false,
}: ContextPanelProps) {
  const providerName = getProviderDisplayName(session.provider);
  const harnessSupported = providerSupportsHarness(session.provider);
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const [diffPayload, setDiffPayload] = useState<DiffPayload | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const backgroundTasks = interaction?.backgroundTasks ?? [];
  const appliedEffort = interaction?.runtime?.appliedEffort;
  const effortMatches = appliedEffort === requestedEffort;
  const effortStatusLabel = appliedEffort
    ? effortMatches
      ? 'Applied'
      : 'Restart required'
    : 'Unknown';

  const sessionChangedFiles = useMemo(() => {
    const summaries = extractCodeChangeSummaries(messages);
    const seen = new Map<string, { operationLabel: string; count: number }>();
    for (const s of summaries) {
      const existing = seen.get(s.filePath);
      if (existing) {
        existing.count++;
        existing.operationLabel = s.operationLabel;
      } else {
        seen.set(s.filePath, { operationLabel: s.operationLabel, count: 1 });
      }
    }
    return Array.from(seen.entries()).map(([filePath, info]) => ({
      filePath,
      operationLabel: info.operationLabel,
      count: info.count,
    }));
  }, [messages]);

  const hasSessionChanges = sessionChangedFiles.length > 0;

  useEffect(() => {
    const firstPath = hasSessionChanges
      ? sessionChangedFiles[0]?.filePath
      : gitSnapshot.changedFiles[0]?.path;
    setSelectedFilePath(firstPath ?? '');
    setDiffPayload(null);
  }, [sessionChangedFiles, gitSnapshot.changedFiles, hasSessionChanges, session.id]);

  useEffect(() => {
    if (!selectedFilePath) {
      setDiffPayload(null);
      return;
    }

    const loadDiff = async () => {
      setIsLoadingDiff(true);
      try {
        const payload = await onRequestDiff(selectedFilePath);
        setDiffPayload(payload);
      } catch {
        setDiffPayload({
          filePath: selectedFilePath,
          kind: 'missing',
          content: 'Failed to load diff for this file.',
        });
      } finally {
        setIsLoadingDiff(false);
      }
    };

    void loadDiff();
  }, [onRequestDiff, selectedFilePath]);

  const formatTaskDuration = (durationMs: number) => {
    if (durationMs < 1000) {
      return `${durationMs} ms`;
    }
    if (durationMs < 60_000) {
      return `${(durationMs / 1000).toFixed(1)} s`;
    }
    return `${(durationMs / 60_000).toFixed(1)} min`;
  };

  return (
    <aside className="context-pane">
      <div className="context-block">
        <p className="section-kicker">thinking status</p>
        <h2>Thinking 状态</h2>
        <div className={`setting-status-card${effortMatches ? ' is-applied' : ' is-pending'}`}>
          <div className="setting-status-head">
            <strong>{effortStatusLabel}</strong>
            <span>
              Requested {requestedEffort}
              {appliedEffort ? ` · Active ${appliedEffort}` : ''}
            </span>
          </div>
          <p>
            {appliedEffort
              ? effortMatches
                ? '当前 Claude session 已经应用了这个 effort。'
                : '当前 Claude session 还没有应用新的 effort；重启后才会切过去。'
              : '当前 session 还没有上报已应用 effort。'}
          </p>
        </div>
      </div>

      <div className="context-block">
        <p className="section-kicker">background tasks</p>
        <h2>后台任务</h2>
        {backgroundTasks.length > 0 ? (
          <div className="background-task-list">
            {backgroundTasks.map((task) => (
              <div key={task.taskId} className={`background-task-card status-${task.status}`}>
                <div className="background-task-head">
                  <strong>{task.description}</strong>
                  <span className={`background-task-status status-${task.status}`}>{task.status}</span>
                </div>
                <div className="background-task-meta">
                  <span>{task.taskType ?? 'task'}</span>
                  {task.lastToolName ? <span>last tool: {task.lastToolName}</span> : null}
                  {task.usage ? (
                    <span>
                      {task.usage.totalTokens} tk / {task.usage.toolUses} tools /{' '}
                      {formatTaskDuration(task.usage.durationMs)}
                    </span>
                  ) : null}
                </div>
                {task.summary ? <p className="background-task-summary">{task.summary}</p> : null}
                {task.outputFile ? <code className="background-task-output">{task.outputFile}</code> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="changed-file-card empty">
            <strong>没有后台任务</strong>
            <p>这里只显示当前轮的后台任务；发送下一条消息后会清空上一轮。</p>
          </div>
        )}
      </div>

      <div className="context-block">
        <p className="section-kicker">branch state</p>
        <h2>分支状态</h2>
        <div className="branch-summary">
          <strong>{gitSnapshot.branch}</strong>
          <span>{gitSnapshot.source === 'git' ? 'live git' : 'mock snapshot'}</span>
        </div>
        <div className="meta-list">
          <div>
            <span>Tracking</span>
            <strong>{gitSnapshot.tracking ?? 'No remote tracking'}</strong>
          </div>
          <div>
            <span>Sync</span>
            <strong>
              ahead {gitSnapshot.ahead} / behind {gitSnapshot.behind}
            </strong>
          </div>
          <div>
            <span>Dirty</span>
            <strong>{gitSnapshot.dirty ? 'Working tree changed' : 'Clean'}</strong>
          </div>
        </div>
      </div>

      <div className="context-block">
        <p className="section-kicker">{hasSessionChanges ? 'session changes' : 'changed content'}</p>
        <h2>当前改动</h2>
        <div className="changed-file-list">
          {hasSessionChanges ? (
            sessionChangedFiles.map((file) => (
              <button
                key={file.filePath}
                type="button"
                className={`changed-file-card diff-trigger${selectedFilePath === file.filePath ? ' selected' : ''}`}
                onClick={() => setSelectedFilePath(file.filePath)}
              >
                <div className="changed-file-head">
                  <strong>{file.filePath}</strong>
                  <span>{file.operationLabel}</span>
                </div>
                {file.count > 1 ? <p>{file.count} operations</p> : null}
              </button>
            ))
          ) : gitSnapshot.changedFiles.length > 0 ? (
            gitSnapshot.changedFiles.map((file) => (
              <button
                key={file.path}
                type="button"
                className={`changed-file-card diff-trigger${selectedFilePath === file.path ? ' selected' : ''}`}
                onClick={() => setSelectedFilePath(file.path)}
              >
                <div className="changed-file-head">
                  <strong>{file.path}</strong>
                  <span>{file.status}</span>
                </div>
                <p>
                  +{file.additions} / -{file.deletions}
                </p>
              </button>
            ))
          ) : (
            <div className="changed-file-card empty">
              <strong>没有未提交改动</strong>
              <p>当前工作树是干净的。</p>
            </div>
          )}
        </div>

        {selectedFilePath ? (
          <div className="diff-viewer">
            <div className="diff-header">
              <strong>{selectedFilePath}</strong>
              <span>{isLoadingDiff ? 'loading...' : diffPayload?.kind ?? 'diff'}</span>
            </div>
            {isLoadingDiff ? (
              <pre>Loading diff...</pre>
            ) : (
              <DiffContent payload={diffPayload} />
            )}
          </div>
        ) : null}
      </div>

      <div className="context-block">
        <p className="section-kicker">harness</p>
        <h2>Long-Running Harness</h2>
        <div className="meta-list">
          <div>
            <span>Provider</span>
            <strong>{providerName}</strong>
          </div>
          <div>
            <span>Kind</span>
            <strong>{session.sessionKind ?? 'standard'}</strong>
          </div>
          <div>
            <span>Artifact dir</span>
            <strong>{session.harnessState?.artifactDir ?? session.harness?.artifactDir ?? 'not bootstrapped'}</strong>
          </div>
        </div>
        {!harnessSupported ? (
          <p className="harness-panel-note">Harness is currently available only for Claude sessions.</p>
        ) : session.sessionKind !== 'harness' ? canBootstrapHarness ? (
          <button
            type="button"
            className="mini-action primary"
            onClick={onBootstrapHarness}
            disabled={isBootstrappingHarness || isRunningHarness}
          >
            {isBootstrappingHarness ? 'Bootstrapping...' : 'Bootstrap Harness'}
          </button>
        ) : (
          <p className="harness-panel-note">Harness becomes available after this session has real task context.</p>
        ) : (
          <button
            type="button"
            className="mini-action primary"
            onClick={onRunHarness}
            disabled={!canRunHarness || isBootstrappingHarness || isRunningHarness}
          >
            {isRunningHarness ? 'Running Harness...' : 'Run Harness'}
          </button>
        )}
      </div>

      <div className="context-block">
        <p className="section-kicker">session meta</p>
        <div className="meta-list">
          <div>
            <span>Workspace</span>
            <strong>{session.workspace}</strong>
          </div>
          <div>
            <span>Project</span>
            <strong>{session.projectName}</strong>
          </div>
          <div>
            <span>Streamwork</span>
            <strong>{session.dreamName}</strong>
          </div>
          <div>
            <span>Injected refs</span>
            <strong>{session.contextReferences?.length ?? 0}</strong>
          </div>
          <div>
            <span>Desktop build</span>
            <strong>{appVersion}</strong>
          </div>
        </div>
      </div>
    </aside>
  );
}

const areContextPanelPropsEqual = (current: ContextPanelProps, next: ContextPanelProps) =>
  current.session === next.session &&
  current.messages === next.messages &&
  current.interaction === next.interaction &&
  current.requestedEffort === next.requestedEffort &&
  current.appVersion === next.appVersion &&
  current.gitSnapshot === next.gitSnapshot &&
  current.canBootstrapHarness === next.canBootstrapHarness &&
  current.canRunHarness === next.canRunHarness &&
  current.isBootstrappingHarness === next.isBootstrappingHarness &&
  current.isRunningHarness === next.isRunningHarness;

export const ContextPanel = memo(ContextPanelComponent, areContextPanelPropsEqual);
