import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextReference, ContextReferenceMode, TokenUsage } from '../data/types';

export type ComposerAttachment = {
  id: string;
  name: string;
  url: string;
  size: number;
  mimeType: string;
  path?: string;
  dataUrl?: string;
};

type ChatComposerProps = {
  draft: string;
  tokenUsage: TokenUsage;
  sessionModel: string;
  contextReferences: ContextReference[];
  slashCommands: string[];
  attachments: ComposerAttachment[];
  isSending: boolean;
  isResponding: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'max';
  supportsPathDrop?: boolean;
  onDraftChange: (value: string) => void;
  onInsertDroppedPaths: (files: FileList | null) => void;
  onAttachFiles: (files: FileList | null) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onModelChange: (value: string) => void;
  onEffortChange: (value: 'low' | 'medium' | 'high' | 'max') => void;
  onUpdateContextReferenceMode: (referenceId: string, mode: ContextReferenceMode) => void;
  onRemoveContextReference: (referenceId: string) => void;
  onSend: () => void;
  onStop: () => void;
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

const formatSize = (value: number) => {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
};
const isImageAttachment = (attachment: ComposerAttachment) => attachment.mimeType.startsWith('image/');

export function ChatComposer({
  draft,
  tokenUsage,
  sessionModel,
  contextReferences,
  slashCommands,
  attachments,
  isSending,
  isResponding,
  model,
  effort,
  supportsPathDrop = true,
  onDraftChange,
  onInsertDroppedPaths,
  onAttachFiles,
  onRemoveAttachment,
  onModelChange,
  onEffortChange,
  onUpdateContextReferenceMode,
  onRemoveContextReference,
  onSend,
  onStop,
}: ChatComposerProps) {
  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const showStopAction = isSending || isResponding;
  const requestedModel = model.trim().toLowerCase();
  const actualSessionModel = sessionModel.trim().toLowerCase();
  const staleLegacyWindow =
    requestedModel.includes('[1m]') &&
    !actualSessionModel.includes('[1m]') &&
    tokenUsage.contextWindow > 0 &&
    tokenUsage.contextWindow < 1000000;
  const hasKnownContextWindow =
    tokenUsage.windowSource !== 'unknown' &&
    Number.isFinite(tokenUsage.contextWindow) &&
    tokenUsage.contextWindow > 0 &&
    !staleLegacyWindow;
  const usageRatio = hasKnownContextWindow && tokenUsage.contextWindow > 0
    ? tokenUsage.used / tokenUsage.contextWindow
    : 0;
  const usagePercentNum = hasKnownContextWindow ? Math.round(usageRatio * 100) : 0;
  const usageEmoji = usagePercentNum >= 80 ? '\u{1F631}' : usagePercentNum >= 40 ? '\u{1F60A}' : '\u{1F60B}';
  const usageSummary = hasKnownContextWindow
    ? `${formatTokens(tokenUsage.used)} / ${formatTokens(tokenUsage.contextWindow)}`
    : `${formatTokens(tokenUsage.used)} / --`;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const slashState = useMemo(() => {
    // Keep slash completion active only while the draft is a single slash token.
    // Once the user adds whitespace, Enter should send instead of re-applying the command.
    const match = draft.match(/^\/([^\s]*)$/);
    if (!match) {
      return null;
    }

    const query = match[1].toLowerCase();
    const commands = slashCommands.filter((command) =>
      query ? command.toLowerCase().startsWith(query) : true,
    );

    return {
      query,
      commands,
    };
  }, [draft, slashCommands]);
  const [activeSlashIndex, setActiveSlashIndex] = useState(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const visibleSlashCommands = slashState?.commands ?? [];

  useEffect(() => {
    setActiveSlashIndex(0);
  }, [slashState?.query, draft]);

  useEffect(() => {
    if (activeSlashIndex < visibleSlashCommands.length) {
      return;
    }
    setActiveSlashIndex(0);
  }, [activeSlashIndex, visibleSlashCommands.length]);

  useEffect(() => {
    slashItemRefs.current[activeSlashIndex]?.scrollIntoView({
      block: 'nearest',
    });
  }, [activeSlashIndex]);

  const applySlashCommand = (command: string) => {
    const firstWhitespace = draft.search(/\s/);
    const suffix = firstWhitespace >= 0 ? draft.slice(firstWhitespace) : ' ';
    onDraftChange(`/${command}${suffix || ' '}`);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  };

  const setDropEffect = (event: React.DragEvent<HTMLElement>) => {
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  return (
    <footer className="composer">
      <div className="composer-toolbar">
        <label className="composer-control">
          <span>Model</span>
          <select value={model} onChange={(event) => onModelChange(event.target.value)}>
            <option value="opus[1m]">opus4.6[1M]</option>
            <option value="sonnet[1m]">sonnet4.6[1M]</option>
          </select>
        </label>
        <label className="composer-control">
          <span>Thinking</span>
          <select value={effort} onChange={(event) => onEffortChange(event.target.value as 'low' | 'medium' | 'high' | 'max')}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </label>
        <div className="composer-usage" aria-label="Token usage">
          {hasKnownContextWindow ? <span className="usage-emoji">{usageEmoji}</span> : null}
          <strong>{usageSummary}</strong>
          {hasKnownContextWindow ? (
            <div className="usage-bar">
              <div
                className={`usage-bar-fill${usagePercentNum >= 80 ? ' critical' : usagePercentNum >= 40 ? ' warning' : ''}`}
                style={{ width: `${Math.min(100, usagePercentNum)}%` }}
              />
            </div>
          ) : null}
          {hasKnownContextWindow ? <span>{usagePercentNum}%</span> : null}
        </div>
      </div>

      {attachments.length > 0 ? (
        <div className="attachment-strip">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="attachment-card">
              {isImageAttachment(attachment) ? (
                <img src={attachment.url} alt={attachment.name} />
              ) : (
                <div className="attachment-file-icon" aria-hidden="true">
                  FILE
                </div>
              )}
              <div>
                <strong>{attachment.name}</strong>
                <span>
                  {attachment.mimeType || 'application/octet-stream'} · {formatSize(attachment.size)}
                </span>
              </div>
              <button type="button" onClick={() => onRemoveAttachment(attachment.id)}>
                x
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {contextReferences.length > 0 ? (
        <div className="context-reference-strip">
          {contextReferences.map((reference) => (
            <div key={reference.id} className="context-reference-card">
              <div className="context-reference-copy">
                <strong>{reference.label}</strong>
                <span>
                  {reference.kind === 'session' ? 'Session context' : 'Streamwork history'}
                  {reference.auto ? ' · auto' : ''}
                </span>
              </div>
              <div className="context-reference-mode-group" role="group" aria-label="Reference mode">
                {(['summary', 'full'] as ContextReferenceMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`context-reference-mode${reference.mode === mode ? ' active' : ''}`}
                    onClick={() => onUpdateContextReferenceMode(reference.id, mode)}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <button type="button" onClick={() => onRemoveContextReference(reference.id)}>
                x
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="composer-box">
        <div
          className={`composer-input-wrap${isDragActive ? ' drag-active' : ''}`}
          onDragEnter={(event) => {
            if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
              return;
            }
            event.preventDefault();
            setDropEffect(event);
            setIsDragActive(true);
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
              return;
            }
            event.preventDefault();
            setDropEffect(event);
            if (!isDragActive) {
              setIsDragActive(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setIsDragActive(false);
            }
          }}
          onDrop={(event) => {
            if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
              return;
            }
            event.preventDefault();
            setIsDragActive(false);
            onInsertDroppedPaths(event.dataTransfer?.files ?? null);
          }}
        >
          {slashState ? (
            <div className="slash-command-menu">
              {visibleSlashCommands.length > 0 ? (
                visibleSlashCommands.map((command, index) => (
                  <button
                    key={command}
                    ref={(node) => {
                      slashItemRefs.current[index] = node;
                    }}
                    type="button"
                    className={`slash-command-item${index === activeSlashIndex ? ' active' : ''}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applySlashCommand(command);
                    }}
                  >
                    <strong>/{command}</strong>
                  </button>
                ))
              ) : (
                <div className="slash-command-empty">No matching commands.</div>
              )}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (slashState && visibleSlashCommands.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveSlashIndex((current) => (current + 1) % visibleSlashCommands.length);
                  return;
                }

                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveSlashIndex((current) => (current - 1 + visibleSlashCommands.length) % visibleSlashCommands.length);
                  return;
                }

                if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                  event.preventDefault();
                  applySlashCommand(visibleSlashCommands[activeSlashIndex] ?? visibleSlashCommands[0]);
                  return;
                }
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            onPaste={(event) => {
              const files = event.clipboardData?.files ?? null;
              if ((files?.length ?? 0) > 0) {
                event.preventDefault();
                onAttachFiles(files);
              }
            }}
            placeholder={
              supportsPathDrop
                ? '在这里输入。也可以粘贴 `[[session:ID]]` 引用 token，或把文件拖进来直接插入路径。'
                : '在这里输入。也可以粘贴 `[[session:ID]]` 引用 token，或把文件拖进来直接作为附件上传。'
            }
            rows={4}
          />
          {isDragActive ? (
            <div className="composer-drop-hint">
              {supportsPathDrop ? '松开以插入文件路径' : '松开以上传附件'}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="send-button"
          onClick={showStopAction ? onStop : onSend}
          disabled={!showStopAction && !canSend}
        >
          {showStopAction ? '停止' : '发送'}
        </button>
      </div>
    </footer>
  );
}
