# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

EasyAIFlow is a desktop/web client for local AI coding workflows. The current codebase supports both Claude and Codex providers, standard one-on-one sessions, and shared group-room sessions that coordinate hidden Claude/Codex backing sessions. The README and UI are in Chinese; code and comments are in English.

## Commands

### Development
```bash
npm run dev              # Start both Vite dev server + Electron app
npm run dev:web          # Start Vite + web server (no Electron)
npm run dev:web:client   # Start only the Vite frontend (default port 4273)
npm run dev:server       # Start only the web server (tsx server/server.ts, default port 8887)
```

### Build & Package
```bash
npm run check            # Type-check all TypeScript configs (tsc -b)
npm run build            # Full build: type-check + Vite + Electron TS
npm run build:web        # Web-only build: type-check + Vite + server TS
npm run package:win      # Build + create Windows NSIS installer
```

### Testing
Tests use `node:assert/strict` with a small custom `run()` helper (no test framework). Run individual tests with tsx:
```bash
npx tsx tests/groupChat.test.ts
npx tsx tests/codexAppServerTurn.test.ts
npx tsx tests/sessionStoreCodexImport.test.ts
```
There is no `npm test` script. Each test file is self-contained and executable.

## Architecture

### Dual Runtime Model
The app runs in two modes sharing the same business logic:

- **Desktop (Electron)**: `electron/main.ts` registers `ipcMain.handle()` handlers. `electron/preload.cts` exposes them as `window.easyAIFlow` via context bridge.
- **Web (HTTP server)**: `server/server.ts` exposes the same operations as JSON-RPC at `POST /api/rpc` with SSE event streaming at `GET /api/events`.

The frontend uses `src/bridge.ts` to abstract over both runtimes. It detects `window.easyAIFlow` in desktop mode and falls back to HTTP RPC + SSE in web mode.

### Session Model
```text
ProjectRecord[]
  └─ DreamRecord[] (Streamworks)
     └─ SessionSummary[] (standard | group | group_member)
        └─ ConversationMessage[]
```

- `standard`: a normal Claude or Codex session
- `group`: a visible room session shared by multiple participants
- `group_member`: a hidden backing session for one room participant

All shared types are in `src/data/types.ts`. Session data persists to a single JSON file via `electron/sessionStore.ts`, with import/recovery logic for native Claude and Codex histories.

### Provider Runtime Model
- **Claude runtime**: `backend/claudeInteraction.ts` manages Claude CLI turns, interactive control requests, resident session metadata, and runtime-state broadcasts.
- **Codex runtime**: `backend/codexAppServer.ts`, `backend/codexAppServerTurn.ts`, and `backend/codexInteraction.ts` manage resident `codex app-server` sessions, turn capture, tool traces, and token usage normalization.
- **Runtime routing**: `backend/providerSessionRuntime.ts` selects the correct provider runtime for standard sessions.
- **Group rooms**: `backend/groupChat.ts` fans one visible room turn out to hidden Claude/Codex participant sessions and mirrors their replies/traces back into the room timeline.

### Event Flow
1. User action -> bridge call -> Electron IPC or HTTP RPC.
2. Backend resolves the target session kind (`standard` or `group`) and provider runtime.
3. Claude CLI or Codex app-server emits provider-specific events.
4. Backend normalizes them into `ClaudeStreamEvent` payloads (`delta`, `status`, `trace`, `complete`, `permission-request`, `plan-mode-request`, `ask-user-question`, `runtime-state`, etc.).
5. Events are delivered to the frontend via IPC `Codex:event` (desktop) or SSE (web).
6. `App.tsx` applies them to React state and mirrored room state.

### Key Directories
- `src/components/` - React components such as `ChatHistory`, `ChatThread`, `ChatComposer`, `ContextPanel`, `PlanModeDialog`, and `AskUserQuestionDialog`
- `src/data/` - Shared types and pure business logic (`groupChat`, `planMode`, `askUserQuestion`, `permissionRequest`, `sessionInteraction`, etc.)
- `electron/` - Electron main process, IPC handlers, session persistence, native import/recovery, and workspace helpers
- `backend/` - Shared backend logic for provider runtimes, group-chat orchestration, runtime paths, and RPC operations
- `server/` - Web server runtime (`server.ts`)
- `tests/` - Self-contained test files run directly with `tsx`

### TypeScript Configuration
Multi-project setup with `tsc -b` (composite):
- `tsconfig.app.json` - Frontend (`src/`, `shared/`) -> DOM target
- `tsconfig.electron.json` - Electron main (`backend/`, `electron/`, `src/data/`) -> `dist-electron/`
- `tsconfig.server.json` - Web server (`backend/`, `server/`, `electron/`, `src/data/`) -> `dist-server/`
- `tsconfig.node.json` - Build tooling (`vite.config.ts`)

### Interactive Dialog System
Claude sessions can pause execution and request user input through three mechanisms:
- **Permission requests**: path/tool access approval (`PermissionDialog`)
- **Plan mode**: review and approval with multiple execution strategies (`PlanModeDialog`)
- **Ask user question**: multi-choice questions with optional notes (`AskUserQuestionDialog`)

Each interaction type has a pending-request registry in the backend, a parser in `electron/claudeControlMessages.ts`, and a response builder that writes back to the active Claude run.

## Conventions

- No ESLint or Prettier is configured; TypeScript strict mode is the primary quality gate.
- The Vite dev server defaults to port `4273`; the web server defaults to port `8887`.
- Session persistence path is platform-specific via `electron/sessionStore.ts` (typically `~/.EasyAIFlow/`).
- Claude Code source reference is available at `D:\AIAgent\claude-code-sourcemap`; all Claude-related changes must be reviewed against that project before implementation.
- The project expects a working local `claude` CLI for Claude sessions and a working local `codex` CLI for Codex sessions. Group rooms use both when both participants are enabled.
