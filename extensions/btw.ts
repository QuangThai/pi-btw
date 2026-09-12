/**
 * /btw — Side Questions for Pi Coding Agent
 *
 * Phase 3: RPC child architecture + slot-based async side sessions.
 *
 * Usage:
 *   /btw <question>       → ask in active slot (or create slot 1)
 *   /btw N <question>     → ask in slot N (1-9)
 *   /btw N                → switch to slot N
 *   /btw inject           → send this slot's answers to the main agent
 *   /btw clear            → discard this slot's answers
 *   /btw                  → open history browser
 *
 * Slot actions are commands rather than shortcuts: terminals disagree about
 * how Alt+<key> is encoded, and a key that silently does nothing is worse
 * than no key at all.
 */

import { readFileSync, appendFileSync, renameSync, statSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stream, type UserMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  getAgentDir,
  getMarkdownTheme,
  ModelRegistry,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ── Slot system imports ──
import {
  createInitialState,
  activeSlot,
  ensureSlot,
  freeSlotIndex,
  listSlots,
  parseBtwArgs,
  clearSlot,
  switchRelativeSlot,
  injectionText,
  queueQuestionToSlot,
  restoreStateFromMessages,
} from "../src/session-state.ts";
import type {
  BtwSlot,
  BtwSlotState,
  BtwTurn,
  BtwUsage,
  BtwEntry,
} from "../src/types.ts";
import { MAX_BTW_SLOTS } from "../src/types.ts";

// ── Constants ──

const BTW_ENTRIES_MAX = 100;

// ── Logging ──

let _logPath: string | null = null;

/** Roll the log over at 512 KB so it cannot grow without bound. */
const LOG_MAX_BYTES = 512 * 1024;

function rotateLogIfNeeded(path: string): void {
  try {
    if (statSync(path).size < LOG_MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    // No log yet, or the rename lost a race. Either way, keep appending.
  }
}

function logBtw(level: "info" | "warn" | "error", msg: string, detail?: string): void {
  try {
    if (!_logPath) {
      const dir = getAgentDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      _logPath = join(dir, "btw.log");
      rotateLogIfNeeded(_logPath);
    }
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] ${msg}${detail ? " - " + detail : ""}\n`;
    appendFileSync(_logPath, line, "utf8");
  } catch {
    // Last resort — can't log, silently ignore
  }
}

function truncateForNotice(text: string, max = 240): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A captured `ctx` throws once its session has been replaced by `/reload`,
 * `/new`, `/resume`, or `/fork`. That is expected and harmless.
 */
function isStaleCtxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bstale\b|session replacement/i.test(message);
}

/**
 * Report a UI failure honestly.
 *
 * Treating every error as a stale context hides real bugs: a view that throws
 * while rendering would leave the user with no view and no explanation.
 */
function reportUiFailure(ctx: ExtensionContext, what: string, error: unknown): void {
  if (isStaleCtxError(error)) {
    logBtw("warn", `Stale ctx during ${what}`, String(error));
    return;
  }
  logBtw("error", `${what} failed`, error instanceof Error ? (error.stack ?? error.message) : String(error));
  try {
    ctx.ui.notify(`/btw ${what} failed: ${truncateForNotice(String(error))}`, "error");
  } catch {
    // The context is gone too; the log entry above is all we can do.
  }
}

// Re-export for external access
export type { BtwUsage, BtwEntry, BtwSlotState };

// ────────────────────────────────────────────────────────────────
// Settings
// ────────────────────────────────────────────────────────────────

export type BtwContextStrategy = "full" | "last-n" | "budget" | "smart" | "none" | "compact";

export interface SlotModelConfig {
  provider: string;
  modelId: string;
}

export interface BtwSettings {
  maxTokens: number;
  maxContextTokens: number;
  strategy: BtwContextStrategy;
  recentExchanges: number;
  btwProvider?: string;
  btwModelId?: string;
  /** Per-slot model overrides. Index 0 = slot 1, index 1 = slot 2, etc. */
  slotModels?: (SlotModelConfig | undefined)[];
}

const DEFAULT_SETTINGS: BtwSettings = {
  maxTokens: 1000,
  maxContextTokens: 8000,
  strategy: "smart",
  recentExchanges: 8,
};

// ────────────────────────────────────────────────────────────────
// Module-level state
// ────────────────────────────────────────────────────────────────

let btwEntries: BtwEntry[] = [];
let btwSettings: BtwSettings = { ...DEFAULT_SETTINGS };
let entryCounter = 0;
let api: ExtensionAPI | null = null;
let slotState: BtwSlotState = createInitialState();

// ── Session-replacement guards ──
let currentAbortController: AbortController | null = null;

/**
 * Providers the RPC child cannot see. The child runs with `--no-extensions`,
 * so providers registered through `pi.registerProvider()` do not exist there
 * and spawning against them always fails.
 */
let childVisibleProviders: Set<string> | null = null;

// ────────────────────────────────────────────────────────────────
// Settings persistence
// ────────────────────────────────────────────────────────────────

function getGlobalSettingsPath(): string { return join(getAgentDir(), "btw-settings.json"); }

function loadGlobalSettings(): BtwSettings {
  try {
    const d = JSON.parse(readFileSync(getGlobalSettingsPath(), "utf8"));
    return {
      maxTokens: typeof d.maxTokens === "number" ? d.maxTokens : DEFAULT_SETTINGS.maxTokens,
      maxContextTokens: typeof d.maxContextTokens === "number" ? d.maxContextTokens : DEFAULT_SETTINGS.maxContextTokens,
      strategy: (["full", "last-n", "budget", "smart", "none", "compact"].includes(d.strategy) ? d.strategy : DEFAULT_SETTINGS.strategy) as BtwContextStrategy,
      recentExchanges: typeof d.recentExchanges === "number" ? d.recentExchanges : DEFAULT_SETTINGS.recentExchanges,
      btwProvider: typeof d.btwProvider === "string" ? d.btwProvider : undefined,
      btwModelId: typeof d.btwModelId === "string" ? d.btwModelId : undefined,
      slotModels: Array.isArray(d.slotModels) ? d.slotModels.map((sm: any) =>
        sm && typeof sm.provider === "string" && typeof sm.modelId === "string"
          ? { provider: sm.provider, modelId: sm.modelId }
          : undefined
      ) : undefined,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ────────────────────────────────────────────────────────────────
// Entry management
// ────────────────────────────────────────────────────────────────

function genId(): string { return `btw-${++entryCounter}-${Date.now()}`; }


function trimEntries(): void {
  if (btwEntries.length > BTW_ENTRIES_MAX) {
    btwEntries = btwEntries.slice(-BTW_ENTRIES_MAX);
  }
}

/**
 * Record a settled turn in the in-memory history and persist it.
 *
 * One entry carries both the history fields and the slot fields so that
 * `restore()` can rebuild the browser and the slots from a single record.
 */
function addEntry(e: BtwEntry, slot?: BtwSlot, turn?: BtwTurn): void {
  btwEntries.push(e);
  trimEntries();
  try {
    api?.appendEntry("btw-entry", {
      id: e.id, question: e.question, answer: e.answer,
      modelProvider: e.modelProvider, modelId: e.modelId, timestamp: e.timestamp,
      usage: e.usage, error: e.error,
      ...(slot && turn
        ? {
            kind: "result",
            slot: slot.index,
            generation: slot.generationId,
            turn: turn.turnIndex,
            startedAt: turn.startedAt,
            finishedAt: turn.finishedAt,
          }
        : {}),
    });
  } catch (err) { logBtw("warn", "appendEntry failed", String(err)); }
}

function delEntry(id: string): void { btwEntries = btwEntries.filter((e) => e.id !== id); }

function restore(ctx: ExtensionContext): void {
  btwEntries = [];
  const slotInputs: { customType?: string; details?: unknown }[] = [];
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type !== "custom" || e.customType !== "btw-entry") continue;
    const d = e.data as Record<string, unknown>;
    if (!d || typeof d.question !== "string") continue;

    const timestamp =
      (typeof d.timestamp === "number" ? d.timestamp : undefined) ??
      (typeof d.finishedAt === "number" ? d.finishedAt : undefined) ??
      (typeof d.startedAt === "number" ? d.startedAt : undefined) ??
      0;

    btwEntries.push({
      id: typeof d.id === "string"
        ? d.id
        : `btw-restored-${btwEntries.length}-${timestamp}`,
      question: d.question,
      answer: typeof d.answer === "string" ? d.answer : "",
      modelProvider: typeof d.modelProvider === "string" ? d.modelProvider : "",
      modelId: typeof d.modelId === "string" ? d.modelId : "",
      timestamp,
      usage: d.usage as BtwUsage | undefined,
      error: typeof d.error === "string" ? d.error : undefined,
    });

    if (typeof d.slot === "number") {
      slotInputs.push({ customType: "btw-entry", details: d });
    }
  }
  trimEntries();
  // Update entry counter
  for (const e of btwEntries) {
    const m = e.id.match(/^btw-(\d+)-/);
    if (m) { const n = parseInt(m[1]!, 10); if (n >= entryCounter) entryCounter = n + 1; }
  }
  // Restore slot state
  slotState = createInitialState();
  restoreStateFromMessages(slotState, slotInputs);
}

// ────────────────────────────────────────────────────────────────
// Format helpers
// ────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────────────
// System prompt (for inline fallback mode)
// ────────────────────────────────────────────────────────────────

const PROMPT = [
  "You are a quick side-question assistant inside a coding agent session.",
  "",
  "IMPORTANT:",
  "- You are a SEPARATE, LIGHTWEIGHT agent spawned to answer this ONE question.",
  "- The main coding agent is NOT interrupted.",
  "- You share the conversation context but are a completely separate instance.",
  "",
  "CRITICAL:",
  "- You have NO tools in this inline fallback mode. Do not call, request, simulate, or output tool calls.",
  "- This is a ONE-OFF response — there will be no follow-up turns.",
  '- NEVER say "Let me try..." or simulate action.',
  "- Answer directly using the provided context.",
  "- Format code blocks with language tags.",
].join("\n");

// ────────────────────────────────────────────────────────────────
// Inline fallback (non-RPC mode)
// Used when RPC child is unavailable or disabled.
// ────────────────────────────────────────────────────────────────

function estimateTokens(m: AgentMessage): number {
  return Math.ceil(JSON.stringify(m).length / 4);
}

function collectSmartContext(ctx: ExtensionContext): AgentMessage[] {
  const s = btwSettings;
  const raw: AgentMessage[] = [];
  let latestCompaction: AgentMessage | null = null;

  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message") raw.push(e.message);
    else if (e.type === "compaction") {
      const cm: AgentMessage = {
        role: "compactionSummary" as AgentMessage["role"],
        summary: e.summary, tokensBefore: e.tokensBefore, timestamp: new Date(e.timestamp).getTime(),
      } as unknown as AgentMessage;
      latestCompaction = cm;
      raw.push(cm);
    }
  }

  if (s.strategy === "full" || s.maxContextTokens <= 0) return raw;
  if (s.strategy === "none") return [];

  if (s.strategy === "compact") {
    if (latestCompaction) {
      const recent: AgentMessage[] = [];
      for (let i = raw.length - 1; i >= 0; i--) {
        const m = raw[i]!;
        if (m.role === "user" || m.role === "assistant") {
          recent.unshift(m);
          if (recent.length >= 4) break;
        }
      }
      return [latestCompaction, ...recent];
    }
    return [];
  }

  if (s.strategy === "last-n") {
    const result: AgentMessage[] = [];
    for (const m of raw) {
      if (m.role === "user" || m.role === "assistant" || m.role === "compactionSummary") result.push(m);
    }
    return result.slice(-s.recentExchanges * 2);
  }

  const budget = Math.max(1000, s.maxContextTokens);
  const scoped: AgentMessage[] = [];
  let tokens = 0;

  for (let i = raw.length - 1; i >= 0; i--) {
    const m = raw[i]!;
    if (s.strategy === "smart") {
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "compactionSummary") continue;
    }
    const t = estimateTokens(m);
    if (tokens + t > budget) break;
    scoped.unshift(m);
    tokens += t;
  }
  return scoped;
}

function serializeContext(msgs: AgentMessage[]): string {
  if (msgs.length === 0) return "(no context requested — fresh session)";
  try { return serializeConversation(convertToLlm(msgs)); } catch { return "(context serialization error)"; }
}

async function resolveBtwModel(
  ctx: ExtensionContext,
  slotIndex?: number,
): Promise<
  { model: NonNullable<ExtensionContext["model"]>; auth: { ok: true; apiKey: string; headers?: Record<string, string>; env?: Record<string, string> } }
  | { error: string }
> {
  // Priority 1: Per-slot model override
  if (slotIndex !== undefined && btwSettings.slotModels?.[slotIndex]) {
    const sm = btwSettings.slotModels[slotIndex]!;
    const slotModel = ctx.modelRegistry.find(sm.provider, sm.modelId);
    if (slotModel) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(slotModel);
      if (auth.ok && auth.apiKey) return { model: slotModel, auth: auth as any };
    }
  }

  // Priority 2: Global BTW model override
  if (btwSettings.btwProvider && btwSettings.btwModelId) {
    const btwModel = ctx.modelRegistry.find(btwSettings.btwProvider, btwSettings.btwModelId);
    if (btwModel) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(btwModel);
      if (auth.ok && auth.apiKey) return { model: btwModel, auth: auth as any };
    }
  }

  // Priority 3: Main agent's model
  if (!ctx.model) return { error: "No model selected. Run /model first." };
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey)
    return { error: auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error };
  return { model: ctx.model, auth: auth as any };
}

async function fallbackAskStreaming(
  ctx: ExtensionContext,
  question: string,
  signal: AbortSignal,
  onPartial: (text: string) => void,
): Promise<{ answer?: string; usage?: BtwUsage; error?: string }> {
  const resolved = await resolveBtwModel(ctx);
  if ("error" in resolved) return { error: resolved.error };
  const { model, auth } = resolved;
  const conv = serializeContext(collectSmartContext(ctx));

  try {
    const msg: UserMessage = {
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: `## Current Context\n\n${conv}\n\n## Question\n\n${question}` }],
    };
    const eventStream: AssistantMessageEventStream = stream(model, { systemPrompt: PROMPT, messages: [msg] }, {
      apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal, maxTokens: btwSettings.maxTokens,
    });

    let answer = "";
    let usage: BtwUsage | undefined;

    for await (const event of eventStream) {
      if (event.type === "text_delta") {
        answer += event.delta;
        onPartial(answer);
      } else if (event.type === "done" && event.message) {
        const m = event.message;
        usage = {
          input: (m.usage as any)?.input ?? 0,
          output: (m.usage as any)?.output ?? 0,
          cacheRead: (m.usage as any)?.cacheRead ?? 0,
          cacheWrite: (m.usage as any)?.cacheWrite ?? 0,
          totalCost: (m.usage as any)?.cost?.total ?? 0,
        };
      }
    }
    return { answer, usage };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const low = msg.toLowerCase();
    if (/no api key|unauthorized|auth|401|403/.test(low)) return { error: `Auth failed for ${model.provider}.` };
    if (/rate.?limit|429|quota|billing/.test(low)) return { error: `Rate-limited on ${model.id}.` };
    if (/timeout|network|fetch|connection|502|503/.test(low)) return { error: `Provider unreachable for ${model.id}.` };
    return { error: msg };
  }
}

