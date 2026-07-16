# pi-btw

[![npm version](https://img.shields.io/npm/v/@nguyenquangthai/pi-btw?style=flat-square&color=blue)](https://www.npmjs.com/package/@nguyenquangthai/pi-btw)
[![license](https://img.shields.io/npm/l/@nguyenquangthai/pi-btw?style=flat-square)](LICENSE)

A Pi Coding Agent extension for **fast, non-blocking, parallel side questions**.

Ask quick side questions without interrupting the main agent, without bloating its context, and without waiting — all via keyboard shortcuts.

```text
/btw What does resolveUser do?       → instant answer view
/btw 2 Explain this error            → slot 2, independent
Alt+I                                → inject slot answer into main chat
```

## Features

- **⚡ Zero context overhead** — BTW runs in a separate RPC child process (`pi --mode rpc --no-session`). No context bloat.
- **🧵 Parallel slots** — 9 independent slots (1-9). Ask different questions simultaneously, each in its own session.
- **🎯 Context scoping** — Smart strategies to include only the relevant context (`smart`, `last-n`, `budget`, `compact`, or `none`).
- **📡 Streaming** — Answers appear token-by-token (Time To First Token < 500ms).
- **🔇 Context isolation** — BTW entries are filtered out of the main agent's context automatically.
- **💉 Answer injection** — `Alt+I` injects answers into main chat when you want them.
- **📜 Session persistence** — Slot state survives `/resume`, `/fork`, and restarts.
- **⌨️ Keyboard-first UI** — Scrollable answer view + full history browser.
- **💰 Cost tracking** — Per-answer token/cost display.
- **🔧 Flexible model config** — Defaults to `ctx.model` (same as main agent). Optionally configure a cheaper model per-slot.

## Install

```bash
pi install npm:@nguyenquangthai/pi-btw
/reload
```

Or from GitHub:

```bash
pi install git:github.com/QuangThai/pi-btw
/reload
```

Local development:

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
| `/btw <question>` | Ask in the active slot (auto-creates slot 1). |
| `/btw N <question>` | Ask in slot N (1-9). |
| `/btw N` | Switch to slot N. |
| `/btw` | Open the side-question history browser. |

### Shortcuts

| Key | Action |
|-----|--------|
| `Alt+I` | Inject answers from active slot into main chat, then clear. |
| `Alt+X` | Clear active slot (discard answers). |
| `Alt+H` | Previous slot. |
| `Alt+L` | Next slot. |
| `Alt+1…Alt+9` | Jump directly to slot N. |

### Answer view

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll answer. |
| `Esc` | Dismiss view. |

### History browser

| Key | Action |
|-----|--------|
| `↑` / `↓` or `j` / `k` | Navigate entries or scroll expanded answer. |
| `Enter` | Expand/collapse selected answer. |
| `d` | Delete entry. |
| `Esc` / `q` | Close. |

## Settings

Global settings at `~/.pi/agent/btw-settings.json`:

```json
{
  "maxTokens": 1000,
  "maxContextTokens": 8000,
  "strategy": "smart",
  "recentExchanges": 8
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `maxTokens` | `1000` | Max output tokens per answer. |
| `maxContextTokens` | `8000` | Max context tokens to include (strategy-dependent). |
| `strategy` | `"smart"` | Context scoping: `"smart"`, `"last-n"`, `"budget"`, `"compact"`, `"none"`, `"full"`. |
| `recentExchanges` | `8` | Recent exchanges to keep when strategy is `"last-n"`. |
| `btwProvider` | _(optional)_ | Separate provider for BTW (cheaper model). Uses `ctx.model` if unset. |
| `btwModelId` | _(optional)_ | Separate model ID for BTW. |
| `slotModels` | _(optional)_ | Per-slot model overrides. Array of `{ provider, modelId }` per slot. |

### Context strategies

| Strategy | Description | Typical tokens |
|---|---|---|
| `"none"` | No context — fastest, cheapest. | 0 |
| `"compact"` | Use compaction summary + latest exchanges. | ~500-2k |
| `"smart"` | Skip tool results, stay within budget. | ~2-8k |
| `"last-n"` | Keep N recent exchanges. | ~4-10k |
| `"budget"` | Walk backwards up to token budget. | Configurable |
| `"full"` | All context (legacy behavior). | 100k+ |

### Per-slot model example

```json
{
  "slotModels": [
    { "provider": "openai", "modelId": "gpt-4o-mini" },
    null,
    { "provider": "anthropic", "modelId": "claude-sonnet-4-20250514" }
  ]
}
```

Slot 1 → gpt-4o-mini (cheap), Slot 3 → claude-sonnet (powerful), Slot 2 → default (ctx.model).

> **Note:** Without `btwProvider`/`btwModelId`/`slotModels`, BTW uses the same model as the main agent — no extra API key needed.

## Architecture

```
extensions/btw.ts         Extension entry: commands, shortcuts, UI, context filter
src/
├── btw-child.ts          RPC child process (pi --mode rpc --no-session)
├── session-state.ts      Slot manager (9 slots, queue, turns, restore)
└── types.ts              Shared TypeScript types
```

### Flow

```
User: /btw 2 "explain this error"
  │
  ├─ resolveBtwModel(slotIndex=1) → check slotModels[1] → ctx.model fallback
  ├─ ensureSlot(state, 1) → create/switch to slot 2
  ├─ BtwChild.spawn("pi --mode rpc --no-session --model X")
  │   └─ JSONL RPC: { type: "prompt", message, streamingBehavior: "followUp" }
  │   └─ Events: message_update (streaming) → agent_settled (done)
  ├─ onPartial(text) → state.text = text → tui.requestRender()
  ├─ User sees streaming answer
  └─ Alt+I → pi.sendUserMessage(injectionText()) → inject into main chat
```

## Development

```bash
npm install
npm run typecheck    # tsc --noEmit (zero errors expected)
```

## Package structure

```
pi-btw/
├── package.json              Pi + npm package metadata
├── README.md                 This file
├── CHANGELOG.md
├── BENCHMARK.md              Performance benchmark guide
├── BTW-IMPROVEMENT-PLAN.md   Full architecture improvement plan
├── LICENSE                   MIT
├── assets/
│   └── pi-btw-gallery.png
├── extensions/
│   └── btw.ts                Extension entry point
├── src/
│   ├── btw-child.ts          RPC child process
│   ├── session-state.ts      Slot state management
│   └── types.ts              Shared types
└── tsconfig.json
```

## License

MIT
