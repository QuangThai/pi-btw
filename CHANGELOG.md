# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

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
