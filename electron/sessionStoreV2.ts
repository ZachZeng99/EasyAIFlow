import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ConversationMessage, ProjectRecord, SessionMessagePage, SessionRecord } from '../src/data/types.js';
import type { SessionStoreAppState } from './sessionStoreMerge.js';
import {
  applySessionStoreV2EventsToPages,
  readAllSessionStoreV2Messages,
  readSessionStoreV2MessagePage,
  readSessionStoreV2PageMeta,
  replaceSessionStoreV2Messages,
  type SessionStoreV2Event as PageSessionStoreV2Event,
} from './sessionStoreV2Pages.js';

export {
  SessionStoreV2StaleCursorError,
} from './sessionStoreV2Pages.js';
export type { SessionMessagePage } from '../src/data/types.js';

export const SESSION_STORE_V2_SCHEMA_VERSION = 2 as const;
export const SESSION_STORE_V2_DIRECTORY_NAME = 'easyaiflow-store-v2';

export class SessionStoreV2LockError extends Error {
  constructor(pid: number) {
    super(`V2 session store is already in use by process ${pid}.`);
    this.name = 'SessionStoreV2LockError';
  }
}

type SessionStoreV2Manifest = {
  schemaVersion: typeof SESSION_STORE_V2_SCHEMA_VERSION;
  createdAt: string;
};

type SessionStoreV2Index = {
  schemaVersion: typeof SESSION_STORE_V2_SCHEMA_VERSION;
  revision: number;
  projects: ProjectRecord[];
  deletedImports: SessionStoreAppState['deletedImports'];
};

export type SessionStoreV2Options = {
  maxMessages: number;
  compactionEventCount?: number;
  compactionBytes?: number;
  indexDebounceMs?: number;
};

export type SessionStoreV2SessionMutation =
  | {
      type: 'append-messages';
      sessionId: string;
      messages: ConversationMessage[];
    }
  | {
      type: 'upsert-message';
      sessionId: string;
      message: ConversationMessage;
    }
  | {
      type: 'replace-messages';
      sessionId: string;
      messages: ConversationMessage[];
    };

export type SessionStoreV2PersistRequest = {
  sessionMutations?: SessionStoreV2SessionMutation[];
  deletedSessionIds?: string[];
  immediateIndex?: boolean;
};

type SessionStoreV2Paths = {
  rootPath: string;
  lockPath: string;
  manifestPath: string;
  indexPath: string;
  sessionsPath: string;
  sessionPath: string;
  metaPath: string;
  pagesPath: string;
  snapshotPath: string;
  eventsPath: string;
};

const encodedSessionId = (sessionId: string) => Buffer.from(sessionId, 'utf8').toString('base64url');

const pathsForRoot = (rootPath: string, sessionId = ''): SessionStoreV2Paths => {
  const sessionsPath = path.join(rootPath, 'sessions');
  const sessionPath = sessionId ? path.join(sessionsPath, encodedSessionId(sessionId)) : sessionsPath;
  return {
    rootPath,
    lockPath: path.join(path.dirname(rootPath), `${SESSION_STORE_V2_DIRECTORY_NAME}.lock`),
    manifestPath: path.join(rootPath, 'manifest.json'),
    indexPath: path.join(rootPath, 'index.json'),
    sessionsPath,
    sessionPath,
    metaPath: path.join(sessionPath, 'meta.json'),
    pagesPath: path.join(sessionPath, 'pages'),
    snapshotPath: path.join(sessionPath, 'snapshot.json'),
    eventsPath: path.join(sessionPath, 'events.jsonl'),
  };
};

export const getSessionStoreV2Paths = (userDataPath: string, sessionId = '') =>
  pathsForRoot(path.join(userDataPath, SESSION_STORE_V2_DIRECTORY_NAME), sessionId);

export type SessionStoreV2Snapshot = {
  schemaVersion: typeof SESSION_STORE_V2_SCHEMA_VERSION;
  sessionId: string;
  revision: number;
  messages: ConversationMessage[];
};

export type SessionStoreV2Event = PageSessionStoreV2Event;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isConversationMessage = (value: unknown): value is ConversationMessage =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
  typeof value.timestamp === 'string' &&
  typeof value.title === 'string' &&
  typeof value.content === 'string';

