import type { TokenUsage } from '../data/types';

export type BtwMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  status?: 'streaming' | 'complete' | 'error';
};

type BtwPanelProps = {
  isOpen: boolean;
  draft: string;
  messages: BtwMessage[];
  isSending: boolean;
  tokenUsage?: TokenUsage;
  inheritedContext: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onClose: () => void;
};

const formatTokens = (value: number) => {
  if (value >= 1000000) {
    return `${(Math.round((value / 1000000) * 10) / 10).toString().replace(/\.0$/, '')}M`;
  }
  if (value >= 1000) {
    return `${(Math.round((value / 1000) * 10) / 10).toString().replace(/\.0$/, '')}k`;
  }
  return `${value}`;
};

export function BtwPanel({
  isOpen,
  draft,
  messages,
  isSending,
  tokenUsage,
  inheritedContext,
  onDraftChange,
  onSend,
  onClose,
}: BtwPanelProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <section className="btw-panel">
      <div className="btw-panel-head">
        <div>
          <p className="section-kicker">temporary q&a</p>
          <h2>BTW</h2>
          <p className="btw-context-note">
            {inheritedContext ? '继承当前正式会话上下文' : '未继承正式会话上下文，仅使用当前工作区环境'}
          </p>
        </div>
        <div className="btw-panel-actions">
          {tokenUsage ? (
            <span className="btw-token-usage">
              {formatTokens(tokenUsage.used)} / {tokenUsage.contextWindow > 0 ? formatTokens(tokenUsage.contextWindow) : '--'}
            </span>
          ) : null}
          <button type="button" className="header-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="btw-message-list">
        {messages.length > 0 ? (
          messages.map((message) => (
            <article key={message.id} className={`btw-message ${message.role}`}>
              <div className="message-meta">
                <span className={`message-role ${message.role}`}>{message.role === 'user' ? 'You' : 'Claude'}</span>
                <span>{message.timestamp}</span>
                {message.status ? <span className={`message-status ${message.status}`}>{message.status}</span> : null}
              </div>
              <pre className="message-body">{message.content}</pre>
            </article>
          ))
        ) : (
          <div className="btw-empty">输入 `/btw 你的问题`，或者直接在这里追问。</div>
        )}
      </div>

      <div className="btw-composer">
        <textarea
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="临时问一句，不进入正式 session。"
          rows={3}
        />
        <button type="button" className="send-button" onClick={onSend} disabled={isSending || !draft.trim()}>
          {isSending ? '发送中' : '发送'}
        </button>
      </div>
    </section>
  );
}