// ────────────────────────────────────────────────────────────────
// UI helpers
// ────────────────────────────────────────────────────────────────

function L(T: Theme, content: string, cw: number): string {
  return `${T.fg("accent", "║")} ${truncateToWidth(content || "", cw, "", true)} ${T.fg("accent", "║")}`;
}

function S(T: Theme, cw: number): string {
  return `${T.fg("accent", "║")} ${T.fg("accent", "─".repeat(cw))} ${T.fg("accent", "║")}`;
}

/**
 * Inner content width for a boxed view.
 *
 * The box draws two border columns and two padding columns, so the content can
 * never be wider than `width - 4`. Clamping up to a readable minimum here would
 * push every line past the terminal edge and break the frame.
 */
function contentWidth(width: number): number {
  return Math.max(1, width - 4);
}

/** Top border with an inline title, truncated so the frame never overflows. */
function topBorder(T: Theme, label: string, width: number): string {
  const title = truncateToWidth(label, Math.max(0, width - 3), "", false);
  const fill = Math.max(0, width - 3 - [...title].length);
  return T.fg("accent", `╔═${title}${"═".repeat(fill)}╗`);
}

/**
 * Bottom border with inline key hints. The hints are dropped entirely when
 * they do not fit, which keeps the frame intact on narrow terminals.
 */