const isSessionStoreV2Event = (value: unknown): value is SessionStoreV2Event => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SESSION_STORE_V2_SCHEMA_VERSION ||
    typeof value.sessionId !== 'string' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1
  ) {
    return false;
  }

  if (value.type === 'upsert-message') {
    return isConversationMessage(value.message);
  }

  if (value.type === 'append-messages' || value.type === 'replace-messages') {
    return Array.isArray(value.messages) && value.messages.every(isConversationMessage);
  }

  return false;
};

export const parseSessionStoreV2EventLog = (raw: string): SessionStoreV2Event[] => {
  const lines = raw.split(/\r?\n/);
  const endsWithNewline = /\r?\n$/.test(raw);
  const lastContentIndex = lines.reduce((last, line, index) => (line.trim() ? index : last), -1);
  const events: SessionStoreV2Event[] = [];

  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }

    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isSessionStoreV2Event(parsed)) {
        throw new Error('Invalid event shape.');
      }
      events.push(parsed);
    } catch (error) {
      if (!endsWithNewline && index === lastContentIndex) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Malformed session event log line ${index + 1}: ${detail}`);
    }
  });

  return events;
};

const capMessages = (messages: ConversationMessage[], maxMessages: number) =>
  maxMessages > 0 && messages.length > maxMessages
    ? messages.slice(-maxMessages)
    : messages;

export const replaySessionStoreV2Events = (
  snapshot: SessionStoreV2Snapshot,
  events: SessionStoreV2Event[],
  maxMessages: number,
): SessionStoreV2Snapshot => {
  let revision = snapshot.revision;
  let messages = [...snapshot.messages];

  events.forEach((event) => {
    if (event.sessionId !== snapshot.sessionId) {
      throw new Error(
        `Session event target mismatch: expected "${snapshot.sessionId}", received "${event.sessionId}".`,
      );
    }
    if (event.revision <= revision) {
      return;
    }

    if (event.type === 'append-messages') {
      messages.push(...event.messages);
    } else if (event.type === 'upsert-message') {
      const index = messages.findIndex((message) => message.id === event.message.id);
      if (index >= 0) {
        messages[index] = event.message;
      } else {
        messages.push(event.message);
      }
    } else {
      messages = [...event.messages];
    }
    revision = event.revision;
  });

  return {
    schemaVersion: SESSION_STORE_V2_SCHEMA_VERSION,
    sessionId: snapshot.sessionId,
    revision,
    messages: capMessages(messages, maxMessages),
  };
};

const isMissingEntry = (error: unknown) =>
  isRecord(error) && error.code === 'ENOENT';

const fileExists = async (filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isMissingEntry(error)) {
      return false;
    }
    throw error;
  }
};

type SessionStoreV2Lock = {
  pid: number;
  processStartedAt: number;
};

const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;
const ownedLockPaths = new Set<string>();
let lockExitHookInstalled = false;

const installLockExitHook = () => {
  if (lockExitHookInstalled) {
    return;
  }
  lockExitHookInstalled = true;
  process.once('exit', () => {
    ownedLockPaths.forEach((lockPath) => {
      try {
        unlinkSync(lockPath);
      } catch {
        // A crash or external cleanup can remove the advisory file first.
      }
    });
  });
};

const isProcessAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
};

const isCurrentProcessLock = (lock: SessionStoreV2Lock) =>
  lock.pid === process.pid && Math.abs(lock.processStartedAt - PROCESS_STARTED_AT) < 5000;

const acquireSessionStoreV2Lock = async (userDataPath: string) => {
  await mkdir(userDataPath, { recursive: true });
  const lockPath = getSessionStoreV2Paths(userDataPath).lockPath;
  const lock: SessionStoreV2Lock = {
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeFile(lockPath, JSON.stringify(lock), { encoding: 'utf8', flag: 'wx' });
      ownedLockPaths.add(lockPath);
      installLockExitHook();
      return;
    } catch (error) {
      if (!(isRecord(error) && error.code === 'EEXIST')) {
        throw error;
      }
    }

    let existing: SessionStoreV2Lock | null = null;
    try {
      const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.pid === 'number' &&
        typeof parsed.processStartedAt === 'number'
      ) {
        existing = parsed as SessionStoreV2Lock;
      }
    } catch {
      // A partial/malformed lock is stale and can be replaced.
    }

    if (existing && isCurrentProcessLock(existing)) {
      ownedLockPaths.add(lockPath);
      installLockExitHook();
      return;
    }
    if (existing && isProcessAlive(existing.pid)) {
      throw new SessionStoreV2LockError(existing.pid);
    }
    await rm(lockPath, { force: true });
  }

  throw new Error(`Could not acquire V2 session store lock at "${lockPath}".`);
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

const readOptionalTextWithPrevious = async (filePath: string) => {
  try {
    return await readTextWithPrevious(filePath);
  } catch (error) {
    if (isMissingEntry(error)) {
      return null;
    }
    throw error;
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
      // The previous file remains available to the recovery reader.
    }
    await rm(tempPath, { force: true });
    throw error;
  }
  await rm(previousPath, { force: true });
};

const parseJson = <T>(raw: string, description: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${description}: ${detail}`);
  }
};

