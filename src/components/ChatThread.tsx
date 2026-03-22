import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationMessage, SessionSummary } from '../data/types';

type ChatThreadProps = {
  session: SessionSummary;
  messages: ConversationMessage[];
};

type DisplayItem =
  | { type: 'message'; message: ConversationMessage }
  | { type: 'trace-group'; id: string; items: ConversationMessage[] };

const shouldShowTitle = (message: ConversationMessage) => {
  if (message.kind && message.kind !== 'message') {
    return true;
  }

  const normalizedTitle = message.title.trim();
  const normalizedContent = message.content.trim();
  if (!normalizedTitle || !normalizedContent) {
    return Boolean(normalizedTitle);
  }

  return normalizedTitle !== normalizedContent && !normalizedContent.startsWith(normalizedTitle);
};

const normalizeMessages = (messages: ConversationMessage[]) => {
  const result: ConversationMessage[] = [];
  let activeTrace: ConversationMessage | null = null;

  const flushTrace = () => {
    if (activeTrace) {
      result.push(activeTrace);
      activeTrace = null;
    }
  };

  for (const message of messages) {
    if (message.role !== 'system') {
      flushTrace();
      result.push(message);
      continue;
    }

    if (message.kind === 'thinking') {
      const text = message.content.trim();
      if (!text || text === 'Thinking step captured.' || text === 'Thinking was redacted by provider.') {
        continue;
      }
    }

    if (message.kind === 'tool_use') {
      flushTrace();
      activeTrace = {
        ...message,
        content: message.content.trim(),
        status:
          message.status === 'error'
            ? 'error'
            : message.status === 'success'
              ? 'success'
              : message.status === 'complete'
                ? 'complete'
                : 'running',
      };
      continue;
    }

    if ((message.kind === 'progress' || message.kind === 'tool_result') && activeTrace) {
      const extra = message.content.trim();
      activeTrace = {
        ...activeTrace,
        content: extra ? `${activeTrace.content}\n${extra}` : activeTrace.content,
        status:
          message.status === 'error'
            ? 'error'
            : message.kind === 'tool_result'
              ? 'success'
              : activeTrace.status,
      };
      continue;
    }

    flushTrace();
    result.push(message);
  }

  flushTrace();
  return result;
};

const buildDisplayItems = (messages: ConversationMessage[]): DisplayItem[] => {
  const normalized = normalizeMessages(messages);
  const items: DisplayItem[] = [];

  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];

    if (current.role === 'assistant') {
      const systemRun: ConversationMessage[] = [];
      let nextIndex = index + 1;
      while (nextIndex < normalized.length && normalized[nextIndex].role === 'system') {
        systemRun.push(normalized[nextIndex]);
        nextIndex += 1;
      }

      if (systemRun.length > 0) {
        items.push({
          type: 'trace-group',
          id: `trace-group-${current.id}`,
          items: systemRun,
        });
        items.push({ type: 'message', message: current });
        index = nextIndex - 1;
        continue;
      }
    }

    if (current.role === 'system') {
      const systemRun: ConversationMessage[] = [current];
      let nextIndex = index + 1;
      while (nextIndex < normalized.length && normalized[nextIndex].role === 'system') {
        systemRun.push(normalized[nextIndex]);
        nextIndex += 1;
      }

      items.push({
        type: 'trace-group',
        id: `trace-group-${current.id}`,
        items: systemRun,
      });
      index = nextIndex - 1;
      continue;
    }

    items.push({ type: 'message', message: current });
  }

  return items;
};

export function ChatThread({ session, messages }: ChatThreadProps) {
  const displayItems = useMemo(() => buildDisplayItems(messages), [messages]);
  const [openTraceIds, setOpenTraceIds] = useState<Record<string, boolean>>({});
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
  }, [displayItems]);

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <div>
          <p className="section-kicker">
            {session.projectName} / Streamwork: {session.dreamName}
          </p>
          <h1>{session.title}</h1>
          <div className="session-tags">
            {session.groups.map((group) => (
              <span key={group.id} className="session-tag" style={{ borderColor: group.color, color: group.color }}>
                {group.name}
              </span>
            ))}
            <span className="session-tag process-tag">
              {traceSummary.tools} tools · {traceSummary.progress} progress · {traceSummary.thinking} thinking
            </span>
          </div>
        </div>
        <div className="chat-actions">
          <button type="button" className="header-button">
            Context
          </button>
          <button type="button" className="header-button active">
            Session
          </button>
        </div>
      </header>

      <div ref={streamRef} className="message-stream">
        {displayItems.map((item) =>
          item.type === 'trace-group' ? (
            <section key={item.id} className="trace-group-card">
              <div className="trace-group-head">
                <strong>Process</strong>
                <span>{item.items.length} steps</span>
              </div>

                <div className="trace-group-list">
                  {item.items.map((message) => {
                    const hasDetails = Boolean(message.content.trim());
                    const isOpen = hasDetails && Boolean(openTraceIds[message.id]);

                    return (
                      <article key={message.id} className={`trace-row ${message.kind ?? 'progress'}`}>
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
                          <strong>
                            {shouldShowTitle(message) ? message.title : message.content.split('\n')[0]?.slice(0, 72) ?? 'Trace'}
                          </strong>
                          <span className="trace-arrow">{hasDetails ? (isOpen ? '▾' : '▸') : ''}</span>
                        </button>
                        {isOpen ? (
                          <div className="markdown-body trace-markdown">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
          ) : (
            <article key={item.message.id} className={`message-card ${item.message.role}${item.message.role === 'assistant' ? ' final-reply' : ''}`}>
              <div className="message-meta">
                <span className={`message-role ${item.message.role}`}>{item.message.role === 'user' ? 'You' : 'Claude'}</span>
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
      </div>
    </section>
  );
}
