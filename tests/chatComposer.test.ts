import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from '../src/components/ChatComposer.tsx';
import type { TokenUsage } from '../src/data/types.ts';

(globalThis as typeof globalThis & { React?: typeof React }).React = React;

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const tokenUsage: TokenUsage = {
  contextWindow: 200000,
  used: 1000,
  input: 600,
  output: 400,
  cached: 0,
  windowSource: 'runtime',
};

run('ChatComposer shows a stop action instead of a disabled sending button while busy', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: 'Explain the diff',
      tokenUsage,
      sessionModel: 'opus[1m]',
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: true,
      isResponding: false,
      model: 'opus[1m]',
      effort: 'medium',
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, />停止</);
  assert.doesNotMatch(html, /<button[^>]*send-button[^>]*disabled/);
});

run('ChatComposer keeps the send action available while only background tasks are running', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: '继续这个需求',
      tokenUsage,
      sessionModel: 'opus[1m]',
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: false,
      isResponding: true,
      allowSendWhileResponding: true,
      model: 'opus[1m]',
      effort: 'medium',
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, />发送</);
  assert.doesNotMatch(html, />停止</);
});

run('ChatComposer offers both send and stop while a group room is generating', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: '继续这个需求',
      tokenUsage,
      sessionModel: '',
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: false,
      isResponding: true,
      allowSendWhileResponding: true,
      isGroupSession: true,
      model: '',
      effort: 'default',
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, />发送</);
  assert.match(html, />停止</);
});

run('ChatComposer renders an inline notice when the host provides one', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: '继续这个需求',
      tokenUsage,
      sessionModel: 'opus[1m]',
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: false,
      isResponding: false,
      model: 'opus[1m]',
      effort: 'medium',
      notice: 'Thinking changed to max. Claude effort takes effect after the session restarts.',
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, /Thinking changed to max/);
  assert.match(html, /session restarts/);
});

run('ChatComposer renders discovered Claude models and preserves the current selection', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: '继续这个需求',
      tokenUsage,
      sessionModel: 'fable',
      modelCatalog: { provider: 'claude', stale: false, updatedAt: 1, models: [
        { id: 'claude-future-99', label: 'Future Claude', isDefault: true },
        { id: 'claude-other-100', label: 'Another Claude' },
      ] },
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: false,
      isResponding: false,
      model: 'fable',
      effort: 'medium',
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.ok(html.includes('Future Claude'));
  assert.match(html, /value="fable"/);
  assert.match(html, /value="claude-future-99"/);
  assert.match(html, /value="claude-other-100"/);
});

run('ChatComposer offers newly discovered Codex models while retaining an older session model', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      provider: 'codex',
      draft: '继续这个需求',
      tokenUsage,
      sessionModel: 'gpt-5.5',
      modelCatalog: { provider: 'codex', stale: true, updatedAt: 1, models: [{ id: 'gpt-future', label: 'Future Codex' }] },
      onRefreshModels: () => undefined,
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: false,
      isResponding: false,
      model: 'gpt-5.5',
      effort: 'medium',
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, /value="gpt-future"/);
  assert.match(html, /value="gpt-5\.5"/);
  assert.match(html, /刷新模型（缓存）/);
});

run('ChatComposer uses the known fable million-token context window for usage display', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: '继续这个需求',
      tokenUsage,
      sessionModel: 'fable',
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: false,
      isResponding: false,
      model: 'fable',
      effort: 'medium',
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, /1k \/ 1M/);
  assert.doesNotMatch(html, /1k \/ 200k/);
});


run('ChatComposer shows mention quick options in group chats when the user types @', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      draft: '@cl',
      tokenUsage,
      sessionModel: 'opus[1m]',
      contextReferences: [],
      slashCommands: [],
      mentionOptions: [
        { value: 'claude', label: 'Claude' },
        { value: 'codex', label: 'Codex' },
        { value: 'all', label: 'Everyone' },
      ],
      attachments: [],
      isSending: false,
      isResponding: false,
      model: 'opus[1m]',
      effort: 'medium',
      isGroupSession: true,
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, /@claude/);
  assert.match(html, /Claude/);
  assert.doesNotMatch(html, /<button[^>]*><strong>@codex/);
});

run('ChatComposer shows the stored permission mode with provider-specific choices', () => {
  const html = renderToStaticMarkup(
    createElement(ChatComposer, {
      provider: 'codex',
      draft: '',
      tokenUsage,
      sessionModel: 'gpt-6.1-sol',
      contextReferences: [],
      slashCommands: [],
      attachments: [],
      isSending: false,
      isResponding: false,
      model: 'gpt-6.1-sol',
      effort: 'default',
      permissionMode: 'read-only',
      onPermissionModeChange: () => undefined,
      onDraftChange: () => undefined,
      onInsertDroppedPaths: () => undefined,
      onAttachFiles: () => undefined,
      onRemoveAttachment: () => undefined,
      onModelChange: () => undefined,
      onEffortChange: () => undefined,
      onUpdateContextReferenceMode: () => undefined,
      onRemoveContextReference: () => undefined,
      onSend: () => undefined,
      onStop: () => undefined,
    }),
  );

  assert.match(html, /aria-label="权限模式"/);
  assert.match(html, /<option value="read-only" selected="">只读<\/option>/);
  assert.match(html, /完全访问/);
  assert.doesNotMatch(html, /自动接受编辑/);
});
