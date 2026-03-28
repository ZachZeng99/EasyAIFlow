import { useEffect, useState } from 'react';
import { DiffContent } from './DiffContent';
import type { DiffPayload, GitSnapshot, SessionSummary } from '../data/types';

type ContextPanelProps = {
  session: SessionSummary;
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

export function ContextPanel({
  session,
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
  const [selectedFilePath, setSelectedFilePath] = useState<string>('');
  const [diffPayload, setDiffPayload] = useState<DiffPayload | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);

  useEffect(() => {
    setSelectedFilePath(gitSnapshot.changedFiles[0]?.path ?? '');
    setDiffPayload(null);
  }, [gitSnapshot.changedFiles, session.id]);

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

  return (
    <aside className="context-pane">
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
        <p className="section-kicker">changed content</p>
        <h2>当前改动</h2>
        <div className="changed-file-list">
          {gitSnapshot.changedFiles.length > 0 ? (
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
            <span>Kind</span>
            <strong>{session.sessionKind ?? 'standard'}</strong>
          </div>
          <div>
            <span>Artifact dir</span>
            <strong>{session.harnessState?.artifactDir ?? session.harness?.artifactDir ?? 'not bootstrapped'}</strong>
          </div>
        </div>
        {session.sessionKind !== 'harness' ? canBootstrapHarness ? (
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