const validateManifest = (value: unknown): SessionStoreV2Manifest => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SESSION_STORE_V2_SCHEMA_VERSION ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Invalid V2 session store manifest.');
  }
  return value as SessionStoreV2Manifest;
};

const validateIndex = (value: unknown): SessionStoreV2Index => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SESSION_STORE_V2_SCHEMA_VERSION ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.projects) ||
    !isRecord(value.deletedImports) ||
    !Array.isArray(value.deletedImports.claudeSessionIds) ||
    !Array.isArray(value.deletedImports.codexThreadIds)
  ) {
    throw new Error('Invalid V2 session store index.');
  }
  return value as SessionStoreV2Index;
};

const sessionRecords = (state: SessionStoreAppState) =>
  state.projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions as SessionRecord[]),
  );

const messageListDigest = (messages: ConversationMessage[]) => {
  const hash = createHash('sha256');
  hash.update(String(messages.length));
  for (const message of messages) {
    hash.update('\0');
    hash.update(JSON.stringify(message));
  }
  return hash.digest('hex');
};

const buildIndex = (state: SessionStoreAppState, revision: number): SessionStoreV2Index => ({
  schemaVersion: SESSION_STORE_V2_SCHEMA_VERSION,
  revision,
  projects: state.projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((session) => {
        const {
          messages: _messages,
          messagesLoaded: _messagesLoaded,
          historyPage: _historyPage,
          ...summary
        } = session as SessionRecord;
        return {
          ...summary,
          messagesLoaded: false,
        };
      }),
    })),
  })),
  deletedImports: {
    claudeSessionIds: [...state.deletedImports.claudeSessionIds],
    codexThreadIds: [...state.deletedImports.codexThreadIds],
  },
});

export class SessionStoreV2 {
  private readonly compactionEventCount: number;
  private readonly compactionBytes: number;
  private readonly indexDebounceMs: number;
  private readonly sessionRevisions: Map<string, number>;
  private readonly sessionEventCounts: Map<string, number>;
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly dirtySessionIds = new Set<string>();
  private readonly knownSessionIds: Set<string>;
  private latestState: SessionStoreAppState | null = null;
  private indexRevision: number;
  private indexDirty = false;
  private indexWritePromise: Promise<void> | null = null;
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundError: unknown = null;

  constructor(
    private readonly rootPath: string,
    options: SessionStoreV2Options,
    indexRevision = 0,
    sessionRevisions = new Map<string, number>(),
    sessionEventCounts = new Map<string, number>(),
    knownSessionIds = new Set<string>(),
  ) {
    this.compactionEventCount = options.compactionEventCount ?? 64;
    this.compactionBytes = options.compactionBytes ?? 1024 * 1024;
    this.indexDebounceMs = options.indexDebounceMs ?? 800;
    this.indexRevision = indexRevision;
    this.sessionRevisions = sessionRevisions;
    this.sessionEventCounts = sessionEventCounts;
    this.knownSessionIds = knownSessionIds;
  }

  private enqueueSession(sessionId: string, operation: () => Promise<void>) {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.sessionQueues.set(sessionId, next);
    void next.finally(() => {
      if (this.sessionQueues.get(sessionId) === next) {
        this.sessionQueues.delete(sessionId);
      }
    }).catch(() => undefined);
    return next;
  }

