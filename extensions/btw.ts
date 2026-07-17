/**
 * /btw — Side Questions for Pi Coding Agent
 *
 * Phase 3: RPC child architecture + slot-based async side sessions.
 *
 * Usage:
 *   /btw <question>       → ask in active slot (or create slot 1)
 *   /btw N <question>     → ask in slot N (1-9)
 *   /btw N                → switch to slot N
 *   /btw                  → open history browser
 *
 * Shortcuts:
 *   Alt+I   → inject active slot's answers into main chat
 *   Alt+X   → clear active slot
 *   Alt+H/L → previous/next slot
 */

import { readFileSync, appendFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { stream, type UserMessage, type AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir, getMarkdownTheme, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ── Slot system imports ──
import {
  createInitialState,
  activeSlot,
  ensureSlot,
  listSlots,
  parseBtwArgs,
  clearSlot,
  switchRelativeSlot,
  injectionText,
  restoreStateFromMessages,
} from "../src/session-state.ts";
import type {
  BtwSlotState,
  BtwUsage,
  BtwEntry,
} from "../src/types.ts";

// ── Constants ──

const BTW_ENTRIES_MAX = 100;

// ── Logging ──

let _logPath: string | null = null;

function logBtw(level: "info" | "warn" | "error", msg: string, detail?: string): void {
  try {
    if (!_logPath) {
      const dir = getAgentDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      _logPath = join(dir, "btw.log");
    }
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] ${msg}${detail ? " - " + detail : ""}\n`;
    appendFileSync(_logPath, line, "utf8");
  } catch {
    // Last resort — can't log, silently ignore
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
let sessionGeneration = 0;

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


function addEntry(e: BtwEntry): void {
  btwEntries.push(e);
  if (btwEntries.length > BTW_ENTRIES_MAX) {
    btwEntries = btwEntries.slice(-BTW_ENTRIES_MAX);
  }
  try {
    api?.appendEntry("btw-entry", {
      id: e.id, question: e.question, answer: e.answer,
      modelProvider: e.modelProvider, modelId: e.modelId, timestamp: e.timestamp,
      usage: e.usage, error: e.error,
    });
  } catch (e) { logBtw("warn", "appendEntry failed", String(e)); }
}

function delEntry(id: string): void { btwEntries = btwEntries.filter((e) => e.id !== id); }

function restore(ctx: ExtensionContext): void {
  btwEntries = [];
  const slotInputs: { customType?: string; details?: unknown }[] = [];
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type === "custom" && e.customType === "btw-entry") {
      const d = e.data as Record<string, unknown>;
      if (!d) continue;

      // Format 1: Old entry with direct id/question/answer
      if (typeof d.id === "string" && typeof d.question === "string") {
        btwEntries.push({
          id: d.id as string, question: d.question as string, answer: (d.answer as string) ?? "",
          modelProvider: (d.modelProvider as string) ?? "", modelId: (d.modelId as string) ?? "",
          timestamp: (d.timestamp as number) ?? 0, usage: d.usage as BtwUsage | undefined,
          error: d.error as string | undefined,
        });
      }

      // Format 2: Slot entry with kind/slot/turn
      if (typeof d.slot === "number") {
        slotInputs.push({ customType: "btw-entry", details: d });
        // Also add to btwEntries if it has question/answer for history browser
        if (typeof d.question === "string" && (typeof d.answer === "string" || typeof d.error === "string")) {
          const existing = btwEntries.find((be) => be.question === d.question && be.timestamp === (d.finishedAt as number ?? 0));
          if (!existing) {
            btwEntries.push({
              id: `btw-slot-${d.slot}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              question: d.question as string,
              answer: (d.answer as string) ?? "",
              modelProvider: "", modelId: (d.modelId as string) ?? "",
              timestamp: (d.finishedAt as number) ?? (d.startedAt as number) ?? Date.now(),
              usage: undefined,
              error: d.error as string | undefined,
            });
          }
        }
      }
    }
  }
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
  "- You have NO tools. Do not call, request, simulate, or output tool calls.",
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
  private maxVis = 30;
  /** Track last rendered text to update markdown on state.text change */
  private lastRenderedText = "";

  constructor(
    private tui: { requestRender(): void },
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
    const cw = Math.max(28, width - 4);
    const lines: string[] = [];
    const e = this.state;

    const lbl = e.done ? ` /btw [${e.slot}] ` : ` /btw [${e.slot}] \u25b6 streaming... `;
    const topD = Math.max(0, width - 3 - [...lbl].length);
    lines.push(T.fg("accent", `╔═${lbl}${"═".repeat(topD)}╗`));
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

    const hp = e.done ? " \u2191\u2193 scroll  Esc dismiss  /btw history  Alt+I inject " : " Esc close ";
    const hintsDim = e.done
      ? ` ${T.fg("dim", "\u2191\u2193 scroll")}  ${T.fg("dim", "Esc dismiss")}  ${T.fg("dim", "/btw history")}  ${T.fg("dim", "Alt+I inject")} `
      : ` ${T.fg("dim", "Esc close")} `;
    const dd = Math.max(0, width - 2 - [...hp].length);
    lines.push(
      T.fg("accent", `╚${"═".repeat(dd)}`) +
      hintsDim +
      T.fg("accent", "╝")
    );
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
    private tui: { requestRender(): void },
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
        if (this.scrollOff >= Math.max(0, mdL.length - 30)) {
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
    const cw = Math.max(36, width - 4);
    const lines: string[] = [];
    const items = btwEntries;
    const hdr = ` /btw  Side Questions${items.length > 0 ? ` (${items.length})` : ""} `;
    const hdrL = [...hdr].length;
    lines.push(T.fg("accent", `╔═${hdr}${"═".repeat(Math.max(0, width - 3 - hdrL))}╗`));

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
          const max = 30;
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
    const dd = Math.max(0, width - 2 - [...hp].length);
    lines.push(T.fg("accent", `╚${"═".repeat(dd)}`) + hintsDim + T.fg("accent", "╝"));
    lines.push("");
    return lines;
  }

  dispose(): void {}
}

