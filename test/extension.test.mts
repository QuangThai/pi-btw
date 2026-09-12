/**
 * Drives the real extension through a fake ExtensionAPI.
 *
 * This covers the wiring that a headless RPC end-to-end run cannot reach:
 * keyboard shortcuts, the TUI components, and the context filter. The views
 * are rendered for real, so a crash or a bad slice shows up here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AuthStorage, initTheme, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import btwExtension from "../extensions/btw.ts";

/** Raw terminal sequences: matchesKey() compares input bytes, not key names. */
const KEY = {
  enter: "\r",
  up: "\u001b[A",
  down: "\u001b[B",
  escape: "\u001b",
};

// Markdown styling reads the global theme; without this the views throw.
initTheme(undefined, false);

// ── Fake host ──

interface Notification { message: string; level: string }
interface SentMessage { content: string; options?: { deliverAs?: string } }

interface RenderedComponent {
  lines: string[];
  input(data: string): void;
  render(width?: number): string[];
}

function makeHarness(options: { idle?: boolean; mode?: string } = {}) {
  const notifications: Notification[] = [];
  const sent: SentMessage[] = [];
  const appended: { customType: string; data: any }[] = [];
  const statuses: { key: string; text: string | undefined }[] = [];
  const eventHandlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  let lastComponent: RenderedComponent | undefined;

  const ext: any = {
    on: (name: string, handler: Function) => eventHandlers.set(name, handler),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    registerShortcut: (name: string, opts: any) => shortcuts.set(name, opts),
    sendUserMessage: (content: string, opts?: any) => { sent.push({ content, options: opts }); },
    appendEntry: (customType: string, data: any) => { appended.push({ customType, data }); },
  };

  // `ctx.ui.custom` hands the views a theme instance. The exported `Theme` is
  // the class, so stand in for an instance and record the colors requested.
  const colorsUsed = new Set<string>();
  const theme = {
    fg(color: string, text: string) { colorsUsed.add(color); return text; },
    bold(text: string) { return text; },
    underline(text: string) { return text; },
  };

  const ctx: any = {
    mode: options.mode ?? "tui",
    hasUI: true,
    cwd: process.cwd(),
    isIdle: () => options.idle ?? true,
    ui: {
      notify: (message: string, level = "info") => { notifications.push({ message, level }); },
      setStatus: (key: string, text?: string) => { statuses.push({ key, text }); },
      // The real custom() blocks until done() is called. Returning early here
      // would let the caller run past the view and hide input-handling bugs.
      custom(factory: Function) {
        return new Promise((resolve) => {
          const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };
          const component: any = factory(tui, theme, {}, (v: unknown) => {
            component.dispose?.();
            resolve(v);
          });
          const render = (width = 80) => component.render(width) as string[];
          lastComponent = {
            lines: render(),
            input: (data: string) => component.handleInput?.(data),
            render,
          };
          component.invalidate?.();
        });
      },
    },
    sessionManager: { getEntries: () => [] as any[], getBranch: () => [] as any[] },
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: false, error: "no auth in test" }),
      // A real AuthStorage lets the extension build the registry a child would
      // see. The fake provider below is never in it, so the pre-flight check
      // takes the inline path instead of spawning a doomed Pi process.
      authStorage: AuthStorage.create(),
    },
    model: undefined,
  };

  btwExtension(ext);

  return {
    ctx, notifications, sent, appended, statuses, commands, shortcuts, colorsUsed,
    component: () => lastComponent,
    async fire(event: string, payload: any = {}) {
      return eventHandlers.get(event)?.(payload, ctx);
    },
    async run(command: string, args = "") {
      return commands.get(command)!.handler(args, ctx);
    },
    async press(shortcut: string) {
      return shortcuts.get(shortcut)!.handler(ctx);
    },
    seed(entries: any[]) {
      ctx.sessionManager.getEntries = () => entries;
    },
  };
}

/** Yield long enough for a command handler to reach ctx.ui.custom(). */
function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A persisted turn in the shape the extension actually writes. */
function persistedTurn(slot: number, turn: number, question: string, answer: string) {
  return {
    type: "custom",
    customType: "btw-entry",
    data: {
      id: `btw-${turn}-${1000 + turn}`,
      kind: "result",
      slot,
      turn,
      question,
      answer,
      modelProvider: "test",
      modelId: "test-model",
      timestamp: 1000 + turn,
      startedAt: 1000 + turn,
      finishedAt: 2000 + turn,
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalCost: 0.01 },
    },
  };
}