  private async loadSessionRevisionState(sessionId: string) {
    if (this.sessionRevisions.has(sessionId)) {
      return;
    }
    const paths = pathsForRoot(this.rootPath, sessionId);
    if (
      this.knownSessionIds.has(sessionId) &&
      !(await fileExists(paths.metaPath)) &&
      !(await fileExists(`${paths.metaPath}.previous`))
    ) {
      throw new Error(`Missing V2 page metadata for session "${sessionId}".`);
    }
    const meta = await readSessionStoreV2PageMeta(paths.sessionPath, sessionId);
    const raw = await readOptionalTextWithPrevious(paths.eventsPath) ?? '';
    const events = parseSessionStoreV2EventLog(raw);
    if (raw.trim() && !/\r?\n$/.test(raw)) {
      await atomicReplaceFile(
        paths.eventsPath,
        events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n` : '',
      );
    }
    const pending = events.filter((event) => event.revision > meta.revision);
    this.sessionRevisions.set(
      sessionId,
      events.reduce((revision, event) => Math.max(revision, event.revision), meta.revision),
    );
    this.sessionEventCounts.set(sessionId, pending.length);
    if (pending.length > 0) {
      this.dirtySessionIds.add(sessionId);
    }
  }

  private async compactSession(sessionId: string) {
    const paths = pathsForRoot(this.rootPath, sessionId);
    const raw = await readOptionalTextWithPrevious(paths.eventsPath) ?? '';
    const events = parseSessionStoreV2EventLog(raw);
    const meta = await applySessionStoreV2EventsToPages(
      paths.sessionPath,
      sessionId,
      events,
    );
    await atomicReplaceFile(paths.eventsPath, '');
    this.sessionRevisions.set(sessionId, meta.revision);
    this.sessionEventCounts.set(sessionId, 0);
    this.dirtySessionIds.delete(sessionId);
  }

  private async appendMutation(mutation: SessionStoreV2SessionMutation) {
    const sessionId = mutation.sessionId;
    await this.loadSessionRevisionState(sessionId);
    const revision = (this.sessionRevisions.get(sessionId) ?? 0) + 1;
    if (mutation.type === 'replace-messages') {
      const paths = pathsForRoot(this.rootPath, sessionId);
      await replaceSessionStoreV2Messages(
        paths.sessionPath,
        sessionId,
        mutation.messages,
        revision,
      );
      await atomicReplaceFile(paths.eventsPath, '');
      this.sessionRevisions.set(sessionId, revision);
      this.sessionEventCounts.set(sessionId, 0);
      this.dirtySessionIds.delete(sessionId);
      this.knownSessionIds.add(sessionId);
      return;
    }
    const event: SessionStoreV2Event = mutation.type === 'upsert-message'
      ? {
          schemaVersion: SESSION_STORE_V2_SCHEMA_VERSION,
          sessionId,
          revision,
          type: mutation.type,
          message: mutation.message,
        }
      : {
          schemaVersion: SESSION_STORE_V2_SCHEMA_VERSION,
          sessionId,
          revision,
          type: mutation.type,
          messages: mutation.messages,
        };
    const paths = pathsForRoot(this.rootPath, sessionId);
    await mkdir(paths.sessionPath, { recursive: true });
    await appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
    this.sessionRevisions.set(sessionId, revision);
    this.dirtySessionIds.add(sessionId);
    const eventCount = (this.sessionEventCounts.get(sessionId) ?? 0) + 1;
    this.sessionEventCounts.set(sessionId, eventCount);
    this.knownSessionIds.add(sessionId);

    const eventBytes = (await stat(paths.eventsPath)).size;
    if (eventCount >= this.compactionEventCount || eventBytes >= this.compactionBytes) {
      await this.compactSession(sessionId);
    }
  }

  async readMessagePage(sessionId: string, before?: string): Promise<SessionMessagePage> {
    let result: SessionMessagePage | null = null;
    await this.enqueueSession(sessionId, async () => {
      await this.loadSessionRevisionState(sessionId);
      if (this.dirtySessionIds.has(sessionId)) {
        await this.compactSession(sessionId);
      }
      result = await readSessionStoreV2MessagePage(
        pathsForRoot(this.rootPath, sessionId).sessionPath,
        sessionId,
        before,
      );
    });
    if (!result) {
      throw new Error(`Failed to read history page for session "${sessionId}".`);
    }
    return result;
  }

  private scheduleIndexWrite() {
    this.indexDirty = true;
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
    }
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.queueIndexWrite().catch((error) => {
        this.backgroundError = error;
      });
    }, this.indexDebounceMs);
  }

  private queueIndexWrite() {
    this.indexDirty = true;
    if (!this.indexWritePromise) {
      this.indexWritePromise = (async () => {
        while (this.indexDirty) {
          this.indexDirty = false;
          const state = this.latestState;
          if (!state) {
            continue;
          }
          const revision = this.indexRevision + 1;
          const index = buildIndex(state, revision);
          await atomicReplaceFile(pathsForRoot(this.rootPath).indexPath, JSON.stringify(index));
          this.indexRevision = revision;
        }
      })().finally(() => {
        this.indexWritePromise = null;
      });
    }
    return this.indexWritePromise;
  }

  async persist(state: SessionStoreAppState, request: SessionStoreV2PersistRequest = {}) {
    if (this.backgroundError) {
      const error = this.backgroundError;
      this.backgroundError = null;
      throw error;
    }
    this.latestState = state;
    // Persist awaits every session queue before returning, so a deep clone here
    // only duplicates potentially multi-megabyte content without adding safety.
    const mutations = request.sessionMutations ?? [];
    for (const mutation of mutations) {
      await this.enqueueSession(mutation.sessionId, () => this.appendMutation(mutation));
    }

    if (request.immediateIndex || (request.deletedSessionIds?.length ?? 0) > 0) {
      if (this.indexTimer) {
        clearTimeout(this.indexTimer);
        this.indexTimer = null;
      }
      await this.queueIndexWrite();
    } else {
      this.scheduleIndexWrite();
    }

    for (const sessionId of request.deletedSessionIds ?? []) {
      await this.enqueueSession(sessionId, async () => {
        const sessionPath = pathsForRoot(this.rootPath, sessionId).sessionPath;
        const resolvedRoot = path.resolve(this.rootPath);
        const resolvedSessionPath = path.resolve(sessionPath);
        if (!resolvedSessionPath.startsWith(`${resolvedRoot}${path.sep}`)) {
          throw new Error(`Refusing to remove session path outside the V2 store: ${resolvedSessionPath}`);
        }
        await rm(resolvedSessionPath, { recursive: true, force: true });
        this.sessionRevisions.delete(sessionId);
        this.sessionEventCounts.delete(sessionId);
        this.knownSessionIds.delete(sessionId);
      });
    }
  }

  async flush(state: SessionStoreAppState) {
    this.latestState = state;
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = null;
    }
    await Promise.all([...this.sessionQueues.values()]);
    await Promise.all(
      [...this.dirtySessionIds].map((sessionId) =>
        this.enqueueSession(sessionId, () => this.compactSession(sessionId)),
      ),
    );
    await this.queueIndexWrite();
    if (this.indexWritePromise) {
      await this.indexWritePromise;
    }
    if (this.backgroundError) {
      const error = this.backgroundError;
      this.backgroundError = null;
      throw error;
    }
  }
}

const loadSessionStoreV2FromRoot = async (
  rootPath: string,
  options: SessionStoreV2Options,
  requireManifest = true,
) => {
  const paths = pathsForRoot(rootPath);
  if (requireManifest) {
    validateManifest(parseJson(await readTextWithPrevious(paths.manifestPath), 'V2 session store manifest'));
  }
  const index = validateIndex(parseJson(await readTextWithPrevious(paths.indexPath), 'V2 session store index'));
  const projects: ProjectRecord[] = index.projects.map((project) => ({
    ...project,
    dreams: project.dreams.map((dream) => ({
      ...dream,
      sessions: dream.sessions.map((summary) => ({
        ...summary,
        messages: [],
        messagesLoaded: false,
      } as SessionRecord)),
    })),
  }));

  const state: SessionStoreAppState = {
    projects,
    deletedImports: {
      claudeSessionIds: [...index.deletedImports.claudeSessionIds],
      codexThreadIds: [...index.deletedImports.codexThreadIds],
    },
  };
  return {
    state,
    store: new SessionStoreV2(
      rootPath,
      options,
      index.revision,
      new Map(),
      new Map(),
      new Set(sessionRecords(state).map((session) => session.id)),
    ),
  };
};

export const openSessionStoreV2 = async (
  userDataPath: string,
  options: SessionStoreV2Options,
) => {
  await acquireSessionStoreV2Lock(userDataPath);
  try {
    return await loadSessionStoreV2FromRoot(
      path.join(userDataPath, SESSION_STORE_V2_DIRECTORY_NAME),
      options,
    );
  } catch (error) {
    if (isMissingEntry(error)) {
      return null;
    }
    throw error;
  }
};

const verifyMigratedStore = async (
  rootPath: string,
  source: SessionStoreAppState,
) => {
  const index = validateIndex(
    parseJson(
      await readTextWithPrevious(pathsForRoot(rootPath).indexPath),
      'migrated V2 session store index',
    ),
  );
  const sourceSessions = sessionRecords(source);
  const indexedSessions = new Map(
    index.projects.flatMap((project) =>
      project.dreams.flatMap((dream) => dream.sessions),
    ).map((session) => [session.id, session]),
  );
  if (source.projects.length !== index.projects.length || sourceSessions.length !== indexedSessions.size) {
    throw new Error('V2 migration verification failed: project or session count mismatch.');
  }
  for (const sourceSession of sourceSessions) {
    const indexedSession = indexedSessions.get(sourceSession.id);
    const expectedMessages = sourceSession.messages ?? [];
    const loaded = await readAllSessionStoreV2Messages(
      pathsForRoot(rootPath, sourceSession.id).sessionPath,
      sourceSession.id,
    );
    if (
      !indexedSession ||
      loaded.messages.length !== expectedMessages.length ||
      messageListDigest(loaded.messages) !== messageListDigest(expectedMessages)
    ) {
      throw new Error(`V2 migration verification failed for session "${sourceSession.id}".`);
    }
    if (
      indexedSession.claudeSessionId !== sourceSession.claudeSessionId ||
      indexedSession.codexThreadId !== sourceSession.codexThreadId
    ) {
      throw new Error(`V2 migration changed the native provider identity for session "${sourceSession.id}".`);
    }
  }
  if (JSON.stringify(index.deletedImports) !== JSON.stringify(source.deletedImports)) {
    throw new Error('V2 migration verification failed: deleted native-import metadata changed.');
  }
};

export const migrateSessionStoreV2 = async (
  userDataPath: string,
  state: SessionStoreAppState,
  options: SessionStoreV2Options,
) => {
  await acquireSessionStoreV2Lock(userDataPath);
  const finalRoot = path.join(userDataPath, SESSION_STORE_V2_DIRECTORY_NAME);
  const existing = await openSessionStoreV2(userDataPath, options);
  if (existing) {
    return existing.store;
  }

  await mkdir(userDataPath, { recursive: true });
  const finalPaths = pathsForRoot(finalRoot);
  const resolvedUserData = path.resolve(userDataPath);
  const resolvedFinalRoot = path.resolve(finalRoot);
  if (!resolvedFinalRoot.startsWith(`${resolvedUserData}${path.sep}`)) {
    throw new Error(`Refusing to initialize a V2 store outside user data: ${resolvedFinalRoot}`);
  }
  await rm(resolvedFinalRoot, { recursive: true, force: true });
  await mkdir(finalPaths.sessionsPath, { recursive: true });
  let activated = false;

  try {
    for (const target of sessionRecords(state)) {
      const paths = pathsForRoot(finalRoot, target.id);
      await mkdir(paths.sessionPath, { recursive: true });
      await replaceSessionStoreV2Messages(
        paths.sessionPath,
        target.id,
        target.messages ?? [],
        0,
      );
      await writeFile(paths.eventsPath, '', 'utf8');
    }

    await writeFile(finalPaths.indexPath, JSON.stringify(buildIndex(state, 0)), 'utf8');
    await verifyMigratedStore(finalRoot, state);
    const manifest: SessionStoreV2Manifest = {
      schemaVersion: SESSION_STORE_V2_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
    };
    await atomicReplaceFile(finalPaths.manifestPath, JSON.stringify(manifest));
    activated = true;
    return new SessionStoreV2(
      finalRoot,
      options,
      0,
      new Map(sessionRecords(state).map((session) => [session.id, 0])),
      new Map(sessionRecords(state).map((session) => [session.id, 0])),
      new Set(sessionRecords(state).map((session) => session.id)),
    );
  } catch (error) {
    if (!activated) {
      await rm(resolvedFinalRoot, { recursive: true, force: true });
    }
    throw error;
  }
};