// ────────────────────────────────────────────────────────────────
// Extension entry point
// ────────────────────────────────────────────────────────────────

export default function (ext: ExtensionAPI) {
  api = ext;
  btwSettings = loadGlobalSettings();
  slotState = createInitialState();

  // ── Context isolation ──
  ext.on("context", async (event) => {
    const filtered = event.messages.filter((m) => {
      if (m.role === "custom" && (m as any).customType === "btw-entry") return false;
      if (m.role === "user") {
        const text = typeof m.content === "string" ? m.content
          : (Array.isArray(m.content) ? m.content.map((c: any) => c.text ?? "").join("") : "");
        if (text.startsWith("[BTW Answer Injection]")) return false;
      }
      return true;
    });
    if (filtered.length !== event.messages.length) return { messages: filtered };
  });

  // ── Session lifecycle ──
  ext.on("session_shutdown", async () => {
    currentAbortController?.abort();
    currentAbortController = null;
    sessionGeneration++;
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
    description: "Side questions (/btw <q>, /btw N <q>, /btw N to switch, /btw for history)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Just "/btw" → open history
      if (!trimmed) {
        await showHistory(ctx);
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

      // "/btw N <question>" or "/btw <question>"
      if (slotNumber !== undefined) {
        ensureSlot(slotState, slotNumber - 1);
      } else {
        ensureSlot(slotState, lowestFreeSlotIndex());
      }

      await doAskRpc(ctx, question || trimmed);
    },
  });

  // ── Shortcuts ──
  ext.registerShortcut("alt+i", {
    description: "Inject active /btw slot answers into main chat",
    handler: async (ctx) => {
      const slot = activeSlot(slotState);
      if (!slot) { ctx.ui.notify("No active /btw slot.", "warning"); return; }
      const turns = slot.turns.filter((t) => t.answer || t.error);
      if (turns.length === 0) { ctx.ui.notify("No answers in active slot.", "warning"); return; }
      ext.sendUserMessage(injectionText(turns));
      await clearSlot(slotState, slot);
      ctx.ui.notify("Injected and cleared slot.", "info");
    },
  });

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

function lowestFreeSlotIndex(): number {
  const idx = slotState.slots.findIndex((s) => !s);
  return idx === -1 ? slotState.slots.length : idx;
}

function createStreamState(question: string, modelId: string, slot: number): {
  state: BtwStreamState;
  onPartial: (text: string) => void;
  setTui: (t: { requestRender(): void }) => void;
  refreshView: () => void;
} {
  const state: BtwStreamState = { text: "", question, modelId, slot, done: false };
  let tuiRef: { requestRender(): void } | null = null;
  return {
    state,
    setTui: (t) => { tuiRef = t; },
    refreshView: () => { tuiRef?.requestRender(); },
    onPartial: (text: string) => {
      state.text = text;
      tuiRef?.requestRender();
    },
  };
}

async function showHistory(ctx: ExtensionContext): Promise<void> {
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
  } catch (e) { logBtw("warn", "Stale ctx", String(e)); }
}