// ── Registration ──

test("registers the command and every documented shortcut", () => {
  const h = makeHarness();
  assert.ok(h.commands.has("btw"));
  for (const key of ["alt+x", "alt+h", "alt+l"]) {
    assert.ok(h.shortcuts.has(key), `missing ${key}`);
  }
  for (let n = 1; n <= 9; n++) {
    assert.ok(h.shortcuts.has(`alt+${n}`), `missing alt+${n}`);
  }
});

test("injection is a command, not a shortcut", () => {
  // Alt+<key> encoding varies by terminal and shortcuts do not reach a focused
  // custom component, so a key that silently does nothing was removed.
  const h = makeHarness();
  assert.equal(h.shortcuts.has("alt+i"), false, "alt+i must not be registered");
  assert.match(h.commands.get("btw").description, /\/btw inject/);
});

test("argument completions offer the slot actions", () => {
  const h = makeHarness();
  const complete = h.commands.get("btw").getArgumentCompletions;
  assert.deepEqual(complete("").map((i: any) => i.value), ["inject", "clear"]);
  assert.deepEqual(complete("in").map((i: any) => i.value), ["inject"]);
  assert.equal(complete("zzz"), null);
});

test("does not register anything inside a BTW child process", () => {
  const previous = process.env.PI_BTW_CHILD;
  process.env.PI_BTW_CHILD = "1";
  try {
    const h = makeHarness();
    assert.equal(h.commands.size, 0, "a child must not re-register /btw");
    assert.equal(h.shortcuts.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_BTW_CHILD;
    else process.env.PI_BTW_CHILD = previous;
  }
});

// ── Context filter (the injection regression) ──

test("context filter drops BTW entries but keeps injected answers", async () => {
  const h = makeHarness();
  const injected =
    "[BTW Answer Injection]\nThe user asked the following question in a separate session:\nwhy?\nThe answer was:\nbecause";
  const messages = [
    { role: "user", content: "real question" },
    { role: "custom", customType: "btw-entry", content: "internal", display: false },
    { role: "user", content: injected },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];

  const result: any = await h.fire("context", { messages });

  assert.ok(result?.messages, "handler must return a filtered list");
  const kept = result.messages;
  assert.equal(kept.length, 3, "only the btw-entry should be dropped");
  assert.ok(
    kept.some((m: any) => m.role === "user" && m.content === injected),
    "the injected answer must reach the model",
  );
  assert.ok(!kept.some((m: any) => m.customType === "btw-entry"));
});

test("context filter leaves an untouched conversation alone", async () => {
  const h = makeHarness();
  const messages = [{ role: "user", content: "hello" }];
  const result = await h.fire("context", { messages });
  assert.equal(result, undefined, "no copy when nothing was filtered");
});

// ── Restore -> /btw inject ──

test("restored answers are injectable with /btw inject", async () => {
  const h = makeHarness();
  h.seed([persistedTurn(0, 1, "what is x", "x is 42")]);
  await h.fire("session_start", { reason: "resume" });

  await h.run("btw", "inject");

  assert.equal(h.sent.length, 1, `expected one injection, got ${JSON.stringify(h.sent)}`);
  const text = h.sent[0]!.content;
  assert.match(text, /^\[BTW Answer Injection\]/);
  assert.match(text, /what is x/);
  assert.match(text, /x is 42/);
  assert.equal(h.sent[0]!.options, undefined, "idle agent needs no delivery mode");
  assert.ok(h.notifications.some((n) => /Injected and cleared/.test(n.message)),
    JSON.stringify(h.notifications));
});

test("/btw inject queues behind the current turn while the agent is streaming", async () => {
  const h = makeHarness({ idle: false });
  h.seed([persistedTurn(0, 1, "q", "a")]);
  await h.fire("session_start", { reason: "resume" });

  await h.run("btw", "inject");

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.options?.deliverAs, "followUp",
    "sendUserMessage rejects without a delivery mode mid-stream");
  assert.ok(h.notifications.some((n) => /Queued injection/.test(n.message)));
});

test("/btw inject clears the slot so answers are not injected twice", async () => {
  const h = makeHarness();
  h.seed([persistedTurn(0, 1, "q", "a")]);
  await h.fire("session_start", { reason: "resume" });

  await h.run("btw", "inject");
  await h.run("btw", "inject");

  assert.equal(h.sent.length, 1, "second press must find an empty slot");
  assert.ok(h.notifications.some((n) => /No active \/btw slot/.test(n.message)),
    JSON.stringify(h.notifications));
});

