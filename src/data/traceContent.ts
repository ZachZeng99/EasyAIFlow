import type { ConversationMessage } from './types.js';

export const TRACE_CONTENT_MAX_CHARS = 256 * 1024;

const TRACE_CONTENT_HEAD_CHARS = 192 * 1024;
const TRACE_CONTENT_NOTICE_BUDGET_CHARS = 1024;
const TRACE_CONTENT_TAIL_CHARS =
  TRACE_CONTENT_MAX_CHARS - TRACE_CONTENT_HEAD_CHARS - TRACE_CONTENT_NOTICE_BUDGET_CHARS;
const EMBEDDED_DATA_URL_PLACEHOLDER = '[Embedded binary data omitted from trace output]';
const EMBEDDED_DATA_URL_PATTERN =
  /data:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,\s"'<>]+)*;base64,[a-z0-9+/_=-]+/gi;

export const sanitizeTraceContent = (content: string) => {
  const redacted = content.replace(EMBEDDED_DATA_URL_PATTERN, EMBEDDED_DATA_URL_PLACEHOLDER);
  if (redacted.length <= TRACE_CONTENT_MAX_CHARS) {
    return redacted;
  }

  const omitted = redacted.length - TRACE_CONTENT_HEAD_CHARS - TRACE_CONTENT_TAIL_CHARS;
  return [
    redacted.slice(0, TRACE_CONTENT_HEAD_CHARS),
    `[Trace output truncated for safety: ${omitted} characters omitted]`,
    redacted.slice(-TRACE_CONTENT_TAIL_CHARS),
  ].join('\n\n');
};

export const sanitizeTraceStructuredValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return sanitizeTraceContent(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeTraceStructuredValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeTraceStructuredValue(entry)]),
    );
  }
  return value;
};

const hasTraceContent = (message: ConversationMessage) =>
  message.role === 'system' || Boolean(message.kind && message.kind !== 'message');

export const sanitizeConversationMessageTraceContent = (message: ConversationMessage) => {
  if (!hasTraceContent(message)) {
    return message;
  }

  const content = sanitizeTraceContent(message.content);
  return content === message.content ? message : { ...message, content };
};

export const sanitizeConversationMessagesForDisplay = (messages: ConversationMessage[]) =>
  messages.map(sanitizeConversationMessageTraceContent);
