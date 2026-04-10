import { memo, useEffect, useMemo, useState } from 'react';
import { getProviderBadgeLabel, normalizeSessionProvider } from '../data/sessionProvider';
import { sortDreamsWithTemporaryFirst } from '../data/streamworkOrder';
import type { DreamRecord, ProjectRecord, SessionActivityState, SessionSummary } from '../data/types';

type ChatHistoryProps = {
  projects: ProjectRecord[];
  selectedSessionId: string;
  sessionIndicators: Record<string, { state: SessionActivityState; online?: boolean }>;
  onOpenProject: () => void;
  onCloseProject: (projectId: string) => void;
  onCreateStreamwork: (projectId: string) => void;
  onRenameStreamwork: (streamworkId: string, name: string) => void;
  onDeleteStreamwork: (streamworkId: string) => void;
  onCreateSession: (streamworkId: string) => void;
  onRenameSession: (sessionId: string, name: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onCopySessionReference: (sessionId: string) => void;
  onReorderStreamworks: (projectId: string, sourceId: string, targetId: string) => void;
  onSelectSession: (session: SessionSummary) => void;
};

type EditingState = {
  kind: 'streamwork' | 'session';
  id: string;
  value: string;
};

const formatTokenCount = (value: number) => {
  if (value >= 1_000_000) {
    const formatted = value / 1_000_000;
    return `${formatted >= 10 ? formatted.toFixed(0) : formatted.toFixed(1)}m`;
  }

  if (value >= 1_000) {
    const formatted = value / 1_000;
    return `${formatted >= 10 ? formatted.toFixed(0) : formatted.toFixed(1)}k`;
  }

  return `${value}`;
};

const sortSessionsByLatest = <T extends SessionSummary>(sessions: T[]) =>
  [...sessions].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

function ActionButton({
  label,
  title,
  onClick,
  tone = 'default',
}: {
  label: string;
  title: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      className={`mini-action${tone === 'danger' ? ' danger' : ''}`}
      title={title}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </button>
  );
}

function ChatHistoryComponent({
  projects,
  selectedSessionId,
  sessionIndicators,
  onOpenProject,
  onCloseProject,
  onCreateStreamwork,
  onRenameStreamwork,
  onDeleteStreamwork,
  onCreateSession,
  onRenameSession,
  onDeleteSession,
  onCopySessionReference,
  onReorderStreamworks,
  onSelectSession,
}: ChatHistoryProps) {
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [collapsedStreamworks, setCollapsedStreamworks] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [draggingStreamwork, setDraggingStreamwork] = useState<{ projectId: string; streamworkId: string } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handleWindowClick = () => setContextMenu(null);
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    window.addEventListener('click', handleWindowClick);
    window.addEventListener('contextmenu', handleWindowClick);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('contextmenu', handleWindowClick);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  const handleSelectSession = (session: SessionSummary) => {
    setContextMenu(null);
    setCollapsedProjects((current) => ({
      ...current,
      [session.projectId]: false,
    }));
    setCollapsedStreamworks((current) => ({
      ...current,
      [session.dreamId]: false,
    }));
    onSelectSession(session);
  };

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return projects.map((project) => ({
        ...project,
        dreams: sortDreamsWithTemporaryFirst(project.dreams).map((dream) => ({
          ...dream,
          sessions: sortSessionsByLatest(dream.sessions.filter((session) => !(session as SessionSummary).hidden && (session as SessionSummary).sessionKind !== 'harness_role')),
        })),
      }));
    }

    const matches = (value: string) => value.toLowerCase().includes(query);

    return projects
      .map((project) => {
        const projectMatch = matches(project.name) || matches(project.rootPath);
        const dreams = project.dreams
          .map((dream) => {
            const dreamMatch = matches(dream.name);
            const sessions = dream.sessions.filter(
              (session) =>
                !(session as SessionSummary).hidden && (session as SessionSummary).sessionKind !== 'harness_role' &&
                (projectMatch ||
                  dreamMatch ||
                  matches(session.title) ||
                  matches(session.preview) ||
                  matches(session.workspace)),
            );

            if (!projectMatch && !dreamMatch && sessions.length === 0) {
              return null;
            }

            return {
              ...dream,
              sessions: sortSessionsByLatest(
                (projectMatch || dreamMatch ? dream.sessions : sessions).filter(
                  (session) => !(session as SessionSummary).hidden && (session as SessionSummary).sessionKind !== 'harness_role',
                ),
              ),
            };
          })
          .filter((dream): dream is DreamRecord => Boolean(dream));

        if (!projectMatch && dreams.length === 0) {
          return null;
        }

        return {
          ...project,
          dreams: sortDreamsWithTemporaryFirst(
            (projectMatch ? project.dreams : dreams).map((dream) => ({
              ...dream,
              sessions: dream.sessions.filter((session) => !(session as SessionSummary).hidden && (session as SessionSummary).sessionKind !== 'harness_role'),
            })),
          ),
        };
      })
      .filter((project): project is ProjectRecord => Boolean(project));
  }, [projects, searchQuery]);

  const commitRename = () => {
    if (!editing?.value.trim()) {
      setEditing(null);
      return;
    }

    if (editing.kind === 'streamwork') {
      onRenameStreamwork(editing.id, editing.value.trim());
    } else {
      onRenameSession(editing.id, editing.value.trim());
    }

    setEditing(null);
  };

  return (
    <aside className="history-pane">
      <div className="brand-row">
        <div>
          <p className="brand-title">EasyAIFlow</p>
          <span className="brand-subtitle">Project / Streamwork / Session</span>
        </div>
      </div>

      <div className="history-actions single">
        <button type="button" className="mini-action primary" onClick={onOpenProject}>
          Open
        </button>
      </div>

      <div className="history-search">
        <input
          type="text"
          value={searchQuery}
          placeholder="Search projects or sessions..."
          aria-label="Search sessions"
          onChange={(event) => setSearchQuery(event.target.value)}
        />
      </div>

      <div className="history-tree">
        {filteredProjects.map((project) => (
          <section key={project.id} className="project-block">
            <div className="integrated-row project-row">
              <button
                type="button"
                className="project-card tree-toggle"
                onClick={() =>
                  setCollapsedProjects((current) => ({
                    ...current,
                    [project.id]: !current[project.id],
                  }))
                }
              >
                <div className="tree-title">
                  <span className={`tree-caret${collapsedProjects[project.id] ? ' collapsed' : ''}`}>⌄</span>
                  <strong>{project.name}</strong>
                </div>
                <div className="tree-copy">
                  <span>{project.rootPath}</span>
                </div>
                <em>{project.dreams.length} streamworks</em>
              </button>
              <div className="tree-actions">
                <ActionButton label="New" title="Create Streamwork" onClick={() => onCreateStreamwork(project.id)} />
                <ActionButton label="X" title="Close Project" tone="danger" onClick={() => onCloseProject(project.id)} />
              </div>
            </div>

            {!collapsedProjects[project.id] ? (
              <div className="dream-list">
                {project.dreams.map((dream) => (
                  <DreamSection
                    key={dream.id}
                    dream={dream}
                    projectId={project.id}
                    selectedSessionId={selectedSessionId}
                    sessionIndicators={sessionIndicators}
                    collapsed={Boolean(collapsedStreamworks[dream.id])}
                    editing={editing}
                    draggingStreamwork={draggingStreamwork}
                    onEditChange={(value) =>
                      setEditing((current) => (current ? { ...current, value } : current))
                    }
                    onStartEdit={(nextEditing) => setEditing(nextEditing)}
                    onCommitEdit={commitRename}
                    onCancelEdit={() => setEditing(null)}
                    onToggle={() =>
                      setCollapsedStreamworks((current) => ({
                        ...current,
                        [dream.id]: !current[dream.id],
                      }))
                    }
                    onCreateSession={onCreateSession}
                    onDeleteStreamwork={onDeleteStreamwork}
                    onDeleteSession={onDeleteSession}
                    onCopySessionReference={onCopySessionReference}
                    onSelectSession={handleSelectSession}
                    onOpenContextMenu={(sessionId, x, y) => setContextMenu({ sessionId, x, y })}
                    onDragStart={() => {
                      if (!dream.isTemporary) {
                        setDraggingStreamwork({ projectId: project.id, streamworkId: dream.id });
                      }
                    }}
                    onDragEnd={() => setDraggingStreamwork(null)}
                    onDropOnStreamwork={(targetId) => {
                      if (draggingStreamwork && draggingStreamwork.projectId === project.id) {
                        onReorderStreamworks(project.id, draggingStreamwork.streamworkId, targetId);
                      }
                      setDraggingStreamwork(null);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>

      {contextMenu ? (
        <div
          className="history-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onCopySessionReference(contextMenu.sessionId);
              setContextMenu(null);
            }}
          >
            Copy reference token
          </button>
        </div>
      ) : null}
    </aside>
  );
}

const areChatHistoryPropsEqual = (current: ChatHistoryProps, next: ChatHistoryProps) =>
  current.projects === next.projects &&
  current.selectedSessionId === next.selectedSessionId &&
  current.sessionIndicators === next.sessionIndicators;

export const ChatHistory = memo(ChatHistoryComponent, areChatHistoryPropsEqual);

function DreamSection({
  dream,
  projectId,
  selectedSessionId,
  sessionIndicators,
  collapsed,
  editing,
  draggingStreamwork,
  onEditChange,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onToggle,
  onCreateSession,
  onDeleteStreamwork,
  onDeleteSession,
  onCopySessionReference,
  onSelectSession,
  onOpenContextMenu,
  onDragStart,
  onDragEnd,
  onDropOnStreamwork,
}: {
  dream: DreamRecord;
  projectId: string;
  selectedSessionId: string;
  sessionIndicators: Record<string, { state: SessionActivityState; online?: boolean }>;
  collapsed: boolean;
  editing: EditingState | null;
  draggingStreamwork: { projectId: string; streamworkId: string } | null;
  onEditChange: (value: string) => void;
  onStartEdit: (editing: EditingState) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onToggle: () => void;
  onCreateSession: (streamworkId: string) => void;
  onDeleteStreamwork: (streamworkId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onCopySessionReference: (sessionId: string) => void;
  onSelectSession: (session: SessionSummary) => void;
  onOpenContextMenu: (sessionId: string, x: number, y: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropOnStreamwork: (targetId: string) => void;
}) {
  const isEditingStreamwork = editing?.kind === 'streamwork' && editing.id === dream.id;

  return (
    <section
      className={`dream-block${draggingStreamwork?.streamworkId === dream.id ? ' dragging' : ''}`}
      draggable={!dream.isTemporary}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        if (!dream.isTemporary) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        if (!dream.isTemporary) {
          event.preventDefault();
          onDropOnStreamwork(dream.id);
        }
      }}
      data-project-id={projectId}
    >
      <div className="integrated-row dream-row">
        <button type="button" className="dream-card tree-toggle" onClick={onToggle}>
          <div className="tree-title">
            <span className={`tree-caret${collapsed ? ' collapsed' : ''}`}>⌄</span>
            {isEditingStreamwork ? (
              <input
                className="inline-rename"
                autoFocus
                value={editing.value}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => onEditChange(event.target.value)}
                onBlur={onCommitEdit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onCommitEdit();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onCancelEdit();
                  }
                }}
              />
            ) : (
              <strong
                onDoubleClick={(event) => {
                  if (dream.isTemporary) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  onStartEdit({
                    kind: 'streamwork',
                    id: dream.id,
                    value: dream.name,
                  });
                }}
              >
                {dream.name}
              </strong>
            )}
          </div>
          <span>{dream.sessions.length} sessions</span>
        </button>

        <div className="tree-actions">
          <ActionButton label="New" title="Create Session" onClick={() => onCreateSession(dream.id)} />
          {!dream.isTemporary ? (
            <ActionButton label="Del" title="Delete Streamwork" tone="danger" onClick={() => onDeleteStreamwork(dream.id)} />
          ) : null}
        </div>
      </div>

      {!collapsed ? (
        <div className="session-lane">
          <div className="session-list">
            {dream.sessions.map((session) => {
              const selected = session.id === selectedSessionId;
              const isEditingSession = editing?.kind === 'session' && editing.id === session.id;
              const indicator = sessionIndicators[session.id] ?? { state: 'idle' as const };
              return (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  className={`session-card provider-${normalizeSessionProvider(session.provider)}${selected ? ' selected' : ''} ${indicator.state}${session.sessionKind === 'harness' ? ' harness' : ''}`}
                  data-provider-label={getProviderBadgeLabel(session.provider)}
                  onClick={() => onSelectSession(session)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectSession(session);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    onOpenContextMenu(session.id, event.clientX, event.clientY);
                  }}
                >
                  <div className="session-card-top">
                    <div className="session-heading">
                      {isEditingSession ? (
                        <input
                          className="inline-rename"
                          autoFocus
                          value={editing.value}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => onEditChange(event.target.value)}
                          onBlur={onCommitEdit}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              onCommitEdit();
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              onCancelEdit();
                            }
                          }}
                        />
                      ) : (
                        <strong
                          onDoubleClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onStartEdit({
                              kind: 'session',
                              id: session.id,
                              value: session.title,
                            });
                          }}
                        >
                          {session.title}
                        </strong>
                      )}
                      {session.sessionKind === 'harness' ? (
                        <span className="session-kind-badge">HARNESS</span>
                      ) : null}
                    </div>
                    <div className="session-actions-inline">
                      <ActionButton
                        label="Ref"
                        title="Copy Session Reference"
                        onClick={() => onCopySessionReference(session.id)}
                      />
                      <ActionButton label="Del" title="Delete Session" tone="danger" onClick={() => onDeleteSession(session.id)} />
                    </div>
                  </div>
                  {indicator.state !== 'idle' || indicator.online ? (
                    <div className="session-card-status">
                      {indicator.online ? (
                        <span className="session-status-badge online">在线</span>
                      ) : null}
                      {indicator.state !== 'idle' ? (
                        <span className={`session-status-badge ${indicator.state}`}>
                          {indicator.state === 'responding'
                            ? '工作中'
                            : indicator.state === 'background'
                              ? '后台中'
                            : indicator.state === 'awaiting_reply'
                              ? '待回复'
                              : '未读'}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="session-card-meta">
                    <span>{session.timeLabel}</span>
                    {session.harness ? <span>{session.harness.role}</span> : null}
                    <span>{formatTokenCount(session.tokenUsage.used)} tk</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