function bottomBorder(T: Theme, plainHints: string, styledHints: string, width: number): string {
  const hintLen = [...plainHints].length;
  if (hintLen + 2 > width) {
    return T.fg("accent", `╚${"═".repeat(Math.max(0, width - 2))}╝`);
  }
  return T.fg("accent", `╚${"═".repeat(width - 2 - hintLen)}`) + styledHints + T.fg("accent", "╝");
}

/** Minimum body rows a boxed view will render regardless of terminal size. */
const MIN_BODY_ROWS = 6;
/** Chrome rows a boxed view needs on top of its body (borders, meta, hints). */
const BOX_CHROME_ROWS = 8;

/**
 * Body height for a boxed view. `Component.render()` only receives the width,
 * so read the row count off the TUI's terminal and leave room for the chrome.
 */
function bodyRows(tui: BtwTui): number {
  const rows = tui.terminal?.rows;
  if (typeof rows !== "number" || !Number.isFinite(rows)) return 30;
  return Math.max(MIN_BODY_ROWS, rows - BOX_CHROME_ROWS);
}

/** The slice of the TUI instance these views actually use. */
interface BtwTui {
  requestRender(): void;
  terminal?: { rows: number };
}

// ────────────────────────────────────────────────────────────────
// Streaming Answer View
// ────────────────────────────────────────────────────────────────

