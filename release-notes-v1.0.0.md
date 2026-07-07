## pi-btw 1.0.0

First production-ready release of `@nguyenquangthai/pi-btw`, a Pi Coding Agent extension for quick, non-blocking side questions.

### Highlights

- Ask `/btw <question>` using the current Pi session context without interrupting the main agent.
- Keep side answers read-only: no tools, no file changes, single-turn responses.
- Browse previous side questions with the built-in TUI history view.
- Preserve side-question history across `/resume` and `/fork` through extension session state.
- Render Markdown answers with code block support.
- Show token and cost metadata when the selected model provider returns it.

### Package readiness

- Added professional English documentation.
- Added npm and Pi package metadata for discoverability.
- Added Pi package gallery image.
- Added `CHANGELOG.md`, `LICENSE`, `.npmignore`, `tsconfig.json`, and CI typecheck workflow.
- Added strict TypeScript validation and package dry-run checks.

### Verification

- `npm run typecheck`
- `npm pack --dry-run`

### Install

```bash
pi install npm:@nguyenquangthai/pi-btw
/reload
```

Or from GitHub:

```bash
pi install git:github.com/QuangThai/pi-btw@v1.0.0
/reload
```
