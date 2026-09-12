# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-09-12

Slot plumbing that was written but never connected is now wired into the
extension, which fixes three advertised features that could not work before.

### Fixed

- **Injected answers never reached the model.** The `context` handler filtered
  out every user message starting with `[BTW Answer Injection]` — exactly the
  text `Alt+I` sends. The injection was visible in the TUI and invisible to the
  LLM. Only BTW's own custom entries are filtered now.
- **`Alt+I` and `Alt+X` always reported an empty slot.** The ask flow wrote
  results to the history list but never to `slot.turns`, which is what both
  shortcuts read. All questions now run through the slot queue.
- **Slot state did not survive `/resume` or `/fork`.** Persisted entries were
  missing the slot number that restore keys off, so slots were never rebuilt.
  One entry now carries both the history and slot fields.
- **The tenth plain `/btw <question>` threw.** Each bare `/btw` allocated a new
  slot, and allocation past slot 9 produced an out-of-range index. A bare
  `/btw` now reuses the active slot, and slot exhaustion is reported as a
  notification.
- **Context scoping did not apply to the RPC path.** `strategy`,
  `maxContextTokens`, and `recentExchanges` only affected the inline fallback;
  the child received the bare question. The first question in a slot now
  carries the scoped transcript, and follow-ups reuse the child's history.
- **Token and cost display was cumulative, not per answer.** The view reported
  the child's running total, so the second question in a slot showed inflated
  numbers. Usage is now snapshotted per turn.
- **A hung child could block a slot forever.** `waitForSettlement()` had no
  timeout. It now fails after 5 minutes.
- **`stop()` could resolve before the process died** and leaked a 2s timer on
  every call. The test suite's wall clock dropped from 14.5s to 3.2s.
- **Protocol-level RPC errors were ignored.** Responses without a request id
  (parse errors) left requests waiting for the full 2 minute timeout.
- **Error notices repeated stderr twice**, because both the child error and the
  extension's formatter appended it.
- **Multi-part answers were truncated** to the last text part by
  `getFinalOutput()`.
- **A provider failure inside the child was reported as `(no answer)`.** When
  the child settled with `stopReason: "error"`, the error message was dropped.
  It is now surfaced, and HTML error pages are condensed to one readable line.
- **Every UI error was logged as a stale context.** A view that threw while
  rendering left the user with no view and no explanation. Genuine failures are
  now reported; only real session-replacement errors stay quiet.
- **Boxed views overflowed narrow terminals.** The title and key hints were
  never truncated and the content width had a floor above the terminal width,
  so the frame broke below roughly 40 columns.
- **Injection never worked, and the UI pointed at the key that did not work.**
  `Alt+I` was advertised in the answer view's footer, but extension shortcuts
  are dispatched on the default editor, so the key never reached a handler
  while that view owned the input. `Alt+<key>` encoding also differs between
  terminals and keyboard protocols, and it did not reach the handler from the
  editor either.

### Added

- Pre-flight provider check: a provider registered by another extension cannot
  exist inside a `--no-extensions` child, so BTW now detects that before
  spawning and answers inline with an actionable warning instead of failing.
- `BtwChildHandle.abort()` to stop a turn without killing the process.
- An extension harness test that drives the real extension through a fake
  host: every shortcut and slot command, the context filter, and both TUI
  views rendered for real at several terminal widths.
- `npm run e2e`: a live end-to-end check covering cold start, the RPC child's
  tools, slot reuse, slot exhaustion, answer injection reaching the provider
  payload, restore after a restart, and the pre-flight check for a provider
  registered at runtime by another extension.
- Unit tests for slot allocation, queue serialisation, fallback handling,
  cancellation, the persist/restore round trip, and provider-error formatting.
  The suite is now 45 tests.
- Log rotation for `~/.pi/agent/btw.log` at 512 KB.

### Changed

- The RPC child is launched with `--offline`. Startup package resolution runs
  even under `--no-extensions`, and a child that lives for seconds has no
  reason to make network calls. Handshake time dropped from ~1.25s to ~0.88s.
- Answer and history views size themselves to the terminal instead of assuming
  30 rows, and their frames stay inside narrow terminals.
