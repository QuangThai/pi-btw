# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-16

### Added

- **RPC child architecture** (`src/btw-child.ts`): Spawns `pi --mode rpc --no-session` as a headless child process for zero-context-overhead side questions. Communicates via JSONL over stdin/stdout.
- **9 parallel slots** (`src/session-state.ts`): Independent slots (1–9), each with its own RPC child process and turn queue. Ask multiple questions simultaneously.
- **Smart context scoping**: 6 configurable strategies (`smart`, `compact`, `last-n`, `budget`, `none`, `full`) with token budget control.
- **Context isolation filter**: BTW entries are automatically filtered out of the main agent's context via `ext.on("context", ...)`.
- **Streaming answer view**: Token-by-token streaming using `message_update` RPC events, with live-updating Markdown renderer.
- **Answer injection**: `Alt+I` injects formatted answers from the active slot into the main chat. Auto-clear after injection.
- **Slot shortcuts**: `Alt+H`/`Alt+L` (prev/next slot), `Alt+X` (clear slot), `Alt+1…Alt+9` (jump to slot).
- **Per-slot model config**: Optional `slotModels` array in settings for per-slot model overrides.
- **Persistent slot state**: Slot state survives `/resume`, `/fork`, and session restarts via session entry restoration.
- **Cost/token tracking**: Per-answer token counts and cost display in the answer view.
- **Logging system**: `~/.pi/agent/btw.log` with structured log entries.
- **Memory management**: `btwEntries` capped at 100 entries to prevent unbounded growth.
- **BENCHMARK.md**: Performance benchmark guide.
- **BTW-IMPROVEMENT-PLAN.md**: Full architecture documentation.

### Changed

- **Phase 1–3 rewrite**: Complete architecture overhaul from inline serialize-conversation to RPC child process model.
- **Settings system**: Extended with `maxContextTokens`, `strategy`, `recentExchanges`, `btwProvider`, `btwModelId`, `slotModels`.

### Fixed

- **Empty answer with DeepSeek reasoning models**: `getFinalOutput()` and `getPartialText()` now handle `type: "thinking"` content parts, plain string content, and custom reasoning fields.
- **Stale Markdown instance in answer view**: Added `syncMd()` to recreate the Markdown renderer when `state.text` changes during streaming.
- **Streaming not visible on reasoning models**: Added `getPartialText()` with lenient extraction for streaming updates.
- **Per-slot model not applied**: `resolveBtwModel()` now correctly receives `slotIndex` for per-slot model override lookup.
- **No notification after Esc dismiss**: Shows a notification with answer preview when streaming completes after the user dismissed the view.
- **Child process leak**: Session shutdown handler uses `Promise.allSettled` with 3s timeout for guaranteed cleanup.
- **Silent error swallowing**: All `catch { /* stale */ }` blocks now log to `btw.log`.

### Verified

- `npm run typecheck` — passes (0 errors)
- `npm pack --dry-run` — correct file listing (includes `src/` modules)
- RPC integration test — answer extraction, streaming, model compatibility confirmed

## [1.0.1] - 2026-07-11

### Fixed

- **Stale ctx crash after `/reload`**: The `/btw` command no longer crashes with `Extension "command:btw" error: This extension ctx is stale after session replacement or reload` when the user triggers `/reload` while a side-question API call is in-flight or the answer UI is active.
  - Register `session_shutdown` handler to abort in-flight requests immediately.
  - Use generation counter to detect stale `ExtensionContext` and exit early.
  - Guard all `ctx.*` property accesses and `api?.appendEntry()` with try/catch as safe fallback.
  - Per pi docs best practices: cancel async work on shutdown, check session validity after each `await`, never reuse a captured `ctx` across session boundaries.

### Verified

- `npm run typecheck` — passes
- `npm pack --dry-run` — correct file listing
- Diff reviewed: only `extensions/btw.ts` modified, surgical changes as recommended

## [1.0.0] - 2026-07-07

### Added

- Published the npm package under the `@nguyenquangthai/pi-btw` scope.
- Added production-ready npm and Pi package metadata for discovery on npm and <https://pi.dev/packages>.
- Added a gallery preview image for Pi package listings.
- Added TypeScript validation through `tsconfig.json` and npm scripts.
- Added CI workflow for typechecking and package dry-run validation.
- Added MIT license file.
- Added npm packaging controls via `files` and `.npmignore`.

### Changed

- Rewrote all user-facing documentation in professional English.
- Updated package version to `1.0.0`.
- Refined README installation, usage, settings, development, and publishing guidance.
- Removed the stale `Alt+B` usage reference from extension comments.
- Cleaned up TypeScript unused imports and return types so strict typechecking passes.

### Verified

- `npm run typecheck`
- `npm pack --dry-run`

[1.0.0]: https://github.com/QuangThai/pi-btw/releases/tag/v1.0.0
[1.0.1]: https://github.com/QuangThai/pi-btw/releases/tag/v1.0.1
[1.1.0]: https://github.com/QuangThai/pi-btw/releases/tag/v1.1.0