interface BtwStreamState {
  text: string;
  question: string;
  modelId: string;
  slot: number;
  done: boolean;
  error?: string;
  usage?: BtwUsage;
}

class BtwAnswerView implements Component {
  private scrollOff = 0;
  private md: Markdown;
  private mdTheme: MarkdownTheme;
  private get maxVis(): number { return bodyRows(this.tui); }
  /** Track last rendered text to update markdown on state.text change */
  private lastRenderedText = "";

  constructor(
    private tui: BtwTui,
    private theme: Theme,
    private state: BtwStreamState,
    private onClose: () => void,
  ) {
    this.mdTheme = getMarkdownTheme();
    this.md = new Markdown(state.text || "", 1, 0, this.mdTheme);
    this.lastRenderedText = state.text || "";
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.onClose(); return; }
    if (matchesKey(data, Key.up)) { this.scrollOff = Math.max(0, this.scrollOff - 1); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.scrollOff++; this.tui.requestRender(); return; }
  }

  invalidate(): void {
    this.md = new Markdown(this.state.text || "", 1, 0, this.mdTheme);
    this.lastRenderedText = this.state.text || "";
  }

  private syncMd(): void {
    const t = this.state.text || "";
    if (t !== this.lastRenderedText) {
      this.md = new Markdown(t, 1, 0, this.mdTheme);
      this.lastRenderedText = t;
    }
  }

  render(width: number): string[] {
    this.syncMd();
    const T = this.theme;
    const cw = contentWidth(width);
    const lines: string[] = [];
    const e = this.state;

    const lbl = e.done ? ` /btw [${e.slot}] ` : ` /btw [${e.slot}] \u25b6 streaming... `;
    lines.push(topBorder(T, lbl, width));
    lines.push(L(T, ` ${T.fg("accent", "\u2753")} ${T.fg("accent", e.question)}`, cw));

    if (e.error) {
      lines.push(S(T, cw));
      lines.push(L(T, ` ${T.fg("error", "\u2717")} ${e.error}`, cw));
    } else if (e.text || !e.done) {
      lines.push(S(T, cw));
      const mdL = this.md.render(cw - 2);
      this.scrollOff = Math.min(this.scrollOff, Math.max(0, mdL.length - this.maxVis));
      const vis = mdL.slice(this.scrollOff, this.scrollOff + this.maxVis);
      for (const mdLine of vis) lines.push(L(T, ` ${mdLine}`, cw));

      if (!e.done) lines.push(L(T, ` ${T.fg("dim", "\u25b6 generating...")}`, cw));
      if (mdL.length > this.maxVis) {
        const st = `\u2191\u2193 scroll \u00b7 ${this.scrollOff + 1}\u2013${this.scrollOff + vis.length} of ${mdL.length}`;
        lines.push(L(T, ` ${T.fg("dim", st)}`, cw));
      } else if (vis.length < 3) {
        for (let r = vis.length; r < 3; r++) lines.push(L(T, "", cw));
      }
    } else {
      lines.push(S(T, cw));
      lines.push(L(T, ` ${T.fg("dim", "No answer.")}`, cw));
    }

    lines.push(S(T, cw));
    const meta: string[] = [];
    if (e.modelId) meta.push(T.fg("dim", e.modelId));
    if (e.usage?.output) meta.push(T.fg("dim", `${fmtTokens(e.usage.output)} out`));
    if (e.usage?.input) meta.push(T.fg("dim", `${fmtTokens(e.usage.input)} in`));
    if (e.usage?.totalCost) meta.push(T.fg("dim", `\$${e.usage.totalCost.toFixed(4)}`));
    if (!e.done) meta.push(T.fg("accent", "streaming..."));
    lines.push(L(T, meta.length ? meta.join(" \u00b7 ") : "", cw));

    const hp = e.done ? " \u2191\u2193 scroll  Esc dismiss  /btw inject  /btw history " : " Esc close ";
    const hintsDim = e.done
      ? ` ${T.fg("dim", "\u2191\u2193 scroll")}  ${T.fg("dim", "Esc dismiss")}  ${T.fg("dim", "/btw inject")}  ${T.fg("dim", "/btw history")} `
      : ` ${T.fg("dim", "Esc close")} `;
    lines.push(bottomBorder(T, hp, hintsDim, width));
    lines.push("");
    return lines;
  }

  dispose(): void {}
}

// ────────────────────────────────────────────────────────────────
// History Browser
// ────────────────────────────────────────────────────────────────

