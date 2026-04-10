import { memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiffContent } from './DiffContent';
import { InlinePermissionCard } from './InlinePermissionCard';
import { InlineAskUserQuestionCard } from './InlineAskUserQuestionCard';
import { InlinePlanModeCard } from './InlinePlanModeCard';
import { getDisplayedCodeChangeDiff, shouldRequestCodeChangeDiff } from '../data/codeChangeDiff';
import { parsePermissionRequest, type PermissionRequest } from '../data/permissionRequest';
import { getProviderBadgeLabel, getProviderDisplayName, normalizeSessionProvider } from '../data/sessionProvider';
import { buildDisplayItems, shouldShowTitle } from '../data/chatThreadDisplay';
import type { AskUserQuestionDraft } from '../data/askUserQuestion';
import type { PlanModeResponsePayload } from '../data/planMode';
import {
  getActiveSessionPermissionRequest,
  type SessionInteractionState,
} from '../data/sessionInteraction';
import type { ConversationMessage, DiffPayload, SessionSummary } from '../data/types';

const isTraceErrorStatus = (status: ConversationMessage['status']) => status === 'error';

const getTracePreview = (message: ConversationMessage) => {
  if (!isTraceErrorStatus(message.status)) {
    return '';
  }

  const lines = message.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '';
  }

  const ranked =
    [...lines]
      .reverse()
      .find((line) =>
        /(error|failed|interrupted|denied|rejected|timed out|timeout|exit code|not found|cannot|can't|unable|stopped)/i.test(
          line,
        ),
      ) ??
    [...lines]
      .reverse()
      .find((line) => !/^[\[\]{}(),:]+$/.test(line)) ??
    lines[lines.length - 1];

  return ranked.length > 160 ? `${ranked.slice(0, 157)}...` : ranked;
};

type ChatThreadProps = {
  session: SessionSummary;
  messages: ConversationMessage[];
  isLoadingHistory?: boolean;
  isCliOnline?: boolean;
  onDisconnect?: () => void;
  onRequestPermission?: (request: PermissionRequest) => void;
  onRequestDiff?: (filePath: string) => Promise<DiffPayload>;
  interaction?: SessionInteractionState;
  onGrantPermission?: () => void;
  onDenyPermission?: () => void;
  onSubmitAskUserQuestion?: (draft?: AskUserQuestionDraft) => void;
  onSubmitPlanMode?: (payload: PlanModeResponsePayload) => void;
};