- **Injection moved from `Alt+I` to `/btw inject`**, with `/btw clear` added
  alongside it. A command is delivered in every terminal and works from inside
  the answer view; a keyboard shortcut that silently does nothing is worse than
  no shortcut. The remaining `Alt+` keys are conveniences with command
  equivalents (`/btw N`, `/btw clear`).
- Injection queues as a follow-up when the agent is streaming, rather than
  failing silently.
- TUI-only paths are guarded with `ctx.mode === "tui"` as the extension docs
  require.
- `peerDependencies` use the documented `"*"` range and are marked optional, so
  `pi install` no longer pulls a second copy of the Pi packages.
- `files` no longer lists `BENCHMARK.md` and `BTW-IMPROVEMENT-PLAN.md`, which
  do not exist, nor ships tests and scripts to consumers.
- CI runs on Linux and Windows across Node 22 and 24, with a read-only token
  and run-cancelling concurrency.
- README now describes what the code does, including startup cost, the
  fallback path, and the security model, and shows the gallery image.
- **New gallery image.** The old one clipped its own content — a feature pill
  ran off the card and the terminal mock's text ran past the right edge — and
  claimed "No tools", which stopped being true once the RPC child gained
  `read`, `grep`, `find`, and `ls`. The replacement is a single bleed terminal:
  the main agent's transcript still running above, the `/btw` answer frame
  docked below where it actually appears. `scripts/build-gallery.mjs`
  regenerates its HTML source, and the frame is assembled with the same
  arithmetic `extensions/btw.ts` uses, so the rectangle is exact.

### Verified

- `npm run typecheck`
- `npm test` — 49 tests
- `npm run smoke:rpc` against a live model
- `npm run e2e` against a live model — 38 checks, including `/btw` as the very
  first command in a new session, `/btw inject` landing in the real provider
  payload, and a provider registered at runtime by another extension
- `npm pack --dry-run`

## [1.1.3] - 2026-08-10

### Fixed

- Launch RPC children through the resolved Pi CLI with the current Node runtime, fixing Windows `.cmd` resolution failures.
- Support both modern `agent_settled` and older `agent_end` RPC completion events so tool calls do not hang.
- Make RPC failures visible and recoverable instead of silently reusing dead children.

### Changed

- Enable read-only child tools (`read`, `grep`, `find`, `ls`) while disabling recursive extension/MCP loading.
- Require Pi packages at version `0.80.3` or newer.

### Verified

- `npm run typecheck`
- `npm test`
- RPC read-tool smoke test with the configured model
- `npm pack --dry-run`

## [1.1.2] - 2026-07-16

### Changed

- Updated BTW answer and history frames to use the active theme's `accent` color, making the border and question prompt visually prominent without changing Markdown answer colors.
- Removed the legacy `/btw slots` statusline and the redundant slot number in answer metadata; model, token counts, and cost remain visible.

### Fixed

- Clear a statusline left behind by prior BTW versions at session start.

### Verified

- `npm run typecheck`
- `npm ci`
- `npm pack --dry-run`

## [1.1.1] - 2026-07-16

### Fixed

- Released the final validated source artifact so the npm package, Git tag, and GitHub release are reproducible from the same commit.
- Restored strict unused-symbol TypeScript checks and removed unused extension helpers.
- Added `.gitattributes` to enforce LF line endings for TypeScript, Markdown, and JSON files across platforms.

### Verified

- `npm run typecheck` — passes with `noUnusedLocals` and `noUnusedParameters` enabled.
- `npm pack --dry-run` — correct runtime file listing.

## [1.1.0] - 2026-07-16

### Added

- **RPC child architecture** (`src/btw-child.ts`): Spawns Pi's resolved CLI entry through the current runtime with `--mode rpc --no-session` as a headless child process for zero-context-overhead side questions. Communicates via JSONL over stdin/stdout.
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
[1.1.1]: https://github.com/QuangThai/pi-btw/releases/tag/v1.1.1
[1.1.2]: https://github.com/QuangThai/pi-btw/releases/tag/v1.1.2
[1.1.3]: https://github.com/QuangThai/pi-btw/releases/tag/v1.1.3
[1.2.0]: https://github.com/QuangThai/pi-btw/releases/tag/v1.2.0
