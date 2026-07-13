import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRecord } from '../src/data/types.ts';
import type { SessionStoreAppState } from '../electron/sessionStoreMerge.ts';
import {
  getSessionStoreV2Paths,
  migrateSessionStoreV2,
  openSessionStoreV2,
} from '../electron/sessionStoreV2.ts';

const options = {
  maxMessages: 0,
  compactionEventCount: 64,
  compactionBytes: 1024 * 1024,
  indexDebounceMs: 5,
};

const memory = () => {
  global.gc?.();
  const usage = process.memoryUsage();
  return {
    rssMiB: Math.round(usage.rss / 1024 / 1024),
    heapUsedMiB: Math.round(usage.heapUsed / 1024 / 1024),
    externalMiB: Math.round(usage.external / 1024 / 1024),
  };
};

const [mode, userDataPath] = process.argv.slice(2);
if (!mode || !userDataPath) {
  throw new Error('Usage: sessionStoreV2MemorySmoke.ts <migrate|open> <userDataPath>');
}

if (mode === 'migrate') {
  const migration = await (async () => {
    const legacyPath = path.join(userDataPath, 'easyaiflow-sessions.json');
    const raw = await readFile(legacyPath, 'utf8');
    const beforeHash = createHash('sha256').update(raw).digest('hex');
    const parsed = JSON.parse(raw) as { projects: ProjectRecord[]; deletedImports?: SessionStoreAppState['deletedImports'] };
    const state: SessionStoreAppState = {
      projects: parsed.projects,
      deletedImports: parsed.deletedImports ?? { claudeSessionIds: [], codexThreadIds: [] },
    };
    const legacyBytes = Buffer.byteLength(raw);
    const projects = state.projects.length;
    const sessions = state.projects.flatMap((project) =>
      project.dreams.flatMap((dream) => dream.sessions),
    ).length;
    await migrateSessionStoreV2(userDataPath, state, options);
    const afterHash = createHash('sha256')
      .update(await readFile(legacyPath, 'utf8'))
      .digest('hex');
    return {
      legacyBytes,
      legacyUnchanged: beforeHash === afterHash,
      projects,
      sessions,
    };
  })();
  console.log(JSON.stringify({
    mode,
    ...migration,
    memory: memory(),
  }));
} else if (mode === 'open') {
  const loaded = await openSessionStoreV2(userDataPath, options);
  if (!loaded) {
    throw new Error('V2 store was not found.');
  }
  const coldMemory = memory();
  const catalogSessions = loaded.state.projects.flatMap((project) =>
    project.dreams.flatMap((dream) => dream.sessions),
  );
  const sessionDirs = await readdir(getSessionStoreV2Paths(userDataPath).sessionsPath, { withFileTypes: true });
  let largest: { sessionId: string; bytes: number; messages: number } | null = null;
  for (const dir of sessionDirs) {
    if (!dir.isDirectory()) {
      continue;
    }
    try {
      const meta = JSON.parse(
        await readFile(path.join(getSessionStoreV2Paths(userDataPath).sessionsPath, dir.name, 'meta.json'), 'utf8'),
      ) as { sessionId: string; messageCount: number; pages: Array<{ byteLength: number }> };
      const bytes = meta.pages.reduce((sum, page) => sum + page.byteLength, 0);
      if (!largest || bytes > largest.bytes) {
        largest = { sessionId: meta.sessionId, bytes, messages: meta.messageCount };
      }
    } catch {
      // Ignore an incomplete benchmark copy; normal store reads still validate it.
    }
  }
  const page = largest ? await loaded.store.readMessagePage(largest.sessionId) : null;
  console.log(JSON.stringify({
    mode,
    catalogSessions: catalogSessions.length,
    catalogMessagesInMemory: catalogSessions.reduce(
      (sum, session) => sum + ((session as { messages?: unknown[] }).messages?.length ?? 0),
      0,
    ),
    coldMemory,
    largestSession: largest,
    openedPage: page ? {
      messages: page.messages.length,
      serializedBytes: Buffer.byteLength(JSON.stringify(page.messages)),
      hasMoreBefore: page.hasMoreBefore,
    } : null,
    afterOnePageMemory: memory(),
  }));
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
