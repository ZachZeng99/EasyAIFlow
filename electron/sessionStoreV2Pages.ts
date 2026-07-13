import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationMessage, SessionMessagePage } from '../src/data/types.js';

const SCHEMA_VERSION = 2 as const;
export const SESSION_MESSAGE_PAGE_MAX_MESSAGES = 100;
export const SESSION_MESSAGE_PAGE_MAX_BYTES = 5 * 1024 * 1024;

export type SessionStoreV2Event =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      sessionId: string;
      revision: number;
      type: 'append-messages';
      messages: ConversationMessage[];
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      sessionId: string;
      revision: number;
      type: 'upsert-message';
      message: ConversationMessage;
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      sessionId: string;
      revision: number;
      type: 'replace-messages';
      messages: ConversationMessage[];
    };

export type SessionStoreV2PageDescriptor = {
  id: string;
  messageCount: number;
  byteLength: number;
};

export type SessionStoreV2PageMeta = {
  schemaVersion: typeof SCHEMA_VERSION;
  sessionId: string;
  revision: number;
  messageCount: number;
  pages: SessionStoreV2PageDescriptor[];
  messagePageById: Record<string, string>;
};

type SessionStoreV2PageFile = {
  schemaVersion: typeof SCHEMA_VERSION;
  sessionId: string;
  pageId: string;
  messages: ConversationMessage[];
};

type PageChunk = {
  messages: ConversationMessage[];
  byteLength: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMissingEntry = (error: unknown) => isRecord(error) && error.code === 'ENOENT';

const isConversationMessage = (value: unknown): value is ConversationMessage =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
  typeof value.timestamp === 'string' &&
  typeof value.title === 'string' &&
  typeof value.content === 'string';

const parseJson = <T>(raw: string, description: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${description}: ${detail}`);
  }
};

const makeTempPath = (filePath: string) =>
  `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

const atomicReplaceFile = async (filePath: string, content: string) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = makeTempPath(filePath);
  const previousPath = `${filePath}.previous`;
  await writeFile(tempPath, content, 'utf8');

  try {
    await rename(tempPath, filePath);
    return;
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    if (code !== 'EEXIST' && code !== 'EPERM') {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  await rm(previousPath, { force: true });
  await rename(filePath, previousPath);
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await rename(previousPath, filePath);
    } catch {
      // The recovery reader can still use the previous file.
    }
    await rm(tempPath, { force: true });
    throw error;
  }
  await rm(previousPath, { force: true });
};

const readTextWithPrevious = async (filePath: string) => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (!isMissingEntry(error)) {
      throw error;
    }
    return readFile(`${filePath}.previous`, 'utf8');
  }
};

const metaPathFor = (sessionPath: string) => path.join(sessionPath, 'meta.json');
const pagesPathFor = (sessionPath: string) => path.join(sessionPath, 'pages');
const pagePathFor = (sessionPath: string, pageId: string) =>
  path.join(pagesPathFor(sessionPath), `${pageId}.json`);

const emptyMeta = (sessionId: string): SessionStoreV2PageMeta => ({
  schemaVersion: SCHEMA_VERSION,
  sessionId,
  revision: 0,
  messageCount: 0,
  pages: [],
  messagePageById: {},
});

const validateMeta = (value: unknown, sessionId: string): SessionStoreV2PageMeta => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.sessionId !== sessionId ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.messageCount !== 'number' ||
    !Number.isSafeInteger(value.messageCount) ||
    value.messageCount < 0 ||
    !Array.isArray(value.pages) ||
    !value.pages.every((page) =>
      isRecord(page) &&
      typeof page.id === 'string' &&
      typeof page.messageCount === 'number' &&
      Number.isSafeInteger(page.messageCount) &&
      page.messageCount > 0 &&
      typeof page.byteLength === 'number' &&
      Number.isSafeInteger(page.byteLength) &&
      page.byteLength >= 0
    ) ||
    !isRecord(value.messagePageById)
  ) {
    throw new Error(`Invalid V2 page metadata for session "${sessionId}".`);
  }
  return value as SessionStoreV2PageMeta;
};

const validatePage = (
  value: unknown,
  sessionId: string,
  pageId: string,
): SessionStoreV2PageFile => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    value.sessionId !== sessionId ||
    value.pageId !== pageId ||
    !Array.isArray(value.messages) ||
    !value.messages.every(isConversationMessage)
  ) {
    throw new Error(`Invalid V2 page "${pageId}" for session "${sessionId}".`);
  }
  return value as SessionStoreV2PageFile;
};

const messageByteLength = (message: ConversationMessage) =>
  Buffer.byteLength(JSON.stringify(message), 'utf8');

export const splitSessionMessagesIntoPages = (messages: ConversationMessage[]): PageChunk[] => {
  const chunks: PageChunk[] = [];
  let current: ConversationMessage[] = [];
  let currentBytes = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    chunks.push({ messages: current, byteLength: currentBytes });
    current = [];
    currentBytes = 0;
  };

  for (const message of messages) {
    const bytes = messageByteLength(message);
    if (bytes > SESSION_MESSAGE_PAGE_MAX_BYTES) {
      flush();
      chunks.push({ messages: [message], byteLength: bytes });
      continue;
    }
    if (
      current.length >= SESSION_MESSAGE_PAGE_MAX_MESSAGES ||
      (current.length > 0 && currentBytes + bytes > SESSION_MESSAGE_PAGE_MAX_BYTES)
    ) {
      flush();
    }
    current.push(message);
    currentBytes += bytes;
  }
  flush();
  return chunks;
};

