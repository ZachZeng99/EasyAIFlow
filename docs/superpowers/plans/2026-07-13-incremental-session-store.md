# Lazy Paginated Session Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace monolithic/full-memory session persistence with a crash-safe V2 catalog that loads bounded message pages only for selected or explicitly active sessions while preserving parallel provider execution.

**Architecture:** `electron/sessionStoreV2.ts` owns an index-only catalog plus immutable bounded page files and per-session event queues. `electron/sessionStore.ts` remains the compatibility facade but stores only summaries and bounded live buffers in memory. IPC/HTTP expose one cursor-based page contract, while the React client merges pages and evicts only inactive historical pages.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Electron IPC, HTTP JSON-RPC, React, direct `tsx` tests.

---

### Task 1: Make V2 storage catalog-only and page-addressable

**Files:**
- Modify: `electron/sessionStoreV2.ts`
- Modify: `tests/sessionStoreV2.test.ts`
- Modify: `tests/sessionStoreV2Migration.test.ts`

- [ ] **Step 1: Write failing page-layout tests**

Add tests that call the intended APIs:

```ts
const opened = await openSessionStoreV2(userDataPath, options);
assert.equal(opened?.state.projects[0].dreams[0].sessions[0].messagesLoaded, false);
assert.deepEqual((opened?.state.projects[0].dreams[0].sessions[0] as SessionRecord).messages, []);

const newest = await opened!.store.readMessagePage('session-1');
assert.equal(newest.messages.length, 100);
assert.equal(newest.hasMoreBefore, true);
const older = await opened!.store.readMessagePage('session-1', newest.nextBefore);
assert.deepEqual([...older.messages, ...newest.messages], originalMessages);
```

Also instrument `readFile` through a dependency hook and assert catalog open reads no path below `sessions/`.

- [ ] **Step 2: Run the focused tests and observe RED**

Run: `npx tsx tests/sessionStoreV2.test.ts && npx tsx tests/sessionStoreV2Migration.test.ts`

Expected: failure because `readMessagePage`, page metadata, and catalog-only open do not exist.

- [ ] **Step 3: Replace full snapshots with bounded pages**

Implement these public types and method:

```ts
export type SessionMessagePage = {
  sessionId: string;
  pageId: string;
  messages: ConversationMessage[];
  nextBefore?: string;
  hasMoreBefore: boolean;
  sessionRevision: number;
};

class SessionStoreV2 {
  readMessagePage(sessionId: string, before?: string): Promise<SessionMessagePage>;
}
```

Write `meta.json` with ordered page descriptors and a message-ID locator. Split messages at 100 entries or 5 MiB of serialized data, allowing one oversize message on its own page. Make `loadSessionStoreV2FromRoot()` construct `messages: []` and `messagesLoaded: false` from `index.json` without opening session paths.

- [ ] **Step 4: Preserve targeted append/upsert and crash safety**

Keep per-session JSONL revisions. Before page reads, flush and compact the bounded event tail into only the affected page(s), atomically publish `meta.json`, then clear covered events. Whole-session replace rebuilds pages and publishes metadata last.

- [ ] **Step 5: Run page and migration tests GREEN**

Run the two focused test files. Expected: all tests pass and migration verifies exact message digests across pages.

### Task 2: Refactor the session-store facade around catalog state

**Files:**
- Modify: `electron/sessionStore.ts`
- Modify: `src/data/types.ts`
- Modify: `tests/sessionStoreLoadState.test.ts`
- Modify: `tests/sessionStoreV2Integration.test.ts`

- [ ] **Step 1: Add failing catalog and lazy-read integration tests**

Assert that cold V2 `loadState()` returns summaries with no messages, `getSessionMessagePage(sessionId)` reads only the newest page, and appending to an unloaded session persists the append without materializing older pages.

```ts
const state = await store.loadState();
assert.equal(find(state, 's1').messages.length, 0);
assert.equal(find(state, 's1').messagesLoaded, false);
await store.appendMessagesToSession('s1', [message], 'preview', 'now');
assert.equal((await store.getSessionMessagePage('s1')).messages.at(-1)?.id, message.id);
```