class BtwHistoryView implements Component {
  selectedIndex = 0;
  expandedIndex: number | null = null;
  private scrollOff = 0;
  private md: Markdown;
  private mdTheme: MarkdownTheme;

  constructor(
    private tui: BtwTui,
    private theme: Theme,
    private onClose: () => void,
    private onDelete: (id: string) => void,
    initialIndex: number,
    initialExpanded: number | null,
  ) {
    this.mdTheme = getMarkdownTheme();
    this.md = new Markdown("", 1, 0, this.mdTheme);
    this.selectedIndex = initialIndex;
    this.expandedIndex = initialExpanded;
    if (initialExpanded !== null && btwEntries[initialExpanded]?.answer)
      this.md.setText(btwEntries[initialExpanded]!.answer);
  }

  handleInput(data: string): void {
    const n = btwEntries.length;
    if (matchesKey(data, Key.escape)) { this.onClose(); return; }
    if (data === "q") { this.onClose(); return; }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (this.expandedIndex !== null) {
        if (this.scrollOff <= 0) {
          this.expandedIndex = null; this.scrollOff = 0;
          this.selectedIndex = this.selectedIndex <= 0 ? n - 1 : this.selectedIndex - 1;
        } else { this.scrollOff--; }
      } else {
        this.selectedIndex = this.selectedIndex <= 0 ? n - 1 : this.selectedIndex - 1;
      }
      this.invalidate(); this.tui.requestRender(); return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.expandedIndex !== null) {
        const mdL = this.md.render(this.maxMdW());
        if (this.scrollOff >= Math.max(0, mdL.length - bodyRows(this.tui))) {
          this.expandedIndex = null; this.scrollOff = 0;
          this.selectedIndex = this.selectedIndex >= n - 1 ? 0 : this.selectedIndex + 1;
        } else { this.scrollOff++; }
      } else {
        this.selectedIndex = this.selectedIndex >= n - 1 ? 0 : this.selectedIndex + 1;
      }
      this.invalidate(); this.tui.requestRender(); return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.expandedIndex === this.selectedIndex) {
        this.expandedIndex = null; this.scrollOff = 0;
      } else {
        this.expandedIndex = this.selectedIndex; this.scrollOff = 0;
        this.md.setText(btwEntries[this.selectedIndex]?.answer ?? "");
      }
      this.invalidate(); this.tui.requestRender(); return;
    }

    if (data === "d" || data === "D") {
      const e = btwEntries[this.selectedIndex]; if (!e) return;
      this.onDelete(e.id);
      if (this.expandedIndex === this.selectedIndex) { this.expandedIndex = null; this.scrollOff = 0; }
      if (this.selectedIndex >= btwEntries.length) this.selectedIndex = Math.max(0, btwEntries.length - 1);
      this.invalidate(); this.tui.requestRender();
    }
  }

  invalidate(): void {
    if (this.expandedIndex !== null && btwEntries[this.expandedIndex])
      this.md.setText(btwEntries[this.expandedIndex]!.answer);
  }

  private maxMdW(): number { return Math.max(36, 80) - 6; }

  render(width: number): string[] {
    const T = this.theme;
    const cw = contentWidth(width);
    const lines: string[] = [];
    const items = btwEntries;
    const hdr = ` /btw  Side Questions${items.length > 0 ? ` (${items.length})` : ""} `;
    lines.push(topBorder(T, hdr, width));

    if (items.length === 0) {
      lines.push(L(T, ` ${T.fg("dim", "No side questions yet.")}`, cw));
      lines.push(L(T, ` ${T.fg("dim", "Type /btw <question> to ask one.")}`, cw));
      lines.push(L(T, "", cw));
    } else {
      for (let i = 0; i < items.length; i++) {
        const e = items[i]!;
        const sel = i === this.selectedIndex;
        const exp = i === this.expandedIndex;
        if (i > 0) lines.push(S(T, cw));
        const mrk = sel ? T.fg("accent", "\u25b8") : " ";
        lines.push(L(T, `${mrk} ${T.fg("dim", `${i + 1}`)}  ${T.fg(sel ? "accent" : "text", e.question)}`, cw));
        if (exp && !e.error && e.answer) {
          const mdL = this.md.render(cw - 2);
          const max = bodyRows(this.tui);
          this.scrollOff = Math.min(this.scrollOff, Math.max(0, mdL.length - max));
          const vis = mdL.slice(this.scrollOff, this.scrollOff + max);
          for (const l of vis) lines.push(L(T, ` ${l}`, cw));
          if (mdL.length > max) {
            const st = `\u2191\u2193 scroll \u00b7 ${this.scrollOff + 1}\u2013${this.scrollOff + vis.length} of ${mdL.length}`;
            lines.push(L(T, ` ${T.fg("dim", st)}`, cw));
          }
          const meta: string[] = [];
          if (e.modelId) meta.push(T.fg("dim", e.modelId));
          meta.push(T.fg("dim", fmtTime(e.timestamp)));
          if (e.usage?.input) meta.push(T.fg("dim", `in ${fmtTokens(e.usage.input)}`));
          if (e.usage?.output) meta.push(T.fg("dim", `out ${fmtTokens(e.usage.output)}`));
          if (e.usage?.totalCost) meta.push(T.fg("dim", `\$${e.usage.totalCost.toFixed(4)}`));
          if (meta.length) lines.push(L(T, ` ${meta.join(" \u00b7 ")}`, cw));
        } else if (exp && e.error) {
          lines.push(L(T, ` ${T.fg("error", "\u2717")} ${e.error}`, cw));
        }
      }
    }

    const isExp = this.expandedIndex !== null;
    const hp = ` \u2191\u2193 nav \u00b7 Enter${isExp ? " collapse" : " expand"} \u00b7 d del \u00b7 Esc/q close `;
    const hintsDim = ` ${T.fg("dim", `\u2191\u2193 nav \u00b7 Enter${isExp ? " collapse" : " expand"} \u00b7 d del \u00b7 Esc/q close`)} `;
    lines.push(bottomBorder(T, hp, hintsDim, width));
    lines.push("");
    return lines;
  }

  dispose(): void {}
}