test("/btw inject on a session with no slots warns instead of throwing", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("btw", "inject");
  assert.equal(h.sent.length, 0);
  assert.equal(h.notifications.at(-1)?.level, "warning");
});

test("/btw clear discards the active slot", async () => {
  const h = makeHarness();
  h.seed([persistedTurn(0, 1, "q", "a")]);
  await h.fire("session_start", { reason: "resume" });

  await h.run("btw", "clear");
  assert.ok(h.notifications.some((n) => /Slot cleared/.test(n.message)),
    JSON.stringify(h.notifications));

  await h.run("btw", "inject");
  assert.equal(h.sent.length, 0, "cleared answers must not be injectable");
});

test("/btw clear on an empty session warns instead of throwing", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("btw", "clear");
  assert.equal(h.notifications.at(-1)?.level, "warning");
});

test("Alt+X clears the active slot", async () => {
  const h = makeHarness();
  h.seed([persistedTurn(0, 1, "q", "a")]);
  await h.fire("session_start", { reason: "resume" });

  await h.press("alt+x");
  assert.ok(h.notifications.some((n) => /Slot cleared/.test(n.message)));

  await h.run("btw", "inject");
  assert.equal(h.sent.length, 0, "cleared answers must not be injectable");
});

test("Alt+H / Alt+L move between occupied slots", async () => {
  const h = makeHarness();
  h.seed([
    persistedTurn(0, 1, "q1", "a1"),
    persistedTurn(2, 1, "q2", "a2"),
  ]);
  await h.fire("session_start", { reason: "resume" });

  await h.press("alt+l");
  await h.run("btw", "inject");
  assert.match(h.sent.at(-1)!.content, /q2/, "Alt+L should land on the second slot");

  // Slot 3 is gone after injecting; the remaining slot must still be reachable.
  await h.press("alt+h");
  await h.run("btw", "inject");
  assert.match(h.sent.at(-1)!.content, /q1/);
});

test("Alt+N jumps to a slot without throwing on an empty one", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  for (let n = 1; n <= 9; n++) await h.press(`alt+${n}`);
  await h.run("btw", "inject");
  // Nine empty slots now exist; the active one simply has no answers.
  assert.ok(h.notifications.some((n) => /No answers in active slot/.test(n.message)),
    JSON.stringify(h.notifications.slice(-3)));
});

// ── Commands ──

test("/btw N switches slots and reports it", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("btw", "4");
  assert.ok(h.notifications.some((n) => n.message === "Switched to slot 4"),
    JSON.stringify(h.notifications));
});

test("/btw with no history notifies instead of opening an empty browser", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  await h.run("btw", "");
  assert.ok(h.notifications.some((n) => /No side questions yet/.test(n.message)));
  assert.equal(h.component(), undefined, "no component for an empty history");
});

// ── Real TUI rendering ──

test("the history browser renders, scrolls, expands, and deletes", async () => {
  const h = makeHarness();
  h.seed([
    persistedTurn(0, 1, "first question", "First **answer** with `code`."),
    persistedTurn(1, 1, "second question", "Second answer.\n\n- bullet\n- another"),
  ]);
  await h.fire("session_start", { reason: "resume" });

  const pending = h.run("btw", "");
  await tick();
  const view = h.component();
  assert.ok(view, "history browser must be built");

  const lines = view!.lines;
  assert.ok(lines.length > 0, "renders something");
  assert.ok(lines.some((l) => l.includes("first question")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("second question")));
  assert.ok(lines.some((l) => l.includes("Side Questions (2)")), lines[0]);

  // Expanding must render the markdown body without throwing.
  view!.input(KEY.enter);
  const expanded = view!.render();
  assert.ok(expanded.some((l) => l.includes("answer")), expanded.join("\n"));

  // Navigation and deletion must not throw on boundaries.
  view!.input(KEY.down);
  view!.input(KEY.up);
  view!.input("j");
  view!.input("k");
  view!.input("d");
  const afterDelete = view!.render();
  assert.ok(afterDelete.length > 0);

  view!.input(KEY.escape);
  await pending;
});