- [ ] **Step 2: Run integration tests RED**

Run: `npx tsx tests/sessionStoreLoadState.test.ts && npx tsx tests/sessionStoreV2Integration.test.ts`

Expected: existing loader hydrates all messages and no page facade exists.

- [ ] **Step 3: Introduce the page facade and bounded live records**

Add to shared types:

```ts
export type SessionHistoryPageState = {
  nextBefore?: string;
  hasMoreBefore: boolean;
  sessionRevision: number;
};
```

Export `getSessionMessagePage(sessionId, before?)`. Keep `cachedState` catalog-only. Message mutators update only catalog preview/group sequence plus a `liveSessionMessages` map for current-turn IDs, and send append/upsert mutations directly to V2. Any operation that needs history must explicitly iterate page reads.

- [ ] **Step 4: Remove V2 startup hydration and legacy caps**

Do not call full native/session hydration during V2 cold open. After one-time V1 migration, reopen V2 catalog state and release the parsed V1 object. Apply the 400-message cap only to the legacy writer; V2 page writes preserve all messages.

- [ ] **Step 5: Run facade tests GREEN**

Run the two integration tests plus `tests/sessionStorePersistTrim.test.ts`. Expected: all pass, with the legacy cap test unchanged and V2 retaining complete history.

### Task 3: Discover native sessions by metadata and import bodies lazily

**Files:**
- Modify: `electron/sessionStore.ts`
- Modify: `tests/sessionStoreCodexImport.test.ts`
- Modify: `tests/sessionStoreLoadState.test.ts`

- [ ] **Step 1: Write failing native-laziness tests**

Create Claude `history.jsonl`, Codex `session_index.jsonl`, and large native transcript fixtures. Assert bootstrap discovers titles/provider IDs but does not call transcript parsers. Then call `getSessionMessagePage()` for one imported session and assert only that transcript is parsed and paged.

- [ ] **Step 2: Run native tests RED**

Run: `npx tsx tests/sessionStoreCodexImport.test.ts && npx tsx tests/sessionStoreLoadState.test.ts`

Expected: bootstrap currently parses every transcript.

- [ ] **Step 3: Split metadata discovery from transcript materialization**

Read Claude history entries and Codex session-index/thread metadata into catalog summaries. For Codex files absent from the name index, read only the first JSONL metadata record. Store enough native source identity to locate the body later without embedding content.

- [ ] **Step 4: Materialize one requested native session**

On first page request or provider activation, parse only that session's native file, replace its V2 pages, update the catalog, and serve the newest page. Existing explicit `recoverSessionFromNativeHistory(sessionId)` continues to target one session.

- [ ] **Step 5: Run native tests GREEN**

Run the focused import/load tests. Expected: titles appear at bootstrap and transcript parser counters remain zero until the matching session is opened.

### Task 4: Expose identical page APIs in Electron and web

**Files:**
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `server/server.ts`
- Modify: `src/bridge.ts`
- Modify: `backend/claudeRpcOperations.ts`
- Modify: `tests/sessionStoreV2Integration.test.ts`

- [ ] **Step 1: Add failing contract tests**

Assert that desktop bootstrap passes `{ bootstrapProjects: true }`, both runtimes return message-free catalogs, and both page endpoints accept `{ sessionId, before? }` and return the same `SessionMessagePage` shape.

- [ ] **Step 2: Run contract tests RED**

Expected: Electron bootstrap still uses the full-project branch and the page endpoint is absent.

- [ ] **Step 3: Wire the shared operation**

Replace `sessions:get-record`/`getSessionRecord` with page-aware behavior while keeping a compatibility wrapper if existing callers require it. Route Electron IPC and HTTP RPC to the same session-store function. Ensure all mutating `projects` responses contain catalog summaries only.

- [ ] **Step 4: Run contract tests GREEN**

