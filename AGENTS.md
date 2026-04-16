# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

EasyAIFlow is a desktop client for local AI coding workflows, focused on Codex CLI/Codex integration. It's an Electron + React single-codebase app that also supports a web server runtime. The README and UI are in Chinese; code and comments are in English.

## Commands

### Development
```bash
npm run dev              # Start both Vite dev server + Electron app
npm run dev:web          # Start Vite + web server (no Electron)
npm run dev:web:client   # Start only the Vite frontend (port 4173)
npm run dev:server       # Start only the web server (tsx server/server.ts)
```

### Build & Package
```bash
npm run check            # Type-check all TypeScript configs (tsc -b)
npm run build            # Full build: type-check + Vite + Electron TS
npm run build:web        # Web-only build: type-check + Vite + server TS
npm run package:win      # Build + create Windows NSIS installer
```

### Testing
Tests use `node:assert/strict` with a custom `run()` harness (no test framework). Run individual tests with tsx:
```bash
npx tsx tests/planMode.test.ts          # Run a single test file
npx tsx tests/claudeControlMessages.test.ts
```
There is no `npm test` script. Each test file is self-contained and executable.

## Architecture

### Dual Runtime Model
The app runs in two modes sharing the same business logic:

- **Desktop (Electron)**: `electron/main.ts` registers `ipcMain.handle()` handlers. `electron/preload.cts` exposes them as `window.easyAIFlow` via context bridge.
- **Web (HTTP server)**: `server/server.ts` exposes the same operations as JSON-RPC at `POST /api/rpc` with SSE event streaming at `GET /api/events`.

The frontend uses `src/bridge.ts` to abstract over both runtimes — it detects `window.easyAIFlow` (desktop) vs falls back to HTTP calls (web).

### Data Model Hierarchy
```
ProjectRecord[]
  └─ DreamRecord[] (Streamworks)
     └─ SessionSummary[] (standard | harness | harness_role)
        └─ ConversationMessage[]
```
All types are in `src/data/types.ts`. Session data persists to a single JSON file via `electron/sessionStore.ts`.

### Codex CLI Integration
- `electron/claudeSpawn.ts` spawns `Codex` child processes
- Stdout is parsed as NDJSON line-by-line (`electron/sequentialLineProcessor.ts`)
- Control messages (permission requests, plan mode, ask-user-question) are parsed in `electron/claudeControlMessages.ts`
- Responses are written back to Codex's stdin using `buildClaudeControlResponseLine()` and related builders
- Active Codex processes are tracked in `electron/claudeRunRegistry.ts`

### Event Flow
1. User action → bridge call → Electron IPC or HTTP RPC
2. Backend spawns/resumes Codex CLI process
3. Codex stdout → parsed into `ClaudeStreamEvent` (delta, status, complete, permission-request, plan-mode-request, ask-user-question, etc.)
4. Events delivered to frontend via IPC `Codex:event` (desktop) or SSE (web)
5. `App.tsx` applies events to React state via `applyClaudeEvent()`

### Key Directories
- `src/components/` — React components (ChatThread, ChatComposer, PlanModeDialog, AskUserQuestionDialog, HarnessDashboard, etc.)
- `src/data/` — Shared types and pure business logic (planMode, askUserQuestion, permissionRequest, codeChangeDiff, etc.)
- `electron/` — Electron main process, IPC handlers, Codex CLI integration, session persistence
- `backend/` — Shared backend logic used by both Electron and web server (harnessOrchestrator, runtimePaths)
- `server/` — Web server runtime (single file: server.ts)
- `tests/` — Test files mirroring source structure, run individually with tsx

### TypeScript Configuration
Multi-project setup with `tsc -b` (composite):
- `tsconfig.app.json` — Frontend (src/, shared/) → DOM target
- `tsconfig.electron.json` — Electron main (backend/, electron/, src/data/) → dist-electron/
- `tsconfig.server.json` — Web server (backend/, server/, electron/, src/data/) → dist-server/
- `tsconfig.node.json` — Build tooling (vite.config.ts)

### Harness System
Multi-agent orchestration (Planner → Generator → Evaluator) managed by `backend/harnessOrchestrator.ts`. Creates role-based sub-sessions coordinated through a manifest.json in an artifact directory. UI in `src/components/HarnessDashboard.tsx`.

### Interactive Dialog System
Codex can pause execution and request user input through three mechanisms:
- **Permission requests**: Path/tool access approval (`PermissionDialog`)
- **Plan mode**: Plan review and approval with multiple strategies (`PlanModeDialog`)
- **Ask user question**: Multi-choice questions with optional notes (`AskUserQuestionDialog`)

Each has a pending request registry in the backend, a parser in `claudeControlMessages.ts`, and a response builder that writes back to Codex's stdin.

## Conventions

- No ESLint or Prettier configured; TypeScript strict mode is the primary code quality gate
- Vite dev server runs on port 4173; API proxy forwards `/api` to port 8787
- Session persistence path: platform-specific via `electron/sessionStore.ts` (typically `~/.EasyAIFlow/`)
- The project requires a locally installed and working `Codex` CLI command
