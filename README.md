# /btw — Side Questions for Pi Coding Agent

Hỏi câu hỏi nhanh **trong khi** main agent đang làm việc — không gián đoạn, không làm ô nhiễm context.

```
/btw  Hàm resolveUser dùng để làm gì?
    async function resolveUser(id: string): Promise<User> {
      const user = await db.users.findById(id);
      if (!user) throw new NotFoundError("User not found");
      return user;
    }
    claude-sonnet-4 · 230 out · $0.008
    Esc dismiss
```

## ✨ Features

- **Non-blocking** — hỏi trong khi main agent đang làm việc
- **Read-only** — không tool access, không thể modify file
- **Ephemeral** — không ghi vào main conversation history
- **Droid-style UI** — widget non-modal + overlay panel cho history
- **Persistent** — Q&A survive `/resume` và `/fork`
- **Markdown rendering** — code blocks syntax highlight
- **Cache-friendly** — dùng cùng model với main session

## 📦 Install

```bash
pi install D:/Workspace/pi-btw
/reload
```

## ⌨️ Usage

### Commands

| Command | Description |
|---------|-------------|
| `/btw <question>` | Ask side question → widget shows above editor |
| `/btw` | Open overlay panel with full history |

### Widget controls (latest Q&A)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll answer (nếu dài) |
| `Esc` | Dismiss widget |

### Panel controls (full history)

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate entries |
| `Enter` | Expand/collapse answer |
| `d` | Delete entry |
| `Esc` | Close panel |

## ⚙️ Settings

Lưu tại `~/.pi/agent/btw-settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `maxTokens` | `1000` | Max output tokens cho /btw |

## 🏗️ How it works

```
/btw "câu hỏi"
  → Fork session context (plain text → LLM)
  → Gọi model: "You are separate agent. NO tools. Single turn."
  → Lưu Q&A vào extension state
  → Show answer view (scrollable, Esc dismiss)

/btw → open history browser
```

## 📁 Structure

```
pi-btw/
├── package.json
├── README.md
└── extensions/
    └── btw.ts
```