// ────────────────────────────────────────────────────────────────
// Extension entry point
// ────────────────────────────────────────────────────────────────

export default function (ext: ExtensionAPI) {
  // A BTW child is intentionally read-only and must not load this extension
  // again, otherwise every child could recursively spawn another child.
  if (process.env.PI_BTW_CHILD === "1") {
    logBtw("info", "Skipping BTW extension in child process");
    return;
  }

  api = ext;
  btwSettings = loadGlobalSettings();
  slotState = createInitialState();

  // ── Context isolation ──
  // Answers only reach the main agent when the user explicitly runs
  // `/btw inject`, so drop any BTW custom message that made it into the
  // branch. Injected answers are deliberately NOT filtered: getting them in
  // front of the model is the whole point of injecting.
  ext.on("context", async (event) => {
    const filtered = event.messages.filter(
      (m) => !(m.role === "custom" && (m as any).customType === "btw-entry"),
    );
    if (filtered.length !== event.messages.length) return { messages: filtered };
  });

  // ── Session lifecycle ──
  ext.on("session_shutdown", async () => {
    currentAbortController?.abort();
    currentAbortController = null;
    childVisibleProviders = null;
    // Stop all child processes with timeout
    const slots = listSlots(slotState);
    if (slots.length > 0) {
      logBtw("info", `session_shutdown: stopping ${slots.length} child process(es)`);
      const results = await Promise.allSettled(
        slots.map(async (slot) => {
          if (!slot.child) return;
          try {
            await Promise.race([
              slot.child.stop(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("stop timeout")), 3000)),
            ]);
          } catch (e) {
            logBtw("warn", "Child stop error", String(e));
          }
        }),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) logBtw("warn", `${failed}/${slots.length} child processes failed to stop`);
      else logBtw("info", "All child processes stopped");
    }
  });

  ext.on("session_start", async (_e, ctx) => {
    slotState = createInitialState();
    restore(ctx);
    // Clear the legacy slot-status line from prior extension versions.
    try { ctx.ui.setStatus("btw-slots", undefined); } catch (e) { logBtw("warn", "Clear legacy slot status failed", String(e)); }
  });

  // ── /btw command ──
  ext.registerCommand("btw", {
    description: "Side questions (/btw <q>, /btw N <q>, /btw N to switch, /btw inject, /btw clear, /btw for history)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "inject", label: "inject — send this slot's answers to the main agent, then clear it" },
        { value: "clear", label: "clear — discard this slot's answers" },
      ].filter((i) => i.value.startsWith(prefix.toLowerCase()));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Just "/btw" → open history
      if (!trimmed) {
        await showHistory(ctx);
        return;
      }

      // Slot actions live on the command rather than on a keyboard shortcut:
      // terminals disagree about how Alt+<key> is encoded, and a command is
      // always delivered.
      const action = trimmed.toLowerCase();
      if (action === "inject") {
        await injectSlot(ctx, activeSlot(slotState));
        return;
      }
      if (action === "clear") {
        const slot = activeSlot(slotState);
        if (!slot) { ctx.ui.notify("No active /btw slot.", "warning"); return; }
        await clearSlot(slotState, slot);
        ctx.ui.notify("Slot cleared.", "info");
        return;
      }

      const { slotNumber, question } = parseBtwArgs(trimmed);

      // "/btw N" with no question → switch to slot N
      if (slotNumber !== undefined && !question) {
        const slot = ensureSlot(slotState, slotNumber - 1);
        slot.unread = false;
        slotState.folded = false;
        ctx.ui.notify(`Switched to slot ${slotNumber}`, "info");
        return;
      }

      // "/btw N <question>" targets slot N. A bare "/btw <question>" reuses the
      // active slot, and only allocates a new one when no slot exists yet.
      let slot: BtwSlot;
      if (slotNumber !== undefined) {
        slot = ensureSlot(slotState, slotNumber - 1);
      } else {
        const existing = activeSlot(slotState);
        if (existing) {
          slot = existing;
          slotState.folded = false;
          slot.unread = false;
        } else {
          const free = freeSlotIndex(slotState);
          if (free === undefined) {
            ctx.ui.notify(
              `All ${MAX_BTW_SLOTS} /btw slots are in use. Clear one with Alt+X, or target one with /btw N <question>.`,
              "warning",
            );
            return;
          }
          slot = ensureSlot(slotState, free);
        }
      }

      await doAskRpc(ctx, question || trimmed, slot);
    },
  });

  // ── Shortcuts ──
  //
  // Injection is deliberately NOT a shortcut. Alt+<key> encoding differs
  // between terminals and protocols, and a key that silently does nothing is
  // worse than no key at all. Use `/btw inject`.

  ext.registerShortcut("alt+x", {
    description: "Clear active /btw slot",
    handler: async (ctx) => {
      const slot = activeSlot(slotState);
      if (!slot) { ctx.ui.notify("No active /btw slot.", "warning"); return; }
      await clearSlot(slotState, slot);
      ctx.ui.notify("Slot cleared.", "info");
    },
  });

  ext.registerShortcut("alt+h", {
    description: "Previous /btw slot",
    handler: async () => {
      switchRelativeSlot(slotState, -1);
    },
  });

  ext.registerShortcut("alt+l", {
    description: "Next /btw slot",
    handler: async () => {
      switchRelativeSlot(slotState, 1);
    },
  });

  // ── Alt+1…Alt+9 slot jump ──
  for (let n = 1; n <= 9; n++) {
    const slotIndex = n - 1;
    ext.registerShortcut(`alt+${n}` as any, {
      description: `Jump to /btw slot ${n}`,
      handler: async () => {
        ensureSlot(slotState, slotIndex);
      },
    });
  }
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * View state for one in-flight question, plus the handle the answer view uses
 * to request a redraw. The view may be opened and closed repeatedly while the
 * underlying turn keeps running, so the TUI reference is late-bound.
 */
