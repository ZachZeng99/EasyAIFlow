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