const newPageId = (revision: number, index: number) =>
  `p${revision.toString(36)}-${index.toString(36)}-${randomUUID().slice(0, 8)}`;

const writeChunks = async (
  sessionPath: string,
  sessionId: string,
  chunks: PageChunk[],
  revision: number,
) => {
  await mkdir(pagesPathFor(sessionPath), { recursive: true });
  const descriptors: SessionStoreV2PageDescriptor[] = [];
  const pageMessages = new Map<string, ConversationMessage[]>();

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const pageId = newPageId(revision, index);
    const page: SessionStoreV2PageFile = {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      pageId,
      messages: chunk.messages,
    };
    await atomicReplaceFile(pagePathFor(sessionPath, pageId), JSON.stringify(page));
    descriptors.push({
      id: pageId,
      messageCount: chunk.messages.length,
      byteLength: chunk.byteLength,
    });
    pageMessages.set(pageId, chunk.messages);
  }

  return { descriptors, pageMessages };
};

const readPageMessages = async (
  sessionPath: string,
  sessionId: string,
  pageId: string,
) => validatePage(
  parseJson(
    await readTextWithPrevious(pagePathFor(sessionPath, pageId)),
    `page "${pageId}" for session "${sessionId}"`,
  ),
  sessionId,
  pageId,
).messages;

export const readSessionStoreV2PageMeta = async (
  sessionPath: string,
  sessionId: string,
) => {
  try {
    return validateMeta(
      parseJson(await readTextWithPrevious(metaPathFor(sessionPath)), `page metadata for session "${sessionId}"`),
      sessionId,
    );
  } catch (error) {
    if (isMissingEntry(error)) {
      return emptyMeta(sessionId);
    }
    throw error;
  }
};

const buildLocator = (
  descriptors: SessionStoreV2PageDescriptor[],
  pageMessages: Map<string, ConversationMessage[]>,
) => {
  const locator: Record<string, string> = {};
  descriptors.forEach((descriptor) => {
    for (const message of pageMessages.get(descriptor.id) ?? []) {
      locator[message.id] = descriptor.id;
    }
  });
  return locator;
};

const cleanupPages = async (sessionPath: string, pageIds: Iterable<string>) => {
  for (const pageId of pageIds) {
    await rm(pagePathFor(sessionPath, pageId), { force: true });
    await rm(`${pagePathFor(sessionPath, pageId)}.previous`, { force: true });
  }
};

export const replaceSessionStoreV2Messages = async (
  sessionPath: string,
  sessionId: string,
  messages: ConversationMessage[],
  revision: number,
) => {
  const previous = await readSessionStoreV2PageMeta(sessionPath, sessionId);
  const written = await writeChunks(
    sessionPath,
    sessionId,
    splitSessionMessagesIntoPages(messages),
    revision,
  );
  const meta: SessionStoreV2PageMeta = {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    revision,
    messageCount: messages.length,
    pages: written.descriptors,
    messagePageById: buildLocator(written.descriptors, written.pageMessages),
  };
  await atomicReplaceFile(metaPathFor(sessionPath), JSON.stringify(meta));
  const currentPageIds = new Set(meta.pages.map((page) => page.id));
  await cleanupPages(
    sessionPath,
    previous.pages.map((page) => page.id).filter((pageId) => !currentPageIds.has(pageId)),
  );
  return meta;
};

const cloneMeta = (meta: SessionStoreV2PageMeta): SessionStoreV2PageMeta => ({
  ...meta,
  pages: meta.pages.map((page) => ({ ...page })),
  messagePageById: { ...meta.messagePageById },
});

