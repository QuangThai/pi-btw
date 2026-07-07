# Changelog

All notable changes to this project are documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-07-07

### Added

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
