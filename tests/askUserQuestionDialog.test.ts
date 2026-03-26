import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AskUserQuestionDialog } from '../src/components/AskUserQuestionDialog.tsx';

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

run('AskUserQuestionDialog renders a dedicated scrollable body container for long forms', () => {
  const html = renderToStaticMarkup(
    createElement(AskUserQuestionDialog, {
      open: true,
      dialogKey: 'toolu_ask_user',
      busy: false,
      questions: [
        {
          question: '你的 Jenkins 是通过什么方式访问的？',
          header: 'Access',
          options: [
            { label: '内网 HTTP/HTTPS', description: '直接通过内网访问' },
            { label: '公网 + VPN', description: '需要 VPN' },
          ],
          multiSelect: false,
        },
      ],
      onSkip: () => undefined,
      onSubmit: () => undefined,
    }),
  );

  assert.match(html, /class="dialog-card ask-user-dialog"/);
  assert.match(html, /class="dialog-body ask-user-dialog-body"/);
  assert.match(html, /class="dialog-actions ask-user-dialog-actions"/);
});