export const applySessionStoreV2EventsToPages = async (
  sessionPath: string,
  sessionId: string,
  events: SessionStoreV2Event[],
) => {
  const current = await readSessionStoreV2PageMeta(sessionPath, sessionId);
  const pending = events.filter((event) => event.revision > current.revision);
  if (pending.length === 0) {
    return current;
  }
  for (const event of pending) {
    if (event.sessionId !== sessionId) {
      throw new Error(`Session event target mismatch for "${sessionId}".`);
    }
  }

  const latestReplaceIndex = pending.reduce(
    (found, event, index) => event.type === 'replace-messages' ? index : found,
    -1,
  );
  if (latestReplaceIndex >= 0) {
    const replacement = pending[latestReplaceIndex];
    let messages = replacement.type === 'replace-messages' ? [...replacement.messages] : [];
    for (const event of pending.slice(latestReplaceIndex + 1)) {
      if (event.type === 'append-messages') {
        messages.push(...event.messages);
      } else if (event.type === 'upsert-message') {
        const index = messages.findIndex((message) => message.id === event.message.id);
        if (index >= 0) {
          messages[index] = event.message;
        } else {
          messages.push(event.message);
        }
      }
    }
    return replaceSessionStoreV2Messages(
      sessionPath,
      sessionId,
      messages,
      pending.at(-1)!.revision,
    );
  }

  const meta = cloneMeta(current);
  const cachedPages = new Map<string, ConversationMessage[]>();
  const obsoletePageIds = new Set<string>();

  const getMessages = async (pageId: string) => {
    const cached = cachedPages.get(pageId);
    if (cached) {
      return cached;
    }
    const loaded = await readPageMessages(sessionPath, sessionId, pageId);
    cachedPages.set(pageId, loaded);
    return loaded;
  };

  const replaceDescriptor = async (
    descriptorIndex: number,
    previousMessages: ConversationMessage[],
    nextMessages: ConversationMessage[],
    revision: number,
  ) => {
    const previousDescriptor = meta.pages[descriptorIndex];
    const written = await writeChunks(
      sessionPath,
      sessionId,
      splitSessionMessagesIntoPages(nextMessages),
      revision,
    );
    if (previousDescriptor) {
      obsoletePageIds.add(previousDescriptor.id);
      for (const message of previousMessages) {
        delete meta.messagePageById[message.id];
      }
    }
    meta.pages.splice(descriptorIndex, previousDescriptor ? 1 : 0, ...written.descriptors);
    for (const descriptor of written.descriptors) {
      const messages = written.pageMessages.get(descriptor.id) ?? [];
      cachedPages.set(descriptor.id, messages);
      for (const message of messages) {
        meta.messagePageById[message.id] = descriptor.id;
      }
    }
  };

  for (const event of pending) {
    if (event.type === 'append-messages') {
      const lastIndex = meta.pages.length - 1;
      const previousMessages = lastIndex >= 0
        ? await getMessages(meta.pages[lastIndex].id)
        : [];
      await replaceDescriptor(
        Math.max(0, lastIndex),
        previousMessages,
        [...previousMessages, ...event.messages],
        event.revision,
      );
      meta.messageCount += event.messages.length;
    } else if (event.type === 'upsert-message') {
      const pageId = meta.messagePageById[event.message.id];
      const descriptorIndex = pageId
        ? meta.pages.findIndex((descriptor) => descriptor.id === pageId)
        : -1;
      if (descriptorIndex < 0) {
        const lastIndex = meta.pages.length - 1;
        const previousMessages = lastIndex >= 0
          ? await getMessages(meta.pages[lastIndex].id)
          : [];
        await replaceDescriptor(
          Math.max(0, lastIndex),
          previousMessages,
          [...previousMessages, event.message],
          event.revision,
        );
        meta.messageCount += 1;
      } else {
        const previousMessages = await getMessages(pageId);
        const nextMessages = previousMessages.map((message) =>
          message.id === event.message.id ? event.message : message,
        );
        await replaceDescriptor(
          descriptorIndex,
          previousMessages,
          nextMessages,
          event.revision,
        );
      }
    }
    meta.revision = event.revision;
  }

  await atomicReplaceFile(metaPathFor(sessionPath), JSON.stringify(meta));
  const activePageIds = new Set(meta.pages.map((page) => page.id));
  await cleanupPages(
    sessionPath,
    [...obsoletePageIds].filter((pageId) => !activePageIds.has(pageId)),
  );
  return meta;
};

export class SessionStoreV2StaleCursorError extends Error {
  constructor(sessionId: string, cursor: string) {
    super(`Stale history cursor "${cursor}" for session "${sessionId}".`);
    this.name = 'SessionStoreV2StaleCursorError';
  }
}

export const readSessionStoreV2MessagePage = async (
  sessionPath: string,
  sessionId: string,
  before?: string,
): Promise<SessionMessagePage> => {
  const meta = await readSessionStoreV2PageMeta(sessionPath, sessionId);
  if (meta.pages.length === 0) {
    return {
      sessionId,
      pageId: '',
      messages: [],
      hasMoreBefore: false,
      sessionRevision: meta.revision,
    };
  }

  const pageIndex = before === undefined
    ? meta.pages.length - 1
    : meta.pages.findIndex((page) => page.id === before);
  if (pageIndex < 0) {
    throw new SessionStoreV2StaleCursorError(sessionId, before ?? '');
  }
  const descriptor = meta.pages[pageIndex];
  const messages = await readPageMessages(sessionPath, sessionId, descriptor.id);
  return {
    sessionId,
    pageId: descriptor.id,
    messages,
    nextBefore: pageIndex > 0 ? meta.pages[pageIndex - 1].id : undefined,
    hasMoreBefore: pageIndex > 0,
    sessionRevision: meta.revision,
  };
};

export const readAllSessionStoreV2Messages = async (
  sessionPath: string,
  sessionId: string,
) => {
  const meta = await readSessionStoreV2PageMeta(sessionPath, sessionId);
  const messages: ConversationMessage[] = [];
  for (const descriptor of meta.pages) {
    messages.push(...await readPageMessages(sessionPath, sessionId, descriptor.id));
  }
  return { meta, messages };
};