Run the integration test and `npm run check`. Expected: identical desktop/web types and no full message arrays in bootstrap/mutation responses.

### Task 5: Add frontend pagination, merging, and safe LRU eviction

**Files:**
- Create: `src/data/sessionHistoryPages.ts`
- Create: `tests/sessionHistoryPages.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/ChatThread.tsx`
- Modify: `src/data/projectSnapshots.ts`
- Modify: `tests/chatThread.test.ts`
- Modify: `tests/projectSnapshots.test.ts`

- [ ] **Step 1: Write failing pure page-cache tests**

Test chronological prepend with ID de-duplication, stale-page protection by revision, and eviction that keeps the selected session, two recent inactive sessions, and every pinned session.

```ts
const result = evictInactiveSessionHistory(projects, {
  selectedSessionId: 'g',
  recentSessionIds: ['f', 'e'],
  pinnedSessionIds: new Set(['a']),
});
assert.equal(find(result, 'a').messagesLoaded, true);
assert.equal(find(result, 'b').messagesLoaded, false);
```

- [ ] **Step 2: Run page-cache tests RED**

Run: `npx tsx tests/sessionHistoryPages.test.ts`

Expected: module/functions are absent.

- [ ] **Step 3: Implement pure merging and eviction**

Add `mergeSessionHistoryPage`, `mergeLiveSessionMessage`, `isInteractionPinned`, and `evictInactiveSessionHistory`. Eviction clears only historical page arrays/state; it never removes catalog or interaction entries.

- [ ] **Step 4: Connect selection and upward scrolling**

On selection, fetch the newest page only if not loaded. `ChatThread` invokes `onLoadOlder` when its scroll container reaches the top while `hasMoreBefore` and not already loading. Preserve scroll position after prepending older messages.

- [ ] **Step 5: Pin all active and awaiting-interaction sessions**

Derive pinned IDs from runtime phases, queued sends, and pending permission/plan/question state. Existing live events continue to merge by session ID even when that session is not selected.

- [ ] **Step 6: Run frontend tests GREEN**

Run the new page-cache test plus chat-thread and project-snapshot tests. Expected: pagination order is stable and six switches cannot evict a pinned awaiting-reply session.

### Task 6: Concurrency, recovery, memory, and release verification

**Files:**
- Modify: `tests/sessionStoreV2Stress.test.ts`
- Modify: `tests/sessionStoreV2Integration.test.ts`
- Modify: `docs/superpowers/specs/2026-07-13-incremental-session-store-design.md` only if verified behavior differs

- [ ] **Step 1: Write failing interleaved-session stress coverage**

Run parallel append/upsert loops for Claude, Codex, a group room, and hidden group members. Keep one session in awaiting-reply while reading six other sessions and assert its request/live state and persisted messages remain intact.

- [ ] **Step 2: Verify the stress test fails before final fixes**

Run: `npx tsx tests/sessionStoreV2Stress.test.ts`

Expected: any remaining shared revision/cache coupling is exposed.

- [ ] **Step 3: Fix only demonstrated concurrency/recovery defects**

Keep session queues/revisions independent, ensure shutdown flushes every queue, and refuse eviction after a failed flush. Do not add unrelated provider changes.

- [ ] **Step 4: Run the complete automated verification**

Run every `tests/sessionStore*.test.ts`, the page-cache/chat/group tests, `npm run check`, `npm run build`, and `git diff --check`.

- [ ] **Step 5: Run real-data smoke tests on an isolated copy**

Copy the active V1 file to `.tmp-tests`, verify its SHA-256 is unchanged after migration, cold-open V2 with `--expose-gc`, and record RSS/heap. Assert the cold open reads only catalog files. Update one session repeatedly and confirm unrelated page files are unchanged and no multi-gigabyte write spike occurs.

- [ ] **Step 6: Review, commit, and push**

Review the complete diff and status, commit implementation/tests/docs, push `codex/incremental-session-store`, and report the remote branch and verification evidence.
