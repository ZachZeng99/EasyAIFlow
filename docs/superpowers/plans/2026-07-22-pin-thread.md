# Pin Thread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. This repository requires direct edits on the current branch, so do not create a branch or worktree.

**Goal:** Add a Codex-style persistent pin/unpin action for EasyAIFlow sessions so pinned threads stay at the top of their Streamwork.

**Architecture:** Store a boolean `pinned` flag on `SessionSummary`, mutate it through the shared session store, and expose the mutation through both Electron IPC and Web RPC. Keep ordering in a small pure frontend helper: pinned sessions first, then descending `updatedAt`; render a pin marker and expose Pin/Unpin in the existing session context menu.

**Tech Stack:** TypeScript, React 19, Electron IPC, JSON-RPC, the existing V2 session store, `node:assert/strict`, and `tsx`.

---

### Task 1: Define and test pinned-session ordering

**Files:**
- Create: `src/data/sessionOrder.ts`
- Create: `tests/sessionOrder.test.ts`
- Modify: `src/data/types.ts`

- [ ] **Step 1: Write the failing ordering test**

Create sessions with mixed `pinned` values and timestamps, then assert that `sortSessionsWithPinnedFirst` returns pinned sessions first and uses descending `updatedAt` inside both groups without mutating the input.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx tests/sessionOrder.test.ts`

Expected: FAIL because `src/data/sessionOrder.ts` does not exist.

- [ ] **Step 3: Add the minimal type and ordering helper**

Add `pinned?: boolean` to `SessionSummary` and implement:

```ts
export const sortSessionsWithPinnedFirst = <T extends Pick<SessionSummary, 'pinned' | 'updatedAt'>>(
  sessions: readonly T[],
) =>
  [...sessions].sort((left, right) => {
    const pinDifference = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
    return pinDifference || (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
```

- [ ] **Step 4: Run the ordering test**

Run: `npx tsx tests/sessionOrder.test.ts`

Expected: PASS.

### Task 2: Persist pin/unpin through desktop and web bridges

**Files:**
- Create: `tests/sessionStorePin.test.ts`
- Modify: `electron/sessionStore.ts`
- Modify: `electron/main.ts`
- Modify: `electron/preload.cts`
- Modify: `server/server.ts`
- Modify: `src/bridge.ts`

- [ ] **Step 1: Write the failing persistence test**

Create a temporary store and session, call `setSessionPinned(sessionId, true)`, assert the returned project snapshot and stored session are pinned, flush/re-import the store and assert the flag remains pinned, then call `setSessionPinned(sessionId, false)` and assert it clears without changing `updatedAt`.

- [ ] **Step 2: Run the persistence test to verify it fails**

Run: `npx tsx tests/sessionStorePin.test.ts`

Expected: FAIL because `setSessionPinned` is not exported.

- [ ] **Step 3: Implement the store mutation**

Add `setSessionPinned(sessionId: string, pinned: boolean)` that finds the session, throws `Session not found.` when absent, stores `true` for pin and removes/clears the flag for unpin, persists the V2 index immediately, and returns the lightweight project snapshot.

- [ ] **Step 4: Expose the mutation in both runtimes**

Add `setSessionPinned({ sessionId, pinned })` to `EasyAIFlowBridge`, map it to `sessions:set-pinned` in the preload/main process, and map it to `setSessionPinned` in the web RPC operations.

- [ ] **Step 5: Run the persistence test**

Run: `npx tsx tests/sessionStorePin.test.ts`

Expected: PASS.

### Task 3: Add the sidebar interaction and visual state

**Files:**
- Create: `tests/chatHistory.test.ts`
- Modify: `src/components/ChatHistory.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles/app.css`

- [ ] **Step 1: Write the failing render test**

Render `ChatHistory` with a pinned session and assert the markup includes an accessible `Pinned session` marker.

- [ ] **Step 2: Run the render test to verify it fails**

Run: `npx tsx tests/chatHistory.test.ts`

Expected: FAIL because the marker is not rendered.

- [ ] **Step 3: Wire pinning into the sidebar**

Use `sortSessionsWithPinnedFirst` everywhere visible sessions are ordered, add `onSetSessionPinned`, keep the full session in context-menu state, add `Pin thread` / `Unpin thread`, and render a compact pin marker beside pinned titles.

- [ ] **Step 4: Wire the App handler**

Call `bridge.setSessionPinned`, replace project summaries with the result, and surface errors through the existing UI error banner.

- [ ] **Step 5: Add focused styling**

Style the pin marker as a small non-interactive accent that does not compete with provider and activity states.

- [ ] **Step 6: Run focused tests and type checks**

Run:

```powershell
npx tsx tests/sessionOrder.test.ts
npx tsx tests/sessionStorePin.test.ts
npx tsx tests/chatHistory.test.ts
npm run check
```

Expected: all tests PASS and TypeScript exits successfully.

- [ ] **Step 7: Run the full build**

Run: `npm run build`

Expected: TypeScript, Vite, and Electron builds all succeed.

### Task 4: Move pinned threads outside the hierarchy

**Files:**
- Modify: `src/data/sessionOrder.ts`
- Modify: `src/components/ChatHistory.tsx`
- Modify: `src/styles/app.css`
- Modify: `tests/sessionOrder.test.ts`
- Modify: `tests/chatHistory.test.ts`

- [ ] **Step 1: Write failing global-pinning tests**

Assert that `collectPinnedSessions(projects)` collects visible pinned sessions across every Project and Streamwork, sorts them by descending `updatedAt`, and excludes hidden or unpinned sessions. Render `ChatHistory` and assert the pinned card appears once in a dedicated region before `.history-tree` with `data-location-label="Project / Streamwork"`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npx tsx tests/sessionOrder.test.ts
npx tsx tests/chatHistory.test.ts
```

Expected: FAIL because the global collector and pinned region do not exist.

- [ ] **Step 3: Implement global collection and rendering**

Export `collectPinnedSessions(projects)` from `sessionOrder.ts`. In `ChatHistory`, render matching pinned sessions between the search field and project tree, omit pinned sessions from nested Streamwork lists, preserve total Streamwork counts, and reuse the normal selection/context-menu behavior.

- [ ] **Step 4: Add ownership watermark styling**

Give global pinned cards `data-location-label={`${session.projectName} / ${session.dreamName}`}` and override their background pseudo-element to display that text as a low-contrast watermark.

- [ ] **Step 5: Verify focused behavior and the production build**

Run:

```powershell
npx tsx tests/sessionOrder.test.ts
npx tsx tests/chatHistory.test.ts
npx tsx tests/sessionStorePin.test.ts
npm run build
```

Expected: all tests PASS and the production build exits successfully.