function createStreamState(question: string, modelId: string, slot: number): {
  state: BtwStreamState;
  setTui: (t: BtwTui) => void;
  refreshView: () => void;
} {
  const state: BtwStreamState = { text: "", question, modelId, slot, done: false };
  let tuiRef: BtwTui | null = null;
  return {
    state,
    setTui: (t) => { tuiRef = t; },
    refreshView: () => { tuiRef?.requestRender(); },
  };
}

async function showHistory(ctx: ExtensionContext): Promise<void> {
  if (ctx.mode !== "tui") {
    try { ctx.ui.notify(`${btwEntries.length} side question(s) recorded.`, "info"); } catch { /* no UI */ }
    return;
  }
  if (btwEntries.length === 0) {
    try { ctx.ui.notify("No side questions yet. Try /btw <question>", "info"); } catch (e) { logBtw("warn", "Stale ctx", String(e)); }
    return;
  }
  try {
    await ctx.ui.custom<void>((tui, th, _kb, done) => {
      return new BtwHistoryView(
        tui, th as unknown as Theme,
        () => done(undefined),
        (id) => { delEntry(id); },
        0, null,
      );
    });
  } catch (e) { reportUiFailure(ctx, "history browser", e); }
}
// ────────────────────────────────────────────────────────────────
// Child capability probing
// ────────────────────────────────────────────────────────────────

/**
 * Providers the RPC child will be able to resolve.
 *
 * The child runs with `--no-extensions`, so it sees built-in providers plus
 * anything in `models.json`, but not providers registered at runtime through
 * `pi.registerProvider()`. Building a registry the same way the child does is
 * the cheapest accurate way to know that up front, instead of spawning a
 * process that is guaranteed to exit with "Model not found".
 */
function getChildVisibleProviders(ctx: ExtensionContext): Set<string> | null {
  if (childVisibleProviders) return childVisibleProviders;
  try {
    const registry = ModelRegistry.create(ctx.modelRegistry.authStorage);
    const providers = new Set(registry.getAll().map((m) => m.provider));
    if (providers.size === 0) return null;
    childVisibleProviders = providers;
    return childVisibleProviders;
  } catch (e) {
    // Probing is an optimisation. If it fails, fall back to spawning and
    // letting the normal error path handle it.
    logBtw("warn", "Could not probe child-visible providers", String(e));
    return null;
  }
}

function childCanUseProvider(ctx: ExtensionContext, provider: string): boolean {
  const providers = getChildVisibleProviders(ctx);
  return providers ? providers.has(provider) : true;
}

// ────────────────────────────────────────────────────────────────
// Context for the child
// ────────────────────────────────────────────────────────────────

/**
 * Build the main-session context block sent with the first question in a slot.
 * Returns `undefined` when the configured strategy asks for no context.
 */
