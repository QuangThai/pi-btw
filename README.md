# pi-btw

A Pi Coding Agent extension for quick, non-blocking side questions.

Use `/btw` when you want to ask about the current session without interrupting the main agent, changing the main conversation history, or giving the side assistant tool access.

```text
/btw What does resolveUser do?

async function resolveUser(id: string): Promise<User> {
  const user = await db.users.findById(id);
  if (!user) throw new NotFoundError("User not found");
  return user;
}

selected-model · 230 out · $0.008
Esc dismiss
```

## Features

- **Non-blocking side questions** — ask while the main Pi agent keeps working.
- **Read-only assistant** — the side assistant has no tools and cannot modify files.
- **Clean conversation history** — `/btw` answers are stored as extension state, not as normal chat turns.
- **Session persistence** — side-question history survives `/resume` and `/fork`.
- **Keyboard-first UI** — scrollable answer view and full-history browser inside the Pi TUI.
- **Markdown rendering** — formatted responses with syntax-highlighted code blocks.
- **Model-aware execution** — uses the currently selected Pi model and reports token/cost metadata when available.

## Install

Install from npm:

```bash
pi install npm:pi-btw
```

Or install directly from GitHub:

```bash
pi install git:github.com/QuangThai/pi-btw
```

Reload the current Pi session:

```bash
/reload
```

For local development:

```bash
git clone https://github.com/QuangThai/pi-btw.git
cd pi-btw
npm install
pi install ./
/reload
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/btw <question>` | Ask a side question using the current session context. |
| `/btw` | Open the side-question history browser. |

### Latest answer view

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll the answer when it is longer than the visible area. |
| `Esc` | Dismiss the answer view. |

### History browser

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate entries, or scroll an expanded answer. |
| `j` / `k` | Vim-style navigation. |
| `Enter` | Expand or collapse the selected answer. |
| `d` | Delete the selected entry from the in-memory history. |
| `Esc` / `q` | Close the history browser. |

## Settings

Global settings are stored at:

```text
~/.pi/agent/btw-settings.json
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxTokens` | `1000` | Maximum output tokens for each `/btw` response. |

Example:

```json
{
  "maxTokens": 1500
}
```

## How it works

```text
/btw "question"
  → Collect the current Pi branch as plain text context
  → Ask the currently selected model in a single read-only turn
  → Store the Q&A as extension state
  → Show the answer in a scrollable Pi TUI view

/btw
  → Open the history browser for previous side questions
```

The side assistant receives explicit instructions that it has **no tools**, must answer in a **single turn**, and must not simulate tool calls or actions.

## Package structure

```text
pi-btw/
├── package.json              Pi + npm package metadata
├── README.md                 User documentation
├── CHANGELOG.md              Release history
├── LICENSE                   MIT license
├── assets/
│   └── pi-btw-gallery.png    pi.dev package gallery preview
├── extensions/
│   └── btw.ts                /btw extension entry point
└── tsconfig.json             TypeScript validation config
```

## Development

```bash
npm install
npm run typecheck
npm pack --dry-run
```

`npm pack --dry-run` shows the exact files that will be included in the published npm tarball.

## Publishing

Before publishing a release:

1. Confirm `package.json` has the target version.
2. Run validation:

   ```bash
   npm run typecheck
   npm pack --dry-run
   ```

3. Publish to npm:

   ```bash
   npm publish
   ```

4. Pi discovers packages for <https://pi.dev/packages> through the `pi-package` keyword and the `pi` manifest in `package.json`.

For this package, the Pi manifest exposes:

```json
{
  "pi": {
    "extensions": ["./extensions/btw.ts"],
    "image": "https://raw.githubusercontent.com/QuangThai/pi-btw/main/assets/pi-btw-gallery.png"
  }
}
```

## License

MIT
