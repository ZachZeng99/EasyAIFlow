import assert from 'node:assert/strict';
import {
  sanitizeConversationMessageTraceContent,
  sanitizeTraceContent,
  sanitizeTraceStructuredValue,
  TRACE_CONTENT_MAX_CHARS,
} from '../src/data/traceContent.ts';
import type { ConversationMessage } from '../src/data/types.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('sanitizeTraceContent removes embedded base64 data URLs', () => {
  const content = JSON.stringify({
    type: 'image',
    image_url: `data:image/png;base64,${'A'.repeat(300_000)}`,
  });
  const sanitized = sanitizeTraceContent(content);

  assert.equal(sanitized.includes('data:image'), false);
  assert.equal(sanitized.includes('A'.repeat(1024)), false);
  assert.match(sanitized, /Embedded binary data omitted/);
  assert.ok(sanitized.length < 1024);
});

run('sanitizeTraceContent bounds large text while preserving its head and tail', () => {
  const content = `HEAD-${'x'.repeat(TRACE_CONTENT_MAX_CHARS)}-TAIL`;
  const sanitized = sanitizeTraceContent(content);

  assert.ok(sanitized.startsWith('HEAD-'));
  assert.ok(sanitized.endsWith('-TAIL'));
  assert.match(sanitized, /Trace output truncated for safety/);
  assert.ok(sanitized.length < content.length);
});

run('sanitizeTraceStructuredValue removes binary data from nested app-server items', () => {
  const value = {
    output: {
      content: [
        { text: 'kept' },
        { image_url: `data:image/png;base64,${'A'.repeat(300_000)}` },
      ],
    },
  };
  const sanitized = sanitizeTraceStructuredValue(value) as typeof value;

  assert.equal(sanitized.output.content[0]?.text, 'kept');
  assert.match(sanitized.output.content[1]?.image_url ?? '', /Embedded binary data omitted/);
  assert.ok(JSON.stringify(sanitized).length < 1024);
});

run('sanitizeConversationMessageTraceContent leaves ordinary messages unchanged', () => {
  const message: ConversationMessage = {
    id: 'assistant-1',
    role: 'assistant',
    kind: 'message',
    timestamp: 'now',
    title: 'Reply',
    content: `data:image/png;base64,${'A'.repeat(300_000)}`,
    status: 'complete',
  };

  assert.equal(sanitizeConversationMessageTraceContent(message), message);
});