function buildContextMessage(ctx: ExtensionContext): string | undefined {
  if (btwSettings.strategy === "none") return undefined;
  let messages: AgentMessage[];
  try {
    messages = collectSmartContext(ctx);
  } catch (e) {
    logBtw("warn", "Could not collect context for child", String(e));
    return undefined;
  }
  if (messages.length === 0) return undefined;
  const serialized = serializeContext(messages);
  if (!serialized || serialized.startsWith("(")) return undefined;
  return [
    "## Context from the main coding session",
    "",
    "The user is working with another agent in this repository. This transcript",
    "is background only — answer the question below, do not continue that work.",
    "",
    serialized,
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────
// Ask flow
//
// One question becomes one turn on a slot queue. Questions in the same slot
// run serially against a shared RPC child; different slots run in parallel.
// The answer view is just a window onto that turn, so dismissing it with Esc
// leaves the turn running in the background.
// ────────────────────────────────────────────────────────────────

async function doAskRpc(ctx: ExtensionContext, question: string, slot: BtwSlot): Promise<void> {
  // Resolve BTW model (with slot index for per-slot override)
  const resolved = await resolveBtwModel(ctx, slot.index);
  if ("error" in resolved) {
    try { ctx.ui.notify(resolved.error, "error"); } catch (e) { logBtw("warn", "Stale ctx", String(e)); }
    return;
  }
  const { model } = resolved;

  const slotNumber = slot.index + 1;
  try {
    ctx.ui.setStatus("btw", `π /btw [${slotNumber}] ${model.id}...`);
  } catch (e) { logBtw("warn", "Stale ctx", String(e)); }

  const { state, setTui, refreshView } = createStreamState(question, model.id, slotNumber);

  // A provider registered by an extension cannot exist inside the child, so
  // skip the doomed spawn and answer inline instead.
  const rpcUsable = childCanUseProvider(ctx, model.provider);
  if (!rpcUsable) {
    logBtw(
      "warn",
      "Provider is not visible to the RPC child; answering inline",
      `${model.provider}/${model.id}`,
    );
    try {
      ctx.ui.notify(
        `Provider "${model.provider}" is registered by an extension, so /btw cannot use its tool-enabled child. ` +
        "Answering inline without tools. Set btwProvider/btwModelId to a built-in provider for full /btw.",
        "warning",
      );
    } catch (e) { logBtw("warn", "Stale ctx", String(e)); }
  }

  let notifiedFallback = false;
  const runFallback = async (
    q: string,
    onPartial: (text: string) => void,
  ): Promise<{ answer?: string; usage?: BtwUsage; error?: string }> => {
    const controller = new AbortController();
    currentAbortController = controller;
    try {
      return await fallbackAskStreaming(ctx, q, controller.signal, onPartial);
    } finally {
      if (currentAbortController === controller) currentAbortController = null;
    }
  };

  const { turn, done } = queueQuestionToSlot({
    state: slotState,
    slot,
    question,
    provider: model.provider,
    modelId: model.id,
    cwd: ctx.cwd,
    contextMessage: buildContextMessage(ctx),
    onUpdate: (liveTurn) => {
      syncStateFromTurn(state, liveTurn);
      refreshView();
    },
    onFallback: async (q, onPartial, rpcError) => {
      if (!notifiedFallback && rpcUsable) {
        notifiedFallback = true;
        logBtw("error", "RPC child failed; using inline no-tools fallback", rpcError);
        try {
          ctx.ui.notify(
            `BTW RPC unavailable; using inline no-tools fallback. ${truncateForNotice(rpcError)}`,
            "warning",
          );
        } catch (e) { logBtw("warn", "Could not notify about RPC fallback", String(e)); }
      }
      const outcome = await runFallback(q, onPartial);
      // Both paths failed. Report the RPC cause, which is the actionable one,
      // rather than presenting an empty string as a successful answer.
      if (outcome.error) {
        return { ...outcome, error: `${outcome.error} (RPC child: ${rpcError})` };
      }
      if (!outcome.answer?.trim()) {
        return { ...outcome, error: rpcError };
      }
      return outcome;
    },
    persist: (persistedSlot, persistedTurn) => {
      addEntry(
        {
          id: genId(),
          question: persistedTurn.question,
          answer: persistedTurn.answer ?? "",
          modelProvider: model.provider,
          modelId: persistedTurn.modelId ?? model.id,
          timestamp: persistedTurn.finishedAt ?? Date.now(),
          usage: persistedTurn.usage,
          error: persistedTurn.error,
        },
        persistedSlot,
        persistedTurn,
      );
    },
    ...(rpcUsable
      ? {}
      : {
          // Force the fallback path without spawning anything.
          createChild: () => {
            throw new Error(`Provider "${model.provider}" is not available to the /btw child.`);
          },
        }),
  });

  // Keep the view in sync as the turn progresses, even after the user leaves.
  done.then(() => {
    syncStateFromTurn(state, turn);
    refreshView();
  }).catch(() => {
    state.done = true;
    refreshView();
  });

  // Show answer view. Esc closes the window; the turn keeps running.
  let userDismissed = false;
  if (ctx.mode === "tui") {
    try {
      await ctx.ui.custom<void>((tui, th, _kb, doneFn) => {
        setTui(tui);
        state.text = turnText(turn);
        return new BtwAnswerView(tui, th as unknown as Theme, state, () => {
          userDismissed = true;
          doneFn(undefined);
        });
      });
    } catch (e) { reportUiFailure(ctx, "answer view", e); }
  } else {
    // Non-TUI modes have no custom component; just wait for the answer.
    userDismissed = true;
  }

  try { ctx.ui.setStatus("btw", undefined); } catch (e) { logBtw("warn", "Stale ctx", String(e)); }

  // Await the answer (still processing in background even if user dismissed)
  await done;
  syncStateFromTurn(state, turn);

  // If user dismissed early, show a completion notification
  if (userDismissed && (state.text || state.error)) {
    try {
      const preview = turn.error
        ? `Error: ${turn.error}`
        : turn.answer
          ? `${turn.answer.slice(0, 200)}${turn.answer.length > 200 ? "..." : ""}`
          : "(empty)";
      ctx.ui.notify(`✓ /btw [${slotNumber}] complete: ${preview}`, "info");
    } catch (e) { logBtw("warn", "Stale ctx", String(e)); }
  }
}

/**
 * Send a slot's answers to the main agent and clear the slot.
 *
 * Exposed as `/btw inject` rather than a keyboard shortcut. Extension
 * shortcuts are dispatched on the default editor, so they never fire while a
 * custom component owns the input, and Alt+<key> encoding varies by terminal.
 * A command is delivered either way.
 */
async function injectSlot(ctx: ExtensionContext, slot: BtwSlot | undefined): Promise<void> {
  if (!slot) { ctx.ui.notify("No active /btw slot.", "warning"); return; }
  const turns = slot.turns.filter((t) => t.answer || t.error);
  if (turns.length === 0) { ctx.ui.notify("No answers in active slot.", "warning"); return; }
  if (slot.running) {
    ctx.ui.notify("Slot is still answering. Wait for it to finish.", "warning");
    return;
  }
  // sendUserMessage rejects when the agent is streaming and no delivery mode
  // is given, so queue it behind the current turn in that case.
  const streaming = !ctx.isIdle();
  api?.sendUserMessage(
    injectionText(turns),
    streaming ? { deliverAs: "followUp" } : undefined,
  );
  await clearSlot(slotState, slot);
  ctx.ui.notify(
    streaming ? "Queued injection for after the current turn; slot cleared." : "Injected and cleared slot.",
    "info",
  );
}

/** Text to show for a turn: the final answer if settled, otherwise the stream. */
function turnText(turn: BtwTurn): string {
  return turn.answer ?? turn.partial ?? "";
}

function syncStateFromTurn(state: BtwStreamState, turn: BtwTurn): void {
  state.done = turn.status === "answered" || turn.status === "failed";
  state.text = turnText(turn) || state.text;
  state.error = turn.error;
  state.usage = turn.usage;
  if (turn.modelId) state.modelId = turn.modelId;
}