// ────────────────────────────────────────────────────────────────
// RPC-based doAsk
// Uses BtwChild (RPC child process) for zero-context-overhead answers.
// Falls back to inline streaming if RPC is unavailable.
// ────────────────────────────────────────────────────────────────

async function doAskRpc(ctx: ExtensionContext, question: string): Promise<void> {
  // Get or create active slot FIRST (needed for per-slot model)
  const slot = activeSlot(slotState) ?? ensureSlot(slotState, lowestFreeSlotIndex());

  // Resolve BTW model (with slot index for per-slot override)
  const resolved = await resolveBtwModel(ctx, slot.index);
  if ("error" in resolved) {
    try { ctx.ui.notify(resolved.error, "error"); } catch (e) { logBtw("warn", "Stale ctx", String(e)); }
    return;
  }
  const { model } = resolved;

  try {
    ctx.ui.setStatus("btw", `\u03c0 /btw [${slot.index + 1}] ${model.id}...`);
  } catch (e) { logBtw("warn", "Stale ctx", String(e)); }

  const { state, setTui, onPartial, refreshView } = createStreamState(question, model.id, slot.index + 1);

  // Track whether user dismissed the view early
  let userDismissed = false;

  const streamPromise = (async () => {
    try {
      // Try RPC child first
      if (!slot.child) {
        const { BtwChild } = await import("../src/btw-child");
        slot.child = new BtwChild(ctx.cwd, model.provider, model.id);
        await slot.child.ready();
      }

      const answer = await slot.child.ask(question, (partial) => {
        onPartial(partial);
      });

      if (answer) {
        return {
          answer,
          usage: {
            input: slot.child!.details.usage.input,
            output: slot.child!.details.usage.output,
            cacheRead: slot.child!.details.usage.cacheRead,
            cacheWrite: slot.child!.details.usage.cacheWrite,
            totalCost: slot.child!.details.usage.cost,
          } as BtwUsage,
        };
      }
      return { answer: "(no answer)" };
    } catch (err) {
      // Fall back to inline streaming if RPC fails
      return fallbackAskStreaming(ctx, question, new AbortController().signal, onPartial);
    }
  })();

  // Update state as soon as stream completes (live-update view if still visible)
  streamPromise.then((r) => {
    state.done = true;
    state.text = r.answer ?? state.text;
    state.error = r.error;
    state.usage = r.usage;
    refreshView();
  }).catch(() => {
    state.done = true;
    refreshView();
  });

  // Show answer view (blocks until user presses Esc)
  try {
    await ctx.ui.custom<void>((tui, th, _kb, done) => {
      setTui(tui);
      return new BtwAnswerView(tui, th as unknown as Theme, state, () => {
        userDismissed = true;
        done(undefined);
      });
    });
  } catch (e) { logBtw("warn", "Stale ctx", String(e)); }

  try { ctx.ui.setStatus("btw", undefined); } catch (e) { logBtw("warn", "Stale ctx", String(e)); }

  // Await the answer (still processing in background even if user dismissed)
  const r = await streamPromise;

  state.done = true;
  state.text = r.answer ?? state.text;
  state.error = r.error;
  state.usage = r.usage;

  addEntry({
    id: genId(), question, answer: state.text,
    modelProvider: model.provider, modelId: model.id,
    timestamp: Date.now(), usage: r.usage, error: r.error,
  });

  // If user dismissed early, show a completion notification
  if (userDismissed && (state.text || state.error)) {
    try {
      const preview = r.error
        ? `Error: ${r.error}`
        : r.answer
          ? `${r.answer.slice(0, 200)}${r.answer.length > 200 ? "..." : ""}`
          : "(empty)";
      ctx.ui.notify(`\u2713 /btw [${slot.index + 1}] complete: ${preview}`, "info");
    } catch (e) { logBtw("warn", "Stale ctx", String(e)); }
  }
}