test("the history browser renders at narrow and short terminal sizes", async () => {
  const h = makeHarness();
  h.seed([persistedTurn(0, 1, "q".repeat(200), "a".repeat(400))]);
  await h.fire("session_start", { reason: "resume" });

  const pending = h.run("btw", "");
  await tick();
  const view = h.component()!;
  for (const width of [20, 40, 80, 200]) {
    const lines = view.render(width);
    assert.ok(lines.length > 0, `width ${width} rendered nothing`);
    // Every boxed line must stay within the frame it was given.
    for (const line of lines) {
      const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
      assert.ok(visible.length <= width,
        `width ${width}: line overflows (${visible.length}): ${visible.slice(0, 80)}`);
    }
  }

  view.input(KEY.escape);
  await pending;
});

test("the markdown theme is available to the views", () => {
  assert.ok(getMarkdownTheme(), "views construct a Markdown with this theme");
});

// ── Answer view ──

/**
 * Open the streaming answer view for a question that never resolves, so the
 * component can be inspected while it is still generating.
 */
async function openAnswerView(
  h: ReturnType<typeof makeHarness>,
  model: any,
): Promise<{ pending: Promise<unknown> }> {
  h.ctx.model = model;
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "test-key" });
  // The fake provider is not one a child could resolve, so this takes the
  // inline path; the inline path then fails on the fake key. Either way the
  // view is built and stays open until the test closes it.
  //
  // The promise is wrapped in an object on purpose: returning it bare from an
  // async function would make `await openAnswerView(...)` wait for the command
  // to finish, which cannot happen until the test closes the view.
  const pending = h.run("btw", "why is the sky blue");
  await tick();
  return { pending };
}

test("the answer view renders while streaming and after settling", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  const { pending } = await openAnswerView(h, { id: "test-model", provider: "test-provider" });

  const view = h.component();
  assert.ok(view, `answer view must be built; notifications: ${JSON.stringify(h.notifications)}`);

  const lines = view!.lines;
  assert.ok(lines.some((l) => l.includes("/btw [1]")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("why is the sky blue")), lines.join("\n"));

  // Scrolling must not throw at the boundaries.
  view!.input(KEY.up);
  view!.input(KEY.down);
  assert.ok(view!.render().length > 0);

  // Esc closes the view; the turn is still awaited by the command.
  view!.input(KEY.escape);
  await pending;
});

test("the answer view frame fits every terminal width", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  const { pending } = await openAnswerView(h, { id: "a-rather-long-model-id", provider: "test-provider" });

  const view = h.component()!;
  for (const width of [20, 32, 48, 80, 160]) {
    for (const line of view.render(width)) {
      const visible = line.replace(/\u001b\[[0-9;]*m/g, "");
      assert.ok(visible.length <= width,
        `width ${width}: overflow (${visible.length}): ${visible.slice(0, 90)}`);
    }
  }
  view.input(KEY.escape);
  await pending;
});

test("a model that no provider can serve is reported, not swallowed", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  // No ctx.model and no override: resolveBtwModel must fail loudly.
  await h.run("btw", "anything");
  assert.ok(h.notifications.some((n) => n.level === "error" && /No model selected/.test(n.message)),
    JSON.stringify(h.notifications));
  assert.equal(h.component(), undefined, "no view when there is nothing to ask");
});

test("the status line is set while asking and cleared afterwards", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  const { pending } = await openAnswerView(h, { id: "test-model", provider: "test-provider" });
  h.component()!.input(KEY.escape);
  await pending;

  const btwStatuses = h.statuses.filter((s) => s.key === "btw");
  assert.ok(btwStatuses.length >= 2, JSON.stringify(h.statuses));
  assert.ok(btwStatuses[0]!.text?.includes("/btw [1]"), JSON.stringify(btwStatuses[0]));
  assert.equal(btwStatuses.at(-1)!.text, undefined, "status must be cleared when done");
});

test("a settled turn is persisted even when every path failed", async () => {
  const h = makeHarness();
  await h.fire("session_start", { reason: "startup" });
  const { pending } = await openAnswerView(h, { id: "test-model", provider: "test-provider" });
  h.component()!.input(KEY.escape);
  await pending;

  const entries = h.appended.filter((e) => e.customType === "btw-entry");
  assert.equal(entries.length, 1, JSON.stringify(h.appended));
  assert.equal(entries[0]!.data.slot, 0, "persisted turns must carry their slot");
  assert.equal(entries[0]!.data.turn, 1);
  assert.ok(entries[0]!.data.error, "a failure must be recorded as an error, not an empty answer");
});