function ChatThreadComponent({
  session,
  messages,
  isLoadingHistory = false,
  isCliOnline = false,
  onDisconnect,
  onRequestPermission,
  onRequestDiff,
  interaction,
  onGrantPermission,
  onDenyPermission,
  onSubmitAskUserQuestion,
  onSubmitPlanMode,
}: ChatThreadProps) {
  const providerName = getProviderDisplayName(session.provider);
  const displayItems = useMemo(() => buildDisplayItems(messages), [messages]);
  const activePermissionRequest = getActiveSessionPermissionRequest(interaction);
  const showDisconnectAction = isCliOnline && Boolean(onDisconnect);
  const [openTraceIds, setOpenTraceIds] = useState<Record<string, boolean>>({});
  const [openTraceGroupIds, setOpenTraceGroupIds] = useState<Record<string, boolean>>({});
  const [openCodeChangeGroupIds, setOpenCodeChangeGroupIds] = useState<Record<string, boolean>>({});
  const [openCodeChangeIds, setOpenCodeChangeIds] = useState<Record<string, boolean>>({});
  const [codeChangeDiffs, setCodeChangeDiffs] = useState<Record<string, DiffPayload | null>>({});
  const [loadingCodeChangeDiffIds, setLoadingCodeChangeDiffIds] = useState<Record<string, boolean>>({});
  const streamRef = useRef<HTMLDivElement | null>(null);

  const traceSummary = useMemo(() => {
    const traceItems = displayItems.flatMap((item) => (item.type === 'trace-group' ? item.items : []));
    return {
      thinking: traceItems.filter((message) => message.kind === 'thinking').length,
      tools: traceItems.filter((message) => message.kind === 'tool_use').length,
      progress: traceItems.filter((message) => message.kind === 'progress').length,
    };
  }, [displayItems]);

  useEffect(() => {
    const element = streamRef.current;
    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [displayItems, interaction]);

  useEffect(() => {
    setOpenCodeChangeGroupIds({});
    setOpenCodeChangeIds({});
    setCodeChangeDiffs({});
    setLoadingCodeChangeDiffIds({});
  }, [session.id]);

  const toggleCodeChange = async (changeId: string, filePath: string, recordedDiff?: DiffPayload) => {
    const nextOpen = !openCodeChangeIds[changeId];
    const currentPayload = getDisplayedCodeChangeDiff({
      recordedPayload: recordedDiff,
      loadedPayload: codeChangeDiffs[changeId],
    });
    const isLoadingDiff = Boolean(loadingCodeChangeDiffIds[changeId]);
    const requestDiff = onRequestDiff;
    setOpenCodeChangeIds((current) => ({
      ...current,
      [changeId]: nextOpen,
    }));

    if (
      !shouldRequestCodeChangeDiff({
        nextOpen,
        hasRequestDiff: Boolean(requestDiff),
        currentPayload,
        isLoading: isLoadingDiff,
      })
    ) {
      return;
    }

    if (!requestDiff) {
      return;
    }

    setLoadingCodeChangeDiffIds((current) => ({
      ...current,
      [changeId]: true,
    }));

    try {
      const payload = await requestDiff(filePath);
      setCodeChangeDiffs((current) => ({
        ...current,
        [changeId]: payload,
      }));
    } catch {
      setCodeChangeDiffs((current) => ({
        ...current,
        [changeId]: {
          filePath,
          kind: 'missing',
          content: 'Failed to load diff for this file.',
        },
      }));
    } finally {
      setLoadingCodeChangeDiffIds((current) => ({
        ...current,
        [changeId]: false,
      }));
    }
  };

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <div className="chat-header-main">
          <p className="section-kicker">
            {session.projectName} / Streamwork: {session.dreamName}
          </p>
          <h1>{session.title}</h1>
          <div className="session-tags">
            {isCliOnline ? (
              <span className="session-tag cli-status" aria-label="CLI online">
                <span className="cli-status-dot" aria-hidden="true" />
                CLI
              </span>
            ) : null}
            {session.groups.map((group) => (
              <span key={group.id} className="session-tag" style={{ borderColor: group.color, color: group.color }}>
                {group.name}
              </span>
            ))}
            <span className="session-tag process-tag">
              {traceSummary.tools} tools · {traceSummary.progress} progress · {traceSummary.thinking} thinking
            </span>
            <span className={`session-tag provider-pill provider-${normalizeSessionProvider(session.provider)}`}>
              {getProviderBadgeLabel(session.provider)}
            </span>
          </div>
        </div>
        {showDisconnectAction ? (
          <div className="chat-actions">
            <button
              type="button"
              className="disconnect-button"
              aria-label="Disconnect session"
              title="Disconnect session"
              onClick={onDisconnect}
            >
              <span aria-hidden="true">🔌</span>
            </button>
          </div>
        ) : null}
      </header>

      <div ref={streamRef} className="message-stream">
        {displayItems.length === 0 && !activePermissionRequest && !interaction?.askUserQuestion && !interaction?.planModeRequest ? (
          <div className="thread-placeholder">
            {isLoadingHistory ? 'Loading session history...' : 'No saved messages in this session.'}
          </div>
        ) : null}

        {displayItems.map((item) =>
          item.type === 'trace-group' ? (
            (() => {
              const isGroupOpen = openTraceGroupIds[item.id] ?? item.items.some((message) => isTraceErrorStatus(message.status));

              return (
                <section
                  key={item.id}
                  className={`trace-group-card${isGroupOpen ? ' expanded' : ' collapsed'}`}
                >
              <button
                type="button"
                className="trace-group-head"
                aria-expanded={isGroupOpen}
                onClick={() =>
                  setOpenTraceGroupIds((current) => ({
                    ...current,
                    [item.id]: !isGroupOpen,
                  }))
                }
              >
                <div className="trace-group-summary">
                  <strong>Process</strong>
                  <span>{item.items.length} steps</span>
                </div>
                <span className="trace-arrow">{isGroupOpen ? '▾' : '▸'}</span>
              </button>

              {isGroupOpen ? (
                <div className="trace-group-list">
                  {item.items.map((message) => {
                    const hasDetails = Boolean(message.content.trim());
                    const isOpen = hasDetails && Boolean(openTraceIds[message.id]);
                    const preview = !isOpen ? getTracePreview(message) : '';

                    return (
                      <article
                        key={message.id}
                        className={`trace-row ${message.kind ?? 'progress'} ${message.status ?? 'running'}`}
                      >
                        <button
                          type="button"
                          className="trace-toggle"
                          onClick={() => {
                            if (!hasDetails) {
                              return;
                            }

                            setOpenTraceIds((current) => ({
                              ...current,
                              [message.id]: !current[message.id],
                            }));
                          }}
                        >
                          <div className="trace-meta">
                            <span className={`trace-dot ${message.status ?? 'running'}`} />
                            <span className="trace-kind">{message.kind ?? 'trace'}</span>
                            <span>{message.timestamp}</span>
                          </div>
                          <div className="trace-copy">
                            <strong>
                              {shouldShowTitle(message) ? message.title : message.content.split('\n')[0]?.slice(0, 72) ?? 'Trace'}
                            </strong>
                            {preview ? <span className="trace-preview">{preview}</span> : null}
                          </div>
                          <span className="trace-arrow">{hasDetails ? (isOpen ? '▾' : '▸') : ''}</span>
                        </button>
                        {isOpen ? (
                          <div className="markdown-body trace-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                            {(() => {
                              const request = parsePermissionRequest(message.content);
                              if (!request || !onRequestPermission) {
                                return null;
                              }

                              return (
                                <button
                                  type="button"
                                  className="dialog-button primary"
                                  onClick={() => onRequestPermission(request)}
                                >
                                  Grant Access
                                </button>
                              );
                            })()}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              ) : null}
            </section>
              );
            })()
          ) : (
            <article key={item.message.id} className={`message-card ${item.message.role}${item.message.role === 'assistant' ? ' final-reply' : ''}`}>
              <div className="message-meta">
                <span className={`message-role ${item.message.role}`}>{item.message.role === 'user' ? 'You' : providerName}</span>
                <span>{item.message.timestamp}</span>
                {item.message.status ? <span className={`message-status ${item.message.status}`}>{item.message.status}</span> : null}
              </div>

              {shouldShowTitle(item.message) ? <h2>{item.message.title}</h2> : null}

              {item.message.role === 'assistant' ? (
                <div className="markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content}</ReactMarkdown>
                </div>
              ) : (
                <pre className="message-body">{item.message.content}</pre>
              )}

              {item.type === 'message' && item.message.role === 'assistant' && (item.codeChanges?.length ?? 0) > 0 ? (
                <section
                  className={`code-change-section${openCodeChangeGroupIds[item.message.id] ? ' expanded' : ' collapsed'}`}
                >
                  <button
                    type="button"
                    className="code-change-head"
                    aria-expanded={Boolean(openCodeChangeGroupIds[item.message.id])}
                    onClick={() =>
                      setOpenCodeChangeGroupIds((current) => ({
                        ...current,
                        [item.message.id]: !current[item.message.id],
                      }))
                    }
                  >
                    <div className="code-change-summary">
                      <strong>Code Changes</strong>
                      <span>
                        {item.codeChanges?.length} file{item.codeChanges?.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <span className="trace-arrow">{openCodeChangeGroupIds[item.message.id] ? '▾' : '▸'}</span>
                  </button>

                  {openCodeChangeGroupIds[item.message.id] ? (
                    <div className="code-change-list">
                      {item.codeChanges?.map((change) => {
                        const isOpen = Boolean(openCodeChangeIds[change.id]);
                        const diffPayload = getDisplayedCodeChangeDiff({
                          recordedPayload: change.recordedDiff,
                          loadedPayload: codeChangeDiffs[change.id],
                        });
                        const isLoadingDiff = Boolean(loadingCodeChangeDiffIds[change.id]);

                        return (
                          <article key={change.id} className={`code-change-card${isOpen ? ' expanded' : ''}`}>
                            <button
                              type="button"
                              className="code-change-toggle"
                              aria-expanded={isOpen}
                              onClick={() => {
                                void toggleCodeChange(change.id, change.filePath, change.recordedDiff);
                              }}
                            >
                              <div className="code-change-card-copy">
                                <div className="code-change-card-head">
                                  <strong>{change.filePath}</strong>
                                  <span className="code-change-badge">{change.operationLabel}</span>
                                </div>
                                <p>{change.summary}</p>
                              </div>
                              <span className="trace-arrow">{isOpen ? '▾' : '▸'}</span>
                            </button>

                            {isOpen ? (
                              <div className="code-change-body">
                                {isLoadingDiff ? (
                                  <pre>Loading diff...</pre>
                                ) : diffPayload ? (
                                  <div className="diff-viewer inline">
                                    <div className="diff-header">
                                      <strong>{change.filePath}</strong>
                                      <span>{diffPayload.kind}</span>
                                    </div>
                                    <DiffContent payload={diffPayload} />
                                  </div>
                                ) : (
                                  <pre>{change.details}</pre>
                                )}
                              </div>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {item.message.contextReferences && item.message.contextReferences.length > 0 ? (
                <div className="message-context-reference-list">
                  <p className="message-context-reference-title">Referenced Context</p>
                  <div className="message-attachment-list">
                    {item.message.contextReferences.map((reference) => (
                      <span key={reference.id} className="message-attachment-chip context-reference-chip">
                        {reference.label} · {reference.mode}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {item.message.attachments && item.message.attachments.length > 0 ? (
                <div className="message-attachment-list">
                  {item.message.attachments.map((attachment) => (
                    <span key={attachment.id} className="message-attachment-chip">
                      {attachment.name}
                    </span>
                  ))}
                </div>
              ) : null}
            </article>
          ),
        )}

        {activePermissionRequest ? (
          <InlinePermissionCard
            request={activePermissionRequest}
            busy={Boolean(interaction?.isGrantingPermission)}
            onGrant={() => onGrantPermission?.()}
            onDeny={() => onDenyPermission?.()}
          />
        ) : null}

        {interaction?.askUserQuestion ? (
          <InlineAskUserQuestionCard
            toolUseId={interaction.askUserQuestion.toolUseId}
            questions={interaction.askUserQuestion.questions}
            busy={Boolean(interaction.isSubmittingAskUserQuestion)}
            onSkip={() => onSubmitAskUserQuestion?.()}
            onSubmit={(draft) => onSubmitAskUserQuestion?.(draft)}
          />
        ) : null}

        {interaction?.planModeRequest ? (
          <InlinePlanModeCard
            request={interaction.planModeRequest.request}
            busy={Boolean(interaction.isSubmittingPlanMode)}
            onSubmit={(payload) => onSubmitPlanMode?.(payload)}
          />
        ) : null}
      </div>
    </section>
  );
}

const areChatThreadPropsEqual = (current: ChatThreadProps, next: ChatThreadProps) =>
  current.session === next.session &&
  current.messages === next.messages &&
  current.isLoadingHistory === next.isLoadingHistory &&
  current.isCliOnline === next.isCliOnline &&
  current.interaction === next.interaction;

export const ChatThread = memo(ChatThreadComponent, areChatThreadPropsEqual);
